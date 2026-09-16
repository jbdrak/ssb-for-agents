'use strict';

const { americanOddsToImpliedProbability } = require('./ssb-shared-utils');

/**
 * Verbosity formatters for bet data.
 *
 * Converts raw bet objects into different output formats:
 * - minimal: Plain English for casual bettors
 * - standard: Structured data with verbose fields stripped (for intermediate bettors)
 * - full: Raw output (no transformation)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a confidence tier string to a human-readable confidence label.
 *
 * @param {string|*} tier - Confidence tier value (e.g. 'TIER 1', 'TIER 2').
 * @returns {string} Human-readable label: 'high confidence', 'moderate confidence', or 'low confidence'.
 */
function tierToConfidence(tier) {
  const t = String(tier || '').toUpperCase();
  if (t === 'TIER 1') return 'high confidence';
  if (t === 'TIER 2') return 'moderate confidence';
  return 'low confidence';
}

/**
 * Convert a numeric risk score into a human-readable risk label.
 *
 * @param {number|*} riskScore - Numeric risk score (0-10 scale).
 * @returns {string} Risk label: 'high risk', 'moderate risk', or 'low risk'.
 */
function riskScoreToLabel(riskScore) {
  const score = Number.isFinite(Number(riskScore)) ? Number(riskScore) : 0;
  if (score >= 7) return 'high risk';
  if (score >= 4) return 'moderate risk';
  return 'low risk';
}

/**
 * Determine the action verb based on the confidence tier.
 *
 * @param {string|*} tier - Confidence tier value (e.g. 'TIER 1', 'TIER 2').
 * @returns {string} Action verb: 'Bet' for tiers 1-2, 'Consider' otherwise.
 */
function actionWord(tier) {
  const t = String(tier || '').toUpperCase();
  if (t === 'TIER 1' || t === 'TIER 2') return 'Bet';
  return 'Consider';
}

/**
 * Format American odds with a leading '+' for positive values.
 *
 * @param {number|string|null|undefined} odds - American odds value.
 * @returns {string} Formatted odds string (e.g. '+105', '-120'), or empty string if invalid.
 */
function formatOdds(odds) {
  if (odds === null || odds === undefined || odds === '') return '';
  const n = Number(odds);
  if (!Number.isFinite(n)) return String(odds);
  // American odds: positive gets '+', negative keeps '-'
  return n > 0 ? `+${Math.round(n)}` : String(Math.round(n));
}

function isNoVigBook(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  return normalized === 'novig' || normalized === 'novigapp';
}

function hasNoVigExecutionBook(bet = {}, context = {}) {
  const values = [
    bet.book,
    bet.executionBook,
    bet.targetBook,
    bet.preferredBook,
    bet.targetBooks,
    context.book,
    context.executionBook,
    context.targetBook,
    context.targetBooks
  ];
  return values.flatMap((value) => (Array.isArray(value) ? value : [value])).some(isNoVigBook);
}

/**
 * Format a quote for display, using NoVig's probability-price convention only
 * when the selected execution book is NoVigApp. Internal odds remain American.
 *
 * @param {number|string|null|undefined} odds - American odds value.
 * @param {Object} [bet={}] - Bet-level book metadata.
 * @param {Object} [context={}] - Response-level book metadata.
 * @returns {string} Display quote.
 */
function formatOddsForDisplay(odds, bet = {}, context = {}) {
  if (!hasNoVigExecutionBook(bet, context)) return formatOdds(odds);
  const probability = americanOddsToImpliedProbability(odds);
  if (!Number.isFinite(probability)) return formatOdds(odds);
  return `${(probability * 100).toFixed(1)}%`;
}

function oddsValueForDisplay(odds, bet = {}, context = {}) {
  return hasNoVigExecutionBook(bet, context) ? formatOddsForDisplay(odds, bet, context) : odds;
}

function safeString(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val);
}

function responseBookContext(response = {}) {
  return {
    book: response.book,
    targetBook: response.targetBook,
    targetBooks: response.targetBooks
  };
}

/**
 * Map a movement grade to its emoji indicator.
 *
 * @param {string|*} grade - 'green', 'yellow', 'red', or unknown.
 * @returns {string} Corresponding emoji.
 */
function movementGradeEmoji(grade) {
  const g = String(grade || '').toLowerCase();
  if (g === 'green') return '\u{1F7E2}'; // 🟢
  if (g === 'yellow') return '\u{1F7E1}'; // 🟡
  if (g === 'red') return '\u{1F534}'; // 🔴
  return '\u26AA'; // ⚪ unknown
}

// ANSI codes for terminal rendering
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Build a human-readable, scannable summary for a set of quick_screen results.
 *
 * Format per play:  selection at odds  |  edge%  |  GRD  |  N books  |  startCST
 *
 * Leagues get bold section headers.  At most 5 plays per league (TIER 1 first,
 * then TIER 2 sorted by edge).  A footer shows TIER 1 / TIER 2 counts per league.
 *
 * @param {Object[]} results - Array of { league, market, candidates } entries.
 * @returns {string} Formatted multi-line summary string.
 */
function buildQuickScreenSummary(results = [], context = {}) {
  if (!Array.isArray(results) || results.length === 0) return 'No strong plays right now.';

  // Flatten all candidates, tagging each with its league
  const all = [];
  for (const entry of results) {
    const league = entry.league || 'Unknown';
    const cands = Array.isArray(entry.candidates) ? entry.candidates : [];
    for (const c of cands) all.push({ ...c, league });
  }

  if (all.length === 0) return 'No strong plays right now.';

  // Tier priority for sorting: TIER 1 > TIER 2 > rest
  function tierRank(c) {
    const t = String(c.finalConfidenceTier || c.confidenceTier || c.tier || '').toUpperCase();
    if (t === 'TIER 1') return 0;
    if (t === 'TIER 2') return 1;
    return 2;
  }

  // Group by league
  const byLeague = new Map();
  for (const c of all) {
    const league = c.league || 'Unknown';
    if (!byLeague.has(league)) byLeague.set(league, []);
    byLeague.get(league).push(c);
  }

  const lines = [];
  const leagueSummaries = [];

  for (const league of [...byLeague.keys()].sort()) {
    const plays = byLeague.get(league);
    const t1 = plays.filter((p) => tierRank(p) === 0);
    const t2 = plays.filter((p) => tierRank(p) === 1);
    const tier1Count = t1.length;
    const tier2Count = t2.length;

    // Sort: TIER 1 first, then TIER 2 by descending edge
    t1.sort((a, b) => (Number(b.edge) || 0) - (Number(a.edge) || 0));
    t2.sort((a, b) => (Number(b.edge) || 0) - (Number(a.edge) || 0));
    const ordered = [...t1, ...t2];

    lines.push('');
    lines.push(`${BOLD}── ${league} ──${RESET}`);

    const shown = ordered.slice(0, 5);
    for (const p of shown) {
      lines.push(formatBetsSummaryLine(p, context));
    }

    if (ordered.length > 5) {
      const remaining = ordered.length - 5;
      lines.push(`  +${remaining} more plays...`);
    }

    leagueSummaries.push({
      league,
      tier1: tier1Count,
      tier2: tier2Count,
      total: ordered.length
    });
  }

  // Summary footer
  lines.push('');
  lines.push(`${BOLD}── Summary ──${RESET}`);
  for (const ls of leagueSummaries) {
    const parts = [];
    if (ls.tier1) parts.push(`TIER 1: ${ls.tier1}`);
    if (ls.tier2) parts.push(`TIER 2: ${ls.tier2}`);
    lines.push(`  ${ls.league}: ${parts.join(', ')}  (${ls.total} total)`);
  }

  return lines.join('\n').replace(/^\n/, '');
}

/**
 * Format a single candidate as a one-line summary.
 *
 * Format: selection at odds  |  edge%  |  GRD_emoji  |  N books  |  startCST
 *
 * @param {Object} c - Candidate object.
 * @returns {string} Formatted line.
 */
function formatBetsSummaryLine(c = {}, context = {}) {
  const selection = c.selection || c.participant || c.pick || '?';
  const odds = formatOddsForDisplay(c.odds ?? c.targetBookOdds, c, context);
  const edge = c.edge != null ? `${Number(c.edge).toFixed(1)}% edge` : '';
  const grade = movementGradeEmoji(c.movementGrade);
  const books = Number(c.consensusBookCount ?? c.validatedConsensusBookCount) || 0;
  const booksStr = `${books} book${books !== 1 ? 's' : ''}`;
  const timeNote = c.startNote ? ` (${c.startNote})` : '';
  const time = c.startCST || '';
  const timeStr = time ? `${time}${timeNote}` : '';
  const tier = String(c.finalConfidenceTier || c.confidenceTier || c.tier || '').toUpperCase();

  const parts = [`${selection} at ${odds}`, edge, grade, booksStr, timeStr, tier].filter((s) => s.length > 0);
  return `  ${parts.join('  |  ')}`;
}

/**
 * Build per-league tier stats suitable for structured output.
 *
 * @param {Object[]} results - Array of { league, market, candidates } entries.
 * @returns {Object} league → { tier1, tier2, total } mapping.
 */
function buildByLeagueStats(results = []) {
  const stats = {};
  for (const entry of results) {
    const league = entry.league || 'Unknown';
    const cands = Array.isArray(entry.candidates) ? entry.candidates : [];
    const t1 = cands.filter((c) => {
      const t = String(c.finalConfidenceTier || c.confidenceTier || c.tier || '').toUpperCase();
      return t === 'TIER 1';
    }).length;
    const t2 = cands.filter((c) => {
      const t = String(c.finalConfidenceTier || c.confidenceTier || c.tier || '').toUpperCase();
      return t === 'TIER 2';
    }).length;
    stats[league] = { tier1: t1, tier2: t2, total: cands.length };
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Minimal formatter (casual bettors)
// ---------------------------------------------------------------------------

/**
 * Generate a plain-English rationale string for minimal mode.
 *
 * @param {Object} bet - Bet object with selection, edge, confidenceTier, kaiCall, riskScore.
 * @returns {string} Plain-English rationale.
 */
function toRationale(bet = {}) {
  const selection = safeString(bet.selection || bet.participant || bet.pick, 'selection');
  const edge = bet.edge != null ? bet.edge : bet.consensusEdge;
  const edgeStr = Number.isFinite(Number(edge)) ? Number(edge).toFixed(1) : '?';
  const tier = String(bet.confidenceTier || bet.tier || '').toUpperCase();
  const kai = String(bet.kaiCall || '').toUpperCase();

  let base;
  if (tier === 'TIER 1' && kai === 'BET') {
    base = `Strong bet on ${selection}. ${edgeStr}% edge, low risk.`;
  } else if (tier === 'TIER 2' && kai === 'CONSIDER') {
    base = `Consider ${selection}. ${edgeStr}% edge, moderate risk.`;
  } else {
    base = `Skip ${selection}. Insufficient edge or high risk.`;
  }

  // Audit fix (2026-07-11): surface conflict context so the user knows WHY
  // a play was downgraded from TIER 1 BET to TIER 2 CONSIDER. resolveGameConflicts
  // sets `conflictWith` (opposing side that won) and `conflictFlag` (boolean).
  if (bet.conflictWith && (bet.conflictFlag || (kai !== 'BET' && tier !== 'TIER 1'))) {
    base += ` Downgraded — opposing side "${bet.conflictWith}" is the sharper pick on the same game.`;
  }
  return base;
}

/**
 * Format a single bet as a plain-English sentence.
 *
 * Example output:
 * @param {Object} [bet={}] - Bet object with selection, odds, and optional context.
 * @param {string} [bet.selection] - Player/team selection.
 * @param {string} [bet.participant] - Participant name (fallback for selection).
 * @param {string} [bet.pick] - Pick value (fallback for selection).
 * @param {number} [bet.odds] - American odds.
 * @param {number} [bet.targetBookOdds] - Target book odds (fallback for odds).
 * @param {string} [bet.game] - Game description.
 * @param {string} [bet.league] - League name.
 * @param {string} [bet.market] - Market name.
 * @param {string} [bet.startCST] - Start time in CST.
 * @param {string} [bet.startNote] - Start time note.
 * @param {string} [bet.confidenceTier] - Confidence tier (e.g. 'TIER 1').
 * @param {string} [bet.tier] - Shorthand tier (fallback for confidenceTier).
 * @param {number} [bet.riskScore] - Risk score (0-10).
 * @param {string} [bet.rationale] - Explanation text.
 * @returns {string} Plain-English bet description sentence.
 */
function formatBetMinimal(bet = {}, context = {}) {
  const selection = safeString(bet.selection || bet.participant || bet.pick, 'Unknown selection');
  const odds = formatOddsForDisplay(bet.odds ?? bet.targetBookOdds, bet, context);
  const game = safeString(bet.game, '');
  const league = safeString(bet.league, '');
  const market = safeString(bet.market, '');
  const tier = safeString(bet.confidenceTier || bet.tier, '');
  const riskScore = bet.riskScore;
  const rationale = safeString(bet.rationale || toRationale(bet), '');

  const confidence = tierToConfidence(tier);
  const riskLabel = riskScoreToLabel(riskScore);
  const action = actionWord(tier);

  const oddsStr = odds ? ` at ${odds}` : '';
  const gameStr = game ? ` (${game}${league || market ? `, ${[league, market].filter(Boolean).join(' ')}` : ''})` : '';
  const warning = Number.isFinite(Number(riskScore)) && Number(riskScore) >= 7 ? ' ⚠️' : '';

  const startTimeStr = bet.startCST ? `${bet.startCST}${bet.startNote ? ` (${bet.startNote})` : ''} — ` : '';

  let sentence = `${startTimeStr}${action} ${selection}${oddsStr}${gameStr}. ${capitalize(confidence)}, ${riskLabel}.${warning}`;
  if (rationale) {
    sentence += ` Why: ${rationale}`;
  }
  return sentence.trim();
}

/**
 * Format an array of bets as a numbered list.
 * Returns "No strong plays right now." if the array is empty.
 *
 * @param {Object[]} [bets=[]] - Array of bet objects to format.
 * @returns {string} Numbered list of bet sentences, or a fallback message if empty.
 */
function formatBetsMinimal(bets = [], context = {}) {
  if (!Array.isArray(bets) || bets.length === 0) {
    return 'No strong plays right now.';
  }
  return bets.map((bet, i) => `${i + 1}. ${formatBetMinimal(bet, context)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Standard formatter (intermediate bettors)
// ---------------------------------------------------------------------------

/**
 * Fields to keep in the standard output. Everything else (lineHistory,
 * scoreBreakdown, debug, oddsMap, etc.) is stripped.
 */
// ---------------------------------------------------------------------------
// Bets mode: agent-optimized compact shape (~10 fields per candidate).
// Disposition + verdict are consolidated into single fields so agents never
// reconcile kaiCall / displayTier / finalVerdict / validatedTier.
// ---------------------------------------------------------------------------

/** Resolve the single authoritative verdict for bets mode. */
function consolidateVerdict(candidate) {
  if (candidate.finalVerdict) return candidate.finalVerdict;
  if (candidate.displayTier) return candidate.displayTier;
  return candidate.kaiCall || 'PASS';
}

/**
 * Map one candidate to the bets-mode shape.
 *
 * @param {Object} [bet={}] - Raw candidate object from screen results.
 * @param {string} [bet.game] - Game description.
 * @param {string} [bet.awayTeam] - Away team name.
 * @param {string} [bet.homeTeam] - Home team name.
 * @param {string} [bet.startCST] - Start time in CST.
 * @param {string} [bet.startNote] - Start time note.
 * @param {string} [bet.selection] - Player/team selection.
 * @param {string} [bet.participant] - Participant name.
 * @param {string} [bet.pick] - Pick name.
 * @param {number} [bet.odds] - American odds.
 * @param {number} [bet.targetBookOdds] - Target book odds.
 * @param {number} [bet.bestAvailableOdds] - Best available comparison price.
 * @param {string} [bet.executionQuality] - Target-book execution quality.
 * @param {string} [bet.market] - Market name.
 * @param {string} [bet.league] - League name.
 * @param {string} [bet.finalVerdict] - Final verdict.
 * @param {string} [bet.displayTier] - Display tier.
 * @param {string} [bet.kaiCall] - Kai call.
 * @param {string} [bet.finalConfidenceTier] - Final confidence tier.
 * @param {string} [bet.confidenceTier] - Raw confidence tier.
 * @param {string} [bet.validatedMovementDisposition] - Validated disposition.
 * @param {string} [bet.movementDisposition] - Raw disposition.
 * @param {string} [bet.movementSourceBook] - Book providing movement evidence.
 * @param {string} [bet.movementMode] - Movement provenance mode.
 * @param {string} [bet.historyProvider] - History provider name.
 * @param {string} [bet.historyReason] - History resolution reason.
 * @param {string} [bet.historyWarning] - History resolution warning.
 * @param {string} [bet.movementGrade] - Movement grade.
 * @param {string} [bet.confidenceTier] - Pre-validation ranker tier.
 * @param {string} [bet.validatedConfidenceTier] - Tier echoed back by validate_play.
 * @param {number} [bet.riskScore] - Ranker risk score that drove the tier.
 * @param {number} [bet.screenScore] - Ranker screen score.
 * @param {boolean} [bet.conflictFlag] - Row was demoted by a game-conflict guard.
 * @param {string} [bet.conflictWith] - The selection that won the conflict.
 * @param {boolean} [bet.consensusFloorApplied] - Row was demoted by the consensus floor guard.
 * @param {boolean} [bet.altLineFiltered] - Row is an alternate line (never a pick).
 * @param {number} [bet.edge] - Edge value.
 * @param {number} [bet.consensusEdge] - Consensus edge.
 * @param {number} [bet.consensusBookCount] - Consensus book count.
 * @param {number} [bet.validatedConsensusBookCount] - Validated book count.
 * @param {boolean} [bet.sharpBookMovementConfirmed] - Sharp book movement flag.
 * @param {boolean} [bet.steamMove] - Steam move flag.
 * @param {number} [bet.clvProxyPct] - CLV proxy percentage.
 * @param {number} [bet.clv] - CLV value.
 * @param {number} [bet.openingOdds] - Opening odds used in CLV calculation.
 * @param {number} [bet.currentOdds] - Current odds used in CLV calculation.
 * @param {number} [bet.lastMoveAgeMs] - Last move age in ms.
 * @param {string} [bet.rationale] - Rationale text.
 * @param {string} [bet.validatedActionableSummary] - Validated summary.
 * @param {string[]} [bet.validatedRiskFlags] - Risk flags.
 * @param {number} [bet.priceDrift] - Price drift.
 * @param {string[]} [bet.finalWarnings] - Final warnings.
 * @param {string} [bet.playId] - Play ID.
 * @param {string} [bet.selectionKey] - Selection key.
 * @param {string} [bet.targetBook] - Execution sportsbook.
 * @returns {Object} Compact bet object suitable for bets mode.
 */
function formatBetCompact(bet = {}, context = {}) {
  if (!bet || typeof bet !== 'object') return {};
  return {
    game: bet.game || `${bet.awayTeam || '?'} @ ${bet.homeTeam || '?'}`,
    startCST: bet.startCST || null,
    startNote: bet.startNote || null,
    selection: bet.selection || bet.participant || bet.pick || null,
    targetBook: bet.targetBook || context.targetBook || null,
    odds: oddsValueForDisplay(bet.odds ?? bet.targetBookOdds ?? null, bet, context),
    targetBookOdds: oddsValueForDisplay(bet.targetBookOdds ?? bet.odds ?? null, bet, context),
    bestAvailableOdds: oddsValueForDisplay(bet.bestAvailableOdds ?? null, bet, context),
    executionQuality: bet.executionQuality || null,
    market: bet.market || null,
    league: bet.league || null,
    verdict: bet.finalVerdict || consolidateVerdict(bet),
    tier: bet.finalConfidenceTier || bet.confidenceTier || null,
    displayTier: bet.displayTier || null,
    movement: bet.validatedMovementDisposition || bet.movementDisposition || null,
    movementDisposition: bet.movementDisposition || bet.validatedMovementDisposition || null,
    movementSourceBook: bet.movementSourceBook || null,
    movementMode: bet.movementMode || null,
    historyProvider: bet.historyProvider || null,
    historyReason: bet.historyReason || null,
    historyWarning: bet.historyWarning || null,
    movementGrade: bet.movementGrade || null,
    // Tier provenance: the post-ranker guards in screen-ranker.js mutate
    // confidenceTier, so a demoted row can look identical to a never-TIER-1
    // row. Expose the guard verdict + its inputs so a tier drop is explainable
    // from the scan output alone (rank already exposes riskScore).
    riskScore: bet.riskScore ?? null,
    screenScore: bet.screenScore ?? null,
    confidenceTier: bet.confidenceTier ?? null,
    validatedConfidenceTier: bet.validatedConfidenceTier ?? null,
    conflictFlag: bet.conflictFlag || false,
    conflictWith: bet.conflictWith || null,
    consensusFloorApplied: bet.consensusFloorApplied || false,
    altLineFiltered: bet.altLineFiltered || false,
    edge: bet.edge ?? bet.consensusEdge ?? null,
    books: bet.consensusBookCount ?? bet.validatedConsensusBookCount ?? 0,
    pinnacle: bet.sharpBookMovementConfirmed || false,
    steamMove: bet.steamMove || false,
    clvProxyPct: bet.clvProxyPct ?? bet.clv ?? null,
    openingOdds: oddsValueForDisplay(bet.openingOdds ?? null, bet, context),
    currentOdds: oddsValueForDisplay(bet.currentOdds ?? null, bet, context),
    lastMoveAgeMs: bet.lastMoveAgeMs ?? null,
    rationale: bet.rationale || bet.validatedActionableSummary || null,
    flags: bet.validatedRiskFlags || [],
    finalConfidenceTier: bet.finalConfidenceTier || null,
    finalVerdict: bet.finalVerdict || null,
    kaiCall: bet.kaiCall || null,
    priceDrift: bet.priceDrift ?? null,
    finalWarnings: bet.finalWarnings || [],
    playId: bet.playId || null,
    selectionKey: bet.selectionKey || null
  };
}

/** Map an array of bets to the compact shape. */
function formatBetsCompact(bets = [], context = {}) {
  if (!Array.isArray(bets)) return [];
  return bets.map((bet) => formatBetCompact(bet, context));
}

function formatWatchCandidate(candidate = {}, context = {}) {
  const compact = formatBetCompact(candidate, context);
  return {
    ...compact,
    league: candidate.league || null,
    market: candidate.market || null,
    official: false,
    ...(candidate.status ? { status: candidate.status } : {}),
    ...(candidate.incomplete ? { incomplete: true } : {}),
    ...(candidate.lineHistoryAvailable === false ? { lineHistoryAvailable: false } : {}),
    ...(candidate.validationBudgetExhausted ? { validationBudgetExhausted: true } : {}),
    ...(candidate.validationFailureReason ? { validationFailureReason: candidate.validationFailureReason } : {})
  };
}

/** Format a quick_screen response for bets mode. */
function formatQuickScreenBets(response = {}) {
  const context = responseBookContext(response);
  const diagnosticKeys = [
    'scanHealth',
    'preHistoryShortlist',
    'perPairDiagnostics',
    'totalsRecoveryApplied',
    'error',
    'code',
    'recovery'
  ];
  const results = Array.isArray(response.results)
    ? response.results.map((entry) => {
        const plays = Array.isArray(entry.candidates) ? formatBetsCompact(entry.candidates, context) : [];
        for (const p of plays) {
          p.league = entry.league || null;
          p.market = entry.market || null;
        }
        const formattedEntry = { league: entry.league, market: entry.market, plays };
        for (const key of diagnosticKeys) {
          if (entry[key] !== undefined) formattedEntry[key] = entry[key];
        }
        return formattedEntry;
      })
    : [];

  const topLevelDiagnosticKeys = [
    'cardWindowFallthrough',
    'nextDayMerged',
    'nextDayDate',
    'cardWindow',
    'preHistoryShortlist',
    'totalsRecoveryApplied'
  ];
  const topLevelDiagnostics = Object.fromEntries(
    topLevelDiagnosticKeys.filter((key) => response[key] !== undefined).map((key) => [key, response[key]])
  );

  return {
    ok: true,
    ...topLevelDiagnostics,
    targetBook: response.targetBook || null,
    targetBooks: Array.isArray(response.targetBooks) ? response.targetBooks : [],
    leagues: Array.isArray(response.leagues) ? response.leagues : [],
    markets: Array.isArray(response.markets) ? response.markets : [],
    workflow: response.workflow || null,
    ...(Array.isArray(response.markets_alias_used) ? { markets_alias_used: response.markets_alias_used } : {}),
    totalCandidates: response.totalCandidates ?? 0,
    tierStats: response.tierStats || null,
    summary: buildQuickScreenSummary(response.results, context),
    byLeague: buildByLeagueStats(response.results),
    activeSlate: Array.isArray(response.activeSlate) ? response.activeSlate : [],
    emptySlate: Array.isArray(response.emptySlate) ? response.emptySlate : [],
    warnings: Array.isArray(response.warnings) ? response.warnings : [],
    ...(response.scanHealth ? { scanHealth: response.scanHealth } : {}),
    ...(Array.isArray(response.watchCandidates)
      ? { watchCandidates: response.watchCandidates.map((candidate) => formatWatchCandidate(candidate, context)) }
      : {}),
    ...(Array.isArray(response.unresolvedCandidates)
      ? {
          unresolvedCandidates: response.unresolvedCandidates.map((candidate) =>
            formatWatchCandidate(candidate, context)
          )
        }
      : {}),
    results
  };
}

const STANDARD_KEEP_FIELDS = new Set([
  'selection',
  'participant',
  'pick',
  'odds',
  'targetBookOdds',
  'bestAvailableOdds',
  'executionQuality',
  'game',
  'gameId',
  'league',
  'market',
  'targetBook',
  'movementDisposition',
  'movementSourceBook',
  'movementMode',
  'historyProvider',
  'historyReason',
  'historyWarning',
  'start',
  'startCST',
  'startNote',
  'tier',
  'confidenceTier',
  'displayTier',
  // Authoritative merged verdict (screen + validation). Keep so the
  // standard verbosity surfaces the real bet/no-bet call, not just the
  // screen snapshot.
  'finalVerdict',
  'finalConfidenceTier',
  'edge',
  'consensusEdge',
  'riskScore',
  'movementGrade',
  'kaiCall',
  'rationale',
  'consensusScore',
  'consensusBookCount',
  'screenScore',
  'executionQuality',
  'clv',
  'clvProxyPct',
  'consensusStrength',
  'tierTrajectory',
  'playId',
  'selectionKey',
  'homeTeam',
  'awayTeam',
  'isLive',
  'hoursUntilStart',
  'startCT',
  'startsIn',
  'startUnverified',
  'movementAsOf',
  'liquidityFlag',
  'screenUrl',
  // Native PP selection-scoped price-history provenance.
  // Price history can qualify movement while lineHistoryUsable remains degraded.
  'priceHistoryUsable',
  'priceHistoryScope',
  'priceHistorySource',
  'priceHistoryPointCount'
]);

/**
 * Fields that are explicitly verbose and must be stripped even if not in
 * the keep-list (belt-and-suspenders).
 */
const STANDARD_STRIP_FIELDS = new Set([
  'lineHistory',
  'scoreBreakdown',
  'debug',
  'oddsMap',
  'filteredLineHistory',
  'movementDebug',
  'passReasons',
  'nearMissDetails'
]);

/**
 * Format a single bet for standard output: keep key fields, strip verbose
 * debug payloads.
 *
 * @param {Object} [bet={}] - Raw bet object with optional verbose debug fields.
 * @param {string} [bet.selection] - The player/team name.
 * @param {string} [bet.participant] - Alternative participant name.
 * @param {string} [bet.pick] - Alternative pick name.
 * @param {number} [bet.odds] - American odds.
 * @param {number} [bet.targetBookOdds] - Target book odds.
 * @param {number} [bet.consensusEdge] - Consensus edge value.
 * @param {string} [bet.confidenceTier] - Confidence tier string.
 * @param {string} [bet.lineHistory] - Verbose line history (stripped).
 * @param {string} [bet.scoreBreakdown] - Verbose score breakdown (stripped).
 * @param {string} [bet.debug] - Verbose debug info (stripped).
 * @returns {Object} Filtered bet object containing only standard keep-fields.
 */
function formatBetStandard(bet = {}, context = {}) {
  if (!bet || typeof bet !== 'object') return {};
  const out = {};
  for (const key of Object.keys(bet)) {
    if (STANDARD_STRIP_FIELDS.has(key)) continue;
    if (STANDARD_KEEP_FIELDS.has(key)) {
      out[key] = bet[key];
    }
  }
  // Ensure the key fields the spec calls out are always present (with safe defaults)
  if (out.selection === undefined && bet.participant !== undefined) out.selection = bet.participant;
  if (out.selection === undefined && bet.pick !== undefined) out.selection = bet.pick;
  if (out.odds === undefined && bet.targetBookOdds !== undefined) out.odds = bet.targetBookOdds;
  if (out.targetBook === undefined && context.targetBook !== undefined) out.targetBook = context.targetBook;
  if (out.tier === undefined && bet.confidenceTier !== undefined) out.tier = bet.confidenceTier;
  if (out.edge === undefined && bet.consensusEdge !== undefined) out.edge = bet.consensusEdge;
  for (const key of ['odds', 'targetBookOdds', 'bestAvailableOdds', 'openingOdds', 'currentOdds']) {
    if (out[key] !== undefined && out[key] !== null && out[key] !== '') {
      out[key] = oddsValueForDisplay(out[key], bet, context);
    }
  }
  return out;
}

/**
 * Format an array of bets for standard output.
 *
 * @param {Object[]} [bets=[]] - Array of raw bet objects.
 * @returns {Object[]} Array of filtered bet objects with verbose fields stripped.
 */
function formatBetsStandard(bets = [], context = {}) {
  if (!Array.isArray(bets)) return [];
  return bets.map((bet) => formatBetStandard(bet, context));
}

// ---------------------------------------------------------------------------
// Response-level formatters
// ---------------------------------------------------------------------------

/**
 * Format a recommended_bets response for minimal output.
 *
 * @param {Object} [response={}] - Recommended bets API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {number} [response.totalRecommended] - Total recommended count.
 * @param {Object[]} [response.leagues] - Array of per-league result objects.
 * @param {string} [response.leagues[].league] - League name.
 * @param {number} [response.leagues[].count] - Number of plays for this league.
 * @param {Object[]} [response.leagues[].plays] - Array of bet objects for this league.
 * @returns {{summary: string, count: number, type: string}} Object with a plain-English summary string, total count, and type indicator.
 */
function formatRecommendedBetsMinimal(response = {}) {
  const leagues = Array.isArray(response.leagues) ? response.leagues : [];
  const allPlays = leagues.flatMap((l) =>
    Array.isArray(l.plays) ? l.plays.map((p) => ({ ...p, league: l.league })) : []
  );
  const summary = formatBetsMinimal(allPlays, responseBookContext(response));
  return {
    summary,
    count: allPlays.length,
    type: allPlays.length > 0 ? 'plays' : 'no_plays'
  };
}

/**
 * Format a recommended_bets response for standard output.
 * Keeps league grouping but strips verbose fields from each play.
 *
 * @param {Object} [response={}] - Recommended bets API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {number} [response.totalRecommended] - Total recommended count.
 * @param {Object[]} [response.leagues] - Array of per-league result objects.
 * @param {Object} response - All other response fields are preserved.
 * @returns {Object} Response object with league plays filtered through standard formatting.
 */
function formatRecommendedBetsStandard(response = {}) {
  const leagues = Array.isArray(response.leagues) ? response.leagues : [];
  return {
    ...response,
    leagues: leagues.map((l) => ({
      ...l,
      plays: Array.isArray(l.plays) ? formatBetsStandard(l.plays, responseBookContext(response)) : []
    }))
  };
}

/**
 * Format a sharp_plays response for minimal output.
 *
 * @param {Object} [response={}] - Sharp plays API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {number} [response.count] - Number of plays.
 * @param {Object[]} [response.result] - Array of bet objects.
 * @returns {{summary: string, count: number, type: string}} Object with a plain-English summary string, total count, and type indicator.
 */
function formatSharpPlaysMinimal(response = {}) {
  const result = Array.isArray(response.result) ? response.result : [];
  const summary = formatBetsMinimal(result, responseBookContext(response));
  return {
    summary,
    count: result.length,
    type: result.length > 0 ? 'plays' : 'no_plays'
  };
}

/**
 * Format a sharp_plays response for standard output.
 *
 * @param {Object} [response={}] - Sharp plays API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {number} [response.count] - Number of plays.
 * @param {Object[]} [response.result] - Array of raw bet objects.
 * @param {Object} response - All other response fields are preserved.
 * @returns {Object} Response object with result array filtered through standard formatting.
 */
function formatSharpPlaysStandard(response = {}) {
  return {
    ...response,
    result: Array.isArray(response.result) ? formatBetsStandard(response.result, responseBookContext(response)) : []
  };
}

/**
 * Format a screen_ranked response for minimal output.
 *
 * @param {Object} [response={}] - Screen ranked API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {Object[]} [response.result] - Array of ranked bet objects.
 * @returns {{summary: string, count: number, type: string}} Object with a plain-English summary string, total count, and type indicator.
 */
function formatScreenRankedMinimal(response = {}) {
  const result = Array.isArray(response.result) ? response.result : [];
  const summary = formatBetsMinimal(result, responseBookContext(response));
  return {
    summary,
    count: result.length,
    type: result.length > 0 ? 'plays' : 'no_plays'
  };
}

/**
 * Format a screen_ranked response for standard output.
 *
 * @param {Object} [response={}] - Screen ranked API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {Object[]} [response.result] - Array of raw ranked bet objects.
 * @param {Object} response - All other response fields are preserved.
 * @returns {Object} Response object with result array filtered through standard formatting.
 */
function formatScreenRankedStandard(response = {}) {
  return {
    ...response,
    result: Array.isArray(response.result) ? formatBetsStandard(response.result, responseBookContext(response)) : []
  };
}

/**
 * Format a quick_screen response for minimal output.
 * Produces a scannable summary with league-section headers, capped plays,
 * and a tier-count footer.  Also includes structured plays for agent consumption.
 *
 * @param {Object} [response={}] - quick_screen API response.
 * @param {Object[]} [response.results] - Array of per-league/market result objects.
 * @returns {{summary: string, count: number, type: string, byLeague: Object, plays?: Object[], cardWindowFallthrough?: boolean, nextDayMerged?: boolean, nextDayDate?: string|null, cardWindow?: string}} Response object with summary text, count, type, and structured plays.
 */
function formatQuickScreenMinimal(response = {}) {
  const res = /** @type {any} */ (response);
  const context = responseBookContext(res);
  const results = Array.isArray(res.results) ? res.results : [];
  const allPlays = results.flatMap((entry) =>
    Array.isArray(entry.candidates)
      ? entry.candidates.map((c) => ({ ...c, league: entry.league, market: entry.market }))
      : []
  );

  if (!allPlays.length) {
    return {
      summary: 'No strong plays right now.',
      count: 0,
      type: 'no_plays',
      byLeague: {},
      ...(res.scanHealth ? { scanHealth: res.scanHealth } : {}),
      ...(Array.isArray(res.watchCandidates) ? { watchCandidates: res.watchCandidates } : {}),
      ...(Array.isArray(res.unresolvedCandidates)
        ? {
            unresolvedCandidates: res.unresolvedCandidates.map((candidate) => formatWatchCandidate(candidate, context))
          }
        : {})
    };
  }

  const summary = buildQuickScreenSummary(results, context);

  const out = { summary, count: allPlays.length, type: 'plays', byLeague: buildByLeagueStats(results) };
  out.plays = allPlays.map((p) => ({
    league: p.league,
    market: p.market,
    game: p.game,
    gameId: p.gameId,
    playId: p.playId,
    selectionKey: p.selectionKey,
    selection: p.selection,
    targetBook: p.targetBook || res.targetBook || null,
    odds: oddsValueForDisplay(p.odds ?? p.targetBookOdds, p, context),
    targetBookOdds: oddsValueForDisplay(p.targetBookOdds ?? p.odds ?? null, p, context),
    bestAvailableOdds: oddsValueForDisplay(p.bestAvailableOdds ?? null, p, context),
    executionQuality: p.executionQuality || null,
    confidenceTier: p.confidenceTier,
    finalConfidenceTier: p.finalConfidenceTier,
    displayTier: p.displayTier,
    finalVerdict: p.finalVerdict,
    edge: p.edge,
    startCST: p.startCST,
    startNote: p.startNote,
    hoursUntilStart: p.hoursUntilStart,
    movementDisposition: p.movementDisposition || p.validatedMovementDisposition,
    movementSourceBook: p.movementSourceBook || null,
    movementMode: p.movementMode || null,
    historyProvider: p.historyProvider || null,
    historyReason: p.historyReason || null,
    historyWarning: p.historyWarning || null,
    movementGrade: p.movementGrade || null,
    kaiCall: p.kaiCall,
    consensusBookCount: p.consensusBookCount ?? null,
    rationale: p.rationale || p.validatedActionableSummary,
    screenUrl: p.screenUrl || null
  }));
  if (Array.isArray(res.unresolvedCandidates)) {
    out.unresolvedCandidates = res.unresolvedCandidates.map((candidate) => formatWatchCandidate(candidate, context));
  }
  if (res.cardWindowFallthrough) out.cardWindowFallthrough = true;
  if (res.nextDayMerged) {
    out.nextDayMerged = true;
    out.nextDayDate = res.nextDayDate || null;
    out.cardWindow = res.cardWindow || 'today';
  }
  return out;
}

/**
 * Format a quick_screen response for standard output.
 * Keeps the league/market grouping but strips verbose fields from each candidate.
 *
 * @param {Object} [response={}] - quick_screen API response.
 * @param {Object[]} [response.results] - Array of per-league/market result objects.
 * @param {Object} response - All other response fields are preserved.
 * @returns {Object} Response object with candidates filtered through standard formatting.
 */
function formatQuickScreenStandard(response = {}) {
  const res = /** @type {any} */ (response);
  const context = responseBookContext(res);
  const out = {
    ...res,
    results: Array.isArray(res.results)
      ? res.results.map((entry) => ({
          ...entry,
          candidates: Array.isArray(entry.candidates) ? formatBetsStandard(entry.candidates, context) : []
        }))
      : []
  };
  // Carry the honest day-span flags so consumers see when next-day rows were merged
  if (res.cardWindowFallthrough) out.cardWindowFallthrough = true;
  if (res.nextDayMerged) {
    out.nextDayMerged = true;
    out.nextDayDate = res.nextDayDate || null;
  }
  return out;
}

/**
 * Format a get_play_details response for minimal output.
 *
 * @param {Object} [response={}] - get_play_details API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {Object[]} [response.result] - Array of detailed bet row objects.
 * @returns {{summary: string, count: number, type: string, matchedRows: number}} Object with a plain-English summary string, total count, type, and matched rows count.
 */
function formatGetPlayDetailsMinimal(response = {}) {
  const res = /** @type {any} */ (response);
  const result = Array.isArray(res.result) ? res.result : [];
  const summary = formatBetsMinimal(result, responseBookContext(res));
  return {
    summary,
    count: result.length,
    type: result.length > 0 ? 'plays' : 'no_plays',
    matchedRows: res.resultMeta?.matchedRows ?? result.length
  };
}

/**
 * Format a get_play_details response for standard output.
 * Strips verbose payloads but keeps structured data rows.
 *
 * @param {Object} [response={}] - get_play_details API response.
 * @param {boolean} [response.ok] - Success flag.
 * @param {Object[]} [response.result] - Array of raw detailed bet row objects.
 * @param {Object} response - All other response fields are preserved.
 * @returns {Object} Response object with result array and resultMeta filtered through standard formatting.
 */
function formatGetPlayDetailsStandard(response = {}) {
  return {
    ...response,
    result: Array.isArray(response.result) ? formatBetsStandard(response.result, responseBookContext(response)) : []
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function capitalize(str) {
  const s = String(str || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  // Single-bet formatters
  formatBetMinimal,
  formatBetStandard,
  formatBetCompact,
  // Array formatters
  formatBetsMinimal,
  formatBetsStandard,
  formatBetsCompact,
  // Response-level formatters
  formatGetPlayDetailsMinimal,
  formatGetPlayDetailsStandard,
  formatRecommendedBetsMinimal,
  formatRecommendedBetsStandard,
  formatSharpPlaysMinimal,
  formatSharpPlaysStandard,
  formatScreenRankedMinimal,
  formatScreenRankedStandard,
  formatQuickScreenMinimal,
  formatQuickScreenStandard,
  formatQuickScreenBets,
  // Helpers (exported for testing)
  tierToConfidence,
  riskScoreToLabel,
  actionWord,
  formatOdds,
  formatOddsForDisplay,
  consolidateVerdict,
  movementGradeEmoji,
  buildQuickScreenSummary,
  formatBetsSummaryLine,
  buildByLeagueStats,
  STANDARD_KEEP_FIELDS,
  STANDARD_STRIP_FIELDS
};
