'use strict';

/**
 * Record-quality audit for the tracker ledger.
 *
 * A ledger row is only usable for evaluation if its price is a real price, its
 * event identity is resolvable, and its start time is machine-readable. The
 * observed reality (2026-09-17, 90 candidates across 3 scans) is that none of
 * those hold universally:
 *
 *   - `odds` can be a percent STRING (`'49.0%'`) rather than an American price,
 *     because a NoVig-family row carries an implied probability there. The two
 *     are not interchangeable and must never be silently coerced into one
 *     another: '49.0%' is a probability, -104 is a price, and a consumer that
 *     treats one as the other is computing EV against a number that does not
 *     mean what it thinks.
 *   - `gameId` is null on every recorded candidate, so nothing can be re-priced
 *     or settled by id.
 *   - `start` is null on roughly a third of candidates, which carry only the
 *     display string `startCST` (`'Sat, Sep 12, 6:15 PM CT'`, no year).
 *
 * This module reports those facts. It does not repair them and it never guesses
 * a missing value.
 */

/** American-odds string, e.g. `-110`, `+150`. */
const AMERICAN_RE = /^[+-]?\d{2,}$/;
/** Implied-probability percent string written by the NoVig-family formatters, e.g. `49.0%`. */
const PERCENT_RE = /^-?\d+(?:\.\d+)?%$/;
/** Decimal odds, e.g. `1.91`. */
const DECIMAL_RE = /^\d*\.\d+$/;

/**
 * Classify a recorded price WITHOUT converting it.
 *
 * The only conversion performed is the trivial percent-string to fraction
 * (`'49.0%'` -> 0.49), which is a unit change on the same quantity, not a
 * translation between a probability and a price. No `americanToImplied` or
 * `impliedToAmerican` path exists here on purpose: inventing a vig-free price
 * from a single-sided implied probability is exactly the derivation this repo
 * refuses to make.
 *
 * @param {unknown} value - recorded `odds` value
 * @returns {{ok: boolean, format: string, raw: unknown, american: number|null,
 *   decimal: number|null, impliedProbability: number|null}}
 */
function classifyPrice(value) {
  const base = {
    ok: false,
    format: 'unparseable',
    raw: value,
    american: null,
    decimal: null,
    impliedProbability: null
  };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return base;
    if (Math.abs(value) >= 100) return { ...base, ok: true, format: 'american', american: value };
    if (value > 1) return { ...base, ok: true, format: 'decimal', decimal: value };
    if (value > 0) return { ...base, ok: true, format: 'implied_probability', impliedProbability: value };
    return base;
  }
  if (typeof value !== 'string') return base;
  const text = value.trim();
  if (text === '') return base;
  if (PERCENT_RE.test(text)) {
    const pct = Number(text.slice(0, -1));
    // A certain or impossible outcome is not a price and not a usable
    // probability: `0%` and `100%` are refused rather than recorded.
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return base;
    return { ...base, ok: true, format: 'implied_pct', impliedProbability: pct / 100 };
  }
  if (AMERICAN_RE.test(text)) {
    const american = Number(text);
    if (!Number.isFinite(american)) return base;
    return { ...base, ok: true, format: 'american', american };
  }
  if (DECIMAL_RE.test(text)) {
    const decimal = Number(text);
    if (!Number.isFinite(decimal) || decimal <= 1) return base;
    return { ...base, ok: true, format: 'decimal', decimal };
  }
  return base;
}

/** True when the recorded price is an actual price (American or decimal), not a probability. */
function isPricedOdds(value) {
  const classified = classifyPrice(value);
  return classified.ok && (classified.american != null || classified.decimal != null);
}

/**
 * The implied probability of a price, as a fraction in (0, 1), or null.
 *
 * This is the VIGGED implied probability of a single side — it is not a fair
 * (de-vigged) price and must never be presented as one. It is the right input
 * for comparing our price against the closing price, which is a
 * price-versus-price comparison on the same basis.
 *
 * @param {unknown} value - American odds, decimal odds, or an implied fraction
 * @returns {number|null}
 */
function impliedFraction(value) {
  const classified = classifyPrice(value);
  if (!classified.ok) return null;
  if (classified.impliedProbability != null) return classified.impliedProbability;
  if (classified.decimal != null) {
    const decimal = classified.decimal;
    return decimal > 0 ? 1 / decimal : null;
  }
  if (classified.american != null) {
    const american = classified.american;
    if (american < 0) return Math.abs(american) / (Math.abs(american) + 100);
    return 100 / (american + 100);
  }
  return null;
}

/**
 * Closing line value: our decision price against the CLOSING price.
 *
 * Positive means the price we took was better than the price the market closed
 * at, which is the one metric documented to separate winning bettors from
 * losing ones. This is NOT the same quantity as the open-to-current move the
 * cards used to print under the label "CLV" — that one has already happened to
 * the reader and says nothing about beating the close.
 *
 * Fails closed: if either side is missing or is not a price, the answer is
 * `null` with a reason, never a number assembled from a proxy.
 *
 * @param {unknown} decisionOdds - the price taken at decision time
 * @param {unknown} closeOdds - the closing price (or its implied probability)
 * @returns {{ok: boolean, clvPct: number|null, decisionImplied: number|null,
 *   closeImplied: number|null, reason?: string}}
 */
function beatTheClose(decisionOdds, closeOdds) {
  const decisionImplied = impliedFraction(decisionOdds);
  if (decisionImplied == null) {
    return { ok: false, clvPct: null, decisionImplied: null, closeImplied: null, reason: 'decision_price_not_a_price' };
  }
  const closeImplied = impliedFraction(closeOdds);
  if (closeImplied == null) {
    return {
      ok: false,
      clvPct: null,
      decisionImplied,
      closeImplied: null,
      reason: 'close_not_a_price'
    };
  }
  // Rounded to 4dp: these are decision-support numbers, and unrounded floats
  // make otherwise identical rows look different.
  const clvPct = Math.round((decisionImplied - closeImplied) * 100 * 1e4) / 1e4;
  return { ok: true, clvPct, decisionImplied, closeImplied };
}

/**
 * Earliest machine-readable start for a candidate, or null.
 *
 * Only ISO-parseable fields are trusted. `startCST` is a display string with no
 * year and is deliberately NOT parsed: a wrong start would silently move a
 * candidate into or out of a capture window, and reading the year from "today"
 * would misdate a delayed or rescheduled event.
 *
 * @param {Object} candidate
 * @returns {number|null} epoch ms
 */
function candidateStartMs(candidate) {
  const fields = [candidate && candidate.start, candidate && candidate.scheduledStart];
  for (const value of fields) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Audit a ledger's usability for evaluation. Read-only; never mutates.
 *
 * @param {Object} ledger - v2 ledger
 * @returns {Object} counts plus the per-candidate issue breakdown
 */
function auditLedger(ledger) {
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const bets = Array.isArray(ledger && ledger.bets) ? ledger.bets : [];
  const settlements = Array.isArray(ledger && ledger.settlements) ? ledger.settlements : [];
  const scans = Array.isArray(ledger && ledger.scans) ? ledger.scans : [];

  const priceFormats = {};
  const issues = {
    unparseable_price: 0,
    probability_not_price: 0,
    missing_game_id: 0,
    missing_start: 0,
    missing_fair_probability: 0,
    missing_capture_time: 0,
    zero_odds: 0
  };
  let priced = 0;
  let withClose = 0;
  let startedAtRecorded = 0;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const classified = classifyPrice(candidate.odds);
    priceFormats[classified.format] = (priceFormats[classified.format] || 0) + 1;
    if (classified.ok && (classified.american != null || classified.decimal != null)) priced += 1;
    else if (classified.format === 'implied_pct' || classified.format === 'implied_probability')
      issues.probability_not_price += 1;
    else issues.unparseable_price += 1;

    if (candidate.odds === 0) issues.zero_odds += 1;
    if (!candidate.gameId) issues.missing_game_id += 1;
    if (candidateStartMs(candidate) == null) issues.missing_start += 1;
    else startedAtRecorded += 1;
    const snapshot = candidate.featureSnapshot || {};
    if (snapshot.marketFairProbability == null) issues.missing_fair_probability += 1;
    if (snapshot.capturedAt == null) issues.missing_capture_time += 1;
    if (candidate.closeOdds != null || candidate.closeImpliedProbability != null) withClose += 1;
  }

  // A ledger whose official bets carry no settlement cannot answer any question
  // about performance, whatever else is on it.
  const settledBets = bets.filter(
    (bet) => bet && (bet.status === 'win' || bet.status === 'loss' || bet.status === 'push')
  );

  return {
    scans: scans.length,
    candidates: candidates.length,
    bets: bets.length,
    settlements: settlements.length,
    settledBets: settledBets.length,
    pricedCandidates: priced,
    candidatesWithClose: withClose,
    candidatesWithStart: startedAtRecorded,
    priceFormats,
    issues,
    // The two gates that matter for the plan: can we price a row, and can we
    // measure ourselves. Both are counts, not verdicts.
    evaluable: settledBets.length > 0 && priced > 0,
    closeCapturePossible: startedAtRecorded > 0
  };
}

module.exports = {
  classifyPrice,
  isPricedOdds,
  impliedFraction,
  beatTheClose,
  candidateStartMs,
  auditLedger,
  AMERICAN_RE,
  PERCENT_RE
};
