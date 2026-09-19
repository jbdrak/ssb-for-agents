'use strict';

const ledgerApi = require('./record-ledger');

const DECISIONS = ['BET', 'LEAN', 'PASS'];
const PROMOTABLE_DECISION = 'BET';
const CANDIDATE_STATUS = { BET: 'promoted', LEAN: 'lean', PASS: 'pass' };

/**
 * Task 4 core: promote an explicit reviewed card into official bets.
 *
 * A raw SSB verdict is never an official bet. Only an explicit
 * reviewed card whose `decision` is BET creates a bet record in the ledger.
 * LEAN and PASS update the candidate's status without creating a bet.
 *
 * Card input contract:
 *   candidateId        required  — stable scan identity; must exist in the ledger
 *   decision           required  — BET | LEAN | PASS (case-insensitive)
 *   odds               required for BET — exact price at decision time
 *   stake              required for BET — positive stake amount
 *   researchSummary    required for BET
 *   decisionSource     required — who/what produced the reviewed decision
 *   scheduleVerification required for BET — evidence the event time/identity is resolved
 *   lineVerification   required for BET — evidence the line/price was confirmed
 *   notes              optional
 *
 * Official bet records carry the candidate snapshot and scan/source metadata
 * so later review never depends on mutable candidate rows.
 */

function normalizeDecision(decision) {
  return typeof decision === 'string' ? decision.trim().toUpperCase() : '';
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function validatePrice(odds) {
  const value = toNumber(odds);
  if (!Number.isFinite(value)) return 'odds is required for BET promotion and must be a valid number';
  if (value === 0) return 'odds must be a non-zero price';
  return null;
}

function validateStake(stake) {
  const value = toNumber(stake);
  if (!Number.isFinite(value)) return 'stake is required for BET promotion and must be a valid number';
  if (value <= 0) return 'stake must be a positive number';
  return null;
}

function resolvedStart(candidate, card) {
  const raw = candidate.start || candidate.startTimestamp || candidate.scheduledStart || card.scheduledStart || null;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return ['card must be an object'];
  }
  const errors = [];
  if (typeof card.candidateId !== 'string' || card.candidateId.trim() === '') {
    errors.push('candidateId is required');
  }
  const decision = normalizeDecision(card.decision);
  if (!DECISIONS.includes(decision)) {
    errors.push('decision must be one of BET, LEAN, PASS');
  }
  if (decision === PROMOTABLE_DECISION) {
    const oddsError = validatePrice(card.odds);
    if (oddsError) errors.push(oddsError);
    const stakeError = validateStake(card.stake);
    if (stakeError) errors.push(stakeError);
    if (typeof card.researchSummary !== 'string' || card.researchSummary.trim() === '') {
      errors.push('researchSummary is required for BET promotion');
    }
    if (typeof card.decisionSource !== 'string' || card.decisionSource.trim() === '') {
      errors.push('decisionSource is required');
    }
    if (!card.scheduleVerification) {
      errors.push('scheduleVerification is required for BET promotion (unresolved schedule cannot be promoted)');
    }
    if (!card.lineVerification) {
      errors.push('lineVerification is required for BET promotion');
    }
  } else if (DECISIONS.includes(decision)) {
    if (typeof card.decisionSource !== 'string' || card.decisionSource.trim() === '') {
      errors.push('decisionSource is required');
    }
  }
  return errors;
}

function findCandidate(ledger, candidateId) {
  return ledger.candidates.find((candidate) => candidate && candidate.candidateId === candidateId);
}

function findOfficialBet(ledger, candidateId) {
  return ledger.bets.find((bet) => bet && bet.candidateId === candidateId);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildBet(candidate, card, now, ledger) {
  const scan = candidate.scanId ? ledgerApi.findRecord(ledger, 'scans', candidate.scanId) : undefined;
  return {
    id: `bet-${candidate.candidateId}`,
    candidateId: candidate.candidateId,
    scanId: candidate.scanId ?? null,
    gameId: candidate.gameId ?? null,
    game: candidate.game ?? null,
    league: candidate.league ?? null,
    market: candidate.market ?? null,
    selection: candidate.selection ?? null,
    scheduledStart: resolvedStart(candidate, card),
    line: card.line ?? candidate.line ?? null,
    points: card.points ?? candidate.points ?? null,
    oddsAtDecision: toNumber(card.odds),
    stake: toNumber(card.stake),
    decisionAt: now,
    decisionSource: card.decisionSource,
    researchSummary: card.researchSummary ?? null,
    scheduleVerification: card.scheduleVerification ?? null,
    lineVerification: card.lineVerification ?? null,
    notes: card.notes ?? null,
    // Decision-time grade tags, stamped top-level so stats splits never read
    // 'unknown' for bets promoted with a graded candidate. The stats reader
    // also falls back to candidateSnapshot; this covers snapshot-less rows.
    tier: candidate.tier ?? card.tier ?? null,
    movement: candidate.movement ?? candidate.movementDisposition ?? card.movement ?? null,
    status: 'pending',
    settlementId: null,
    scanSource: scan ? (scan.source ?? null) : null,
    scanRecordedAt: scan ? (scan.recordedAt ?? null) : null,
    // Immutable decision-time features: a deep copy of the candidate snapshot
    // captured at promotion so later candidate mutation never alters the bet.
    featureSnapshot: candidate.featureSnapshot ? clone(candidate.featureSnapshot) : null,
    candidateSnapshot: clone(candidate)
  };
}

function markCandidate(candidate, status, card, now) {
  candidate.status = status;
  if (card.notes != null) candidate.reviewNote = card.notes;
  candidate.decisionSource = card.decisionSource;
  candidate.decisionAt = now;
  return candidate;
}

function promoteToBet(ledger, candidate, card, { now, dryRun }) {
  const existing = findOfficialBet(ledger, candidate.candidateId);
  if (existing) return { ok: true, duplicate: true, bet: clone(existing) };
  const bet = buildBet(candidate, card, now, ledger);
  if (dryRun) return { ok: true, dryRun: true, bet: clone(bet) };
  const added = ledgerApi.addRecord(ledger, 'bets', bet, { now: () => now });
  markCandidate(candidate, CANDIDATE_STATUS.BET, card, now);
  return { ok: true, duplicate: false, bet: added.record, candidate: clone(candidate) };
}

function recordNonBetDecision(ledger, candidate, decision, card, { now, dryRun }) {
  const status = CANDIDATE_STATUS[decision];
  const unchanged = candidate.status === status && (card.notes ?? null) === (candidate.reviewNote ?? null);
  if (dryRun) {
    return { ok: true, dryRun: true, candidate: clone(candidate), wouldSetStatus: status };
  }
  if (!unchanged) markCandidate(candidate, status, card, now);
  return { ok: true, duplicate: false, candidate: clone(candidate), status };
}

/**
 * Promote a single reviewed card. Returns { ok, ... } and never throws.
 * Writes only when the card is valid, the candidate exists, and (for BET)
 * the price, stake, and schedule/line verification all check out.
 */
function promoteCard(ledger, card, opts = {}) {
  const errors = validateCard(card);
  if (errors.length) return { ok: false, errors, error: errors[0] };
  const decision = normalizeDecision(card.decision);
  const candidate = findCandidate(ledger, card.candidateId);
  if (!candidate) return { ok: false, error: `candidate not found: ${card.candidateId}` };
  const now = typeof opts.now === 'function' ? opts.now() : new Date().toISOString();
  const dryRun = opts.dryRun === true;
  if (decision === PROMOTABLE_DECISION) {
    if (!resolvedStart(candidate, card)) {
      return {
        ok: false,
        error: 'BET requires a valid scheduled start on the candidate or reviewed card'
      };
    }
    return promoteToBet(ledger, candidate, card, { now, dryRun });
  }
  return recordNonBetDecision(ledger, candidate, decision, card, { now, dryRun });
}

/**
 * Promote an array (or single object) of reviewed cards. Partial success is
 * allowed: each card is validated independently and reported in `results`.
 */
function promoteCards(ledger, cards, opts = {}) {
  const list = Array.isArray(cards) ? cards : [cards];
  const results = list.map((card) => {
    const result = promoteCard(ledger, card, opts);
    return {
      candidateId: card && typeof card.candidateId === 'string' ? card.candidateId : null,
      decision: card && typeof card.decision === 'string' ? card.decision.trim().toUpperCase() : null,
      ok: result.ok === true,
      error: result.error || null,
      errors: result.errors || null,
      duplicate: result.duplicate === true,
      dryRun: result.dryRun === true,
      bet: result.bet || null,
      candidate: result.candidate || null,
      status: result.status || null,
      wouldSetStatus: result.wouldSetStatus || null
    };
  });
  const summary = {
    promoted: results.filter((r) => r.ok && r.bet && !r.duplicate && !r.dryRun).length,
    recorded: results.filter((r) => r.ok && !r.bet && !r.duplicate && !r.dryRun).length,
    duplicates: results.filter((r) => r.ok && r.duplicate).length,
    dryRun: results.filter((r) => r.ok && r.dryRun).length,
    rejected: results.filter((r) => !r.ok).length
  };
  return { ok: true, results, summary };
}

module.exports = { promoteCard, promoteCards, validateCard };
