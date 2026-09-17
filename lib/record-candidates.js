'use strict';

const crypto = require('node:crypto');

/**
 * Normalize scan output into recordable candidate records.
 *
 * Input shapes accepted (Task 2 core):
 *   - top-level array of { league, market, plays: [...] } blocks (the common
 *     scan shape, incl. the injected tennis fallback bucket whose market is
 *     'All Markets' and whose rows carry raw `verdict` instead of
 *     `finalVerdict`/`kaiCall`)
 *   - a wrapped response object: { data: { results }, ... } or { results, ... }
 *
 * Rules:
 *   - Flattens every block; rows missing league/market inherit the block's.
 *   - Market names are preserved exactly (no aliasing — 'Set Handicap' stays
 *     'Set Handicap').
 *   - Raw PP verdicts (BET/CONSIDER/...) remain data fields only; this module
 *     never derives an "official bet" flag or any recommendation decision.
 *   - Missing fields normalize to null; no values are invented.
 *   - Stable candidateId = sha256(scanId|gameId|market|selection|odds),
 *     sliced to 16 hex chars, following the repo's daily-snapshot convention.
 *   - Every candidate carries an immutable `featureSnapshot` (schemaVersion 1)
 *     capturing decision-time features exactly as observed in the scan row.
 *     The snapshot is a JSON-safe deep clone: later mutation of the source
 *     row cannot alter it, and no probability is ever derived — explicit
 *     probability fields are preserved only when present in the row.
 *
 * @param {Array|Object} input - scan results array or wrapped response object
 * @param {Object} [opts] - { scanId, capturedAt } stable id of the scan that
 *   produced rows and the candidate capture time (ISO string) if known; no
 *   clock is read inside this pure function
 * @returns {Array<Object>} flattened, normalized candidate records
 */
function normalizeScanCandidates(input, { scanId, capturedAt = null } = {}) {
  const blocks = Array.isArray(input)
    ? input
    : Array.isArray(input && input.results)
      ? input.results
      : Array.isArray(input && input.data && input.data.results)
        ? input.data.results
        : [];

  const out = [];
  for (const block of blocks) {
    if (!block || !Array.isArray(block.plays) || block.plays.length === 0) continue;
    for (const play of block.plays) {
      if (!play || typeof play !== 'object') continue;
      out.push(normalizeRow(play, block, scanId, capturedAt));
    }
  }
  return out;
}

function normalizeRow(play, block, scanId, capturedAt) {
  const league = play.league ?? block.league ?? null;
  const market = play.market ?? block.market ?? null;
  const gameId = play.gameId ?? null;
  const selection = play.selection ?? play.participant ?? play.pick ?? null;
  const odds = play.odds ?? play.currentOdds ?? null;
  const books = play.books ?? play.consensusBookCount ?? null;

  const candidate = {
    candidateId: buildCandidateId({ scanId, gameId, market, selection, odds }),
    scanId: scanId ?? null,
    gameId,
    game: play.game ?? null,
    league,
    market,
    selection,
    odds,
    tier: play.tier ?? play.confidenceTier ?? null,
    verdict: play.verdict ?? play.finalVerdict ?? play.kaiCall ?? null,
    movement: play.movement ?? null,
    movementDisposition: play.movementDisposition ?? null,
    edge: play.edge ?? play.consensusEdge ?? null,
    // `clvProxyPct` is the move from the OPENING price to the CURRENT one. It is
    // not closing line value and the name was a lie; `openToCurrentPct` is the
    // honest name and is what new consumers should read. The old key is still
    // emitted so stored scans and existing readers keep working, and
    // `closeOdds`/`clvPct` (added by scripts/capture-close.js) carry the close.
    clvProxyPct: play.clvProxyPct ?? play.clv ?? null,
    openToCurrentPct: play.openToCurrentPct ?? play.clvProxyPct ?? play.clv ?? null,
    closeOdds: play.closeOdds ?? null,
    clvPct: play.clvPct ?? null,
    books,
    consensusBookCount: play.consensusBookCount ?? play.books ?? null,
    start: play.start ?? null,
    startCST: play.startCST ?? null,
    startDisplay: play.startDisplay ?? null,
    startSource: play.startSource ?? null,
    startConfidence: play.startConfidence ?? null
  };
  candidate.featureSnapshot = buildFeatureSnapshot(play, { capturedAt });
  return candidate;
}

/**
 * Immutable decision-time feature snapshot (schemaVersion 1).
 *
 * Captures exactly the features observed in the scan row at decision time so
 * later review never depends on mutable candidate rows. All fields normalize
 * to null when unavailable; nothing is derived. Explicit-only probability
 * fields are preserved only when the property is actually present on the row
 * (undefined is treated as absent), and the returned object is a JSON-safe
 * deep clone isolated from the source row.
 *
 * Provenance/context fields (league, market, book, line, selection, gameId,
 * decisionTimestamp, openingOdds, decisionOdds, movementSourceBook,
 * movementMode, correlationGroupId, sportContext) are preserved only when
 * explicitly present on the row — never derived from aliases outside the
 * documented selection chain and never backfilled from settlement/postgame
 * data. Settlement-only fields (outcome, result, winner, finalScore,
 * settlement, settledAt, payout) are never copied here.
 *
 * @param {Object} play - raw scan row
 * @param {Object} ctx - { capturedAt } capture time if known (never read here)
 * @returns {Object} JSON-safe deep-cloned feature snapshot
 */
function buildFeatureSnapshot(play, { capturedAt = null } = {}) {
  const present = (name) => Object.prototype.hasOwnProperty.call(play, name);
  // Explicitly present values are kept as-is (0 survives), but explicit
  // undefined/null normalize to null so the JSON-safe clone never drops keys.
  const value = (name) => (present(name) && play[name] !== undefined ? play[name] : null);
  const signalTier = play.signalTier ?? play.confidenceTier ?? play.tier ?? null;

  const snapshot = {
    schemaVersion: 1,
    capturedAt: capturedAt ?? play.capturedAt ?? null,
    league: play.league ?? null,
    market: play.market ?? null,
    book: play.book ?? null,
    line: play.line ?? null,
    selection: play.selection ?? play.participant ?? play.pick ?? null,
    gameId: play.gameId ?? null,
    decisionTimestamp: play.decisionTimestamp ?? null,
    openingOdds: play.openingOdds ?? null,
    decisionOdds: play.decisionOdds ?? null,
    movementSourceBook: play.movementSourceBook ?? null,
    movementMode: play.movementMode ?? null,
    correlationGroupId: play.correlationGroupId ?? null,
    sportContext:
      play.sportContext && typeof play.sportContext === 'object' && !Array.isArray(play.sportContext)
        ? play.sportContext
        : null,
    signalTier,
    confidenceTier: signalTier,
    signalQualityScore: play.signalQualityScore ?? play.screenScore ?? null,
    verdict: play.finalVerdict ?? play.verdict ?? play.kaiCall ?? null,
    movementDisposition: play.movementDisposition ?? null,
    movementGrade: play.movementGrade ?? null,
    consensusEdgePct: play.consensusEdge ?? play.edge ?? null,
    clvProxyPct: play.clvProxyPct ?? play.clv ?? null,
    openToCurrentPct: play.openToCurrentPct ?? play.clvProxyPct ?? play.clv ?? null,
    sharpBookCount: play.sharpBookCount ?? play.supportBookCount ?? null,
    consensusBookCount: play.consensusBookCount ?? play.books ?? null,
    marketBookCount: play.marketBookCount ?? null,
    executionQuality: play.executionQuality ?? null,
    targetBookOdds: play.targetBookOdds ?? play.odds ?? null,
    bestAvailableOdds: play.bestAvailableOdds ?? null,
    // Explicit-only: never derived from edge/odds/no-vig or any other field.
    marketFairProbability: value('marketFairProbability'),
    modelWinProbability: value('modelWinProbability'),
    modelMarketEdgePct: value('modelMarketEdgePct'),
    ratings: value('ratings')
  };
  return clone(snapshot);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Stable candidate identity: sha256 of scanId + gameId + market + selection +
 * captured price context (odds), each trimmed, sliced to 16 hex chars. Follows
 * the repo convention in scripts/daily-snapshot.js (buildPlayId).
 * Missing/undefined inputs normalize to '' so identity is stable across
 * null/undefined differences.
 *
 * @param {Object} ctx - { scanId, gameId, market, selection, odds }
 * @returns {string} 16-char hex id
 */
function buildCandidateId({ scanId, gameId, market, selection, odds } = {}) {
  const raw = [scanId, gameId, market, selection, odds].map((v) => String(v == null ? '' : v).trim()).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function buildScanFingerprint(input) {
  const candidates = normalizeScanCandidates(input, { scanId: null });
  const identities = candidates
    .map((candidate) =>
      [candidate.gameId, candidate.market, candidate.selection, candidate.odds].map((value) =>
        String(value == null ? '' : value).trim()
      )
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha256').update(JSON.stringify(identities)).digest('hex').slice(0, 16);
}

module.exports = { normalizeScanCandidates, buildCandidateId, buildScanFingerprint, buildFeatureSnapshot };
