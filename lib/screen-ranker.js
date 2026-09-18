'use strict';
const { getSharpBookComparisonSet, getSharpBookContext } = require('./ssb-sharp-books');
const { arbMarginForRow } = require('./arb-scan');
const { summarizeSharpMovement } = require('./ssb-sharp-history');
const { detectSteamMove } = require('./ssb-steam-move');
const { computeMultiWindowScore } = require('./ssb-sharp-consensus');
const { computeMovementDisposition } = require('./ssb-movement-disposition');
const DEBUG = process.env.SSB_DEBUG === 'true';
/* eslint-disable max-lines -- legacy ranking module is being decomposed incrementally. */

const {
  gradeMovementQuality,
  calculateRiskScore,
  getKaiCall,
  getConfidenceTier,
  getConfidenceTierStable,
  getTierTrajectory,
  buildRationale
} = require('./ssb-risk-score');
const {
  americanOddsToImpliedProbability,
  average,
  matchesPreferredBook,
  normalizeLeagueName,
  normalizeMarketName
} = require('./ssb-shared-utils');
const { extractHistoryTrail, extractNumericTrailValue, extractRowFreshnessInfo } = require('./screen-parser');
const { resolveAlternateLines } = require('./alternate-line-filter');
const { expandScreenRow, isEdgePlausible } = require('./screen-row-expander');

const { getLeagueConfig } = require('./league-presets');
const {
  getScreenSelection,
  getResolvedScreenSelection,
  resolveExtractedScreenSide,
  oddsMapForRow
} = require('./selection-resolver');

/**
 * Get the tennis market name from a row, normalized.
 * @param {Object} row - Row data with market/selection/playType fields.
 * @returns {string} Normalized market name.
 */
function getTennisMarketName(row) {
  return normalizeMarketName(row?.market || row?.selection || row?.playType || row?.betType || '');
}

/**
 * Get the ranking preset configuration for a league and market combination.
 * Combines static league config (from league-presets.js) with dynamic sharp book data.
 * @param {string} league - League name.
 * @param {string} market - Market name.
 * @returns {Object} League ranking preset with league, displayName, preferredBooks, minimumScore, marketPriorities.
 */
function getLeagueRankingPreset(league, market) {
  const normalizedLeague = normalizeLeagueName(league);
  const config = getLeagueConfig(normalizedLeague);
  const sharpBooks = getSharpBookComparisonSet({ league: normalizedLeague, market });
  const sharpContext = getSharpBookContext({ league: normalizedLeague, market });

  return {
    league: normalizedLeague || 'NBA',
    displayName: config.displayName,
    preferredBooks: sharpBooks,
    sharpBookContext: sharpContext,
    minimumScore: config.minimumScore,
    marketPriorities: config.marketPriorities
  };
}

/**
 * Check if a row passes the league ranking gate (minimum score threshold + signal requirement).
 * @param {{ score: number, hasConsensus: boolean, hasLineMovement: boolean, leaguePreset: Object, marketHintMatch: string|null }} params - Gate parameters.
 * @returns {{ passed: boolean, reason: string }}
 */
function passesLeagueRankingGate({ score, hasConsensus, hasLineMovement, leaguePreset, marketHintMatch }) {
  const minimumScore = Number(leaguePreset?.minimumScore);
  const hardFloor = Number.isFinite(minimumScore) ? minimumScore : 1.75;
  const hasSignal = Boolean(hasConsensus || hasLineMovement || marketHintMatch);
  if (!hasSignal) {
    return { passed: false, reason: 'no consensus, CLV, or market fit signal' };
  }
  if (!Number.isFinite(score)) {
    return { passed: false, reason: 'score unavailable' };
  }
  if (score < hardFloor) {
    return { passed: false, reason: `score ${score.toFixed(2)} below ${hardFloor.toFixed(2)} gate` };
  }
  return { passed: true, reason: `score ${score.toFixed(2)} passed ${hardFloor.toFixed(2)} gate` };
}

/**
 * Get the market priority score for a market within a league preset.
 * @param {Object} preset - League ranking preset with marketPriorities array.
 * @param {string} marketText - Market name text to match.
 * @returns {{ match: string, weight: number }|null} Matching priority entry or null.
 */
function getMarketPriorityScore(preset, marketText) {
  const normalizedMarket = String(marketText || '').toLowerCase();
  const priority = (preset?.marketPriorities || []).find((item) => normalizedMarket.includes(item.match));
  return priority || null;
}

/**
 * Filter rows by league name.
 * @param {Array<Object>} rows - Array of row objects with league/sport/gameType fields.
 * @param {string} league - League name to filter by.
 * @returns {Array<Object>} Filtered rows.
 */
function filterRowsByLeague(rows, league) {
  const normalizedLeague = normalizeLeagueName(league);
  if (!normalizedLeague) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || typeof row !== 'object') return false;
    const rowLeague = normalizeLeagueName(row.league || row.sport || row.gameType || '');
    if (rowLeague === normalizedLeague) return true;
    return false;
  });
}

/**
 * Detect when a row's selection is the opposite side of the matchup.
 * The line history stores odds for the primary participant (selection1) only.
 * When we're ranking a row for selection2, the CLV direction must be inverted
 * — a sharp move toward selection2 appears as negative CLV in selection1's odds.
 * @param {Object} row - Expanded screen row.
 * @returns {boolean}
 */
function isOppositeSide(row) {
  if (!row) return false;
  // The expanded row has selection set by expandScreenRow to the resolved side.
  const currentSelection = String(row.selection || '')
    .toLowerCase()
    .trim();
  if (!currentSelection) return false;
  // Guard: if the row's own selectionId contains its selection name, the history
  // was fetched for THIS side. Never invert when history belongs to the same side
  // (even if selection matches selection2 — both sides of a moneyline get
  // their own history IDs).
  const selectionId = String(row.selectionId || row.normalizedSelectionId || '')
    .toLowerCase()
    .replace(/[_\s-]+/g, '_');
  if (selectionId && selectionId.includes(currentSelection.replace(/[\s-]+/g, '_'))) {
    return false;
  }
  // Check if this matches selection2 (opposite of the primary participant).
  const sel2 = String(row.selection2 || '')
    .toLowerCase()
    .trim();
  if (sel2 && sel2 === currentSelection) return true;
  // Also check the nested selections map for multi-way support.
  const selections = row.selections;
  if (selections && typeof selections === 'object') {
    for (const key of Object.keys(selections)) {
      const sel = selections[key];
      if (sel && typeof sel === 'object') {
        const nestedSel2 = String(sel.selection2 || '')
          .toLowerCase()
          .trim();
        if (nestedSel2 && nestedSel2 === currentSelection) return true;
      }
    }
  }
  return false;
}

/**
 * Assign reason codes to a ranked row based on its movement, consensus, edge,
 * and CLV signals. Codes are compact machine-readable strings for agent-driven
 * filtering — the existing `rationale` field remains the human-readable version.
 *
 * @param {Object} item - Expanded and scored item from rankScreenRows.
 * @returns {string[]} Array of reason code strings.
 */
function assignReasonCodes(item) {
  const codes = [];
  const { row = {} } = item;
  const movementSummary = item.movementSummary || row.movementSummary || {};
  const movLabel = String(movementSummary.movementLabel || '').toLowerCase();
  const cbk = Number(item.consensusBookCount || row.consensusBookCount || 0);
  const edge = Number(item.consensusEdge || row.consensusEdge || 0);
  const clv = Number(movementSummary.recentClvPct ?? row.clvProxyPct ?? 0);

  // Movement direction
  if (movLabel.includes('supportive')) codes.push('SUPPORTIVE_MOVEMENT');
  if (movLabel.includes('adverse')) codes.push('ADVERSE_MOVEMENT');
  if (movLabel.includes('bouncy')) codes.push('BOUNCY_MOVEMENT');
  if (movLabel.includes('insufficient')) codes.push('INSUFFICIENT_HISTORY');

  // Consensus depth
  if (cbk >= 8) codes.push('CONSENSUS_8_PLUS');
  else if (cbk >= 3) codes.push('CONSENSUS_3_TO_7');
  else if (cbk >= 1) codes.push('CONSENSUS_1_TO_2');

  // Edge
  if (edge > 2) codes.push('EDGE_SIGNIFICANT');
  else if (edge > 0) codes.push('EDGE_POSITIVE');

  // CLV
  if (clv > 0) codes.push('CLV_POSITIVE');
  if (clv < 0) codes.push('CLV_NEGATIVE');

  return codes;
}

/** @type {number} Minimum consensus books to keep Tier 1 without exemption */
const TIER1_MIN_CONSENSUS_BOOKS = 2;
/** @type {number} Edge threshold (percentage points) for single-book Tier 1 exemption */
const TIER1_SINGLE_BOOK_EDGE_EXEMPTION = 2.5;

/**
 * Downgrade Tier 1 plays that come from too few consensus books.
 * Reduces false positives from single-book movements that look strong
 * but lack independent confirmation.
 *
 * Runs AFTER tier assignment but BEFORE resolveGameConflicts so
 * downgraded rows participate in conflict resolution at their new tier.
 *
 * @param {Array} ranked - Array of ranked row objects (mutated in-place).
 */
function applyConsensusFloorGuard(ranked) {
  if (!Array.isArray(ranked)) return;
  for (const row of ranked) {
    if (row.confidenceTier !== 'TIER 1') continue;
    const cbk = Number(row.consensusBookCount || 0);
    if (cbk >= TIER1_MIN_CONSENSUS_BOOKS) continue;

    // Single/thin-book Tier 1: exempt when edge is exceptional (2.5%+)
    // AND movement is supportive (not bouncy or adverse).
    // This catches plays with real consensus edge but thinner book counts
    // (common in MLB totals where fewer books price each line).
    const edge = Number(row.consensusEdge || 0);
    const mov = String(row.movementDisposition || '').toLowerCase();
    if (edge >= TIER1_SINGLE_BOOK_EDGE_EXEMPTION && mov.includes('supportive') && !mov.includes('bouncy')) {
      row.consensusExempted = true;
      row.consensusFloorReason = `Single-book Tier 1: edge=${edge.toFixed(1)}% keeps it at top despite only ${cbk} book${cbk === 1 ? '' : 's'}.`;
      continue;
    }

    // Downgrade
    row.consensusFloorApplied = true;
    row.consensusFloorReason = `Downgraded from Tier 1: only ${cbk} consensus book${cbk === 1 ? '' : 's'}.`;
    row.confidenceTier = 'TIER 3';
    row.displayTier = 'TIER 3';
    row.kaiCall = 'CONSIDER';
  }
}

/**
 * Game-level mutual-exclusivity guard.
 *
 * The ranker assigns a tier to every (game, market, selection) row in
 * isolation — it never learns that two rows are opposite outcomes of the
 * same game. So Guardians -1.5 (run line) and Twins ML can both come back
 * TIER 1 even though they're mutually exclusive: only one can win.
 *
 * resolveGameConflicts walks the already-ranked rows and, per gameId, keeps
 * the single best SIDE-market row (by tier, then consensus edge, then screen
 * score) and downgrades every opposing-side row by one tier + one kaiCall
 * step. The downgraded row keeps a `conflictWith` pointer and a `conflictFlag`
 * so the user can see why it was demoted instead of it silently vanishing.
 */
const SIDE_MARKETS = new Set([
  'moneyline',
  'run line',
  'point spread',
  'spread',
  'draw no bet',
  'match handicap',
  'game handicap'
]);

function isSideMarket(market) {
  if (!market) return false;
  return SIDE_MARKETS.has(String(market).toLowerCase().trim());
}

/**
 * Strip a line/handicap suffix and parenthetical tags from a selection so the
 * same team normalizes identically across markets.
 *   "Cleveland Guardians -1.5" → "cleveland guardians"
 *   "Minnesota Twins"          → "minnesota twins"
 *   "Morocco (Draw No Bet)"    → "morocco"
 * Totals ("Under 168.5") are excluded upstream by isSideMarket, so this never
 * runs on them.
 */
function baseTeamFromSelection(selection) {
  let s = String(selection || '').trim();
  if (!s) return '';
  s = s.replace(/\s[+-]?\d+(?:\.\d+)?\s*$/, '');
  s = s.replace(/\s*\(.*\)\s*$/, '');
  return s.trim().toLowerCase();
}

function tierRankToNumber(tier) {
  const m = /^TIER\s*(\d+)$/.exec(String(tier || ''));
  return m ? Number(m[1]) : 99;
}

function resolveGameConflicts(ranked, { debug = false } = {}) {
  if (!Array.isArray(ranked) || ranked.length === 0) return ranked;
  const byGame = new Map();
  for (const row of ranked) {
    if (row.kaiCall === 'PASS') continue; // only resolve actionable conflicts
    if (!isSideMarket(row.market) && !isSideMarket(row.screenMarket)) continue;
    const gameId = String(row.gameId || row.game || '').trim();
    if (!gameId) continue;
    const team = baseTeamFromSelection(row.selection);
    if (!team) continue;
    if (!byGame.has(gameId)) byGame.set(gameId, []);
    byGame.get(gameId).push({ row, team });
  }
  for (const [gameId, entries] of byGame) {
    // Step 1: Intra-team/intra-market dedup.
    // baseTeamFromSelection strips handicaps (e.g. "Rays -1.5" → "rays"),
    // so two rows for the same team at different handicap values end up
    // with the same team key. The cross-team check (Step 2) can't detect
    // this because it only fires when teams.size >= 2.
    //   e.g. "Tampa Bay Rays -1.5" and "Tampa Bay Rays +1.5" in Run Line.
    // Sort so the best entry per (team, market) is retained.
    entries.sort(
      (a, b) =>
        tierRankToNumber(a.row.confidenceTier) - tierRankToNumber(b.row.confidenceTier) ||
        (Number.isFinite(Number(b.row.consensusEdge)) ? Number(b.row.consensusEdge) : -Infinity) -
          (Number.isFinite(Number(a.row.consensusEdge)) ? Number(a.row.consensusEdge) : -Infinity) ||
        Number(b.row.screenScore ?? -999) - Number(a.row.screenScore ?? -999)
    );
    const teamMarketSeen = new Set();
    for (const entry of entries) {
      const market = String(entry.row.market || entry.row.screenMarket || '').toLowerCase();
      const dedupKey = `${entry.team}||${market}`;
      if (teamMarketSeen.has(dedupKey)) {
        const newTier = Math.min(tierRankToNumber(entry.row.confidenceTier) + 1, 4);
        entry.row.confidenceTier = `TIER ${newTier}`;
        entry.row.kaiCall = entry.row.kaiCall === 'BET' ? 'CONSIDER' : 'PASS';
        if (entry.row.displayTier) entry.row.displayTier = entry.row.kaiCall;
        entry.row.conflictWith = '(intra-team duplicate)';
        entry.row.conflictFlag = true;
        if (debug) {
          process.stderr.write(
            `[screen-ranker] gameConflict: intra-team dedup — downgraded duplicate "${entry.row.selection}" ` +
              `→ ${entry.row.confidenceTier} gameId=${gameId} (${market})\n`
          );
        }
      } else {
        teamMarketSeen.add(dedupKey);
      }
    }

    // Step 2: Cross-team conflict resolution (existing logic).
    const teams = new Set(entries.map((e) => e.team));
    if (teams.size < 2) continue; // no opposing sides in this game
    const winner = entries
      .slice()
      .sort(
        (a, b) =>
          tierRankToNumber(a.row.confidenceTier) - tierRankToNumber(b.row.confidenceTier) ||
          (Number.isFinite(Number(b.row.consensusEdge)) ? Number(b.row.consensusEdge) : -Infinity) -
            (Number.isFinite(Number(a.row.consensusEdge)) ? Number(a.row.consensusEdge) : -Infinity) ||
          Number(b.row.screenScore ?? -999) - Number(a.row.screenScore ?? -999)
      )[0];
    for (const { row, team } of entries) {
      if (team === winner.team) continue;
      const newTier = Math.min(tierRankToNumber(row.confidenceTier) + 1, 4);
      row.confidenceTier = `TIER ${newTier}`;
      row.kaiCall = row.kaiCall === 'BET' ? 'CONSIDER' : 'PASS';
      if (row.displayTier) row.displayTier = row.kaiCall;
      row.conflictWith = winner.row.selection;
      row.conflictFlag = true;
      if (debug) {
        process.stderr.write(
          `[screen-ranker] gameConflict: kept "${winner.row.selection}" (${winner.row.confidenceTier}), ` +
            `downgraded "${row.selection}" → ${row.confidenceTier} gameId=${gameId}\n`
        );
      }
    }
  }
  return ranked;
}

/**
 * Totals dedup: per game, only demote when both Over AND Under are present on
 * the same game. Same-direction totals (e.g. Over 168.5 + Over 171.5) are not
 * contradictory — they signal the same market direction at different lines —
 * so both survive. Opposite-direction totals on the same game still resolve to
 * the single best play by consensus edge.
 */
const TOTALS_MARKETS = new Set(['total runs', 'total points', 'total games', 'over/under', 'totals']);

/**
 * Determine a totals row's direction from its selection.
 * @param {Object} row - Ranked row.
 * @returns {'over'|'under'|null} Direction, or null when unknown/ambiguous
 *   (bare total numbers, combined "Over/Under …" picks).
 */
function totalsDirection(row) {
  const selection = String(row?.selection || '')
    .toLowerCase()
    .trim();
  if (selection.startsWith('over/under')) return null;
  if (selection.startsWith('over')) return 'over';
  if (selection.startsWith('under')) return 'under';
  return null;
}

function resolveTotalsConflicts(ranked, { debug = false } = {}) {
  if (!Array.isArray(ranked)) return ranked;
  const gameGroups = new Map();
  for (const row of ranked) {
    const market = String(row.market || row.screenMarket || '').toLowerCase();
    if (!TOTALS_MARKETS.has(market)) continue;
    const gameId = String(row.gameId || row.game || '').trim();
    if (!gameId) continue;
    if (!gameGroups.has(gameId)) gameGroups.set(gameId, []);
    gameGroups.get(gameId).push(row);
  }
  for (const [gameId, rows] of gameGroups.entries()) {
    if (rows.length <= 1) continue;
    // Only actionable rows with a known direction participate in conflict
    // resolution. PASS rows must never win a conflict (they're not plays),
    // and unknown-direction rows (bare totals, combined Over/Under picks)
    // can't be proven contradictory — so neither may be demoted either.
    const actionable = rows.filter((r) => r.kaiCall !== 'PASS' && totalsDirection(r) !== null);
    if (actionable.length <= 1) continue;
    const overPresent = actionable.some((r) => totalsDirection(r) === 'over');
    const underPresent = actionable.some((r) => totalsDirection(r) === 'under');
    if (!overPresent || !underPresent) continue;
    actionable.sort((a, b) => (Number(b.consensusEdge) || 0) - (Number(a.consensusEdge) || 0));
    const [winner] = actionable;
    const winnerDirection = totalsDirection(winner);
    for (const row of actionable) {
      if (row === winner) continue;
      // Same-direction alternates (Over 168.5 + Over 171.5) signal the same
      // direction at different lines — not a contradiction — so only
      // opposing-direction rows are demoted.
      if (totalsDirection(row) === winnerDirection) continue;
      const newTier = Math.min(tierRankToNumber(row.confidenceTier) + 1, 4);
      row.confidenceTier = `TIER ${newTier}`;
      row.kaiCall = row.kaiCall === 'BET' ? 'CONSIDER' : 'PASS';
      if (row.displayTier) row.displayTier = row.kaiCall;
      row.totalsConflictWith = winner.selection;
      if (debug) {
        process.stderr.write(
          `[screen-ranker] totalsDedup: kept "${winner.selection}" (${winner.confidenceTier}), ` +
            `downgraded "${row.selection}" → ${row.confidenceTier} gameId=${gameId}\n`
        );
      }
    }
  }
  return ranked;
}

function buildMovementDebugPayload(item) {
  return {
    movementSourceBook: item.movementSummary.movementSourceBook,
    movementMode: item.movementSummary.movementMode,
    movementLabel: item.movementSummary.movementLabel,
    movementPointCount: item.movementSummary.movementPointCount,
    filteredHistoryPointCount: item.movementSummary.filteredHistoryPointCount,
    droppedHistoryPointCount: item.movementSummary.droppedHistoryPointCount,
    droppedHistoryReasons: item.movementSummary.droppedHistoryReasons,
    movementQuality: item.movementSummary.movementQuality,
    movementQualityScore: item.movementSummary.movementQualityScore,
    lineHistoryUsable: item.movementSummary.lineHistoryUsable,
    lineHistoryQuality: item.movementSummary.lineHistoryQuality,
    openingOdds: item.movementSummary.openingOdds,
    currentOdds: item.movementSummary.currentOdds,
    openToCurrentClvPct: item.movementSummary.openToCurrentClvPct,
    recentClvPct: item.movementSummary.recentClvPct,
    recentWindowHours: item.movementSummary.recentWindowHours,
    recentSharpMoveDirection: item.movementSummary.recentSharpMoveDirection,
    fullWindowSharpMoveDirection: item.movementSummary.fullWindowSharpMoveDirection
  };
}

/**
 * Newest history-point timestamp in a lineHistory array, as an ISO string.
 * History entries carry the time under various keys (`time`, `timestamp`,
 * `start_ts`/`startTs`, raw variants) and in mixed units (ms vs seconds) —
 * normalize defensively. Returns null when no usable timestamp exists.
 */
function latestHistoryTimestampIso(lineHistory) {
  if (!Array.isArray(lineHistory) || !lineHistory.length) return null;
  let latestMs = -Infinity;
  for (const entry of lineHistory) {
    if (!entry || typeof entry !== 'object') continue;
    const candidates = [
      entry.time,
      entry.timestamp,
      entry.start_ts,
      entry.startTs,
      entry.end_ts,
      entry.endTs,
      entry.raw?.start_ts,
      entry.raw?.startTs,
      entry.raw?.time,
      entry.raw?.timestamp
    ];
    for (const value of candidates) {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) continue;
      // Seconds-epoch values (< 1e12) → ms. Anything smaller than 1e9 is
      // not a plausible timestamp — skip it.
      const ms = num < 1e12 ? (num >= 1e9 ? num * 1000 : NaN) : num;
      if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;
    }
  }
  if (!Number.isFinite(latestMs) || latestMs === -Infinity) return null;
  try {
    return new Date(latestMs).toISOString();
  } catch {
    return null;
  }
}

/**
 * Human kickoff description for a row: CT wall time + relative label.
 * PP tennis timestamps are unreliable — tennis rows are flagged
 * startUnverified so callers never trust them for bet timing.
 */
function describeStartTime(startIso, { league = '', isLive = false, nowMs = Date.now() } = {}) {
  const unverified = /^tennis$/i.test(String(league || '').trim());
  const ms = Date.parse(startIso);
  if (!Number.isFinite(ms)) {
    return { startCT: null, startsIn: isLive ? 'LIVE' : null, startUnverified: unverified };
  }
  const startCT = (() => {
    try {
      return (
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago',
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit'
        }).format(new Date(ms)) + ' CT'
      );
    } catch {
      return null;
    }
  })();
  if (isLive) return { startCT, startsIn: 'LIVE', startUnverified: unverified };
  const diffMin = Math.round((ms - nowMs) / 60000);
  let startsIn;
  if (diffMin < 0) startsIn = 'started';
  else if (diffMin < 1) startsIn = 'starting now';
  else if (diffMin < 60) startsIn = `in ${diffMin}m`;
  else if (diffMin < 24 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    startsIn = m ? `in ${h}h ${m}m` : `in ${h}h`;
  } else {
    const d = Math.floor(diffMin / (24 * 60));
    const h = Math.floor((diffMin % (24 * 60)) / 60);
    startsIn = h ? `in ${d}d ${h}h` : `in ${d}d`;
  }
  return { startCT, startsIn, startUnverified: unverified };
}

/**
 * Executability flag for NoVig liquidity (USD fillable on the row's side).
 * James bets ~$50-100 a ticket: under $100 you may not fill cleanly,
 * over $1000 you can fire freely. Missing/zero liquidity (book doesn't
 * report) returns null — never flag what we don't know.
 */
function describeLiquidity(liquidityUsd) {
  const liq = Number(liquidityUsd);
  if (!Number.isFinite(liq) || liq <= 0) return null;
  if (liq < 100) return 'thin';
  if (liq <= 1000) return 'playable';
  return 'deep';
}

/**
 * Native PP selection-scoped price-history provenance passthrough.
 * Price history can qualify movement while lineHistoryUsable remains false
 * when historical line fields are unavailable.
 */
function priceHistoryProvenance(row = {}) {
  return {
    priceHistoryUsable: row.priceHistoryUsable === true,
    priceHistoryScope: typeof row.priceHistoryScope === 'string' ? row.priceHistoryScope : null,
    priceHistorySource: typeof row.priceHistorySource === 'string' ? row.priceHistorySource : null,
    priceHistoryPointCount: Number.isFinite(Number(row.priceHistoryPointCount)) ? Number(row.priceHistoryPointCount) : 0
  };
}

function buildRankedScreenRow(item, { preferredBook, debug }) {
  // movementAsOf: wall-clock stamp of the newest history point behind this
  // verdict. Rank-vs-exact "flips" on fast markets (NoVig) are usually just
  // new ticks arriving between calls — this stamp lets any consumer see
  // exactly how fresh the movement read is.
  const movementAsOf = latestHistoryTimestampIso(item.row?.lineHistory);
  const liquidityFlag = describeLiquidity(item.row?.liquidityUsd);
  const startInfo = describeStartTime(item.row?.start ?? item.row?.startTime ?? null, {
    league: item.row?.league,
    isLive: Boolean(item.row?.isLive)
  });
  const rankingProvenance = {
    leaguePreset: item.leaguePreset,
    focusBook: preferredBook,
    requestedHistorySportsbooks: item.row.historySportsbooksRequested ?? [],
    sourceBook: item.book,
    sourceMarket: item.market,
    marketHintMatch: item.marketHintMatch,
    lineHistorySource: item.row.lineHistorySource ?? null,
    historyMatchedBy: item.row.historyMatchedBy ?? null,
    historyMatchKey: item.row.historyMatchKey ?? null,
    normalizedSelectionId: item.row.normalizedSelectionId ?? null,
    historyGameId: item.row.historyGameId ?? null,
    rankingReason: item.rankingReason,
    exactLineHistorySuppressed: Boolean(item.row?.exactLineHistorySuppressed),
    ...priceHistoryProvenance(item.row)
  };
  const debugPayload = buildMovementDebugPayload(item);
  return {
    ...item.row,
    exactLineHistorySuppressed: Boolean(item.row?.exactLineHistorySuppressed),
    consensusEdge: item.consensusEdge,
    steamMove: item.steamMove,
    steamBooks: item.steamBooks,
    steamDirection: item.steamDirection,
    steamBookCount: item.steamBookCount,
    steamOriginatorCount: item.steamOriginatorCount ?? 0,
    steamMoveLegacy: item.steamMoveLegacy,
    steamBooksLegacy: item.steamBooksLegacy,
    steamDirectionLegacy: item.steamDirectionLegacy,
    steamBookCountLegacy: item.steamBookCountLegacy,
    multiWindowScore: item.multiWindowScore,
    consensusWindowCount: item.consensusWindowCount,
    totalConsensusWindows: item.totalConsensusWindows,
    consensusWindows: item.consensusWindows,
    multiWindowConfirmedBooks: item.multiWindowConfirmedBooks,
    multiWindowRequiredBooks: item.multiWindowRequiredBooks,
    multiWindowInsufficientData: item.multiWindowInsufficientData,
    clvProxyPct: item.clvProxyPct,
    openingOdds: item.openingOdds,
    currentOdds: item.currentOdds,
    freshnessMs: item.freshnessMs,
    freshnessAgeMs: item.freshnessAgeMs,
    freshnessSource: item.freshnessSource,
    freshnessFallbackUsed: item.freshnessFallbackUsed,
    stale: item.isStale,
    screenMarket: item.market,
    leaguePreset: item.leaguePreset,
    marketHintMatch: item.marketHintMatch,
    screenScore: Number(item.score.toFixed(3)),
    preferredBookMatch: item.preferredBookMatch,
    focusBookMissing: Boolean(item.row?.focusBookMissing),
    focusBookMissingReason: item.row?.focusBookMissingReason || null,
    compDataMissing: Boolean(item.row?.compDataMissing),
    gatePassed: item.gatePassed,
    gateReason: item.gateReason,
    hasConsensus: item.hasConsensus,
    hasLineMovement: item.hasLineMovement,
    isActionable: Boolean(item.isActionable),
    warning: item.isActionable ? null : item.warning || 'Execution quote is not playable',
    consensusBookCount: item.consensusBookCount,
    marketBookCount: item.marketBookCount,
    marketBooks: item.marketBooks,
    supportBookCount: item.supportBookCount,
    supportBooks: item.supportBooks,
    targetBookOdds: item.targetBookOdds,
    bestAvailableOdds: item.bestAvailableOdds,
    // Cross-venue arbitrage margin for this row's two-way market, in percentage points,
    // or null when the row is not arbitrageable. Arbitrage is the one edge the
    // literature documents as retail-accessible and prediction-free, so it is recorded
    // on every row rather than only reported when someone asks. Null is the normal
    // case: a healthy market's implied probabilities sum above 1.
    arbMarginPct: arbMarginForRow(item.row),
    executionQuality: item.executionQuality,
    movementDisposition: item.movementDisposition,
    movementAsOf,
    ...(liquidityFlag ? { liquidityFlag } : {}),
    startCT: startInfo.startCT,
    startsIn: startInfo.startsIn,
    ...(startInfo.startUnverified ? { startUnverified: true } : {}),
    movementGrade: gradeMovementQuality(item),
    riskScore: calculateRiskScore(item),
    kaiCall: getKaiCall(item),
    confidenceTier: getConfidenceTierStable(item),
    confidenceTierLive: getConfidenceTier(item),
    tierTrajectory: getTierTrajectory(item),
    rationale: buildRationale(item),
    reasonCodes: assignReasonCodes(item),
    movementSourceBook: item.movementSummary.movementSourceBook,
    movementMode: item.movementSummary.movementMode,
    movementLabel: item.movementSummary.movementLabel,
    movementPointCount: item.movementSummary.movementPointCount,
    lastPointAgeMs: item.movementSummary.lastPointAgeMs ?? null,
    lineHistoryLookbackHours: item.row.lineHistoryLookbackHours ?? null,
    recentWindowHours: item.movementSummary.recentWindowHours ?? null,
    filteredHistoryPointCount: item.movementSummary.filteredHistoryPointCount,
    droppedHistoryPointCount: item.movementSummary.droppedHistoryPointCount,
    movementQuality: item.movementSummary.movementQuality,
    movementQualityScore: item.movementSummary.movementQualityScore,
    priceHistoryUsable: item.movementSummary.priceHistoryUsable,
    movementHistoryUsable: item.movementSummary.movementHistoryUsable,
    lineHistoryUsable: item.movementSummary.lineHistoryUsable,
    lineHistoryQuality: item.movementSummary.lineHistoryQuality,
    recentClvPct: item.movementSummary.recentClvPct,
    recentSharpMoveDirection: item.movementSummary.recentSharpMoveDirection,
    fullWindowSharpMoveDirection: item.movementSummary.fullWindowSharpMoveDirection,
    openToCurrentClvPct: item.movementSummary.openToCurrentClvPct,
    peakAdverseClvPct: item.movementSummary.peakAdverseClvPct ?? null,
    minClvPct: item.movementSummary.minClvPct ?? null,
    historySportsbooksRequested: item.row.historySportsbooksRequested ?? [],
    rankingProvenance,
    scoreBreakdown: item.scoreBreakdown,
    rankingReason: item.rankingReason,
    historyMatchKey: item.row.historyMatchKey ?? item.historyMatchKey,
    ...(debug
      ? {
          droppedHistoryReasons: item.movementSummary.droppedHistoryReasons,
          filteredLineHistory: item.movementSummary.filteredLineHistory,
          droppedHistoryPoints: item.movementSummary.droppedHistoryPoints,
          movementDebug: debugPayload
        }
      : {})
  };
}

function buildScreenRowContext({ row, presetCache, preferredBook, sharpBooks, recentWindowHours }) {
  const rowMarketName = String(row?.market || getTennisMarketName(row) || row?.selection || '').toLowerCase();
  // getLeagueRankingPreset is pure (depends only on league+market) and
  // builds a fresh object every call. For a 20-row screen that's 20
  // redundant normalizeLeagueName + getSharpBookComparisonSet chains.
  // Memoise on (league, market) for the duration of this rankScreenRows
  // call so identical rows in the same batch share one preset object.
  const rowLeague = row?.league || row?.sport || row?.gameType || '';
  let leaguePreset = presetCache.get(rowLeague);
  if (!leaguePreset || leaguePreset.__marketKey !== rowMarketName) {
    leaguePreset = getLeagueRankingPreset(rowLeague, rowMarketName);
    leaguePreset.__marketKey = rowMarketName;
    presetCache.set(rowLeague, leaguePreset);
  }
  const marketPriority = getMarketPriorityScore(leaguePreset, rowMarketName);
  const marketHintMatch = marketPriority ? marketPriority.match : null;
  const marketHintScore = marketPriority ? marketPriority.weight : 0;
  const movementSummary = summarizeSharpMovement({
    lineHistory: row?.lineHistory,
    preferredBook,
    // Use the league preset's real sharp-book set, NOT the requested-books
    // list. The rank path passes `books: [targetBook]` as preferredBooks, so
    // deriving sharpBooks from it would make the movement source picker treat
    // a no-vig target (NoVigApp/OnyxOdds) as a sharp book and grade movement
    // from its own flat line. The preset carries getSharpBookComparisonSet's
    // actual sharp books (Pinnacle/Circa/BetOnline...).
    sharpBooks:
      Array.isArray(leaguePreset.preferredBooks) && leaguePreset.preferredBooks.length
        ? leaguePreset.preferredBooks
        : sharpBooks,
    options: {
      recentWindowHours,
      maxAbsOdds: 1500,
      // Anchor to wall-clock so the recent window is deterministic and
      // matches any validation re-fetch (which also passes Date.now()).
      // Fixes the screen/validation movement flip caused by the old
      // last-point-timestamp default in buildMovementWindows.
      nowMs: Date.now(),
      invertDirection: isOppositeSide(row),
      historyDegraded: Boolean(row?.historyError || row?.historyErrorCode || row?.historyErrorStatus != null),
      lineFieldMissingCount: Number(row?.lineFieldMissingCount || 0),
      priceHistoryUsable: row?.priceHistoryUsable
    }
  });
  // Multi-window consensus score: fraction of time windows where all
  // configured sharp books agreed on direction. Surfaced alongside
  // movementLabel so the movement grade and risk score can require
  // sustained agreement (>= 0.66 = at least 4 of 6 windows).
  const multiWindowResult = computeMultiWindowScore(row, {
    nowMs: Date.now()
  });
  // Strict steam rule: 3+ sharp books, 5-minute window (industry standard for
  // genuine cross-book coordination rather than 2-book consensus drift).
  // Legacy (1h/2-book) is computed alongside for backwards-compat comparison
  // — exposed as steamMoveLegacy so the daily report can show what each rule
  // would have flagged.
  const nowMs = Date.now();
  const steamMoveResult = detectSteamMove(row, {
    nowMs,
    steamWindowMs: 5 * 60 * 1000,
    minBooks: 3
  });
  const steamMoveLegacyResult = detectSteamMove(row, {
    nowMs,
    steamWindowMs: 60 * 60 * 1000,
    minBooks: 2
  });
  const trail = extractHistoryTrail(row);
  const fallbackOpeningOdds = trail.length >= 2 ? trail[0] : null;
  const fallbackCurrentOdds =
    trail.length >= 2
      ? trail[trail.length - 1]
      : extractNumericTrailValue({ odds: row?.odds || row?.currentOdds || row?.price });
  const fallbackOpeningProb = americanOddsToImpliedProbability(fallbackOpeningOdds);
  const fallbackCurrentProb = americanOddsToImpliedProbability(fallbackCurrentOdds);
  const fallbackClvProxyPct =
    Number.isFinite(fallbackOpeningProb) && Number.isFinite(fallbackCurrentProb)
      ? (fallbackCurrentProb - fallbackOpeningProb) * 100
      : null;
  const openingOdds = movementSummary.movementHistoryUsable ? movementSummary.openingOdds : fallbackOpeningOdds;
  const currentOdds = movementSummary.movementHistoryUsable ? movementSummary.currentOdds : fallbackCurrentOdds;
  const clvProxyPct = movementSummary.movementHistoryUsable ? movementSummary.clvProxyPct : fallbackClvProxyPct;
  return {
    rowMarketName,
    leaguePreset,
    marketHintMatch,
    marketHintScore,
    movementSummary,
    multiWindowResult,
    nowMs,
    steamMoveResult,
    steamMoveLegacyResult,
    openingOdds,
    currentOdds,
    clvProxyPct
  };
}

function buildScreenRankingReason({
  row,
  leaguePreset,
  hasConsensus,
  hasLineMovement,
  marketHintMatch,
  clvProxyPct,
  movementSummary,
  isStale,
  numericMaxAgeMs
}) {
  const clvSuffix = Number.isFinite(clvProxyPct) ? `CLV proxy ${clvProxyPct.toFixed(2)}%` : 'CLV unavailable';
  const movementReason = movementSummary.movementHistoryUsable
    ? [
        movementSummary.movementMode === 'same_book' && movementSummary.movementSourceBook
          ? `same-book sharp movement from ${movementSummary.movementSourceBook}`
          : movementSummary.movementMode === 'comparison_book' && movementSummary.movementSourceBook
            ? `comparison-book movement from ${movementSummary.movementSourceBook}`
            : movementSummary.movementMode === 'mixed_books_fallback'
              ? 'movement available but low confidence, mixed-book fallback'
              : null,
        movementSummary.movementLabel === 'recent_supportive_only'
          ? 'recent supportive movement only, full-window move adverse'
          : movementSummary.movementLabel === 'supportive'
            ? clvSuffix
            : movementSummary.movementLabel === 'adverse'
              ? `adverse movement, ${clvSuffix}`
              : `movement ${movementSummary.movementLabel}, ${clvSuffix}`,
        movementSummary.movementQuality ? `quality ${movementSummary.movementQuality}` : null
      ]
        .filter(Boolean)
        .join(', ')
    : Number.isFinite(clvProxyPct)
      ? `legacy CLV proxy ${clvProxyPct.toFixed(2)}%`
      : 'no usable sharp movement';
  const rankingReason = isStale
    ? `stale data older than ${Math.round(numericMaxAgeMs / 1000)}s, ${leaguePreset.displayName} preset, consensus edge${row?.consensusBookCount ? ` across ${row.consensusBookCount} comp books` : ''}${hasLineMovement ? `, ${movementReason}` : ''}${marketHintMatch ? `, market fit ${marketHintMatch}` : ''}`
    : hasConsensus
      ? `${leaguePreset.displayName} preset, ranked by consensus edge${row?.consensusBookCount ? ` across ${row.consensusBookCount} comp books` : ''}${hasLineMovement ? `, ${movementReason}` : ''}${marketHintMatch ? `, market fit ${marketHintMatch}` : ''}`
      : hasLineMovement
        ? `${leaguePreset.displayName} preset, ranked by line movement only, ${movementReason}${marketHintMatch ? `, market fit ${marketHintMatch}` : ''}`
        : `${leaguePreset.displayName} preset, unranked: no consensus comparison or line movement available${marketHintMatch ? `, market fit ${marketHintMatch}` : ''}`;
  return rankingReason;
}

function buildRankedRowGateAndWarning({ gate, preferredBookMatch, preferredBook, executionQuality, actionGatePassed }) {
  return {
    gatePassed: gate.passed,
    gateReason: gate.passed
      ? gate.reason
      : !preferredBookMatch
        ? `no price for ${preferredBook || 'preferred book'}`
        : `${gate.reason}${executionQuality === 'bad' ? `; execution ${executionQuality}` : ''}`,
    warning: actionGatePassed
      ? null
      : !gate.passed
        ? gate.reason === 'no consensus, CLV, or market fit signal'
          ? 'Insufficient comparison data'
          : gate.reason
        : !preferredBookMatch
          ? `No executable price for ${preferredBook || 'preferred book'}`
          : 'Execution quote is not playable'
  };
}

function computeRankedRowMovementDisposition(row, { movementSummary, clvProxyPct, executionQuality }) {
  return computeMovementDisposition({
    movementGrade: gradeMovementQuality({
      ...row,
      movementSummary,
      clvProxyPct,
      executionQuality,
      consensusBookCount: Number(row?.consensusBookCount || 0)
    }),
    movementLabel: movementSummary?.movementLabel,
    recentSharpMoveDirection: movementSummary?.recentSharpMoveDirection,
    fullWindowSharpMoveDirection: movementSummary?.fullWindowSharpMoveDirection,
    odds: row?.odds,
    currentOdds: row?.currentOdds,
    targetBookOdds: row?.targetBookOdds,
    consensusBookCount: Number(row?.consensusBookCount || 0),
    clvProxyPct,
    priceHistoryUsable: movementSummary?.priceHistoryUsable,
    movementHistoryUsable: movementSummary?.movementHistoryUsable,
    sharpBookMovementConfirmed: row?.sharpBookMovementConfirmed
  });
}

function buildRankedIntermediateRow(
  row,
  { presetCache, preferredBook, sharpBooks, recentWindowHours, numericMaxAgeMs }
) {
  const {
    rowMarketName,
    leaguePreset,
    marketHintMatch,
    marketHintScore,
    movementSummary,
    multiWindowResult,
    nowMs,
    steamMoveResult,
    steamMoveLegacyResult,
    openingOdds,
    currentOdds,
    clvProxyPct
  } = buildScreenRowContext({ row, presetCache, preferredBook, sharpBooks, recentWindowHours });
  const rawConsensusEdge = row?.consensusEdge ?? row?.value ?? row?.ev ?? row?.edge;
  const consensusEdge = Number(rawConsensusEdge);
  const hasConsensus = Boolean(row?.hasConsensus) || Number.isFinite(consensusEdge);
  const book = String(row?.book || row?.sportsbook || '').trim();
  const preferredBookMatch = matchesPreferredBook(book, preferredBook);
  const hasLineMovement = Number.isFinite(clvProxyPct);
  const freshnessInfo = extractRowFreshnessInfo(row);
  const freshnessMs = freshnessInfo?.ms ?? null;
  const freshnessAgeMs = Number.isFinite(freshnessMs) ? Math.max(0, nowMs - freshnessMs) : null;
  const freshnessSource = freshnessInfo?.source || 'response_received';
  const freshnessFallbackUsed = !freshnessInfo;
  const isStale =
    Number.isFinite(numericMaxAgeMs) && Number.isFinite(freshnessMs) ? freshnessAgeMs > numericMaxAgeMs : false;
  const movementWeight = movementSummary.movementHistoryUsable
    ? (movementSummary.movementQualityScore || 0) * (movementSummary.movementMode === 'mixed_books_fallback' ? 0.75 : 1)
    : 1;
  const movementScore = hasLineMovement ? clvProxyPct * 1.5 * movementWeight : 0;
  const consensusScore = hasConsensus ? consensusEdge * 2 : 0;
  const sportScore = hasConsensus || hasLineMovement ? marketHintScore : 0;
  const freshnessPenalty = isStale ? -5 : 0;
  const score = consensusScore + movementScore + sportScore + freshnessPenalty;
  const gate = passesLeagueRankingGate({ score, hasConsensus, hasLineMovement, leaguePreset, marketHintMatch });
  const executionQuality = String(row?.executionQuality ?? 'unknown')
    .trim()
    .toLowerCase();
  const executionPlayable = executionQuality === 'best' || executionQuality === 'playable';
  const actionGatePassed = gate.passed && executionPlayable && preferredBookMatch;
  const rankingReason = buildScreenRankingReason({
    row,
    leaguePreset,
    hasConsensus,
    hasLineMovement,
    marketHintMatch,
    clvProxyPct,
    movementSummary,
    isStale,
    numericMaxAgeMs
  });
  return {
    row,
    score,
    // Strict steam (5-min, 3+ sharp books) drives downstream scoring.
    steamMove: steamMoveResult.isSteam,
    steamBooks: steamMoveResult.steamBooks,
    steamDirection: steamMoveResult.direction,
    steamBookCount: steamMoveResult.dominantBookCount,
    steamOriginatorCount: steamMoveResult.originatorCount,
    // Legacy steam (1h, 2+ sharp books) kept for comparison; does NOT affect scoring.
    steamMoveLegacy: steamMoveLegacyResult.isSteam,
    steamBooksLegacy: steamMoveLegacyResult.steamBooks,
    steamDirectionLegacy: steamMoveLegacyResult.direction,
    steamBookCountLegacy: steamMoveLegacyResult.dominantBookCount,
    // Multi-window consensus score: 0.0-1.0 (consensus windows / total windows).
    // Used by movement grade and risk score to require sustained agreement
    // across the 1h/2h/6h/12h/24h/48h windows.
    multiWindowScore: multiWindowResult.score,
    consensusWindowCount: multiWindowResult.consensusWindowCount,
    totalConsensusWindows: multiWindowResult.totalWindows,
    consensusWindows: multiWindowResult.consensusWindows,
    multiWindowConfirmedBooks: multiWindowResult.confirmedBookCount,
    multiWindowRequiredBooks: multiWindowResult.requiredBookCount,
    multiWindowInsufficientData: multiWindowResult.hasInsufficientData,
    freshnessMs,
    freshnessAgeMs,
    freshnessSource,
    freshnessFallbackUsed,
    isStale,
    ...buildRankedRowGateAndWarning({ gate, preferredBookMatch, preferredBook, executionQuality, actionGatePassed }),
    leaguePreset: leaguePreset.displayName,
    marketHintMatch,
    consensusEdge: hasConsensus ? consensusEdge : null,
    clvProxyPct,
    openingOdds,
    currentOdds,
    market: rowMarketName || getTennisMarketName(row),
    book,
    preferredBookMatch,
    hasConsensus,
    hasLineMovement,
    isActionable: actionGatePassed,
    consensusBookCount: Number(row?.consensusBookCount || 0),
    marketBookCount: Number(row?.marketBookCount || 0),
    marketBooks: Array.isArray(row?.marketBooks) ? row.marketBooks : [],
    supportBookCount: Number(row?.supportBookCount || 0),
    supportBooks: Array.isArray(row?.supportBooks) ? row.supportBooks : [],
    targetBookOdds: row?.targetBookOdds ?? null,
    bestAvailableOdds: row?.bestAvailableOdds ?? null,
    executionQuality,
    // Rank-time disposition: compute the movement grade FIRST, then feed it
    // into the disposition module. The enriched row's flat `movementGrade`
    // is not set until the final ranking pass (gradeMovementQuality reads
    // movementSummary + flat fields), so passing `row?.movementGrade`
    // (undefined) here made every supportive-label row fall through to
    // 'insufficient' at rank time. The getKaiCall/getConfidenceTier guard
    // (2026-08-15) then trusted that stale 'insufficient' and stamped
    // TIER 4/PASS on green steam-move plays before the final pass could
    // correct them (real case: Lakers -148 steam, supportive_clean, killed).
    movementDisposition: computeRankedRowMovementDisposition(row, { movementSummary, clvProxyPct, executionQuality }),
    movementSummary,
    scoreBreakdown: {
      consensusScore: Number(consensusScore.toFixed(3)),
      movementScore: Number(movementScore.toFixed(3)),
      sportScore: Number(sportScore.toFixed(3)),
      freshnessPenalty: Number(freshnessPenalty.toFixed(3)),
      total: Number(score.toFixed(3))
    },
    rankingReason
  };
}

function expandRankedScreenRows({ rows, preferredBook, requirePreferredBook, coverageGaps }) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    // Drop rows with zero data — they're noise, not signal.
    // Total Games and other thin markets often return rows with no consensus
    // books and insufficient history. Surfacing them as PASS is misleading.
    const consensusBookCount = Number(row.consensusBookCount ?? 0);
    const movementLabel = String(row.movementLabel || row.movementSummary?.movementLabel || '')
      .trim()
      .toLowerCase();
    if (consensusBookCount === 0 && movementLabel === 'insufficient_history') {
      return [];
    }

    const nestedSelections = row?.selections && typeof row.selections === 'object' ? row.selections : null;
    const focusSelectionEntry =
      requirePreferredBook && nestedSelections
        ? Object.entries(nestedSelections).find(
            ([, selection]) =>
              selection?.odds && typeof selection.odds === 'object' && Boolean(selection.odds[preferredBook])
          )
        : null;
    const rowForExpansion = focusSelectionEntry
      ? {
          ...row,
          book: preferredBook,
          selections: { [focusSelectionEntry[0]]: focusSelectionEntry[1], ...nestedSelections }
        }
      : row;
    const expandedRows = expandScreenRow(rowForExpansion, { preferredBook, requirePreferredBook });
    if (expandedRows.length === 0) {
      // Row was dropped — likely the focus book has no price. Capture it as a
      // coverage gap so the caller can surface "focus book missing for this match"
      // instead of silently hiding it.
      const rowSelection = getResolvedScreenSelection(row) || getScreenSelection(row);
      const oddsMap = rowSelection?.odds || row?.allBookOdds || {};
      const nestedFocusAvailable =
        row?.selections &&
        typeof row.selections === 'object' &&
        Object.values(row.selections).some(
          (selection) => selection?.odds && typeof selection.odds === 'object' && Boolean(selection.odds[preferredBook])
        );
      const focusAvailable = Boolean(oddsMap?.[preferredBook]) || nestedFocusAvailable;
      if (!focusAvailable) {
        coverageGaps.push({
          preferredBook,
          availableBooks: Object.keys(oddsMap || {}),
          matchup:
            (row?.awayTeam || row?.participant2 || row?.selection2 || '?') +
            ' vs ' +
            (row?.homeTeam || row?.participant1 || row?.selection1 || '?'),
          market: String(row?.market || '').toLowerCase() || null,
          start: row?.start || row?.startRaw || null,
          reason: requirePreferredBook ? 'no_price_dropped' : 'no_price_fallback',
          rowId: row?.id || row?.gameId || null
        });
      }
    } else {
      for (const out of expandedRows) {
        if (out?.focusBookMissing) {
          coverageGaps.push({
            preferredBook,
            resolvedBook: out.book,
            availableBooks: Object.keys(oddsMapForRow(row) || {}),
            matchup:
              (row?.awayTeam || row?.participant2 || row?.selection2 || '?') +
              ' vs ' +
              (row?.homeTeam || row?.participant1 || row?.selection1 || '?'),
            market: String(row?.market || '').toLowerCase() || null,
            start: row?.start || row?.startRaw || null,
            reason: 'no_price_fallback',
            rowId: row?.id || row?.gameId || null,
            focusBookMissingReason: out.focusBookMissingReason
          });
        }
      }
    }
    return expandedRows;
  });
}

function partitionFocusBookRows(filterPipelineResult, { preferredBook, requirePreferredBook, DEBUG }) {
  return filterPipelineResult.reduce(
    (acc, item) => {
      // Only partition into focusBookMissing when the user explicitly
      // requested a specific book. When preferredBooks is the preset
      // default (e.g. Pinnacle for UFC, which doesn't price UFC moneylines),
      // there is no "focus book" — every book is a valid source. Partitioning
      // on the preset default would silently drop every UFC row from result
      // and put them in focusBookMissingRows, where callers like
      // get_play_details and validate_play don't look for them.
      //
      // BUGFIX (2026-06-29): focusBookMissing flag can be a false positive when
      // the odds map contains the preferred book but some internal book-field
      // normalization doesn't match. Guard with a direct odds-map check:
      // if the row has allBookOdds[preferredBook], the book HAS price data,
      // regardless of what the focusBookMissing flag says.
      //
      // Also check selections.odds as a fallback (older row shapes).
      const focusBookHasOdds =
        requirePreferredBook &&
        (Boolean(item.row?.allBookOdds?.[preferredBook]) ||
          (item.row?.selections &&
            typeof item.row.selections === 'object' &&
            Object.values(item.row.selections).some(
              (sel) => sel?.odds && typeof sel.odds === 'object' && Boolean(sel.odds[preferredBook])
            )));
      const reallyMissing = item.row?.focusBookMissing && requirePreferredBook && !focusBookHasOdds;

      if (DEBUG && item.row?.focusBookMissing) {
        const matchup = String(item.row?.game || '');
        const books = item.row?.allBookOdds ? Object.keys(item.row.allBookOdds) : [];
        process.stderr.write(
          `[screen-ranker] focusBookMissing=${item.row.focusBookMissing} ` +
            `matchup="${matchup}" ` +
            `preferredBook="${preferredBook}" ` +
            `allBookOddsHasPreferred=${Boolean(item.row?.allBookOdds?.[preferredBook])} ` +
            `allBookOddsKeys=${JSON.stringify(books.slice(0, 10))} ` +
            `focusBookHasOdds=${focusBookHasOdds} ` +
            `reallyMissing=${reallyMissing} ` +
            `requirePreferredBook=${requirePreferredBook}\n`
        );
      }

      if (reallyMissing) acc.fallbackRows.push(item);
      else acc.mainRows.push(item);
      return acc;
    },
    { mainRows: [], fallbackRows: [] }
  );
}

/**
 * Rank screen rows by scoring, gating, and sorting based on consensus edge, line movement, freshness, and market priority.
 * @param {Array<Object>} rows - Array of row data.
 * @param {Object} [options={}] - Ranking options.
 * @param {number} [options.limit=12] - Max rows to return.
 * @param {string[]} [options.preferredBooks] - Ordered list of preferred books.
 * @param {string} [options.focusBook=''] - Specific preferred book to use as anchor.
 * @param {boolean} [options.includeAll=false] - Include rows that don't pass the ranking gate.
 * @param {number|null} [options.maxAgeMs=null] - Staleness threshold in ms.
 * @param {number} [options.recentWindowHours=6] - Recent movement window in hours.
 * @param {boolean} [options.debug=true] - Include debug payload in results.
 * @param {boolean} [options.requirePreferredBook=false] - Require preferred book to have a price.
 * @param {boolean} [options.playableOnly=false] - Filter to playable rows only.
 * @param {boolean} [options.includeFallbackRows=false] - Include comparison-book rows when the preferred book has no price.
 * @returns {Array<Object>} Ranked and enriched rows.
 */
function rankScreenRows(
  rows,
  {
    limit = 12,
    preferredBooks = ['NoVigApp', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa'],
    focusBook = '',
    includeAll = false,
    maxAgeMs = null,
    recentWindowHours = 6,
    debug = true,
    requirePreferredBook = false,
    playableOnly = false,
    includeFallbackRows = false
  } = {}
) {
  // When the caller explicitly wants a specific book (e.g. NoVigApp for
  // validate_play), use it as the preferred book. Otherwise fall back to
  // the first book in the preferredBooks list. Without this, validate_play
  // on non-NBA/NFL/MLB leagues (where ALL_SCREEN_BOOKS is the comparison
  // set) always picks '4cx' (first alphabetically) and computes execution
  // quality against its odds instead of the user's actual execution book.
  const resolvedFocusBook = String(focusBook || '').trim();
  const preferredBook =
    resolvedFocusBook && Array.isArray(preferredBooks) && preferredBooks.includes(resolvedFocusBook)
      ? resolvedFocusBook
      : Array.isArray(preferredBooks) && preferredBooks.length
        ? String(preferredBooks[0])
        : 'NoVigApp';
  const numericMaxAgeMs = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : null;
  const sharpBooks = Array.isArray(preferredBooks)
    ? preferredBooks.map((book) => String(book || '').trim()).filter(Boolean)
    : [];
  // Per-call memo for getLeagueRankingPreset. Keyed by league, with a
  // __marketKey stamp so a different market for the same league gets a
  // fresh preset rather than the previous one. Bounded by the unique-league
  // count in a single screen (typically <= 1).
  const presetCache = new Map();
  const coverageGaps = [];
  const expanded = expandRankedScreenRows({ rows, preferredBook, requirePreferredBook, coverageGaps });
  const filterPipelineResult = expanded
    .map((row) =>
      buildRankedIntermediateRow(row, {
        presetCache,
        preferredBook,
        sharpBooks,
        recentWindowHours,
        numericMaxAgeMs
      })
    )
    .filter((item) => {
      if (!includeAll && !item.gatePassed) {
        if (DEBUG) {
          process.stderr.write(
            `[screen-ranker] gate filter: dropped "${String(item.row?.game || '')}" — ` +
              `gatePassed=${item.gatePassed} includeAll=${includeAll} score=${item.score.toFixed(2)}\n`
          );
        }
        return false;
      }
      if (playableOnly && item.executionQuality === 'bad') {
        if (DEBUG) {
          process.stderr.write(
            `[screen-ranker] playableOnly filter: dropped "${String(item.row?.game || '')}" — ` +
              `executionQuality=${item.executionQuality}\n`
          );
        }
        return false;
      }
      return true;
    });
  // Split focusBookMissing rows out of the main result. Rows that fell
  // back to a different book (because the focus book had no price) carry
  // the same tier/kaiCall/edge signal but cannot be placed on the focus
  // book. Surfacing them as `focusBookMissingRows` on the returned array
  // (non-enumerable) keeps the main `result` array clean for queries
  // like "all TIER 1 bets on NoVigApp today" — which would otherwise
  // return rows the user can't place on the focus book.
  const partitioned = partitionFocusBookRows(filterPipelineResult, {
    preferredBook,
    requirePreferredBook,
    DEBUG
  });
  const ranked = (includeFallbackRows ? [...partitioned.mainRows, ...partitioned.fallbackRows] : partitioned.mainRows)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.consensusEdge ?? -999) - Number(a.consensusEdge ?? -999) ||
        Number(b.clvProxyPct ?? -999) - Number(a.clvProxyPct ?? -999)
    )
    .map((item) => buildRankedScreenRow(item, { preferredBook, debug }));
  resolveAlternateLines(ranked, { debug: DEBUG });
  const limitedRows = ranked.filter((row) => !row.altLineFiltered).slice(0, limit);
  // Alternate lines never surface in output: they flooded rank results
  // (19/20 rows alt variants) and buried the main lines. Count them for
  // metadata, then drop before the limit slice so mains fill the slots.
  const droppedAltLineCount = ranked.filter((row) => row.altLineFiltered).length;
  if (includeAll) {
    ranked.splice(0, ranked.length, ...ranked.filter((row) => !row.altLineFiltered).slice(0, limit));
  } else {
    ranked.splice(0, ranked.length, ...limitedRows);
  }
  Object.defineProperty(ranked, 'droppedAltLineCount', {
    value: droppedAltLineCount,
    enumerable: false,
    writable: false,
    configurable: false
  });
  // Consensus-book floor: single-book Tier 1 plays are demoted
  // unless edge is exceptional + movement is clean. This prevents false
  // positives from one book's isolated move producing the max tier.
  // NOTE: this is about consensus BOOK COUNT, not dollar liquidity —
  // liquidityUsd never affects tiers (see describeLiquidity, display-only).
  applyConsensusFloorGuard(ranked);
  // Game-level mutual-exclusivity guard: never let two opposite-sided TIER 1
  // bets on the same game both surface as top picks.
  resolveGameConflicts(ranked, { debug: DEBUG });
  // Totals dedup: per game, keep only the best totals play. Prevents
  // showing both Over AND Under on the same game as TIER 1.
  resolveTotalsConflicts(ranked, { debug: DEBUG });
  // Alternate-line filter: per game, per market type, keep only the main
  // line (most consensus books). Alternate spreads (-12.5, -18.5, +3.5)
  // and alternate totals (line numbers away from the consensus) get
  // downgraded to TIER 3/4 so they never surface as picks.
  resolveAlternateLines(ranked, { debug: DEBUG });
  // Attach coverage gaps and focusBookMissingRows as non-enumerable
  // properties so callers can see (a) which matches the focus book didn't
  // price (coverageGaps, captured during expand), and (b) which ranked
  // rows fell back to a different book (focusBookMissingRows, captured
  // before the limit slice). Both use Object.defineProperty so they
  // don't show up in Array.prototype methods or get serialized by
  // JSON.stringify — existing callers that consume the array still work.
  Object.defineProperty(ranked, 'coverageGaps', {
    value: coverageGaps,
    enumerable: false,
    writable: false,
    configurable: false
  });
  // focusBookMissingRows: items that pass the gate but couldn't be priced
  // on the focus book. They carry focusBookMissing: true, kaiCall capped at
  // CONSIDER, and the actual book they were sourced from. We exclude them
  // from the main array because filtering the main array by tier ("all TIER
  // 1 bets on NoVigApp today") would otherwise return rows the user can't
  // place on the focus book.
  if (partitioned.fallbackRows.length && !includeFallbackRows) {
    Object.defineProperty(ranked, 'focusBookMissingRows', {
      value: partitioned.fallbackRows.map((item) => ({
        book: item.book,
        pick: item.pick,
        participant: item.participant,
        market: item.market,
        matchup: `${item.row?.awayTeam || '?'} vs ${item.row?.homeTeam || '?'}`,
        start: item.row?.start || item.row?.startRaw || null,
        targetBookOdds: item.targetBookOdds,
        bestAvailableOdds: item.bestAvailableOdds,
        consensusEdge: item.consensusEdge,
        clvProxyPct: item.clvProxyPct,
        movementLabel: item.movementLabel,
        consensusBookCount: item.consensusBookCount,
        supportBookCount: item.supportBookCount,
        screenScore: Number(item.score.toFixed(3)),
        confidenceTier: item.confidenceTier,
        confidenceTierLive: item.confidenceTierLive,
        kaiCall: item.kaiCall,
        riskScore: item.riskScore,
        focusBookMissingReason: item.row?.focusBookMissingReason,
        rationale: item.rankingReason
      })),
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return ranked;
}

/**
 * Rank screen rows for a specific league, applying league-specific ranking presets.
 * @param {Array<Object>} rows - Array of row data.
 * @param {Object} [options={}] - Options including league, market, limit, etc.
 * @param {string} [options.league='NBA'] - League name.
 * @param {string} [options.market] - Market name.
 * @param {number} [options.limit=12] - Max rows to return.
 * @param {boolean} [options.includeAll=false] - Include rows that don't pass gate.
 * @param {number|null} [options.maxAgeMs=null] - Staleness threshold.
 * @param {number[]|string[]} [options.books=[]] - Preferred books.
 * @param {string} [options.focusBook=''] - Specific preferred book to use as anchor.
 * @param {number} [options.recentWindowHours=6] - Recent movement window.
 * @param {boolean} [options.debug=true] - Include debug payload.
 * @param {boolean} [options.requirePreferredBook=false] - Require preferred book to have a price.
 * @param {boolean} [options.playableOnly=false] - Filter to playable rows only.
 * @param {boolean} [options.includeFallbackRows=false] - Include comparison-book rows when the preferred book has no price.
 * @returns {Array<Object>} Ranked rows with league preset metadata.
 */
function rankLeagueScreenRows(
  rows,
  {
    league = 'NBA',
    market,
    limit = 12,
    includeAll = false,
    maxAgeMs = null,
    books = [],
    focusBook = '',
    recentWindowHours = 6,
    debug = true,
    requirePreferredBook = false,
    playableOnly = false,
    includeFallbackRows = false
  } = {}
) {
  const preset = getLeagueRankingPreset(league, market);
  const filteredRows = filterRowsByLeague(rows, preset.league);
  const ranked = rankScreenRows(filteredRows, {
    limit,
    preferredBooks: Array.isArray(books) && books.length ? books : preset.preferredBooks,
    focusBook,
    includeAll,
    maxAgeMs,
    recentWindowHours,
    debug: debug === undefined ? true : debug,
    requirePreferredBook,
    playableOnly,
    includeFallbackRows
  });
  const decorated = ranked.map((row) => ({
    ...row,
    leaguePreset: preset.displayName,
    rankingPreset: preset.displayName,
    rankingMarkets: (preset.marketPriorities || []).map((item) => item.match)
  }));
  // Preserve coverageGaps and focusBookMissingRows from the inner ranker
  // call (map() returns a new array and would drop the non-enumerable
  // properties).
  // @ts-expect-error
  if (ranked.coverageGaps) {
    Object.defineProperty(decorated, 'coverageGaps', {
      // @ts-expect-error
      value: ranked.coverageGaps,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  // @ts-expect-error
  if (ranked.focusBookMissingRows) {
    Object.defineProperty(decorated, 'focusBookMissingRows', {
      // @ts-expect-error
      value: ranked.focusBookMissingRows,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  // @ts-expect-error
  if (typeof ranked.droppedAltLineCount === 'number') {
    Object.defineProperty(decorated, 'droppedAltLineCount', {
      // @ts-expect-error
      value: ranked.droppedAltLineCount,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return decorated;
}

module.exports = {
  applyConsensusFloorGuard,
  average,
  expandScreenRow,
  isEdgePlausible,
  filterRowsByLeague,
  getLeagueRankingPreset,
  getMarketPriorityScore,
  getResolvedScreenSelection,
  getScreenSelection,
  getTennisMarketName,
  passesLeagueRankingGate,
  rankLeagueScreenRows,
  rankScreenRows,
  resolveExtractedScreenSide,
  oddsMapForRow,
  resolveGameConflicts,
  resolveTotalsConflicts,
  isSideMarket,
  baseTeamFromSelection,
  latestHistoryTimestampIso,
  describeStartTime,
  describeLiquidity
};
