'use strict';

/**
 * Cross-venue arbitrage detection.
 *
 * WHY THIS EXISTS
 *
 * The measured record of this repo's own scan is ~36% beat-the-close with a mean CLV
 * around -0.6%: the signature of paying the vig with no information advantage. That
 * matches the literature, which finds no statistically significant long-term odds-only
 * strategy in major pregame markets, and finds that apparent inefficiencies are not
 * persistent across leagues or seasons.
 *
 * The one documented retail-accessible edge that does NOT require out-predicting a
 * market is arbitrage BETWEEN venues. The strongest located study (11,933 matches,
 * Europe's five largest leagues) found 2,287 bookmaker/exchange inter-market arbitrage
 * opportunities at an average gross return of ~1.4%, concentrated in higher-liquidity
 * matches. The exchange leg matters: a sportsbook-vs-sportsbook pair is often two quotes
 * in the same market, which is not the same thing.
 *
 * The mechanism is arithmetic, not predictive. For a two-way market, backing side 1 at
 * one venue and side 2 at another is risk-free when the sum of the two implied
 * probabilities is below 1:
 *
 *     1/decimal(A) + 1/decimal(B) < 1
 *
 * In implied-probability space that is simply `impliedA + impliedB < 1`, which is why
 * this module needs no decimal conversion — `americanOddsToImpliedProbability` already
 * returns exactly `1/decimal`.
 *
 * TWO DIFFERENT DENOMINATORS, and conflating them misreports every arb. `marginPct` is
 * `1 - sum(implied)`, which is expressed relative to the PAYOUT. Profit measured
 * against the STAKE is larger: the exact relation is
 * `return = stake / (1 - marginPct/100)`, not `stake * (1 + marginPct/100)`.
 * A 4.76% margin is a 5.0% return on stake.
 *
 * WHAT THIS DOES NOT CLAIM
 *
 * Arbitrage is capacity-limited, not risk-free operationally. Stake limits, rejection or
 * partial acceptance, line movement between legs, differing settlement rules,
 * palpable-error voids, and account limiting all eat the margin — and the margin here is
 * small. A detected opportunity is a CANDIDATE requiring manual verification at both
 * venues, never a guaranteed profit. Nothing in this module places a bet.
 */

const { americanOddsToImpliedProbability } = require('./ssb-shared-utils');

/**
 * Below this margin a detected "arb" is more likely to be stale prices, a mislabelled
 * line, or slippage than a real opportunity. Expressed in percentage points of stake.
 */
const DEFAULT_MIN_ARB_MARGIN_PCT = 0.25;

/**
 * Above this margin the finding is almost certainly a DATA error rather than an
 * opportunity — a real cross-venue arb on a major market is worth a fraction of a
 * percent, rarely more than a few. The dangerous case: a row whose two sides carry the
 * same long price (both +500 implies 0.1667 + 0.1667 = 0.333, i.e. a "67% arb") is a
 * broken row, not free money. Such rows are reported but flagged `suspicious`, never
 * silently dropped — a silent drop would hide the data problem instead of surfacing it.
 */
const DEFAULT_MAX_PLAUSIBLE_MARGIN_PCT = 10;

/**
 * Implied probability for a price, or null when the price is unusable.
 * Never coerces 0 or a malformed value into a probability.
 */
function impliedOf(odds) {
  const implied = americanOddsToImpliedProbability(odds);
  return Number.isFinite(implied) && implied > 0 ? implied : null;
}

/**
 * Best (lowest-implied) two-sided quote for one row across its books.
 * @returns {{side1: Object|null, side2: Object|null}}
 */
function bestQuotes(row) {
  const oddsMap = row && typeof row.allBookOdds === 'object' && row.allBookOdds ? row.allBookOdds : null;
  const out = { side1: null, side2: null };
  if (!oddsMap) return out;
  for (const [book, prices] of Object.entries(oddsMap)) {
    if (!prices || typeof prices !== 'object') continue;
    for (const [key, side] of [
      ['odds1', 'side1'],
      ['odds2', 'side2']
    ]) {
      const implied = impliedOf(prices[key]);
      if (implied == null) continue;
      // Lowest implied probability wins: that is the biggest payout for the same side.
      if (!out[side] || implied < out[side].implied) {
        out[side] = { book, odds: Number(prices[key]), implied };
      }
    }
  }
  return out;
}

/**
 * Find cross-venue arbitrage opportunities across scan rows.
 *
 * Each returned row is a CANDIDATE, not a guarantee: the two prices must be verified as
 * live, same-line, and actually accepted at both venues before any money moves.
 *
 * @param {Array} rows - scan/ranker rows carrying `allBookOdds`
 * @param {Object} [opts] - { minMarginPct, maxPlausibleMarginPct }
 * @returns {{ opportunities: Array, examined: number, minMarginPct: number, maxPlausibleMarginPct: number }}
 */
function findArbs(rows, opts = {}) {
  const minMarginPct = Number.isFinite(opts.minMarginPct) ? opts.minMarginPct : DEFAULT_MIN_ARB_MARGIN_PCT;
  const maxPlausiblePct = Number.isFinite(opts.maxPlausibleMarginPct)
    ? opts.maxPlausibleMarginPct
    : DEFAULT_MAX_PLAUSIBLE_MARGIN_PCT;
  const list = Array.isArray(rows) ? rows : [];
  const opportunities = [];
  let examined = 0;

  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    // A two-way market needs two DISTINCT selections. Rows that resolve both sides to
    // the same selection are not arbitrageable and must not be priced as if they were.
    // Rows carrying no selections at all are still examined (the prices may be sound).
    const label = (value) =>
      String(value == null ? '' : value)
        .trim()
        .toLowerCase();
    const name1 = label(row.selection1);
    const name2 = label(row.selection2);
    if (name1 && name2 && name1 === name2) continue;

    const { side1, side2 } = bestQuotes(row);
    if (!side1 || !side2) continue;
    examined += 1;

    const total = side1.implied + side2.implied;
    if (total >= 1) continue;
    const marginPct = (1 - total) * 100;
    if (marginPct < minMarginPct) continue;

    // Back both sides so the payout is identical either way. Stake fractions are the
    // implied probabilities, normalised by the total outlay (< 1 means profit).
    const stake1 = side1.implied / total;
    const stake2 = side2.implied / total;

    opportunities.push({
      league: row.league ?? null,
      market: row.market ?? null,
      game: row.game ?? null,
      selection1: row.selection1 ?? null,
      selection2: row.selection2 ?? null,
      side1,
      side2,
      marginPct,
      // A single book pricing both sides into an arb is a mispricing that books
      // routinely void as palpable error. Surface it separately rather than presenting
      // it as a normal cross-venue opportunity.
      sameBook: side1.book === side2.book,
      // See DEFAULT_MAX_PLAUSIBLE_MARGIN_PCT: this is a data-integrity signal, not a
      // bigger opportunity.
      suspicious: marginPct > maxPlausiblePct,
      stakeSplit: { side1: stake1, side2: stake2 }
    });
  }

  opportunities.sort((a, b) => b.marginPct - a.marginPct);
  return { opportunities, examined, minMarginPct, maxPlausibleMarginPct: maxPlausiblePct };
}

/**
 * Compact arb margin for a single row, or null when this row is not an arb.
 *
 * Used on the scan path, where building a full opportunity object per row would be
 * wasted work: the caller only needs the margin so it can be recorded and reported.
 * Returns `1 - sum(best implied per side)` in percentage points, or null when the row
 * has no usable two-sided market or is not arbitrageable.
 *
 * @param {Object} row
 * @returns {number|null}
 */
function arbMarginForRow(row) {
  const { side1, side2 } = bestQuotes(row);
  if (!side1 || !side2) return null;
  const label = (value) =>
    String(value == null ? '' : value)
      .trim()
      .toLowerCase();
  const name1 = label(row && row.selection1);
  const name2 = label(row && row.selection2);
  if (name1 && name2 && name1 === name2) return null;
  const total = side1.implied + side2.implied;
  return total < 1 ? (1 - total) * 100 : null;
}

module.exports = {
  findArbs,
  bestQuotes,
  arbMarginForRow,
  impliedOf,
  DEFAULT_MIN_ARB_MARGIN_PCT,
  DEFAULT_MAX_PLAUSIBLE_MARGIN_PCT
};
