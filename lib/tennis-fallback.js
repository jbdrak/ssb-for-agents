'use strict';

const { getSharpBookComparisonSet, ALL_SCREEN_BOOKS } = require('./ssb-sharp-books');
const { buildCanonicalPlayId } = require('./ssb-mcp-ranked-screen');
const { summarizeSharpMovement } = require('./ssb-sharp-history');
const { normalizeHistoryPayload } = require('./ssb-history');
const { computeMovementDisposition } = require('./ssb-movement-disposition');

/**
 * Tennis fallback recovery — when the sharp-play pipeline drops all tennis
 * plays (because sharp books don't carry tennis markets), re-query the
 * screen API directly and compute real CLV/movement from multi-book odds history.
 *
 * @module lib/tennis-fallback
 */

const { correctTennisTimes } = require('./ssb-tennis');
const { normalizeTennisMarketQuery } = require('./screen-tennis');
const { parseGameStartMs, americanOddsToImpliedProbability } = require('./ssb-shared-utils');
const { getLocalTimezone, localDateKey, getOddsHistoryLookbackHours } = require('./mcp-runtime-config');

/**
 * Convert American odds to implied probability.
 * @param {number} americanOdds - American odds (e.g. -110, +150)
 * @returns {number} Implied probability 0-1
 */
function impliedProb(americanOdds) {
  return americanOddsToImpliedProbability(americanOdds);
}

/**
 * Compute CLV (Closing Line Value) from odds history entries.
 * Returns the change in implied probability from earliest to latest odds,
 * along with the opening and current odds used in the calculation.
 * Positive CLV = line moved toward this selection (supportive).
 * @param {Array<Object>} history - Array of {odds, start_ts} entries
 * @returns {{clv: number, openingOdds: number, currentOdds: number}|null} CLV result or null if insufficient data
 */
function computeClvFromHistory(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const sorted = [...history].sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
  const openOdds = sorted[0].odds;
  const currentOdds = sorted[sorted.length - 1].odds;
  if (!openOdds || !currentOdds || openOdds === 0) return null;
  return { clv: (impliedProb(currentOdds) - impliedProb(openOdds)) * 100, openingOdds: openOdds, currentOdds };
}

/**
 * Derive movement disposition from CLV.
 * @param {number|null} clv - CLV percentage
 * @returns {string} Movement disposition label
 */
function deriveMovementFromClv(clv) {
  if (clv === null || clv === undefined) return 'insufficient';
  if (clv > 2) return 'supportive_clean';
  if (clv > 0) return 'supportive_bouncy';
  if (clv < -2) return 'adverse_full';
  if (clv < 0) return 'adverse_recent';
  return 'insufficient'; // exactly 0 = flat, no signal
}

/**
 * Map movement disposition to verdict.
 * Only supportive movement surfaces as BET. Adverse movement (even recent)
 * and insufficient data all map to CONSIDER.
 * @param {string} movementDisposition - Movement disposition label
 * @returns {'BET'|'CONSIDER'} Verdict
 */
function verdictFromDisposition(movementDisposition) {
  if (movementDisposition === 'supportive_clean' || movementDisposition === 'supportive_bouncy') return 'BET';
  return 'CONSIDER';
}

/**
 * Assign tier based on CLV magnitude and book count.
 * @param {number|null} clv - CLV percentage
 * @param {number} bookCount - Number of books with data
 * @returns {string} Tier label
 */
function assignTierFromClv(clv, bookCount) {
  if (clv === null) return 'TIER 2';
  const absClv = Math.abs(clv);
  // TIER 1 is the lock tier — it requires movement IN OUR FAVOR. Grading on
  // |CLV| alone let an adverse line (CLV -4) ship as TIER 1 while its verdict
  // was CONSIDER. Mirror the verdict ladder (CONSIDER -> TIER 3) on the
  // adverse side so tier and verdict can never contradict each other.
  if (clv < 0) return 'TIER 3';
  if (absClv >= 3 && bookCount >= 2) return 'TIER 1';
  if (absClv >= 1.5) return 'TIER 1';
  if (absClv >= 0.5) return 'TIER 2';
  return 'TIER 2';
}

/**
 * Check if a tennis market+selection pair is an alternate (expanded) line.
 *
 * Policy (aligned with alternate-line-filter.js and screen-ranker.js):
 * - Moneyline: never alternate (keep regardless of price)
 * - Total Games: always standard (keep all)
 * - Set Handicap: standard set lines are retained
 * - Game Handicap: standard lines are ±1.5 and ±2.5; anything beyond ±2.5
 *   is an expanded alternate and gets filtered out
 *
 * @param {string} market - Market name (e.g. 'Moneyline', 'Game Handicap', 'Set Handicap', 'Total Games')
 * @param {string} selection - Selection text (e.g. 'Djokovic -1.5', 'Over 22.5')
 * @returns {boolean} True if this is an alternate line that should be dropped
 */
function isTennisAlternateLine(market, selection) {
  if (market === 'Moneyline') return false;
  if (market === 'Total Games') return false;
  if (market === 'Game Handicap') {
    const match = String(selection || '').match(/(\d+\.?\d*)/);
    if (!match) return false; // can't determine, keep it
    const lineNumber = parseFloat(match[1]);
    return lineNumber > 2.5;
  }
  return false;
}

function createFallbackPlay({
  game,
  market,
  selection,
  side,
  selectionId,
  odds,
  book,
  clv,
  movementDisposition,
  bookCount,
  clvSource,
  openingOdds,
  currentOdds,
  movementSourceBook,
  movementMode,
  movementLabel,
  recentClvPct,
  recentSharpMoveDirection,
  fullWindowSharpMoveDirection
}) {
  const roundedClv = clv !== null ? Math.round(clv * 10) / 10 : 0;
  return {
    game: `${game.awayTeam || ''} vs ${game.homeTeam || ''}`,
    gameId: game.gameId,
    league: 'Tennis',
    market,
    start: game.start,
    scheduledStart: game.start,
    selection: selection[`selection${side}`],
    participant: selection[`participant${side}`] || selection[`selection${side}`],
    selectionId,
    playId: buildCanonicalPlayId({
      gameId: game.gameId,
      market,
      selection: selection[`selection${side}`]
    }),
    odds,
    book,
    tier: assignTierFromClv(clv, bookCount),
    verdict: verdictFromDisposition(movementDisposition),
    movementDisposition,
    edge: roundedClv,
    clvProxyPct: roundedClv,
    openingOdds,
    currentOdds,
    movementSourceBook,
    movementMode,
    movementLabel,
    recentClvPct,
    recentSharpMoveDirection,
    fullWindowSharpMoveDirection,
    source: clvSource ? `tennis_fallback (${clvSource})` : 'tennis_fallback'
  };
}

/**
 * @param {Object} client - PP API client
 * @param {string} gameId - Game identifier
 * @param {string} selectionId - Selection identifier
 * @param {Object} [options={}] - Movement lookup options
 * @param {string} [options.preferredBook] - Preferred execution book
 * @param {number} [options.lookbackHours] - Odds history lookback window
 * @param {string} [options.market] - Tennis market name
 */
async function getSelectionMovement(client, gameId, selectionId, { preferredBook, lookbackHours, market } = {}) {
  const empty = {
    clv: null,
    movementDisposition: 'insufficient',
    bookCount: 0,
    clvSource: null,
    openingOdds: null,
    currentOdds: null,
    movementSourceBook: null,
    movementMode: 'none',
    movementLabel: 'insufficient_history',
    recentClvPct: null,
    recentSharpMoveDirection: 'insufficient_history',
    fullWindowSharpMoveDirection: 'insufficient_history'
  };
  if (!selectionId || !gameId) return empty;
  try {
    const sharpBooks = getSharpBookComparisonSet({ league: 'Tennis', market });
    const sportsbooks = Array.from(new Set([...sharpBooks, preferredBook].filter(Boolean)));
    const preferredIsSharpBook = Boolean(preferredBook) && sharpBooks.includes(preferredBook);
    const history = await client.queryOddsHistory({
      gameId,
      selectionId,
      sportsbooks,
      lookbackHours: getOddsHistoryLookbackHours(lookbackHours)
    });
    const lineHistory = normalizeHistoryPayload(
      Object.fromEntries(
        Object.entries(history || {}).map(([book, points]) => [
          book,
          (Array.isArray(points) ? points : []).map((point) => ({ ...point, book }))
        ])
      )
    );
    const movement = summarizeSharpMovement({
      lineHistory,
      preferredBook,
      sharpBooks,
      options: { recentWindowHours: 6, allowMixedFallback: true }
    });
    const movementDisposition = computeMovementDisposition({
      ...movement,
      movementGrade: movement.movementQuality === 'high' ? 'green' : 'yellow'
    });
    const executionMovement = summarizeSharpMovement({
      lineHistory,
      preferredBook,
      sharpBooks: preferredIsSharpBook ? [] : sharpBooks,
      options: { recentWindowHours: 6, allowMixedFallback: false }
    });
    const executionConflict = executionMovement.movementLabel === 'adverse';
    const finalMovementDisposition = executionConflict ? 'adverse_full' : movementDisposition;
    const bookCount = new Set(lineHistory.map((point) => point.book)).size;
    return {
      ...empty,
      clv: movement.clvProxyPct,
      movementDisposition: finalMovementDisposition,
      bookCount,
      clvSource: movement.movementSourceBook,
      openingOdds: movement.openingOdds,
      currentOdds: movement.currentOdds,
      movementSourceBook: movement.movementSourceBook,
      movementMode: movement.movementMode,
      movementLabel: movement.movementLabel,
      recentClvPct: movement.recentClvPct,
      recentSharpMoveDirection: movement.recentSharpMoveDirection,
      fullWindowSharpMoveDirection: movement.fullWindowSharpMoveDirection
    };
  } catch {
    return empty;
  }
}

/**
 * Resolve opposite-side conflicts per (gameId, market) group.
 *
 * Defense-in-depth: ensures that both sides of the same market (e.g. both
 * Djokovic ML and Alcaraz ML) never both surface as BET. The primary
 * protection is verdictFromDisposition — adverse CLV always maps to
 * CONSIDER — but this step catches any edge case where the primary
 * logic would still produce a duplicate.
 *
 * @param {Array<Object>} plays - Array of play objects (mutated in-place)
 * @returns {Array<Object>} Same array with conflicts resolved
 */
function resolveOppositeSideConflicts(plays) {
  if (!Array.isArray(plays)) return plays;

  // Group BET plays by (gameId, market)
  const groups = new Map();
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    if (p.verdict !== 'BET') continue;
    const key = `${p.gameId}|${p.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }

  for (const [, indices] of groups) {
    if (indices.length <= 1) continue;

    // Sort: prefer supportive_clean > supportive_bouncy, then higher absolute CLV
    const sorted = [...indices].sort((aIdx, bIdx) => {
      const a = plays[aIdx];
      const b = plays[bIdx];
      const aScore = a.movementDisposition === 'supportive_clean' ? 2 : 1;
      const bScore = b.movementDisposition === 'supportive_clean' ? 2 : 1;
      if (bScore !== aScore) return bScore - aScore;
      return Math.abs(b.clvProxyPct || 0) - Math.abs(a.clvProxyPct || 0);
    });

    const winnerIdx = sorted[0];
    const winnerPlay = plays[winnerIdx];
    for (let i = 1; i < sorted.length; i++) {
      const loserIdx = sorted[i];
      const loser = plays[loserIdx];
      loser.verdict = 'CONSIDER';
      loser.conflictResolved = true;
      loser.conflictNote = `Opposite side "${winnerPlay.selection}" (${winnerPlay.movementDisposition}, CLV=${winnerPlay.clvProxyPct}) kept as BET`;
    }
  }

  return plays;
}

/**
 * Default history-call budget for a DIRECT tennis-only fallback. Still well
 * inside the shared odds-history window (default 300 calls per 5 min, env
 * PP_ODDS_HISTORY_BUDGET — which also serves the caller's own hydration),
 * and the effective budget is clamped to what actually remains in the window
 * at call time — never hundreds of blind attempts.
 */
const DEFAULT_MAX_HISTORY_SELECTIONS = 300;

// Headroom kept under the shared odds-history window when the fallback sizes
// itself from the client's remaining budget (covers pacing stragglers).
const HISTORY_REMAINING_MARGIN = 2;

// American odds considered "playable" for shortlist prioritization.
const PLAYABLE_ODDS_MIN = -500;
const PLAYABLE_ODDS_MAX = 400;

/**
 * Cheap current-market-only score for one selection side (never calls
 * history). Higher = more worth hydrating:
 * - consensus edge proxy: how much better the target book's implied
 *   probability is than the multi-book consensus (positive = underpriced)
 * - book coverage bonus (up to 2 books)
 * - target-book playable-price bonus
 *
 * @param {Object} oddsMap - sel.odds: book -> { odds1, odds2 }
 * @param {'odds1'|'odds2'} sideKey - Which side of the entry to score.
 * @param {string} targetBook - Execution book (e.g. NoVigApp).
 * @returns {number} Score (negative Infinity when no usable odds).
 */
function scoreSelectionSide(oddsMap, sideKey, targetBook) {
  if (!oddsMap || typeof oddsMap !== 'object') return -Infinity;
  let count = 0;
  let sumIp = 0;
  let targetIp = null;
  let targetOdds = null;
  const targetBookLower = String(targetBook || '')
    .trim()
    .toLowerCase();
  for (const [bookName, value] of Object.entries(oddsMap)) {
    const odds = Number(value?.[sideKey]);
    if (!Number.isFinite(odds) || odds === 0) continue;
    count += 1;
    sumIp += impliedProb(odds);
    if (bookName.toLowerCase() === targetBookLower) {
      targetIp = impliedProb(odds);
      targetOdds = odds;
    }
  }
  if (count === 0) return -Infinity;
  const consensusIp = sumIp / count;
  // Positive when the target book's price implies LESS probability than the
  // consensus — i.e. the target price is better than the market.
  let score = targetIp !== null ? (consensusIp - targetIp) * 100 : 0;
  score += Math.min(2, count) * 0.5;
  if (targetIp !== null) {
    score += 1;
    if (targetOdds >= PLAYABLE_ODDS_MIN && targetOdds <= PLAYABLE_ODDS_MAX) score += 0.5;
  }
  return score;
}

/**
 * Score a full selection entry (both sides) using cheap current-market data.
 * @param {Object} sel - Screen selection entry (selection1/2, odds map).
 * @param {string} market - Market name.
 * @param {string} targetBook - Execution book.
 * @returns {number} Entry score.
 */
function scoreSelectionEntry(sel, market, targetBook) {
  const oddsMap = sel?.odds;
  const s1 = scoreSelectionSide(oddsMap, 'odds1', targetBook);
  const s2 = scoreSelectionSide(oddsMap, 'odds2', targetBook);
  const sides = [s1, s2].filter((score) => Number.isFinite(score));
  if (sides.length === 0) return -Infinity;
  // Both sides priced (paired market) is worth slightly more — opposite-side
  // awareness only exists when we hydrate both.
  return Math.max(...sides) + (sides.length === 2 ? 0.25 : 0);
}

/**
 * Filter tennis games to a local calendar card window.
 * @param {Object[]} rows - Raw tennis game rows.
 * @param {string} cardWindow - 'today', 'next', or 'all'.
 * @param {Object} [options]
 * @param {number} [options.nowMs] - Timestamp override for deterministic tests.
 * @param {string} [options.timezone] - IANA timezone override.
 * @returns {Object[]} Rows in the requested window.
 */
function filterTennisRowsByCardWindow(rows, cardWindow, { nowMs = Date.now(), timezone } = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const window = String(cardWindow || 'all')
    .trim()
    .toLowerCase();
  if (window === 'all') return sourceRows;
  if (window !== 'today' && window !== 'next') return sourceRows;

  const tz = timezone || getLocalTimezone();
  const todayKey = localDateKey(nowMs, tz);
  const nextKey = localDateKey(nowMs + 24 * 60 * 60 * 1000, tz);
  const targetKey = window === 'today' ? todayKey : nextKey;

  return sourceRows.filter((row) => {
    const raw = row?.start ?? row?.startTime ?? row?.startTimestamp;
    const dateOnly = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? raw.trim() : null;
    // Date-only values represent a calendar date, not UTC midnight. Keep the
    // date key directly and use noon UTC only for the finite timestamp check.
    const startMs = dateOnly ? Date.parse(`${dateOnly}T12:00:00.000Z`) : parseGameStartMs(raw);
    if (!Number.isFinite(startMs)) return false;
    return (dateOnly || localDateKey(startMs, tz)) === targetKey;
  });
}

function coerceTennisGameRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of ['game_data', 'rows', 'data', 'result', 'results', 'games']) {
    if (payload[key] === undefined) continue;
    const rows = coerceTennisGameRows(payload[key]);
    if (rows.length) return rows;
  }

  const values = Object.values(payload);
  if (
    values.length > 0 &&
    values.every(
      (value) =>
        value && typeof value === 'object' && !Array.isArray(value) && (value.gameId || value.id || value.selections)
    )
  ) {
    return values;
  }
  return [];
}

async function collectTennisFallbackCandidates({ client, book, markets, cardWindow }) {
  const candidatesByMarket = new Map();
  let totalCandidates = 0;
  let screenRows = 0;
  let targetBookSelections = 0;
  for (const market of markets) {
    const data = await client.queryScreenOdds({
      league: 'Tennis',
      market,
      books: ALL_SCREEN_BOOKS,
      is_live: false
    });
    const games = coerceTennisGameRows(data);
    screenRows += games.length;
    for (const game of filterTennisRowsByCardWindow(games, cardWindow)) {
      if (!game.selections) continue;
      for (const sel of Object.values(game.selections)) {
        const bookOdds = sel?.odds?.[book];
        if (!bookOdds) continue;
        targetBookSelections += 1;
        const odds1 = bookOdds.odds1;
        const odds2 = bookOdds.odds2;
        if (!odds1 && !odds2) continue;
        const selection1 = odds1 ? sel.selection1 : null;
        const selection2 = odds2 ? sel.selection2 : null;
        // Drop only expanded alternate lines (Game Handicap beyond ±2.5).
        // Standard lines — Moneyline, GH ±1.5/±2.5, all Total Games and Set
        // Handicap rows — are always kept regardless of book coverage.
        if (odds1 && selection1 && isTennisAlternateLine(market, selection1)) continue;
        if (odds2 && selection2 && isTennisAlternateLine(market, selection2)) continue;
        const entry = {
          game,
          market,
          sel,
          odds1: odds1 || null,
          odds2: odds2 || null,
          // Per-side current-market scores let an odd side budget hydrate the
          // strongest side of a pair instead of the first one encountered.
          sideScores: {
            s1: scoreSelectionSide(sel?.odds, 'odds1', book),
            s2: scoreSelectionSide(sel?.odds, 'odds2', book)
          },
          score: scoreSelectionEntry(sel, market, book)
        };
        if (!candidatesByMarket.has(market)) candidatesByMarket.set(market, []);
        candidatesByMarket.get(market).push(entry);
        totalCandidates += 1;
      }
    }
  }
  return { candidatesByMarket, totalCandidates, screenRows, targetBookSelections };
}

/**
 * @param {Object} opts
 * @param {Object} opts.client - PP API client
 * @param {string} opts.book - Target book name
 * @param {string|string[]} [opts.markets] - Explicit market(s) to query; defaults to the preferred Tennis markets
 * (Moneyline, Total Games, Set Handicap). Game Handicap remains explicit-only.
 * @param {string} [opts.cardWindow='all'] - Local card window ('today', 'next', or 'all').
 * @param {boolean} [opts.skipTimeCorrection=false] - Skip ESPN time correction (testing only)
 * @param {number} [opts.maxHistorySelections=60] - HARD cap on the number of
 * @param {number} [opts.lookbackHours] - Odds history lookback window
 * SELECTION SIDES (history calls) hydrated. Selection entries carry both
 * sides, so up to ceil(maxHistorySelections / 2) entries are selected and
 * hydration stops the moment the side budget is reached — actual history
 * calls never exceed maxHistorySelections. The effective budget is
 * additionally clamped to what remains in the client's shared odds-history
 * window minus HISTORY_REMAINING_MARGIN, so a mixed all-sport scan can
 * never push the combined quick-screen + validation + fallback spend past
 * the shared odds-history budget (default 300 calls per 5 min, env
 * PP_ODDS_HISTORY_BUDGET).
 * @returns {Promise<Array<Object>>} Tennis plays with computed CLV/movement.
 *   A non-enumerable `fallbackMeta` property carries shortlist accounting
 *   ({totalCandidates, hydratedEntries, historyCalls, skippedEntries,
 *   maxHistorySelections, effectiveMaxHistorySelections, markets}).
 */
async function recoverTennisFromScreen({
  client,
  book,
  markets: requestedMarkets,
  cardWindow = 'all',
  skipTimeCorrection = false,
  maxHistorySelections = DEFAULT_MAX_HISTORY_SELECTIONS,
  lookbackHours
}) {
  const explicitMarkets = requestedMarkets
    ? (Array.isArray(requestedMarkets) ? requestedMarkets : [requestedMarkets]).filter((market) =>
        String(market).trim()
      )
    : [];
  const markets = [
    ...new Set(
      (explicitMarkets.length ? explicitMarkets : ['Moneyline', 'Total Games', 'Set Handicap']).flatMap((market) =>
        normalizeTennisMarketQuery(market)
      )
    )
  ];

  // Effective budget: caller's declared cap, clamped to what the shared
  // odds-history window actually has left (minus a small margin). This keeps
  // the fallback fitting alongside quick-screen hydration + validation in a
  // mixed-sport scan without hard-coding pair counts.
  const remaining =
    typeof client?.oddsHistoryBudgetRemaining === 'function' ? Number(client.oddsHistoryBudgetRemaining()) : null;
  const effectiveMax = Number.isFinite(remaining)
    ? Math.max(0, Math.min(maxHistorySelections, remaining - HISTORY_REMAINING_MARGIN))
    : maxHistorySelections;
  // The budget is in SELECTION SIDES (one history call per side). Entries
  // carry both sides, so pick enough entries to fill an odd budget, then
  // hydrate sides until the side budget is hit — effectiveMax=1 must yield
  // exactly ONE history call, never a paired double-hydration.
  const entryBudget = effectiveMax > 0 ? Math.ceil(effectiveMax / 2) : 0;

  const { candidatesByMarket, totalCandidates, screenRows, targetBookSelections } =
    await collectTennisFallbackCandidates({
      client,
      book,
      markets,
      cardWindow
    });

  // ── Phase 2: GLOBAL shortlist across markets — cheap current-market
  //    signals only. Each market's entries are sorted best-first, then a
  //    round-robin picks one entry per market per pass so no market is
  //    starved, while the best edge/coverage candidates consume the budget
  //    before weaker ones. Whole entries (paired sides) travel together so
  //    opposite-side conflict resolution stays meaningful.
  const marketKeys = [...candidatesByMarket.keys()];
  for (const list of candidatesByMarket.values()) {
    list.sort((a, b) => b.score - a.score);
  }
  const selected = [];
  while (selected.length < entryBudget) {
    let took = false;
    for (const marketKey of marketKeys) {
      if (selected.length >= entryBudget) break;
      const list = candidatesByMarket.get(marketKey);
      if (!list || list.length === 0) continue;
      selected.push(list.shift());
      took = true;
    }
    if (!took) break;
  }

  // ── Phase 3: hydrate only the bounded candidates ──
  // The side budget (effectiveMax) is the HARD limit on history calls. An
  // odd budget hydrates the strongest side of the next entry; hydration
  // stops the instant the budget is spent.
  const plays = [];
  let historyCalls = 0;
  for (const entry of selected) {
    if (historyCalls >= effectiveMax) break;
    const sides = [];
    if (entry.odds1 && entry.sel.selection1) sides.push({ side: 1, score: entry.sideScores.s1 });
    if (entry.odds2 && entry.sel.selection2) sides.push({ side: 2, score: entry.sideScores.s2 });
    sides.sort((a, b) => b.score - a.score);
    for (const { side } of sides) {
      if (historyCalls >= effectiveMax) break;
      historyCalls += 1;
      const movement = await getSelectionMovement(
        client,
        entry.game.gameId,
        side === 1 ? entry.sel.selection1Id : entry.sel.selection2Id,
        { preferredBook: book, lookbackHours, market: entry.market }
      );
      plays.push(
        createFallbackPlay({
          game: entry.game,
          market: entry.market,
          selection: entry.sel,
          side,
          selectionId: side === 1 ? entry.sel.selection1Id : entry.sel.selection2Id,
          odds: side === 1 ? entry.odds1 : entry.odds2,
          book,
          ...movement
        })
      );
    }
  }

  // Defense-in-depth: ensure opposite sides of same market never both BET
  resolveOppositeSideConflicts(plays);

  // Correct tennis start times via ESPN before returning
  if (plays.length > 0 && !skipTimeCorrection) {
    await correctTennisTimes(plays);
  }

  Object.defineProperty(plays, 'fallbackMeta', {
    value: {
      totalCandidates,
      screenRows,
      targetBookSelections,
      hydratedEntries: selected.length,
      skippedEntries: totalCandidates - selected.length,
      // Actual selection-side history calls made (never exceeds effectiveMax).
      historyCalls,
      maxHistorySelections,
      effectiveMaxHistorySelections: effectiveMax,
      markets
    },
    enumerable: false,
    writable: false,
    configurable: false
  });

  return plays;
}

module.exports = {
  recoverTennisFromScreen,
  filterTennisRowsByCardWindow,
  computeClvFromHistory,
  deriveMovementFromClv,
  verdictFromDisposition,
  assignTierFromClv,
  isTennisAlternateLine,
  resolveOppositeSideConflicts
};
