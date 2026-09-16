'use strict';

/**
 * quick_screen handler — extracted from createMcpHandlers() in handlers.js.
 *
 * This is a behavioral extraction with NO behavior change. The original inline
 * handlers.quick_screen body is preserved verbatim but reorganized into a thin
 * orchestrator (runQuickScreen) that delegates each phase to an explicit,
 * dependency-injected helper below. Every helper receives its inputs and returns
 * its outputs — no closure state is captured beyond the passed `deps`.
 *
 * quick_screen fans out through handlers.sharp_plays and the screen impls via
 * ctx.handlers (already wired by createMcpHandlers before this module is
 * merged in), exactly as the inline version did.
 *
 * @param {import('../../../lib/ssb-api').SSBClient} client
 * @param {import('./handler-context').HandlerContext} ctx
 * @param {object} deps
 * @param {object} deps.responseCache - LruCache instance (aggregate response cache)
 * @param {number} deps.responseCacheTtlMs
 * @param {Function} deps.gameContextFn
 * @param {Function} deps.maybeGc
 */

const { ok } = require('../../../lib/response-envelope');
const { clearTierCache } = require('../../../lib/ssb-risk-score');
const { getMarketsForSport } = require('../../../lib/ssb-market-registry');
const { getPropMarketsForSport } = require('../../../lib/ssb-market-registry');
const { getLocalTimezone, localDateKey } = require('../../../lib/mcp-runtime-config');
const { getLeagueRankingPreset } = require('../../../lib/ssb-mcp-ranked-screen');
const { mapCandidateRow } = require('../../../lib/ssb-mcp-candidate-mapper');
const { parseGameStartMs } = require('../../../lib/ssb-shared-utils');
const { recoverStandardTotals } = require('./totals-recovery');
const { resolveMarkets, stripVerdictFields } = require('./handler-utils');
const { planAggregateScreen } = require('./aggregate-screen');
const { logLargeQuickScreenResponse } = require('./log-large-response');
const { stripLiteResponse } = require('./strip-lite-response');
const validationPipeline = require('../../../lib/ssb-validation-pipeline');
const {
  applyValidatedFields,
  applyFinalVerdict,
  flagContradictoryPlays,
  promoteFinalVerdictToDisplay
} = require('../../../lib/bet-verdict');
const { runResearchOnTopRows } = require('../../../lib/ssb-research-runner');
const { buildFinalResearchBatch } = require('../../../lib/ssb-quick-screen-research');
const { categorizeError } = require('../../../lib/ssb-mcp-stdio');
const {
  formatQuickScreenMinimal,
  formatQuickScreenStandard,
  formatQuickScreenBets
} = require('../../../lib/ssb-formatter');
const { filterRowsByKaiCall, filterRowsByMinEV, filterRowsByMovement } = require('../../../lib/ssb-row-filter');
const { sortRows } = require('../../../lib/ssb-sort-utils');
const { getPickStats, getBacktestSummary } = require('../../../lib/ssb-picks');
const { mapWithConcurrency } = require('../../../lib/ssb-shared-utils');

// Local mirror of the original inline getDefaultMarketsForLeague wrapper in
// handlers.js — resolves default markets for a league via the registry.
function getDefaultMarketsForLeague(league, _targetBooks) {
  return getMarketsForSport(league, _targetBooks);
}

function isStandardTotalsMarket(market) {
  return new Set(['Total Runs', 'Total Points', 'Total Goals', 'Total Games', 'Total Rounds']).has(
    String(market || '').trim()
  );
}

// ─── Phase: env-gated scan timing ─────────────────────────────────────────────
// PP_SCAN_TIMING=1 emits one stderr line per phase with elapsed ms. Read at call
// time (not module load) so tests can toggle it. Zero effect when unset.
function scanTimingEnabled() {
  return process.env.PP_SCAN_TIMING === '1';
}

/**
 * Emit an elapsed-time line for one scan phase and return the current
 * timestamp for chaining into the next phase.
 * @param {string} label - Phase label, e.g. 'fanout.probe'.
 * @param {number} startedAt - Date.now() from the previous phase boundary.
 * @returns {number} Date.now() after emitting.
 */
function scanTiming(label, startedAt) {
  const now = Date.now();
  if (scanTimingEnabled()) {
    process.stderr.write(`[scan-timing] ${label}=${now - startedAt}ms\n`);
  }
  return now;
}

// ─── Phase: resolve markets per league (incl. includeProps augmentation) ───────

function resolveQuickScreenMarkets(leagues, markets, targetBooks, includeProps) {
  const resolvedMarketsByLeague = {};
  const allAliasesUsed = [];
  for (const league of leagues) {
    const marketsForResolution = markets === null ? getDefaultMarketsForLeague(league, targetBooks) : markets;
    let marketArray = marketsForResolution;
    if (includeProps === true) {
      const propMarkets = getPropMarketsForSport(league);
      if (propMarkets.length) {
        marketArray = [...new Set([...marketArray, ...propMarkets])];
      }
    }
    const marketResolution = resolveMarkets({ markets: marketArray }, league);
    resolvedMarketsByLeague[league] = marketResolution.array.length
      ? marketResolution.array
      : [marketResolution.single];
    allAliasesUsed.push(...marketResolution.aliasesUsed);
  }
  return { resolvedMarketsByLeague, allAliasesUsed };
}

// ─── Phase: active-pair probe + hydrated fan-out ──────────────────────────────

async function runQuickScreenFanout(
  ctx,
  { targetBooks, leagues, resolvedMarketsByLeague, scanLimit, lookbackHours, debug, maxPerMarket, limit, args }
) {
  const allCandidates = [];
  const unresolvedCandidates = [];
  const emptySlate = []; // league+market pairs that returned zero candidates
  const cardWindow = args.cardWindow || 'all';

  const leagueMarketPairs = [];
  for (const league of leagues) {
    for (const market of resolvedMarketsByLeague[league] || []) {
      leagueMarketPairs.push({ league, market });
    }
  }

  const fanoutStart = Date.now();
  const activeLeagueMarketPairs = await probeActivePairs(ctx, leagueMarketPairs, {
    targetBooks,
    scanLimit,
    lookbackHours,
    emptySlate,
    cardWindow
  });
  const probeDone = scanTiming(
    `fanout.probe pairs=${leagueMarketPairs.length} active=${activeLeagueMarketPairs.length}`,
    fanoutStart
  );
  const activeAggregatePairCount = Math.max(1, activeLeagueMarketPairs.length);

  await mapWithConcurrency(
    activeLeagueMarketPairs,
    async ({ league, market }) => {
      await runOneHydratedPair(ctx, {
        league,
        market,
        targetBooks,
        scanLimit,
        lookbackHours,
        debug,
        maxPerMarket,
        limit,
        args,
        leagueMarketPairs,
        activeAggregatePairCount,
        allCandidates,
        unresolvedCandidates,
        emptySlate,
        cardWindow
      });
    },
    { concurrency: 8 }
  );
  scanTiming(`fanout.hydrate pairs=${activeLeagueMarketPairs.length}`, probeDone);

  return { allCandidates, unresolvedCandidates, emptySlate };
}

// Active-pair probe (bounded, no-history): find which league×market pairs
// actually have current rows so the hydrated fan-out only consumes odds-history
// budget on live pairs.
async function probeActivePairs(
  ctx,
  leagueMarketPairs,
  { targetBooks, scanLimit, lookbackHours, emptySlate, cardWindow }
) {
  const activeLeagueMarketPairs = [];
  await mapWithConcurrency(
    leagueMarketPairs,
    async ({ league, market }) => {
      try {
        const probeArgs = {
          books: targetBooks,
          league,
          market,
          scanLimit,
          lookbackHours,
          is_live: false,
          cardWindow,
          skipHistory: true,
          compact: true,
          includeResearch: false,
          strict: false,
          includePasses: true
        };
        const probe =
          String(getLeagueRankingPreset(league).league || league).toUpperCase() === 'TENNIS'
            ? await ctx.handlers.runTennisScreen(probeArgs)
            : await ctx.handlers.runLeagueScreen(probeArgs, league);
        if (Array.isArray(probe?.result) && probe.result.length > 0) {
          activeLeagueMarketPairs.push({ league, market });
        } else {
          emptySlate.push({
            league,
            market,
            reason: probe?.resultMeta?.emptyState?.reason || 'no_ranked_rows_scanned',
            scannedRowCount: probe?.resultMeta?.emptyState?.scannedRowCount || 0,
            ...(probe?.resultMeta?.emptyState?.failureBreakdown
              ? { failureBreakdown: probe.resultMeta.emptyState.failureBreakdown }
              : {})
          });
        }
      } catch {
        // Probe failure: activity is unknown — fail OPEN and let the hydrated
        // fan-out report the error. Only a definitively EMPTY probe marks a
        // pair inactive.
        activeLeagueMarketPairs.push({ league, market });
      }
    },
    { concurrency: 8 }
  );
  return activeLeagueMarketPairs;
}

async function runOneHydratedPair(
  ctx,
  {
    league,
    market,
    targetBooks,
    scanLimit,
    lookbackHours,
    debug,
    maxPerMarket,
    limit,
    args,
    leagueMarketPairs,
    activeAggregatePairCount,
    allCandidates,
    unresolvedCandidates,
    emptySlate,
    cardWindow
  }
) {
  try {
    const spResult = await ctx.handlers.sharp_plays({
      targetBooks,
      league,
      market,
      limit: scanLimit,
      scanLimit,
      lookbackHours,
      recentWindowHours: args.recentWindowHours,
      is_live: false,
      strict: false,
      includePasses: true,
      includeResearch: false,
      cardWindow,
      debug,
      quickScreenAggregate: true,
      activeAggregatePairCount,
      aggregatePairCount: leagueMarketPairs.length,
      aggregateHistoryAllocation: args.aggregateHistoryAllocation
    });

    let candidates = Array.isArray(spResult?.result) ? spResult.result : [];
    if (process.env.SSB_DEBUG === 'true' && candidates.length) {
      // Does the sharp-play row carry the ranker's tier at all? Everything
      // downstream (validate echo -> final tier) keys off this field, and a
      // missing field silently becomes the mapper's TIER 4 default.
      const s = candidates[0];
      process.stderr.write(
        `[quick-screen] spRow tier=${s.confidenceTier} tierLive=${s.confidenceTierLive} kai=${s.kaiCall} ` +
          `score=${s.screenScore} hasTier=${'confidenceTier' in s} keys=${Object.keys(s).length}\n`
      );
    }
    if (Array.isArray(spResult?.resultMeta?.unresolvedCandidates)) {
      unresolvedCandidates.push(
        ...spResult.resultMeta.unresolvedCandidates.map((candidate) => ({
          ...mapCandidateRow(candidate),
          official: false,
          status: 'unresolved',
          incomplete: true,
          lineHistoryAvailable: false,
          movementDisposition: 'unavailable',
          validationFailureReason: candidate.validationFailureReason
        }))
      );
    }
    let totalsRecoveryApplied = false;
    const totalsScanTruncated = Boolean(
      spResult.resultMeta?.scanHealth?.truncated ||
      (Array.isArray(spResult.resultMeta?.preHistoryShortlist) &&
        spResult.resultMeta.preHistoryShortlist.some((entry) => entry.truncated))
    );
    if (
      !candidates.length &&
      isStandardTotalsMarket(market) &&
      totalsScanTruncated &&
      typeof ctx.handlers.runLeagueScreen === 'function'
    ) {
      try {
        const recoveredRows = await recoverStandardTotals({
          runLeagueScreen: ctx.handlers.runLeagueScreen,
          league,
          market,
          targetBooks,
          scanLimit,
          lookbackHours
        });
        if (recoveredRows?.length) {
          candidates = recoveredRows;
          totalsRecoveryApplied = true;
        }
      } catch {
        // Keep the original empty-market diagnostics on recovery failure.
      }
    }
    if (!candidates.length) {
      emptySlate.push({
        league,
        market,
        reason: spResult.resultMeta?.emptyState?.reason || 'no_ranked_rows_scanned',
        scannedRowCount: spResult.resultMeta?.emptyState?.scannedRowCount || 0,
        ...(spResult.resultMeta?.emptyState?.failureBreakdown
          ? { failureBreakdown: spResult.resultMeta.emptyState.failureBreakdown }
          : {})
      });
      if (spResult.resultMeta?.scanHealth || spResult.resultMeta?.preHistoryShortlist) {
        allCandidates.push({
          league,
          market,
          candidates: [],
          ...(spResult.resultMeta.scanHealth ? { scanHealth: spResult.resultMeta.scanHealth } : {}),
          ...(spResult.resultMeta.preHistoryShortlist
            ? { preHistoryShortlist: spResult.resultMeta.preHistoryShortlist }
            : {}),
          ...(spResult.resultMeta.perPairDiagnostics
            ? { perPairDiagnostics: spResult.resultMeta.perPairDiagnostics }
            : {})
        });
      }
      return;
    }

    const perMarketCap = maxPerMarket || limit;
    allCandidates.push({
      league,
      market,
      candidates: candidates.slice(0, perMarketCap).map(mapCandidateRow),
      ...(spResult.resultMeta?.scanHealth ? { scanHealth: spResult.resultMeta.scanHealth } : {}),
      ...(spResult.resultMeta?.preHistoryShortlist
        ? { preHistoryShortlist: spResult.resultMeta.preHistoryShortlist }
        : {}),
      ...(spResult.resultMeta?.perPairDiagnostics
        ? { perPairDiagnostics: spResult.resultMeta.perPairDiagnostics }
        : {}),
      ...(totalsRecoveryApplied ? { totalsRecoveryApplied: true } : {})
    });
  } catch (error) {
    const categorized = categorizeError(error);
    allCandidates.push({
      league,
      market,
      candidates: [],
      error: categorized.message,
      code: categorized.code,
      recovery: categorized.recovery
    });
  }
}

// ─── Phase: card-window filter + multi-day merge ─────────────────────────────

function applyQuickScreenCardWindow(allCandidates, emptySlate, cardWindow) {
  if (cardWindow !== 'today' && cardWindow !== 'next') {
    return { cardWindowFallthrough: null, nextDayMerged: null };
  }
  const tz = getLocalTimezone();
  let targetDateKey =
    cardWindow === 'today' ? localDateKey(Date.now(), tz) : localDateKey(Date.now() + 24 * 60 * 60 * 1000, tz);

  const filterBy = (key) => {
    const nowMs = Date.now();
    for (const entry of allCandidates) {
      if (!entry.candidates || !entry.candidates.length) continue;
      const pregameOnly =
        String(entry.league || '')
          .trim()
          .toUpperCase() !== 'TENNIS';
      entry.candidates = entry.candidates.filter((row) => {
        const startMs = parseGameStartMs(row.start);
        if (!startMs) return true;
        if (localDateKey(startMs, tz) !== key) return false;
        if (pregameOnly && (row.isLive === true || startMs < nowMs)) return false;
        return true;
      });
    }
  };

  const fullCandidatesSnapshot = allCandidates.map((entry) => ({
    ...entry,
    candidates: [...(entry.candidates || [])]
  }));

  filterBy(targetDateKey);

  if (cardWindow !== 'today') {
    return { cardWindowFallthrough: null, nextDayMerged: null };
  }

  const totalLive = allCandidates.reduce((sum, e) => sum + (e.candidates?.length || 0), 0);
  const nextKey = localDateKey(Date.now() + 24 * 60 * 60 * 1000, tz);
  const nextCandidates = [];
  for (const entry of fullCandidatesSnapshot) {
    if (!entry.candidates || !entry.candidates.length) continue;
    if (String(entry.league || '').toLowerCase() === 'tennis') continue;
    const nextRows = entry.candidates.filter((row) => {
      const startMs = parseGameStartMs(row.start);
      if (!startMs) return true;
      return localDateKey(startMs, tz) === nextKey;
    });
    if (nextRows.length > 0) {
      nextCandidates.push({ league: entry.league, market: entry.market, candidates: nextRows });
    }
  }

  let cardWindowFallthrough = null;
  let nextDayMerged = null;
  if (totalLive <= 1 && allCandidates.length > 0) {
    for (let i = 0; i < allCandidates.length; i++) {
      allCandidates[i].candidates = [...fullCandidatesSnapshot[i].candidates];
    }
    targetDateKey = nextKey;
    filterBy(targetDateKey);
    cardWindowFallthrough = targetDateKey;
  } else if (nextCandidates.length > 0) {
    for (const nc of nextCandidates) {
      const existing = allCandidates.find((e) => e.league === nc.league && e.market === nc.market);
      if (existing) {
        const todayKeys = new Set(existing.candidates.map((c) => `${c.gameId || ''}:${c.selection || ''}`));
        const newRows = nc.candidates.filter((c) => !todayKeys.has(`${c.gameId || ''}:${c.selection || ''}`));
        existing.candidates.push(...newRows);
      } else {
        allCandidates.push(nc);
      }
    }
    nextDayMerged = nextKey;
  }
  return { cardWindowFallthrough, nextDayMerged };
}

// ─── Phase: validation pipeline + final verdict + contradictory downgrade ──────

// Build the validate_play args for one quick_screen candidate (mirrors the
// original inline buildArgs closure verbatim).
function getValidationFailureReason(candidate) {
  if (candidate.validationFailureReason) return candidate.validationFailureReason;
  if (candidate.validatedUnverified) return 'validated line disappeared or is no longer priced';
  if (candidate.validatedConsensusDrift) {
    return `validated consensus drift${candidate.validatedDriftReason ? `: ${candidate.validatedDriftReason}` : ''}`;
  }
  const disposition = String(candidate.validatedMovementDisposition || '')
    .trim()
    .toLowerCase();
  if (disposition === 'adverse_full' || disposition === 'adverse') return 'validated movement became adverse';
  if (disposition === 'insufficient') return 'validated movement was insufficient';
  if (candidate.validatedExecQuality === 'bad') {
    return 'validated execution quality was bad';
  }
  if (candidate.validatedVerdict && candidate.validatedVerdict !== 'BET') {
    return `validator verdict: ${candidate.validatedVerdict}`;
  }
  if (candidate.finalVerdict && candidate.finalVerdict !== 'BET') {
    return `final verdict: ${candidate.finalVerdict}`;
  }
  return 'final verdict was downgraded';
}

function buildQuickScreenValidationArgs(candidate, entry, args) {
  const executionBook = candidate.book || args.book || (Array.isArray(args.books) ? args.books[0] : undefined);
  const comparisonBooks = Array.isArray(candidate.historySportsbooksRequested)
    ? candidate.historySportsbooksRequested
    : Array.isArray(args.books)
      ? args.books
      : [];
  const validationBooks = executionBook
    ? [executionBook, ...comparisonBooks.filter((book) => book !== executionBook)]
    : comparisonBooks;
  if (process.env.SSB_DEBUG === 'true') {
    // Tier provenance matters more than it looks: validate echoes screenTier
    // back as the authoritative tier for scan-sourced rows, so a missing or
    // defaulted candidate tier silently rewrites the play's tier downstream.
    process.stderr.write(
      `[quick-screen] validateArgs ${candidate.gameId}::${candidate.selection}::${entry.market} ` +
        `screenTier=${candidate.confidenceTier} screenKai=${candidate.kaiCall} score=${candidate.screenScore}\n`
    );
  }
  return {
    league: entry.league,
    gameId: candidate.gameId,
    selection: candidate.selection,
    books: validationBooks.length ? validationBooks : undefined,
    exactSelectionOnly: true,
    playId: candidate.playId,
    market: entry.market,
    skipResearch: true,
    lookbackHours:
      Number.isFinite(Number(candidate.lineHistoryLookbackHours)) && Number(candidate.lineHistoryLookbackHours) > 0
        ? Number(candidate.lineHistoryLookbackHours)
        : Number.isFinite(Number(args.lookbackHours))
          ? Number(args.lookbackHours)
          : 6,
    recentWindowHours:
      Number.isFinite(Number(candidate.recentWindowHours)) && Number(candidate.recentWindowHours) > 0
        ? Number(candidate.recentWindowHours)
        : Number.isFinite(Number(args.recentWindowHours)) && Number(args.recentWindowHours) > 0
          ? Number(args.recentWindowHours)
          : undefined,
    screenMovementSourceBook: candidate.movementSourceBook || undefined,
    screenMovementMode: candidate.movementMode || undefined,
    screenMovementDisposition: candidate.movementDisposition || undefined,
    // Echo the LIVE tier, not the hysteresis-stable one. In a one-shot scan
    // process the aggregate ranks the same play more than once (active-pair
    // probe, EV-first discovery, then the hydrated pass), and
    // getConfidenceTierStable's evolving tier is the MODE of those in-process
    // observations. Two thin observations outvote the hydrated one, so
    // `confidenceTier` came back TIER 4 while `confidenceTierLive` was TIER 1
    // for the same row. validate echoes screenTier back as the authoritative
    // tier, so the stable tier leaked a TIER 4 into a BET row, and
    // applyFinalVerdict's contradictory-tier clamp (BET + TIER 4 -> TIER 2)
    // then shipped every real TIER 1 play as TIER 2. `rank` never multi-ranks,
    // which is why it reported TIER 1 all along.
    screenTier: candidate.confidenceTierLive || candidate.confidenceTier,
    screenKaiCall: candidate.kaiCall,
    screenOdds: candidate.odds ?? candidate.currentOdds ?? undefined,
    screenConsensusBookCount: candidate.consensusBookCount,
    screenExecutionQuality: candidate.executionQuality,
    screenConsensusEdge: candidate.edge,
    enableHistoryLineFallback: false,
    screenSharpBookConfirmed: candidate.sharpBookMovementConfirmed || false
  };
}

function collectDowngradedWatchCandidates(allCandidates, watchCandidates) {
  const watchKeys = new Set(
    watchCandidates.map(
      (candidate) => `${candidate.gameId || ''}::${candidate.selection || ''}::${candidate.market || ''}`
    )
  );
  for (const entry of allCandidates) {
    for (const candidate of entry.candidates || []) {
      if (
        candidate._screenWasBet !== true ||
        candidate.validationSkipped === true ||
        candidate.validationBudgetExhausted === true ||
        candidate.validationWatchRecorded === true ||
        candidate.finalVerdict === 'BET'
      ) {
        continue;
      }
      const key = `${candidate.gameId || ''}::${candidate.selection || ''}::${entry.market || ''}`;
      if (watchKeys.has(key)) continue;
      candidate.validationFailureReason = getValidationFailureReason(candidate);
      candidate.official = false;
      watchCandidates.push({
        ...candidate,
        market: entry.market,
        originalVerdict: candidate._screenVerdict,
        official: false
      });
      watchKeys.add(key);
    }
  }
  for (const entry of allCandidates) {
    for (const candidate of entry.candidates || []) {
      delete candidate._screenWasBet;
      delete candidate._screenVerdict;
    }
  }
  for (const candidate of watchCandidates) {
    delete candidate._screenWasBet;
    delete candidate._screenVerdict;
  }
  return watchCandidates;
}

async function runQuickScreenValidation(
  client,
  ctx,
  allCandidates,
  { args, validateAll, requestedValidateTop, leagues }
) {
  const watchCandidates = [];
  let validationEligibleCount = 0;
  let validationSelectedCount = 0;
  let validationPartial = false;
  let validationBudgetExhausted = false;

  for (const entry of allCandidates) {
    for (const candidate of entry.candidates || []) {
      candidate._screenWasBet = candidate.kaiCall === 'BET';
      candidate._screenVerdict = candidate.kaiCall;
    }
  }

  if (args.validate === false) {
    for (const entry of allCandidates) {
      for (const candidate of entry.candidates || []) candidate.validationSkipped = true;
    }
  }

  let validateTop = 0;
  if (validateAll || requestedValidateTop > 0) {
    const remainingBeforeValidation =
      typeof client.oddsHistoryBudgetRemaining === 'function' ? client.oddsHistoryBudgetRemaining() : null;
    const tennisInScan = (leagues || []).some((leagueName) => String(leagueName || '').toLowerCase() === 'tennis');
    const VALIDATION_RESERVE_CALLS = tennisInScan ? 40 : 20;
    const VALIDATION_ESTIMATED_CALLS = 3;
    const validationBudgetCap = Number.isFinite(remainingBeforeValidation)
      ? Math.max(0, Math.floor((remainingBeforeValidation - VALIDATION_RESERVE_CALLS) / VALIDATION_ESTIMATED_CALLS))
      : requestedValidateTop;
    validateTop = validateAll ? requestedValidateTop : Math.min(requestedValidateTop, validationBudgetCap);
    validationBudgetExhausted = args.validate !== false && requestedValidateTop > 0 && validateTop === 0;
  }

  if (validateAll || validateTop > 0) {
    const validationOutcome = await validationPipeline.runValidationPipeline({
      validate: (vargs) => ctx.handlers.runValidatePlayImpl(client, vargs),
      buildArgs: (candidate, entry) => buildQuickScreenValidationArgs(candidate, entry, args),
      buildCacheKey: (candidate, entry) => `${candidate.gameId}::${candidate.selection}::${entry.market}`,
      rows: allCandidates.flatMap((entry) =>
        (entry.candidates || []).map((candidate) => ({ target: candidate, entry }))
      ),
      isEligible: isCandidateEligibleForValidation,
      isBet: (candidate) => candidate.kaiCall === 'BET',
      selectTargets: (selection) => {
        const ncaafOnly = leagues.length === 1 && String(leagues[0] || '').toLowerCase() === 'ncaaf';
        return ncaafOnly
          ? validationPipeline.selectTopBalanced(selection)
          : validationPipeline.selectTopGlobal(selection);
      },
      onNotSelected: (candidate, entry) => {
        candidate.validationBudgetSkipped = true;
        candidate.validationBudgetExhausted = false;
        candidate.validationFailureReason = 'validation not selected within validation budget';
        candidate.validationWatchRecorded = true;
        // Screen-BET budget-skipped candidates need applyFinalVerdict so they
        // have finalVerdict/finalConfidenceTier for the onlyBets filter.
        // Without this, they silently vanish (finalVerdict=undefined fails
        // the filter) instead of flowing through as actionable plays.
        if (candidate._screenWasBet === true) {
          applyFinalVerdict(candidate);
          promoteFinalVerdictToDisplay(candidate);
        } else {
          watchCandidates.push({
            ...candidate,
            market: entry.market,
            originalVerdict: candidate._screenVerdict,
            official: false
          });
        }
      },
      applyValidated: (candidate, validation) => {
        if (process.env.SSB_DEBUG === 'true') {
          process.stderr.write(
            `[quick-screen] validated ${candidate.selection} respTier=${validation?.tier} ` +
              `respVerdict=${validation?.verdict} summaryDisplay=${validation?.verdictSummary?.displayTier} ` +
              `candTier=${candidate.confidenceTier} candTierLive=${candidate.confidenceTierLive} candKai=${candidate.kaiCall}\n`
          );
        }
        applyValidatedFields(candidate, validation);
        candidate._validated = true;
        applyFinalVerdict(candidate);
        promoteFinalVerdictToDisplay(candidate);
      },
      validateAll,
      validateTop,
      mapWithConcurrency
    });
    validationEligibleCount = validationOutcome.eligibleCount;
    validationSelectedCount = validationOutcome.selectedCount;
    validationPartial = validationOutcome.partial;
  }

  // Authoritative final verdict for every candidate (incl. budget-exhausted BETs).
  for (const entry of allCandidates) {
    for (const candidate of entry.candidates || []) {
      if (validationBudgetExhausted && candidate.kaiCall === 'BET' && !candidate._validated) {
        candidate.validationBudgetExhausted = true;
        candidate.validationFailureReason = 'shared odds-history budget exhausted before validation';
        candidate.validationWatchRecorded = true;
        watchCandidates.push({
          ...candidate,
          market: entry.market,
          originalVerdict: candidate._screenVerdict,
          official: false
        });
      }
      applyFinalVerdict(candidate);
    }
  }

  for (const entry of allCandidates) {
    if (entry.candidates && entry.candidates.length) {
      flagContradictoryPlays(entry.candidates);
    }
  }

  const validatedCount = allCandidates.reduce(
    (sum, entry) => sum + (entry.candidates || []).filter((c) => c._validated).length,
    0
  );

  collectDowngradedWatchCandidates(allCandidates, watchCandidates);

  return {
    watchCandidates,
    validationBudgetExhausted,
    validationEligibleCount,
    validationSelectedCount,
    validationPartial,
    validateTop,
    validatedCount
  };
}

// ─── Phase: post-validation filters (empty tracking, targetTiers, kaiCall/sort, onlyBets, hideVerdict) ─

function applyQuickScreenFilters(allCandidates, emptySlate, args) {
  // Post-filter empty tracking.
  for (const entry of allCandidates) {
    if (!entry.candidates || entry.candidates.length > 0) continue;
    if (entry.error) continue;
    const wasEmpty = emptySlate.some((e) => e.league === entry.league && e.market === entry.market);
    if (!wasEmpty) {
      emptySlate.push({
        league: entry.league,
        market: entry.market,
        reason: 'all candidates filtered out (card window / tier / kaiCall)'
      });
    }
  }

  if (Array.isArray(args.targetTiers) && args.targetTiers.length) {
    for (const entry of allCandidates) {
      if (!entry.candidates || !entry.candidates.length) continue;
      entry.candidates = entry.candidates.filter((c) => {
        const liveTier = c.finalConfidenceTier || c.confidenceTierLive || c.confidenceTier || 'TIER 4';
        return args.targetTiers.includes(liveTier);
      });
    }
  }

  for (const entry of allCandidates) {
    if (!entry.candidates || !entry.candidates.length) continue;
    entry.candidates = sortRows(
      filterRowsByMinEV(
        filterRowsByMovement(filterRowsByKaiCall(entry.candidates, args.kaiCall), args.movement),
        args.minEV
      ),
      { sortBy: args.sortBy, sortDir: args.sortDir }
    );
  }

  if (args.onlyBets) {
    const floor = ['TIER 1', 'TIER 2', 'TIER 3'].indexOf(args.minFinalTier || 'TIER 2');
    for (const entry of allCandidates) {
      if (!entry.candidates || !entry.candidates.length) continue;
      entry.candidates = entry.candidates.filter((c) => {
        const tierIdx = ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4'].indexOf(
          c.finalConfidenceTier || c.confidenceTier || 'TIER 4'
        );
        return (
          c.finalVerdict === 'BET' &&
          (c._validated === true || c.validationBudgetSkipped === true) &&
          c.validationSkipped !== true &&
          !c.validationBudgetExhausted &&
          tierIdx <= floor
        );
      });
    }
  }

  const verbosity = String(args.verbosity || 'full').toLowerCase();
  if (args.hideVerdict && verbosity !== 'bets') {
    for (const entry of allCandidates) {
      if (!entry.candidates || !entry.candidates.length) continue;
      for (const c of entry.candidates) {
        stripVerdictFields(c);
      }
    }
  }
  return verbosity;
}

// ─── Phase: scoped player research ────────────────────────────────────────────

async function runQuickScreenResearch(ctx, allCandidates, { includeResearch, args, gameContextFn }) {
  const researchResults = [];
  if (!includeResearch) return researchResults;
  const researchLimit = Number.isFinite(Number(args.researchLimit))
    ? Math.max(1, Math.min(50, Number(args.researchLimit)))
    : 50;
  const researchBatch = buildFinalResearchBatch(allCandidates, researchLimit);
  if (researchBatch.length) {
    const researchOut = await runResearchOnTopRows({
      rows: researchBatch.map((r) => ({
        selection: r.player,
        league: r.league,
        game: r.game,
        start: r.start,
        market: r.market
      })),
      limit: researchBatch.length,
      playerContextFn: ctx.handlers.player_context,
      gameContextFn,
      concurrency: 3
    });
    for (const r of researchOut.results) {
      researchResults.push({
        player: r.player,
        game: r.game,
        riskFlag: r.riskFlag,
        riskSummary: r.riskSummary || null,
        contextType: r.contextType || 'player',
        market: r.market || null,
        ...(r.topTweet ? { topTweet: r.topTweet.slice(0, 120) } : {})
      });
    }
  }
  return researchResults;
}

// ─── Phase: topPick collapse ──────────────────────────────────────────────────

function applyQuickScreenTopPick(allCandidates, topPick) {
  if (!topPick) return;
  const pool = [];
  for (const entry of allCandidates) {
    for (const c of entry.candidates || []) pool.push(c);
  }
  const betTier = pool.filter((c) => c.kaiCall === 'BET' || c.displayTier === 'BET');
  const source = betTier.length ? betTier : pool;
  source.sort((a, b) => (Number(b.screenScore) || 0) - (Number(a.screenScore) || 0));
  const top = source[0];
  for (const entry of allCandidates) entry.candidates = [];
  if (top) {
    top.why = `Top pick: ${top.selection} (${top.game}) — ${top.rationale}. Edge ${Number(top.edge || 0).toFixed(2)}%, CLV ${Number(top.clv || 0).toFixed(2)}%, ${top.consensusBookCount} books, movement ${top.movementDisposition}.`;
    allCandidates.push({ league: top.league || 'TOP', market: top.market, candidates: [top] });
  }
}

// ─── Phase: assemble + format + cache + log ───────────────────────────────────

function buildScanHealth(
  allCandidates,
  client,
  {
    validationBudgetExhausted,
    validationPartial,
    validatedCount,
    requestedValidateTop,
    validationEligibleCount,
    validationSelectedCount
  }
) {
  return {
    incomplete:
      validationBudgetExhausted ||
      validationPartial ||
      allCandidates.some((entry) => entry.error || entry.scanHealth?.incomplete || entry.scanHealth?.truncated),
    validationBudgetExhausted,
    validation: {
      requested: requestedValidateTop,
      eligible: validationEligibleCount,
      selected: validationSelectedCount,
      completedCount: validatedCount,
      remainingBeforeValidation:
        typeof client.oddsHistoryBudgetRemaining === 'function' ? client.oddsHistoryBudgetRemaining() : null,
      ...(validationPartial
        ? { reason: 'validation budget selected fewer candidates than eligible BET candidates' }
        : {})
    },
    truncated: allCandidates.some((entry) => entry.scanHealth?.truncated),
    preHistoryShortlist: allCandidates
      .filter((entry) => entry.preHistoryShortlist)
      .flatMap((entry) => entry.preHistoryShortlist)
  };
}

function buildTierStats() {
  try {
    const stats = getPickStats({ days: 90 });
    const backtest = getBacktestSummary({ days: 90 });
    return {
      byTier: stats?.stats?.byTier || null,
      backtest: backtest?.ok ? backtest : null
    };
  } catch {
    return null;
  }
}

function assembleQuickScreenResponse({
  allCandidates,
  unresolvedCandidates,
  emptySlate,
  watchCandidates,
  researchResults,
  targetBooks,
  leagues,
  markets,
  activeSlate,
  warnings,
  validationBudgetExhausted,
  validationPartial,
  requestedValidateTop,
  validationEligibleCount,
  validationSelectedCount,
  validateTop,
  validatedCount,
  cardWindow,
  cardWindowFallthrough,
  nextDayMerged,
  allAliasesUsed,
  args,
  lite,
  responseCache,
  responseCacheTtlMs,
  maybeGc,
  validateAll,
  client
}) {
  const bookList = targetBooks.length === 1 ? targetBooks[0] : targetBooks.join(', ');
  const validateAllActive = validateAll || requestedValidateTop > 0;
  const screenResponse = {
    ok: true,
    targetBook: bookList,
    targetBooks,
    leagues,
    markets,
    totalCandidates: allCandidates.reduce((sum, l) => sum + (l.candidates?.length || 0), 0),
    activeSlate,
    emptySlate,
    ...(watchCandidates.length ? { watchCandidates } : {}),
    ...(unresolvedCandidates.length ? { unresolvedCandidates } : {}),
    scanHealth: buildScanHealth(allCandidates, client, {
      validationBudgetExhausted,
      validationPartial,
      validatedCount,
      requestedValidateTop,
      validationEligibleCount,
      validationSelectedCount
    }),
    cardWindow: cardWindowFallthrough || cardWindow,
    ...(cardWindowFallthrough ? { cardWindowFallthrough: true } : {}),
    ...(nextDayMerged ? { nextDayMerged: true, nextDayDate: nextDayMerged } : {}),
    maxPlaysPerGame:
      Number.isFinite(Number(args.maxPlaysPerGame)) && Number(args.maxPlaysPerGame) > 0
        ? Number(args.maxPlaysPerGame)
        : 2,
    results: allCandidates,
    research: researchResults,
    warnings,
    tierStats: buildTierStats(),
    _meta: validateAllActive
      ? {
          validation: {
            requested: validateTop,
            completedCount: validatedCount,
            note: 'Validated rows have validatedTier, validatedConsensusBookCount, validatedMovementDisposition, validatedActionableSummary, and _validated=true'
          }
        }
      : undefined,
    workflow: `${bookList} target book(s). Playable price (not necessarily best). Sharp book movement cross-referenced. Player context research included.`,
    markets_alias_used: allAliasesUsed
  };

  const verbosity = String(args.verbosity || 'full').toLowerCase();
  let formattedResponse;
  if (verbosity === 'minimal') formattedResponse = formatQuickScreenMinimal(screenResponse);
  else if (verbosity === 'bets') formattedResponse = formatQuickScreenBets(screenResponse);
  else if (verbosity === 'standard') formattedResponse = formatQuickScreenStandard(screenResponse);
  else formattedResponse = screenResponse;

  if (lite && formattedResponse.ok) {
    stripLiteResponse(formattedResponse);
  }

  if (args._aggregateCacheKey && formattedResponse.ok) {
    let estimatedSizeBytes = 0;
    try {
      estimatedSizeBytes = JSON.stringify(formattedResponse).length;
    } catch {
      /* non-serializable — skip caching */
    }
    const aggregateResultCount = (formattedResponse.results || []).reduce(
      (sum, entry) => sum + (entry.count || (entry.candidates || []).length || (entry.plays || []).length || 0),
      0
    );
    if (aggregateResultCount > 0) {
      responseCache.set(args._aggregateCacheKey, formattedResponse, responseCacheTtlMs, estimatedSizeBytes);
    }
  }
  logLargeQuickScreenResponse(formattedResponse);
  maybeGc();
  return ok(formattedResponse);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runQuickScreen(deps, args = {}) {
  const { client, ctx, responseCache, responseCacheTtlMs, gameContextFn, maybeGc } = deps;

  clearTierCache();

  const plan = planAggregateScreen(args, { responseCache });
  if (plan.cachedResponse) {
    return plan.cachedResponse;
  }
  if (plan.aggregateCacheKey) {
    args._aggregateCacheKey = plan.aggregateCacheKey;
  }
  const {
    targetBooks,
    leagues,
    markets,
    limit,
    maxPerMarket,
    scanLimit,
    lookbackHours,
    includeResearch,
    debug,
    topPick,
    lite
  } = plan;

  const qsStart = Date.now();
  const { resolvedMarketsByLeague, allAliasesUsed } = resolveQuickScreenMarkets(
    leagues,
    markets,
    targetBooks,
    args.includeProps
  );

  const { allCandidates, unresolvedCandidates, emptySlate } = await runQuickScreenFanout(ctx, {
    targetBooks,
    leagues,
    resolvedMarketsByLeague,
    scanLimit,
    lookbackHours,
    debug,
    maxPerMarket,
    limit,
    args
  });
  let phaseMark = scanTiming('quick_screen.fanout', qsStart);

  const { cardWindowFallthrough, nextDayMerged } = applyQuickScreenCardWindow(
    allCandidates,
    emptySlate,
    String(args.cardWindow || 'today')
      .trim()
      .toLowerCase()
  );
  phaseMark = scanTiming('quick_screen.card_window', phaseMark);

  // Strip alternate-line candidates (resolveAlternateLines TIER 4 downgrades).
  for (const entry of allCandidates) {
    if (!entry.candidates || !entry.candidates.length) continue;
    entry.candidates = entry.candidates.filter((c) => !c.altLineFiltered);
  }

  const activeSlate = allCandidates
    .filter((r) => r.candidates && r.candidates.length > 0)
    .map((r) => ({ league: r.league, market: r.market, count: r.candidates.length, error: r.error || null }));

  const warnings = allCandidates.some((r) =>
    r.candidates?.some((c) => c.hoursUntilStart !== null && c.hoursUntilStart < 0)
  )
    ? ['Some games have already started. Live odds may be stale.']
    : [];

  const validateAll = args.validate === true;
  const requestedValidateTop =
    args.validate === false ? 0 : Number.isFinite(Number(args.validateTop)) ? Number(args.validateTop) : 10;

  const validation = await runQuickScreenValidation(client, ctx, allCandidates, {
    args,
    validateAll,
    requestedValidateTop,
    leagues
  });
  phaseMark = scanTiming('quick_screen.validate', phaseMark);

  const verbosity = applyQuickScreenFilters(allCandidates, emptySlate, args);
  void verbosity;

  const researchResults = await runQuickScreenResearch(ctx, allCandidates, {
    includeResearch,
    args,
    gameContextFn
  });
  scanTiming('quick_screen.research', phaseMark);

  applyQuickScreenTopPick(allCandidates, topPick);

  return assembleQuickScreenResponse({
    allCandidates,
    unresolvedCandidates,
    emptySlate,
    watchCandidates: validation.watchCandidates,
    researchResults,
    targetBooks,
    leagues,
    markets,
    activeSlate,
    warnings,
    validationBudgetExhausted: validation.validationBudgetExhausted,
    validationPartial: validation.validationPartial,
    requestedValidateTop,
    validationEligibleCount: validation.validationEligibleCount,
    validationSelectedCount: validation.validationSelectedCount,
    validateTop: validation.validateTop,
    validatedCount: validation.validatedCount,
    cardWindow: String(args.cardWindow || 'today')
      .trim()
      .toLowerCase(),
    cardWindowFallthrough,
    nextDayMerged,
    allAliasesUsed,
    args,
    lite,
    responseCache,
    responseCacheTtlMs,
    maybeGc,
    validateAll,
    client,
    limit
  });
}

function createQuickScreenHandlers(client, ctx, factoryDeps) {
  const { responseCache, responseCacheTtlMs, gameContextFn, maybeGc } = factoryDeps;
  return {
    async quick_screen(args = {}) {
      return runQuickScreen({ client, ctx, responseCache, responseCacheTtlMs, gameContextFn, maybeGc }, args);
    }
  };
}

/**
 * Decide whether a screen row may be validated.
 *
 * IMPORTANT: this must NOT consider the screen-time BET flag (`kaiCall`).
 * Validation exists to UPGRADE a candidate to BET (and to downgrade one), so
 * gating eligibility on `kaiCall === 'BET'` is circular: only rows already
 * flagged BET get validated, anything that would BECOME a BET never does, and
 * `--only-bets` silently returns a strict subset of the real BETs. That bug was
 * live until 2026-09-11, where `-B` returned 0 of 2 NCAAF plays and 7 of 11 MLB
 * plays. The onlyBets filter belongs on the OUTPUT verdict, which the CLI
 * applies after this pipeline returns.
 *
 * @param {Object} candidate - Screen candidate row.
 * @returns {boolean} True when the row can be validated.
 */
function isCandidateEligibleForValidation(candidate) {
  return Boolean(candidate && candidate.gameId && candidate.selection && !candidate.altLineFiltered);
}

module.exports = {
  createQuickScreenHandlers,
  // Exported for hermetic rejection-diagnostic tests (see
  // test/quick-screen-rejection-diagnostics.test.js). These are pure over their
  // inputs and owned by this module's reliability patch.
  getValidationFailureReason,
  collectDowngradedWatchCandidates,
  buildQuickScreenValidationArgs,
  // Exported so the "eligibility must not depend on the screen BET flag"
  // invariant stays testable (test/quick-screen-onlybets-eligibility.test.js).
  isCandidateEligibleForValidation
};
