'use strict';

const { extractScreenRows } = require('./screen-parser');
const { summarizeFreshness } = require('./screen-summary');
const { getLeagueRankingPreset } = require('./screen-ranker');
const { hydrateScreenRowsWithHistory } = require('./ssb-screen-history');
const {
  DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS,
  getOddsHistoryLookbackHours,
  getLocalTimezone,
  localDateKey
} = require('./mcp-runtime-config');
const { parseGameStartMs } = require('./ssb-shared-utils');
const { uniqueBooks } = require('./ssb-sharp-books');
const { compactRow: stripEmptyFields } = require('./ssb-shared-utils');
const { computeMovementDisposition } = require('./ssb-movement-disposition');
const { buildRationale } = require('./ssb-risk-score');
const { expandScreenRow } = require('./screen-row-expander');
const { normalizeMarketName, normalizeLeagueName } = require('./ssb-shared-utils');
const { buildResultMeta } = require('./ssb-ranked-screen-meta');
const { buildRankedResultRows } = require('./ssb-ranked-screen-results');
const { finalizeRankedScreenResponse } = require('./ssb-ranked-screen-finalize');
const { planPreHistoryHydration } = require('./ssb-ranked-screen-history-plan');
const { annotateRankedRows } = require('./ssb-ranked-screen-row-annotation');
const { buildRankedHydrationOptions } = require('./ssb-ranked-screen-hydration-options');
const { mergeRecoveredRows } = require('./ssb-ranked-screen-recovery-merge');
const { resolveAlternateLines } = require('./alternate-line-filter');
const { enrichSoccerEventRows } = require('./soccer-event-context');
const { createSharpOddsClient } = require('./sharpodds-client');
const { createSharpOddsHistoryProvider, DEFAULT_SHARP_BOOKS } = require('./sharpodds-history-provider');

function normalizeSelectionKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildCanonicalPlayId(row = {}) {
  const gameId = String(row.gameId || '').trim();
  const market = String(row.market || '').trim();
  const selectionKey = normalizeSelectionKey(
    row.selection || row.participant || row.pick || row.homeTeam || row.awayTeam || ''
  );
  return [gameId, market, selectionKey].join('::');
}

function normalizeBookList(books) {
  return uniqueBooks(books);
}

function getMaxPerMarket(args = {}) {
  const value = Number(args.maxPerMarket);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getLimit(args = {}) {
  const limit = Number(args.limit);
  return Number.isFinite(limit) && limit > 0 ? limit : 100;
}

// Pre-history shortlist (broad scans): when a scan is not game-filtered and
// the caller opts in, hydrate only a bounded candidate set chosen by CHEAP
// current-market signals (consensus edge from the odds map — no history
// calls). Otherwise a wide slate (e.g. tennis 100+ rows, or 21 games × 2
// sides = 42 history calls) exhausts the process-wide odds-history budget
// (default 300 calls per 5 min, env PP_ODDS_HISTORY_BUDGET) on low-value
// rows, and good late candidates degrade to
// movementDisposition=insufficient. The shortlist preserves paired sides
// (both sides of a game travel together) and round-robins across
// (league, market) buckets so no market is starved.
const PRE_HISTORY_SHORTLIST_MULTIPLIER = 2;
const PRE_HISTORY_SHORTLIST_MIN_GAMES = 2;
// Game cap for the pre-history shortlist. Tuned to the REAL odds-history
// budget (PP_ODDS_HISTORY_BUDGET, default 300 per 5-min window), not the
// historical 75-call figure the older comments reference. The aggregate
// allocator reserves 60% of the budget for initial ranking; with the
// default 300 that is 180 calls ≈ 90 paired games across a scan, so a
// Per-pair callers can raise this for a single-sport slate (NCAAF uses 700),
// while aggregate multi-sport allocation still clamps the effective budget
// per pair before any history calls are made.
const PRE_HISTORY_SHORTLIST_MAX_GAMES = 700;

/**
 * True when the request explicitly targets games/participants. Targeted
 * lookups (get_play_details / validate_play / screen_ranked with games)
 * must retain FULL exact-selection hydration — the shortlist is a broad-scan
 * optimization only.
 */
function hasExplicitGameFilter(args = {}) {
  if (String(args.gameId || '').trim()) return true;
  return ['games', 'gameIds', 'participants'].some((key) => {
    const value = args[key];
    return Array.isArray(value) && value.length > 0;
  });
}

/**
 * Shortlist game budget: bounded by the final limit, with a floor so a
 * limit=1 scan still hydrates enough candidates to rank from, and a hard
 * cap so one scan never approaches the process-wide odds-history budget
 * (default 300 calls per 5 min, env PP_ODDS_HISTORY_BUDGET).
 * Aggregate scans (quick_screen fan-out) pass an explicit per-query budget
 * via args.preHistoryGameBudget so the process-wide budget is shared fairly
 * across all league×market pairs instead of each ranked query claiming up
 * to 48 selection calls.
 */
function getPreHistoryShortlistGameBudget(args = {}) {
  const explicit = Number(args.preHistoryGameBudget);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const limit = getLimit(args);
  const games = Math.max(PRE_HISTORY_SHORTLIST_MIN_GAMES, limit * PRE_HISTORY_SHORTLIST_MULTIPLIER);
  return Math.min(games, PRE_HISTORY_SHORTLIST_MAX_GAMES);
}

/**
 * Cheap current-market-only score for a row: best consensus edge across the
 * row's expanded sides, with an implausible-edge penalty, a strong bonus for
 * multi-book consensus, and a near-even price preference. Never calls history.
 *
 * The raw consensus edge is capped because a huge edge on a heavy favorite is
 * usually a stale/off-market price artifact (grades adverse after hydration),
 * while near-even lines with broad book consensus are the rows that actually
 * hydrate to supportive movement. Multi-book agreement is the cheapest signal
 * that correlates with supportive_clean/supportive_bouncy.
 */
function scoreRowForShortlist(row, preferredBook) {
  let best = -Infinity;
  try {
    const expanded = expandScreenRow(row, { preferredBook, requirePreferredBook: false });
    for (const side of Array.isArray(expanded) ? expanded : []) {
      if (!side || typeof side !== 'object') continue;
      const edge = Number(side.consensusEdge);
      if (!Number.isFinite(edge)) continue;
      // Edge matters but at HALF weight and capped at ±6: a huge edge on a
      // heavy favorite is usually a stale/off-market price artifact (grades
      // adverse after hydration), while broad multi-book consensus on a
      // near-even line is the cheapest signal that correlates with supportive
      // movement. Cap is high enough that real edge differences (2-6pp) still
      // discriminate between candidates.
      let score = Math.max(-6, Math.min(edge, 6)) * 0.5;
      if (side.edgeSanityFlag === 'implausible') score -= 10;
      // Multi-book consensus dominates: saturates at 5+ books (+3.0). 20 books
      // and 8 books both rank strong, but 1-2 book rows get minimal credit.
      score += Math.min(5, Number(side.consensusBookCount) || 0) * 0.6;
      // Near-even price bonus (James's common lines, ~-150..+150). Heavy
      // favorites/dogs are deprioritized unless consensus is genuinely strong.
      const price = Number(side.odds);
      if (Number.isFinite(price)) {
        const absPrice = Math.abs(price);
        if (absPrice <= 150) score += 1.5;
        else if (absPrice <= 250) score += 0.5;
        else score -= 1;
      }
      if (side.focusBookMissing) score -= 1;
      if (score > best) best = score;
    }
  } catch {
    // Unscorable row: stays at -Infinity (eligible only when budget allows).
  }
  return best;
}

/**
 * Build the bounded pre-history shortlist from the raw extracted rows.
 * Groups rows by (gameId, league, market) so both sides of a game travel
 * together, scores each group with current-market data only, then selects
 * the top groups round-robin across (league, market) buckets.
 *
 * @param {Array<object>} rows - Extracted screen rows.
 * @param {{gameBudget: number, preferredBook: string, rowBudget?: number}} opts
 * @returns {{rows: Array<object>, skippedRows: Array<object>, gameCount: number, skippedGameCount: number, bucketCount: number, gameBudget: number}}
 */
function buildPreHistoryShortlist(rows, { gameBudget, preferredBook, rowBudget }) {
  const groups = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const gameId = String(row.gameId ?? row.game_id ?? row.gameID ?? row.game?.id ?? '').trim();
    const league = normalizeLeagueName(row.league || row.sport || '');
    const market = normalizeMarketName(row.market || row.playType || '');
    const key = gameId
      ? `${gameId}::${league}::${market}`
      : `row:${row.book || ''}:${row.selectionId || row.selection || row.pick || ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, league, market, rows: [], score: -Infinity };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  for (const group of groups.values()) {
    let best = -Infinity;
    for (const row of group.rows) {
      const score = scoreRowForShortlist(row, preferredBook);
      if (score > best) best = score;
    }
    group.score = best;
  }

  // Bucket by (league, market) and sort each bucket best-first.
  const buckets = new Map();
  for (const group of groups.values()) {
    const bucketKey = `${group.league}::${group.market}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(group);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => b.score - a.score);
  }

  // Seed every bucket before quality-weighted passes. This prevents a large,
  // high-scoring bucket from consuming the row budget before a requested
  // league/market bucket receives any history hydration.
  const selected = [];
  const bucketKeys = [...buckets.keys()];
  let remaining = Math.min(gameBudget, groups.size);
  let selectedRows = 0;
  for (const bucketKey of bucketKeys) {
    if (remaining <= 0) break;
    const list = buckets.get(bucketKey);
    if (list.length === 0) continue;
    const group = list.shift();
    if (rowBudget && selectedRows + group.rows.length > rowBudget) {
      const availableRows = Math.max(1, rowBudget - selectedRows);
      group.rows = group.rows
        .map((row) => ({ row, score: scoreRowForShortlist(row, preferredBook) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, availableRows)
        .map((entry) => entry.row);
    }
    selected.push(group);
    selectedRows += group.rows.length;
    remaining -= 1;
  }
  while (remaining > 0 && (!rowBudget || selectedRows < rowBudget)) {
    let took = false;
    for (const bucketKey of bucketKeys) {
      if (remaining <= 0 || (rowBudget && selectedRows >= rowBudget)) break;
      const list = buckets.get(bucketKey);
      if (list.length === 0) continue;
      const group = list[0];
      const availableRows = rowBudget ? rowBudget - selectedRows : group.rows.length;
      if (availableRows <= 0) break;
      list.shift();
      if (group.rows.length > availableRows) group.rows = group.rows.slice(0, availableRows);
      selected.push(group);
      selectedRows += group.rows.length;
      remaining -= 1;
      took = true;
    }
    if (!took) break;
  }

  // Hydration priority: strongest groups first — the shared history budget
  // gate grants calls in request order, so the best candidates consume the
  // budget before weaker ones.
  selected.sort((a, b) => b.score - a.score);

  // Hydration priority: strongest groups first — the shared history budget
  // gate grants calls in request order, so the best candidates consume the
  // budget before weaker ones.
  selected.sort((a, b) => b.score - a.score);
  const selectedKeys = new Set(selected.map((group) => group.key));
  const skippedGroups = [...groups.values()]
    .filter((group) => !selectedKeys.has(group.key))
    .sort((a, b) => b.score - a.score);

  return {
    rows: selected.flatMap((group) => group.rows),
    skippedRows: skippedGroups.flatMap((group) => group.rows),
    gameCount: selected.length,
    skippedGameCount: skippedGroups.length,
    bucketCount: bucketKeys.length,
    gameBudget
  };
}

function getIncludeAll(args = {}) {
  return args.includeAll !== undefined ? Boolean(args.includeAll) : true;
}

function getMaxAgeMs(args = {}) {
  const value = Number(args.maxAgeMs);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function getLookbackHours(args = {}) {
  const value = Number(args.lookbackHours);
  return Number.isFinite(value) && value > 0 ? value : getOddsHistoryLookbackHours();
}

function getRecentWindowHours(args = {}) {
  const value = Number(args.recentWindowHours);
  return Number.isFinite(value) && value > 0 ? value : getLookbackHours(args);
}

function getDebugFlag(value, defaultValue = true) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  return defaultValue;
}

function getCompactFlag(args = {}) {
  if (args.compact === undefined || args.compact === null) return false;
  if (typeof args.compact === 'boolean') return args.compact;
  const normalized = String(args.compact).trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(normalized);
}

// Default field set used when compact=true
const COMPACT_FIELDS = [
  'id',
  'gameId',
  'playId',
  'selectionKey',
  'start',
  'league',
  'homeTeam',
  'awayTeam',
  'isLive',
  'market',
  'participant',
  'selection',
  'pick',
  'odds',
  'targetBookOdds',
  'currentOdds',
  'line',
  'edge',
  'clv',
  'clvProxyPct',
  'consensusBookCount',
  'executionQuality',
  'movementGrade',
  'movementDisposition',
  'riskScore',
  'kaiCall',
  'confidenceTier',
  'confidenceTierLive',
  'rationale',
  'screenScore',
  'book',
  'playType',
  'lineHistoryAvailable',
  'lineHistoryPoints',
  // Movement signals (small fields, high value for quick scanning)
  'steamMove',
  'steamBooks',
  'steamDirection',
  'consensusEdge',
  'multiWindowScore',
  'movementLabel',
  'movementSourceBook',
  'tierTrajectory',
  // Freshness + kickoff labels (tiny strings, high value for quick scanning)
  'movementAsOf',
  'startCT',
  'startsIn',
  'startUnverified',
  'liquidityFlag',
  // Native PP selection-scoped price-history provenance.
  // Price history may qualify movement while line-history provenance remains degraded.
  'priceHistoryUsable',
  'movementHistoryUsable',
  'priceHistoryScope',
  'priceHistorySource',
  'priceHistoryPointCount'
];

/**
 * Filter a row to only the specified fields.
 * @param {Object} row - Full ranked row
 * @param {string[]} fields - Field names to keep
 * @returns {Object} Row with only the requested fields
 */
function filterRowFields(row = {}, fields = []) {
  if (!Array.isArray(fields) || !fields.length) return row;
  const result = {};
  for (const field of fields) {
    if (field in row) {
      result[field] = row[field];
    }
  }
  return result;
}

/**
 * Strip a ranked row down to essential fields only.
 * Removes: lineHistory, scoreBreakdown, selections (full odds map),
 *          movement debug payloads, and other verbose metadata.
 * Keeps: game, selection, odds, edge, tier, kai, start, risk, etc.
 */
function compactRow(row = {}) {
  return filterRowFields(row, COMPACT_FIELDS);
}

function compactResult(ranked = []) {
  return ranked.map(compactRow);
}

/**
 * Analyze ranked rows and emit warnings when the response is operating in degraded mode.
 * Prevents users from treating weak signals as strong ones.
 */
function buildDegradedDataWarnings(ranked, _rows, _freshness) {
  const warnings = [];
  if (!ranked || ranked.length === 0) return warnings;

  const totalRows = ranked.length;

  // Line history availability
  const rowsWithHistory = ranked.filter((r) => Array.isArray(r.lineHistory) && r.lineHistory.length > 0).length;
  const historyPct = Math.round((rowsWithHistory / totalRows) * 100);
  if (rowsWithHistory === 0) {
    warnings.push(
      `No line history available for any of ${totalRows} rows. Movement scores and CLV tracking are unavailable.`
    );
  } else if (historyPct < 50) {
    warnings.push(
      `Line history available for only ${rowsWithHistory}/${totalRows} rows (${historyPct}%). Movement analysis is limited.`
    );
  }

  // Consensus book coverage
  const rowsWithConsensus = ranked.filter((r) => Number(r.consensusBookCount || 0) >= 2).length;
  if (rowsWithConsensus === 0) {
    warnings.push(
      `No consensus data: all ${totalRows} rows show only single-book odds. Cross-book validation is unavailable.`
    );
  } else if (rowsWithConsensus < totalRows * 0.5) {
    warnings.push(
      `Consensus data sparse: only ${rowsWithConsensus}/${totalRows} rows have 2+ books posting. Most plays lack cross-book validation.`
    );
  }

  // Freshness fallback — KNOWN BENIGN (see CHANGELOG entry on freshnessFallbackUsed):
  // the upstream /screen API ships no per-row timestamps, so freshness is estimated
  // from response timing on every healthy response. This is expected, not degradation;
  // it was surfacing a misleading "degraded" warning that made healthy reads look broken.
  // Stubbed per James 2026-08-19 — do not re-add as a warning. Movement/CLV come from
  // the odds_history feed (separate, healthy path), which is what actually matters.

  // Line-field backfill (v2.1.3): if any row's lineHistory had entries with
  // `line: null` and we backfilled from the row's current line, line-movement
  // detection is degraded — every entry shows the current line so we can't
  // see actual movement. Surface this honestly so users don't mistake the
  // degraded data for a clean signal.
  // The backfill code (`resolveHistoryForEntity`) only sets
  // `lineFieldMissingCount > 0` when `fallbackLine !== null`, which only
  // happens for non-moneyline rows (moneylines legitimately have line1=null
  // → fallbackLine=null → no backfill → count=0). So the count alone is
  // sufficient — we don't need a market-name check. The market check is
  // retained as defense-in-depth in case a future ranker change ever sets
  // the count on a moneyline row by accident.
  const backfilledRows = ranked.filter((r) => {
    if (!Array.isArray(r.lineHistory) || r.lineHistory.length === 0) return false;
    if (Number(r.lineFieldMissingCount || 0) === 0) return false;
    const market = String(r.market || r.screenMarket || r.playType || '')
      .trim()
      .toLowerCase();
    if (market === 'moneyline') return false;
    return true;
  });
  if (backfilledRows.length > 0) {
    const totalBackfilledEntries = backfilledRows.reduce((sum, r) => sum + Number(r.lineFieldMissingCount || 0), 0);
    warnings.push(
      `Line values missing from upstream history for ${backfilledRows.length}/${totalRows} non-moneyline rows (${totalBackfilledEntries} entries backfilled from current line). Line-movement detection is degraded for this slate.`
    );
  }

  // Movement scores all zero
  const rowsWithMovement = ranked.filter((r) => {
    const breakdown = r.scoreBreakdown;
    return breakdown && (Number(breakdown.movementScore || 0) > 0 || Number(breakdown.consensusScore || 0) > 0);
  }).length;
  if (rowsWithMovement === 0 && rowsWithHistory === 0) {
    warnings.push(
      `All ranking scores driven by sport score alone. Movement and consensus scores are zero due to missing history data.`
    );
  }

  return warnings;
}

async function buildRankedScreenResponse(opts = /** @type {any} */ ({})) {
  const {
    client,
    payloads = [],
    args = {},
    league,
    rankRows,
    focusBook,
    resultMeta = {},
    preHydrationFilter,
    preRankingTransform,
    sharpOddsProvider
  } = opts;
  const compact = getCompactFlag(args);
  const targetBook = String(focusBook || '').trim();
  const focusPlays = targetBook ? [{ book: targetBook }] : [];
  const extractedRows = payloads.flatMap((payload) =>
    extractScreenRows(
      payload,
      hasExplicitGameFilter(args) || /^(player|pitcher)\b/i.test(String(args.market || '').trim()) ? [] : focusPlays
    )
  );
  const enrichedRowsRaw = await enrichSoccerEventRows(extractedRows, {
    fetchImpl: opts.soccerFetchImpl || globalThis.fetch,
    timeoutMs: opts.soccerTimeoutMs
  });
  // Optional async start-time normalization applied BEFORE the date window.
  // Some feeds ship a stale row start that the pipeline corrects further down
  // (tennis: the raw gameId timestamp is often a day off). Filtering the window
  // on the raw value drops the wrong day — observed serving next-day matches
  // from a `today` window while row-filtering the games that were actually
  // upcoming. Normalize first so the window and the displayed time agree.
  const enrichedRows =
    typeof opts.startTimeNormalizer === 'function' ? await opts.startTimeNormalizer(enrichedRowsRaw) : enrichedRowsRaw;
  const cardWindow = String(args.cardWindow || '')
    .trim()
    .toLowerCase();
  const windowActive = cardWindow === 'today' || cardWindow === 'next';
  const windowNowMs = Number.isFinite(Number(args.nowMs)) ? Number(args.nowMs) : Date.now();
  const windowTz = getLocalTimezone();
  const rowsForCardWindow = windowActive
    ? enrichedRows.filter((row) => {
        const startMs = parseGameStartMs(row?.start ?? row?.startTime ?? row?.startTimestamp);
        if (!Number.isFinite(startMs)) return false;
        const targetKey = localDateKey(windowNowMs + (cardWindow === 'next' ? 24 * 60 * 60 * 1000 : 0), windowTz);
        return localDateKey(startMs, windowTz) === targetKey;
      })
    : enrichedRows;
  // Honest window diagnostics: rows that exist but fall outside the requested
  // date window are NOT an empty slate. Callers read `emptyState.reason` to
  // explain an empty result, so this must not collapse into
  // `no_ranked_rows_scanned` ("the feed has nothing").
  const cardWindowFilteredRowCount = windowActive ? enrichedRows.length - rowsForCardWindow.length : 0;
  const cardWindowMeta =
    windowActive && cardWindowFilteredRowCount > 0
      ? {
          cardWindow,
          cardWindowSourceRowCount: enrichedRows.length,
          cardWindowFilteredRowCount,
          ...(rowsForCardWindow.length === 0
            ? {
                emptyState: {
                  reason: 'outside_card_window',
                  cardWindow,
                  scannedRowCount: 0,
                  sourceRowCount: enrichedRows.length,
                  filteredRowCount: cardWindowFilteredRowCount
                }
              }
            : {})
        }
      : {};
  const rows =
    typeof preHydrationFilter === 'function' ? rowsForCardWindow.filter(preHydrationFilter) : rowsForCardWindow;
  // Pre-hydration alt-line prune: alternate spread/total variants never
  // survive ranking (they are dropped post-rank), so hydrating them wastes
  // one history query + sequential line-variant fallbacks per row. A single
  // NCAAF game can carry dozens of alt lines — this prune cuts hydration
  // work 10-50x on line markets. Same definition of "main" as the post-rank
  // filter, so surviving rows are identical.
  let preHydrationAltPruned = 0;
  let hydrationRows_ = rows;
  if (args.pruneAltLinesBeforeHydration !== false && Array.isArray(rows) && rows.length > 1) {
    resolveAlternateLines(rows, { debug: false });
    const mains = rows.filter((row) => !row.altLineFiltered);
    // Never prune to zero: if every row got marked (single-row markets,
    // moneylines without numbers), keep the full set.
    if (mains.length > 0 && mains.length < rows.length) {
      preHydrationAltPruned = rows.length - mains.length;
      hydrationRows_ = mains;
    }
  }
  const rowsForHydration = hydrationRows_;
  const sharpBooks = normalizeBookList(args.historySportsbooks || args.books || (targetBook ? [targetBook] : []));
  const configuredSharpOddsBooks = normalizeBookList(args.sharpOddsBooks);
  const sharpOddsBooks = configuredSharpOddsBooks.length ? configuredSharpOddsBooks : [...DEFAULT_SHARP_BOOKS];
  const effectiveSharpOddsProvider =
    sharpOddsProvider ||
    (args.enableSharpOddsHistory === true
      ? createSharpOddsHistoryProvider({
          client: createSharpOddsClient({ fetchImpl: globalThis.fetch, timeoutMs: 12_000 }),
          timezone: getLocalTimezone(),
          sharpBooks: sharpOddsBooks
        })
      : null);
  const debug = getDebugFlag(args.debug, false);
  const lookbackHoursUsed = getLookbackHours(args);
  const recentWindowHours = getRecentWindowHours(args);

  // Use `fields` or `compact` to control output size — they only affect response
  // formatting, not data hydration. This ensures movement scores, CLV, and lineHistory
  // are available regardless of output mode.
  const skipHistory = args.skipHistory === true;
  // Broad-scan pre-history shortlist: when the caller opts in
  // (preHistoryShortlist: true) and the request is NOT game/participant
  // targeted, hydrate only a bounded current-market shortlist instead of the
  // entire raw universe. Without this, a wide slate exhausts the process-wide
  // odds-history budget (default 300 calls per 5 min, env PP_ODDS_HISTORY_BUDGET)
  // on low-value rows and strong late candidates
  // degrade to movementDisposition=insufficient. Targeted lookups
  // (get_play_details / validate_play / screen_ranked with games) always keep
  // full exact-selection hydration.
  const canHydrate = !skipHistory && client && typeof client.queryOddsHistory === 'function';
  const { hydrationRows, recoveryRows, unresolvedRows, preHistoryShortlistMeta } = planPreHistoryHydration({
    rows: rowsForHydration,
    args,
    targetBook,
    canHydrate,
    hasExplicitGameFilter: hasExplicitGameFilter(args),
    buildPreHistoryShortlist,
    getGameBudget: getPreHistoryShortlistGameBudget
  });
  const hydrateOptions = buildRankedHydrationOptions({
    client,
    lookbackHours: lookbackHoursUsed,
    targetBook,
    sharpBooks,
    sharpOddsBooks,
    args,
    sharpOddsProvider: effectiveSharpOddsProvider
  });
  // Hydration deadline: history fetches must never hang the call forever.
  // On timeout the snapshot rows go through unhydrated (movement degrades
  // to insufficient) and resultMeta.historyPartial flags it. Default 5 min,
  // overridable via args.historyDeadlineMs / PP_HISTORY_DEADLINE_MS.
  const historyDeadlineMs = Number.isFinite(Number(args.historyDeadlineMs))
    ? Math.max(1000, Number(args.historyDeadlineMs))
    : Number.isFinite(Number(process.env.PP_HISTORY_DEADLINE_MS))
      ? Math.max(1000, Number(process.env.PP_HISTORY_DEADLINE_MS))
      : 300000;
  let historyTimedOut = false;
  async function hydrateWithDeadline(hydrationRowsInput) {
    if (skipHistory) return rows;
    const pending = hydrateScreenRowsWithHistory(hydrationRowsInput, hydrateOptions);
    if (!Number.isFinite(historyDeadlineMs)) return pending;
    let timer = null;
    try {
      return await Promise.race([
        pending,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            historyTimedOut = true;
            process.stderr.write(
              `[ssb-for-agents] History hydration hit the ${historyDeadlineMs}ms deadline; ` +
                'continuing with snapshot rows (movement may show insufficient).\n'
            );
            resolve(hydrationRowsInput);
          }, historyDeadlineMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Swallow late rejections from the losing hydration promise so they
      // never surface as unhandled rejections after we continued.
      pending.catch(() => {});
    }
  }
  const hydratedRows = await hydrateWithDeadline(hydrationRows);
  const { allHydratedRows, preHistoryRecoveryMeta } = await mergeRecoveredRows({
    hydratedRows,
    recoveryRows,
    skipHistory,
    hydrateOptions,
    args,
    hydrateFn: hydrateScreenRowsWithHistory,
    buildIdFn: buildCanonicalPlayId
  });
  const rankingRows =
    typeof preRankingTransform === 'function' ? preRankingTransform(allHydratedRows) : allHydratedRows;
  const ranked = rankRows(rankingRows, { debug, recentWindowHours });
  // Reconcile rank-time movement with expanded-row movement before formatting.
  annotateRankedRows(ranked, {
    normalizeSelectionKey,
    buildCanonicalPlayId,
    computeMovementDisposition,
    buildRationale
  });
  const freshness = summarizeFreshness(rows, Date.now(), { maxAgeMs: getMaxAgeMs(args) });
  const warnings = buildDegradedDataWarnings(ranked, rows, freshness);
  const fields =
    Array.isArray(args.fields) && args.fields.length ? args.fields.map((f) => String(f).trim()).filter(Boolean) : null;

  const resultRows = buildRankedResultRows({
    ranked,
    fields,
    compact,
    filterRowFields,
    compactResult
  });

  // Build the base response
  const includeList =
    Array.isArray(args.include) && args.include.length
      ? args.include.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : null;

  const baseResponse = {
    ok: true,
    result: resultRows,
    freshness,
    ...(warnings.length > 0 ? { warnings } : {}),
    // focusBookMissingRows: ranked rows that fell back to a different book
    // because the focus book had no price. Surfaced as a top-level field
    // (not inside result[]) so callers filtering result by tier ("all TIER 1
    // bets on NoVigApp") get only rows executable on the focus book. Use
    // --focus-book-only to hide this field.
    ...(ranked.focusBookMissingRows ? { focusBookMissingRows: ranked.focusBookMissingRows } : {}),
    resultMeta: {
      ...buildResultMeta({
        targetBook,
        sharpBooks,
        lookbackHoursUsed,
        debug,
        freshness,
        warnings,
        compact,
        fields,
        args,
        ranked,
        compactFields: COMPACT_FIELDS,
        preHistoryShortlistMeta,
        unresolvedRows,
        preHistoryRecoveryMeta,
        preHydrationAltPruned,
        historyTimedOut,
        sourceRowCount: rows.length
      }),
      ...resultMeta,
      ...cardWindowMeta
    },
    ...(league ? { league } : {})
  };

  return finalizeRankedScreenResponse(baseResponse, includeList, stripEmptyFields);
}

module.exports = {
  buildRankedScreenResponse,
  buildDegradedDataWarnings,
  getIncludeAll,
  getLeagueRankingPreset,
  getLimit,
  getMaxPerMarket,
  getLookbackHours,
  getRecentWindowHours,
  getMaxAgeMs,
  normalizeBookList,
  normalizeSelectionKey,
  buildCanonicalPlayId,
  getDebugFlag,
  getCompactFlag,
  compactRow,
  compactResult,
  filterRowFields,
  COMPACT_FIELDS,
  DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS,
  buildPreHistoryShortlist,
  getPreHistoryShortlistGameBudget,
  hasExplicitGameFilter,
  PRE_HISTORY_SHORTLIST_MAX_GAMES
};
