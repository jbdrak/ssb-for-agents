'use strict';

const { ODDS_HISTORY_REQUEST_BUDGET } = require('./ssb-api');
const { getSharpBookComparisonSet, classifySharpBookOrigin } = require('./ssb-sharp-books');
const {
  buildUfcShortlist,
  resolveSharpPlayLeagues,
  resolveSharpPlayMarkets,
  resolveSharpPlayMarketsByLeague,
  resolveTargetBooks,
  summarizeSharpPlayRows,
  uniqueBooks
} = require('./ssb-sharp-plays');
const { mapWithConcurrency, withPairTimeout } = require('./ssb-shared-utils');
const {
  getLeagueRankingPreset,
  getLimit,
  getLookbackHours,
  getPreHistoryShortlistGameBudget
} = require('./ssb-mcp-ranked-screen');

// Aggregate quick_screen scans: quick_screen fans out one sharp_plays call
// per (league, market) pair, and the process-wide odds-history budget is
// ODDS_HISTORY_REQUEST_BUDGET calls per 5 minutes per account
// (lib/ssb-api.js, default 150, env-tunable). Without a
// shared allocation each pair's ranked query would claim up to 48 selection
// calls (24-game shortlist × 2 sides) plus a duplicate sharp-only
// cross-reference, so the first few pairs exhaust the budget and every later
// row degrades to movementDisposition=insufficient. In aggregate mode each
// pair claims a small explicit pre-history budget derived from the total pair
// count. Aggregate mode hydrates the strongest side per shortlisted game;
// direct and targeted paths still hydrate paired sides. Sixty percent of the
// budget is reserved for initial ranking, leaving room for validation and
// Tennis fallback recovery.
const AGGREGATE_HISTORY_CALL_ALLOCATION = Math.floor(ODDS_HISTORY_REQUEST_BUDGET * 0.6);

// Per-(league, market) fan-out timeout. One slow or never-resolving pair must
// not hang the whole mixed scan and erase every sibling league's rows. The
// screen pipeline has no AbortController seam, so withPairTimeout resolves the
// pair's slot with a structured PAIR_TIMEOUT error (caught below →
// response.ok=false) and the scan continues. Bounded by default so an N-pair
// mixed scan can't take N×unbounded wall-clock; env-tunable.
const PAIR_TIMEOUT_MS = Math.max(1, Math.floor(Number(process.env.PP_PAIR_TIMEOUT_MS) || 120000));

/**
 * Per-pair pre-history game budget for an aggregate quick_screen scan.
 * Aggregate mode hydrates one strongest current-market side per shortlisted
 * game. Floored at one game so every league/market pair with data keeps at
 * least one evaluated candidate even when the slate is huge.
 *
 * @param {number} pairCount - Total league×market pairs in the quick_screen fan-out.
 * @returns {number} Game budget for a single main ranked query.
 */
function getAggregateGameBudget(pairCount, allocationOverride) {
  const pairs = Math.max(1, Math.floor(Number(pairCount) || 1));
  // Caller-specific allocation: a composite card query (pp today) wants a
  // bounded per-pair budget instead of the full aggregate share. A wide
  // fan-out on the full share congests the serial odds-history gate, which
  // aborts pairs and both wastes wall clock and LOSES rows (measured: 35
  // pairs / 15 active at the 300-call default = 185s with 4 aborted scopes
  // and a 19-play slate; at a 90-call allocation = 34s with none and a
  // 32-play slate).
  const override = Number(allocationOverride);
  const allocation =
    Number.isFinite(override) && override > 0 ? Math.floor(override) : AGGREGATE_HISTORY_CALL_ALLOCATION;
  const games = Math.floor(allocation / pairs);
  return Math.max(1, games);
}

async function queryRankedSharpPlayResponses({
  rankScanTuples,
  args,
  quickScreenAggregate,
  aggregateGameBudget,
  targetPlusSharpBooks,
  queryLeagueScreen,
  queryTennisScreen
}) {
  // Wall-clock bound for the allocator share: the allocator divides the
  // process-wide budget by pair count, but the odds-history gate is serial
  // (~100ms spacing) and each pair has a fixed PAIR_TIMEOUT_MS deadline. A
  // -n 5 scan must not hydrate 133 games/pair when the limit-derived
  // shortlist only needs 10 — that floods the gate and every pair aborts.
  // Bound the effective per-pair budget by what the caller asked for; wide
  // scans keep the allocator share.
  const requestedLimit = Number(args.scanLimit) > 0 ? Number(args.scanLimit) : getLimit(args);
  const limitGameNeed = getPreHistoryShortlistGameBudget({ ...args, limit: requestedLimit });
  const pairGameBudget =
    quickScreenAggregate && Number.isFinite(Number(aggregateGameBudget))
      ? Math.max(1, Math.min(Number(aggregateGameBudget), limitGameNeed))
      : aggregateGameBudget;
  const rankedResponses = await mapWithConcurrency(
    rankScanTuples,
    async ({ executionBook, league, market }) => {
      const books = targetPlusSharpBooks(league, market, executionBook);
      const rankedArgs = {
        ...args,
        league,
        market,
        book: executionBook,
        targetBook: executionBook,
        books,
        historySportsbooks: books,
        includeAll: true,
        limit:
          Number.isFinite(Number(args.scanLimit)) && Number(args.scanLimit) > 0
            ? Number(args.scanLimit)
            : Math.max(20, getLimit(args) * 3),
        ...(quickScreenAggregate
          ? {
              // Explicit opt-in to the broad-scan pre-history shortlist: the
              // main ranked query is the ONLY history consumer in aggregate
              // mode (the sharp-only cross-reference below is skipped), so
              // its shortlist must not claim the default 24-game / ~48-call
              // allowance per pair. Standalone screen_ranked / direct
              // sharp_plays never get this flag — they keep full hydration.
              preHistoryShortlist: true,
              // Per-pair pre-history game budget: the allocator share bounded
              // by the caller's limit (pairGameBudget) so a small -n scan
              // cannot flood the serial odds-history gate and blow the pair
              // deadline (see queryRankedSharpPlayResponses).
              preHistoryGameBudget: Math.max(1, pairGameBudget - 1),
              // Reserve a bounded recovery pass for likely skipped candidates:
              // when the primary shortlist hydrates to ZERO supportive rows
              // (edge-score whiffed), re-hydrate a meaningful second slice
              // instead of a token single game. Scaled off the per-pair game
              // budget so wide slates get a real second chance without
              // blowing the shared odds-history window.
              preHistoryRecoveryGameBudget: Math.max(2, Math.floor(pairGameBudget / 4)),
              // Row cap: hydrate the strongest side per shortlisted game.
              // Paired-side hydration remains available in direct/targeted
              // paths, but cannot fit across 30+ aggregate pairs under the
              // shared budget.
              preHistoryRowBudget: pairGameBudget,
              preHistoryRecoveryRowBudget: Math.max(2, Math.floor(pairGameBudget / 4)),
              // Cap the EV-first discovery pass the same way: it runs before
              // the main ranked query and would otherwise re-flood the gate
              // (runEvFirst honors evFirstHistoryCap in aggregate mode).
              evFirstHistoryCap: Math.max(1, Math.floor(pairGameBudget / 4)),
              // The aggregate allocator budgets one history request per
              // shortlisted side. Adjacent-line retries can triple that spend,
              // so keep them for targeted/detail paths only.
              enableHistoryLineFallback: false
            }
          : {})
      };
      let response;
      try {
        // Bound the single (league, market) screen call so one slow or
        // never-resolving pair can't hang the whole mixed scan and erase
        // every sibling league's rows. The screen pipeline has no
        // AbortController seam, so on timeout withPairTimeout rejects; we
        // record it as a failed response and let the scan continue.
        const screenCall =
          String(getLeagueRankingPreset(league, market).league || league).toUpperCase() === 'TENNIS'
            ? withPairTimeout(queryTennisScreen, PAIR_TIMEOUT_MS, {
                label: `Tennis:${rankedArgs.market}`
              })
            : withPairTimeout(
                (args2) => queryLeagueScreen(args2, getLeagueRankingPreset(league, market).league || league),
                PAIR_TIMEOUT_MS,
                { label: `${league}:${rankedArgs.market}` }
              );
        response = await screenCall(rankedArgs);
      } catch (error) {
        response = { ok: false, error: error?.message || String(error) };
      }
      return { targetBook: executionBook, league, market, response };
    },
    { concurrency: 4 }
  );
  return rankedResponses;
}

async function collectSharpBookMovement({
  args,
  leagues,
  resolvedMarketsByLeague,
  targetBooks,
  quickScreenAggregate,
  queryLeagueScreen,
  queryTennisScreen
}) {
  let sharpBookQueryCount = 0;
  // history hydration and movement analysis actually work. Querying each
  // book individually (books: [sharpBook]) means no consensus data and
  // movementLabel always comes back as 'insufficient_history'.
  // Aggregate quick_screen mode SKIPS this query entirely: the main ranked
  // query already hydrates target + sharp books, so re-hydrating the same
  // slate with sharp-only books would duplicate odds-history calls — the
  // exact spend that exhausts the process-wide odds-history budget (default
  // 300 calls per 5 min, env PP_ODDS_HISTORY_BUDGET) on a wide
  // fan-out. Direct sharp_plays calls keep the two-query contract.
  const sharpBookComparisonSet = getSharpBookComparisonSet({
    league: leagues[0],
    market: (resolvedMarketsByLeague[leagues[0]] || [])[0],
    requestedBooks: Array.isArray(args.sharpBooks) && args.sharpBooks.length ? args.sharpBooks : undefined
  });
  const sharpBookMovementMap = new Map(); // key: "gameId|selection" → { book, movementLabel, clvProxyPct }
  // Filter out target books from the sharp set
  const crossRefSharpBooks = sharpBookComparisonSet.filter(
    (sb) => !targetBooks.some((tb) => tb.toLowerCase() === sb.toLowerCase())
  );
  if (quickScreenAggregate && crossRefSharpBooks.length > 0) {
    if (process.env.SSB_DEBUG) {
      process.stderr.write(
        `[sharp-plays] aggregate quick_screen: skipping sharp-only cross-reference (main ranked query already hydrates target + sharp books)\n`
      );
    }
  }
  if (crossRefSharpBooks.length > 0 && !quickScreenAggregate) {
    // Sharp-book cross-reference is independent per (league, market), so fan
    // it out the same way. Failures are absorbed (a single bad league should
    // not abort the whole scan).
    const crossRefTuples = [];
    for (const league of leagues) {
      for (const market of resolvedMarketsByLeague[league] || []) {
        crossRefTuples.push({ league, market });
      }
    }
    await mapWithConcurrency(
      crossRefTuples,
      async ({ league, market }) => {
        try {
          const sharpArgs = {
            ...args,
            league,
            market,
            books: crossRefSharpBooks,
            historySportsbooks: crossRefSharpBooks,
            includeAll: true,
            limit: 50,
            compact: true,
            fields: [
              'gameId',
              'game',
              'selection',
              'participant',
              'pick',
              'movementLabel',
              'movementSourceBook',
              'clvProxyPct'
            ]
          };
          const sharpResponse =
            String(getLeagueRankingPreset(league, '').league || league).toUpperCase() === 'TENNIS'
              ? await queryTennisScreen(/** @type {any} */ (sharpArgs))
              : await queryLeagueScreen(
                  /** @type {any} */ (sharpArgs),
                  getLeagueRankingPreset(league, '').league || league
                );
          sharpBookQueryCount++;
          for (const row of Array.isArray(sharpResponse?.result) ? sharpResponse.result : []) {
            const gameId = String(row.gameId || row.game || '').trim();
            const selection = String(row.selection || row.participant || row.pick || '').trim();
            if (!gameId || !selection) continue;
            const key = `${gameId}|${selection}`;
            if (row.movementLabel === 'supportive' && !sharpBookMovementMap.has(key)) {
              sharpBookMovementMap.set(key, {
                book: row.book || crossRefSharpBooks[0],
                origin: row.book ? classifySharpBookOrigin(row.book) : '',
                movementLabel: row.movementLabel,
                clvProxyPct: row.clvProxyPct ?? null
              });
            }
          }
        } catch (err) {
          // Sharp book query failed — continue without it
          if (process.env.SSB_DEBUG) {
            process.stderr.write(
              `[sharp-plays] query failed for ${league} ${market}: ${err?.message || String(err)}\n`
            );
          }
        }
      },
      { concurrency: 4 }
    );
  }

  return { sharpBookMovementMap, sharpBookQueryCount };
}

function computePerTargetBook(rankedRows, result, targetBooks) {
  return Object.fromEntries(
    targetBooks.map((book) => {
      const scanned = rankedRows.filter((row) => row.executionBook === book).length;
      const returned = result.filter((row) => (row.executionBook || row.targetBook || row.book) === book).length;
      return [book, { scanned, returned }];
    })
  );
}

function buildSharpPlayDiagnostics({ rankedResponses }) {
  const perPairDiagnostics = rankedResponses.map(({ league, market, response }) => {
    const resultMeta = response?.resultMeta || {};
    return {
      league,
      market,
      targetBook: resultMeta.focusBook || resultMeta.targetBook || null,
      targetBookCoverage: resultMeta.targetBookCoverage || null,
      focusBookMissingRowCount: Number(resultMeta.focusBookMissingRowCount || 0),
      coverageGapCount: Array.isArray(resultMeta.coverageGaps) ? resultMeta.coverageGaps.length : 0,
      scannedRowCount: Array.isArray(response?.result) ? response.result.length : 0,
      ...(resultMeta.classificationSummary
        ? { failureBreakdown: resultMeta.classificationSummary.passReasonCounts || {} }
        : {}),
      ...(resultMeta.emptyState ? { emptyReason: resultMeta.emptyState.reason } : {}),
      ...(response?.error ? { failureReason: response.error } : {})
    };
  });
  const preHistoryShortlist = rankedResponses
    .filter(({ response }) => response?.resultMeta?.preHistoryShortlist)
    .map(({ league, market, response }) => ({
      league,
      market,
      totalRows: response.resultMeta.preHistoryShortlist.totalRows,
      shortlistedRows: response.resultMeta.preHistoryShortlist.shortlistedRows,
      skippedRowCount: response.resultMeta.preHistoryShortlist.skippedRowCount,
      truncated: Boolean(response.resultMeta.preHistoryShortlist.truncated)
    }));
  const unresolvedCandidates = rankedResponses.flatMap(({ league, market, response }) =>
    (Array.isArray(response?.resultMeta?.unresolvedRows) ? response.resultMeta.unresolvedRows : []).map((row) => ({
      ...row,
      league,
      market,
      official: false,
      status: 'unresolved'
    }))
  );
  const unresolvedByPair = new Map();
  for (const row of unresolvedCandidates) {
    const key = `${row.league}::${row.market}`;
    unresolvedByPair.set(key, (unresolvedByPair.get(key) || 0) + 1);
  }
  const identityGap = preHistoryShortlist.some(
    (pair) => pair.skippedRowCount !== (unresolvedByPair.get(`${pair.league}::${pair.market}`) || 0)
  );
  const anyResponseFailed = rankedResponses.some(({ response }) => response?.ok === false);
  return { perPairDiagnostics, preHistoryShortlist, unresolvedCandidates, identityGap, anyResponseFailed };
}

function buildSharpPlayEmptyState(sharpPlaySummary, result) {
  if (result.length > 0) return null;
  return sharpPlaySummary.classificationSummary.totalRowsClassified === 0
    ? {
        reason: 'no_ranked_rows_scanned',
        scannedRowCount: sharpPlaySummary.classificationSummary.totalRowsClassified,
        failureBreakdown: sharpPlaySummary.classificationSummary.passReasonCounts,
        topNearMisses: sharpPlaySummary.topNearMisses
      }
    : {
        reason: 'rows_failed_post_filter',
        scannedRowCount: sharpPlaySummary.classificationSummary.totalRowsClassified,
        failureBreakdown: sharpPlaySummary.classificationSummary.passReasonCounts,
        topNearMisses: sharpPlaySummary.topNearMisses
      };
}

function buildUfcShortlistForRanked(rankedRows, args, targetBook) {
  const ufcRows = rankedRows.filter(
    (row) =>
      String(row.scanLeague || row.league || '')
        .trim()
        .toUpperCase() === 'UFC'
  );
  return ufcRows.length
    ? buildUfcShortlist(
        ufcRows,
        /** @type {any} */ ({
          ...args,
          targetBook,
          limit: getLimit(args)
        })
      )
    : null;
}

function buildSharpPlayResult({
  rankedRows,
  rankedResponses,
  sharpBookMovementMap,
  sharpBookQueryCount,
  args,
  targetBooks,
  targetBook,
  leagues,
  markets,
  resolvedMarketsByLeague,
  quickScreenAggregate,
  aggregatePairCount,
  aggregateGameBudget
}) {
  // Tag ranked rows with sharp book movement confirmation
  for (const row of rankedRows) {
    const gameId = String(row.gameId || row.game || '').trim();
    const selection = String(row.selection || row.participant || row.pick || '').trim();
    if (!gameId || !selection) continue;
    const key = `${gameId}|${selection}`;
    const sharpMovement = sharpBookMovementMap.get(key);
    if (sharpMovement) {
      row.sharpBookMovementConfirmed = true;
      row.sharpBookMovementSource = sharpMovement.book;
      row.sharpBookMovementOrigin = sharpMovement.origin || classifySharpBookOrigin(sharpMovement.book);
      row.sharpBookClv = sharpMovement.clvProxyPct;
    }
  }
  const strict = args.strict !== undefined ? Boolean(args.strict) : true;
  const sharpPlaySummary = summarizeSharpPlayRows(
    rankedRows,
    /** @type {any} */ ({
      ...args,
      targetBook,
      strict,
      limit: getLimit(args),
      requirePlayablePrice: args.requirePlayablePrice !== undefined ? args.requirePlayablePrice : false,
      requireBestPrice: args.requireBestPrice !== undefined ? args.requireBestPrice : false
    })
  );
  const result = sharpPlaySummary.filteredRows;
  const ufcShortlist = buildUfcShortlistForRanked(rankedRows, args, targetBook);
  const perTargetBook = computePerTargetBook(rankedRows, result, targetBooks);
  const { perPairDiagnostics, preHistoryShortlist, unresolvedCandidates, identityGap, anyResponseFailed } =
    buildSharpPlayDiagnostics({ rankedResponses });
  const emptyState = buildSharpPlayEmptyState(sharpPlaySummary, result);

  return {
    ok: true,
    count: result.length,
    result,
    resultMeta: {
      source: 'sharp_plays_addon',
      targetBook,
      targetBooks,
      targetBookCount: targetBooks.length,
      leagues,
      markets,
      marketsByLeague: resolvedMarketsByLeague,
      strict,
      includePasses: Boolean(args.includePasses),
      minConsensusBookCount: Number.isFinite(Number(args.minConsensusBookCount))
        ? Number(args.minConsensusBookCount)
        : 2,
      minOdds: args.minOdds ?? null,
      maxOdds: args.maxOdds ?? null,
      lookbackHoursUsed: getLookbackHours(args),
      scannedRowCount: rankedRows.length,
      scannedQueryCount: rankedResponses.length + sharpBookQueryCount,
      perTargetBook,
      classificationSummary: sharpPlaySummary.classificationSummary,
      emptyState,
      ufcShortlist,
      ...(unresolvedCandidates.length ? { unresolvedCandidates } : {}),
      ...(quickScreenAggregate
        ? {
            preHistoryShortlist,
            perPairDiagnostics,
            scanHealth: {
              truncated: anyResponseFailed || identityGap,
              incomplete: anyResponseFailed || identityGap,
              totalRows: preHistoryShortlist.reduce((sum, pair) => sum + (Number(pair.totalRows) || 0), 0),
              shortlistedRows: preHistoryShortlist.reduce((sum, pair) => sum + (Number(pair.shortlistedRows) || 0), 0),
              skippedRowCount: preHistoryShortlist.reduce((sum, pair) => sum + (Number(pair.skippedRowCount) || 0), 0),
              identityGap
            }
          }
        : {}),
      ...(quickScreenAggregate
        ? {
            historyBudget: {
              mode: 'aggregate',
              pairCount: aggregatePairCount,
              perPairGameBudget: aggregateGameBudget,
              maxSelectionCalls: aggregatePairCount * aggregateGameBudget
            }
          }
        : {}),
      workflow:
        'Target book is execution only. Supportive movement must come from a non-target sharp book; target-book-only movement is downgraded. For props, market availability and playable price are used instead of raw consensus count.'
    }
  };
}

/**
 * Orchestrate a multi-league/multi-market sharp-play scan across one or more target books.
 *
 * For each (targetBook, league, market) combination the function queries either
 * `queryLeagueScreen` or `queryTennisScreen` (depending on the league's ranking preset).
 * It then cross-references the returned rows against a set of sharp comparison books to
 * tag rows that show supportive sharp-book movement. Finally it summarises & shortlists
 * the results via `summarizeSharpPlayRows` and optionally builds a UFC shortlist.
 *
 * @param {Object}  [args={}] - Configuration object.
 * @param {string|string[]} [args.book] - Single target execution book (alias for `targetBook`).
 * @param {string}  [args.targetBook] - Alias for `book`.
 * @param {string[]} [args.targetBooks] - Execution books to scan together.
 * @param {string[]} [args.sharpBooks] - Override the default sharp-book comparison set.
 * @param {string|string[]} [args.league] - Single league shortcut.
 * @param {string[]} [args.leagues] - Leagues to scan (default: NBA, MLB, NHL, Tennis, WNBA).
 * @param {string}   [args.market] - Single market shortcut.
 * @param {string[]} [args.markets] - Markets to scan (default: ["Moneyline"]).
 * @param {number}   [args.limit] - Max final sharp plays to return.
 * @param {number}   [args.scanLimit] - Per-league/market ranked rows to scan before final filtering.
 * @param {boolean}  [args.strict=true] - When true, returns only Bet candidates.
 * @param {boolean}  [args.includePasses] - Include failed rows with passReasons for debugging.
 * @param {boolean}  [args.requirePlayablePrice] - When true, rows without a playable price are excluded.
 * @param {boolean}  [args.requireBestPrice] - When true, only rows where the target book has the best price are kept.
 * @param {number}   [args.minConsensusBookCount] - Minimum number of books with data for prop classification.
 * @param {number}   [args.minOdds] - Minimum target-book American odds.
 * @param {number}   [args.maxOdds] - Maximum target-book American odds.
 * @param {number}   [args.lookbackHours] - Odds-history lookback window in hours.
 * @param {boolean}  [args.debug] - Include verbose movement debug payloads.
 * @param {boolean}  [args.quickScreenAggregate] - Aggregate quick_screen mode: one sharp_plays call per (league, market) pair sharing a pre-history budget.
 * @param {number}   [args.aggregatePairCount] - Total league×market pair count, used for per-pair pre-history budget allocation in aggregate mode when activeAggregatePairCount is absent.
 * @param {number}   [args.aggregateHistoryAllocation] - Override the aggregate odds-history call allocation (default: 60% of the process-wide budget). Lower it for card-style composite queries whose wide fan-out would otherwise congest the serial odds-history gate and abort pairs.
 * @param {number}   [args.activeAggregatePairCount] - Active (nonempty) league×market pair count in aggregate mode, used for per-pair pre-history budget allocation. Preferred over aggregatePairCount so a mixed scan that includes empty pairs does not starve live pairs of hydration budget.
 * @param {Object}   [deps={}] - Dependency injection object.
 * @param {Function} deps.queryLeagueScreen - Async function called with `(args, league)` to screen a league.
 * @param {Function} deps.queryTennisScreen - Async function called with `(args)` to screen tennis.
 *
 * @returns {Promise<{ ok: boolean, count: number, result: Array<Object>, resultMeta: { source: string, targetBook: string, targetBooks: Array<string>, targetBookCount: number, leagues: Array<string>, markets: Array<string>, strict: boolean, includePasses: boolean, minConsensusBookCount: number, minOdds: number|null, maxOdds: number|null, lookbackHoursUsed: number, scannedRowCount: number, scannedQueryCount: number, perTargetBook: Object, classificationSummary: Object, emptyState: Object|null, ufcShortlist: Object|null, workflow: string } }>} Result object.
 */
async function runSharpPlays(
  args = {},
  deps = /** @type {{ queryLeagueScreen: Function, queryTennisScreen: Function }} */ ({})
) {
  const { queryLeagueScreen, queryTennisScreen } = deps;
  if (typeof queryLeagueScreen !== 'function') {
    throw new TypeError('runSharpPlays requires queryLeagueScreen(args, league)');
  }
  if (typeof queryTennisScreen !== 'function') {
    throw new TypeError('runSharpPlays requires queryTennisScreen(args)');
  }

  const targetBooks = resolveTargetBooks(/** @type {any} */ (args));
  const targetBook = targetBooks[0];
  const leagues = resolveSharpPlayLeagues(/** @type {any} */ (args));
  // Per-league market resolution: explicit markets apply to every league,
  // otherwise each league fans out its own registry defaults (Tennis →
  // Moneyline/Total Games/Set Handicap, MLB → Moneyline/Run Line/Total Runs,
  // UFC → Moneyline/Total Rounds, ...). `markets` keeps the caller-facing
  // single list (explicit markets as given, or the deduplicated union of the
  // per-league defaults) for resultMeta and aggregate budget diagnostics.
  const resolvedMarketsByLeague = resolveSharpPlayMarketsByLeague(/** @type {any} */ (args), leagues);
  const explicitMarketsGiven = args.markets !== undefined || args.market !== undefined;
  const markets = explicitMarketsGiven
    ? resolveSharpPlayMarkets(/** @type {any} */ (args))
    : uniqueBooks(Object.values(resolvedMarketsByLeague).flat());
  const targetPlusSharpBooks = (league, market, executionBook) =>
    uniqueBooks([
      executionBook,
      ...getSharpBookComparisonSet({
        league,
        market,
        requestedBooks: Array.isArray(args.sharpBooks) && args.sharpBooks.length ? args.sharpBooks : undefined
      })
    ]);

  // Build the cartesian product (targetBook × league × market) up front so
  // we can fan it out with mapWithConcurrency instead of awaiting each
  // (targetBook, league, market) tuple serially. With the v2.1.9 default of
  // 1 book × 10 leagues × 1 market = 10 sequential HTTP calls; with this
  // change the wall-clock latency is roughly max(per-call) rather than
  // sum(per-call). Concurrency-4 keeps the backend from being hammered.
  const rankScanTuples = [];
  for (const executionBook of targetBooks) {
    for (const league of leagues) {
      for (const market of resolvedMarketsByLeague[league] || []) {
        rankScanTuples.push({ executionBook, league, market });
      }
    }
  }
  // Aggregate quick_screen mode: quick_screen fans out one call per
  // (league, market) pair and passes the pair count so every pair can
  // claim a fair, small slice of the process-wide odds-history budget
  // (default 300 calls per 5 min, env PP_ODDS_HISTORY_BUDGET)
  // instead of first-come starvation under concurrency. The count
  // must be the ACTIVE pair count (pairs with current rows) — quick_screen
  // probes each pair with a no-history screen first and passes that via
  // activeAggregatePairCount. Dividing the 60% initial allocation (180 calls
  // at the default 300 budget) by the raw league×market fan-out count
  // starves live pairs down to ~1
  // hydrated game each on broad mixed scans (e.g. 20 pairs, only MLB and
  // WNBA with a slate) and valid candidates disappear.
  const quickScreenAggregate = args.quickScreenAggregate === true;
  const aggregatePairCount = quickScreenAggregate
    ? Math.max(
        1,
        Math.floor(Number(args.activeAggregatePairCount) || Number(args.aggregatePairCount) || rankScanTuples.length)
      )
    : rankScanTuples.length;
  const aggregateGameBudget = quickScreenAggregate
    ? getAggregateGameBudget(aggregatePairCount, args.aggregateHistoryAllocation)
    : null;
  const rankedResponses = await queryRankedSharpPlayResponses({
    rankScanTuples,
    args,
    quickScreenAggregate,
    aggregateGameBudget,
    targetPlusSharpBooks,
    queryLeagueScreen,
    queryTennisScreen
  });

  const rankedRows = rankedResponses.flatMap(({ targetBook: executionBook, league, market, response }) =>
    (Array.isArray(response?.result) ? response.result : []).map((row) => ({
      ...row,
      targetBook: executionBook,
      executionBook,
      scanTargetBook: executionBook,
      scanLeague: league,
      scanMarket: market
    }))
  );

  const { sharpBookMovementMap, sharpBookQueryCount } = await collectSharpBookMovement({
    args,
    leagues,
    resolvedMarketsByLeague,
    targetBooks,
    quickScreenAggregate,
    queryLeagueScreen,
    queryTennisScreen
  });

  return buildSharpPlayResult({
    rankedRows,
    rankedResponses,
    sharpBookMovementMap,
    sharpBookQueryCount,
    args,
    targetBooks,
    targetBook,
    leagues,
    markets,
    resolvedMarketsByLeague,
    quickScreenAggregate,
    aggregatePairCount,
    aggregateGameBudget
  });
}

module.exports = {
  runSharpPlays,
  getAggregateGameBudget
};
