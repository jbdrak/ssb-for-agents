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
 * Best available label for one side of a row, or null.
 *
 * Spread/total markets leave the top-level `selection1`/`selection2` null and carry the
 * real label in the nested `selections` map (e.g. "Over 8" / "Under 8"), so fall back
 * through it. Deliberately does NOT fall back to `participant`/`pick`: those name whichever
 * side this row happens to describe, so using them for both sides would print the same
 * name twice and misdescribe the market.
 */
function selectionName(row, key) {
  if (!row || typeof row !== 'object') return null;
  const clean = (value) => {
    const text = value == null ? '' : String(value).trim();
    return text === '' ? null : text;
  };
  const direct = clean(row[key]);
  if (direct) return direct;
  const selections = row.selections && typeof row.selections === 'object' ? Object.values(row.selections) : [];
  for (const entry of selections) {
    const nested = clean(entry && entry[key]);
    if (nested) return nested;
  }
  return null;
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
  const seenMarkets = new Set();
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

    // `pp rank` emits ONE ROW PER SIDE of the same market, and both rows carry the same
    // two-sided price map. Without this, every opportunity is reported twice and the
    // count is inflated by a factor of ~2. Dedupe on the market identity so `examined`
    // means unique markets, not rows.
    const marketKey = `${row.gameId || row.game || row.id || ''}|${row.market || ''}`;
    if (marketKey !== '|') {
      if (seenMarkets.has(marketKey)) continue;
      seenMarkets.add(marketKey);
    }

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
      gameId: row.gameId ?? null,
      game: row.game ?? null,
      selection1: selectionName(row, 'selection1'),
      selection2: selectionName(row, 'selection2'),
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

/**
 * Extract ranked rows from a `pp rank -j` capture.
 *
 * `pp ... -j` stdout is NOT pure JSON: progress lines ("Fetching ...", "Ranking ...",
 * "Done in Ns") are written both BEFORE AND AFTER the payload, so a naive `JSON.parse`
 * fails with "Unexpected token" — and slicing from the first `{` to the end still fails
 * when a trailing progress line is present. This scans for the first COMPLETE JSON value
 * using brace/bracket depth (string-aware, so braces inside strings do not confuse it),
 * which tolerates noise on either side.
 *
 * Returns `[]` for unusable input rather than throwing — the caller is a report, and a
 * parse failure must surface as "no rows", never as a crash that loses the run.
 *
 * @param {string} text
 * @returns {Array}
 */
function rowsFromRankOutput(text) {
  const raw = String(text == null ? '' : text);
  /** Upper bound on JSON candidates tried, so a pathological input stays O(n). */
  const MAX_PARSE_ATTEMPTS = 200;
  const pick = (doc) => {
    if (Array.isArray(doc)) return doc;
    if (doc && Array.isArray(doc.result)) return doc.result;
    return [];
  };
  const tryParse = (slice) => {
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  };

  // A already-clean payload (bare array or object, nothing around it).
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const direct = tryParse(trimmed);
    if (direct) return pick(direct);
  }

  // Progress lines can contain brackets of their own ("Fetching ... [Cubs]..."), so the
  // first bracket in the output is NOT reliably the payload. Try every container start in
  // order and take the first that parses, capped so a pathological input cannot turn this
  // into an unbounded scan.
  const starts = [];
  for (let i = 0; i < raw.length && starts.length < MAX_PARSE_ATTEMPTS; i += 1) {
    if (raw[i] === '{' || raw[i] === '[') starts.push(i);
  }
  for (const start of starts) {
    const balanced = extractBalancedJson(raw, start);
    if (balanced == null) continue;
    const parsed = tryParse(balanced);
    if (parsed) return pick(parsed);
  }
  return [];
}

/**
 * Substring of `text` from `start` to the matching close of the first container,
 * string-aware. Returns null when the brackets never balance.
 * @param {string} text
 * @param {number} start - index of the opening `{` or `[`
 * @returns {string|null}
 */
function extractBalancedJson(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

module.exports = {
  findArbs,
  bestQuotes,
  arbMarginForRow,
  rowsFromRankOutput,
  selectionName,
  impliedOf,
  DEFAULT_MIN_ARB_MARGIN_PCT,
  DEFAULT_MAX_PLAUSIBLE_MARGIN_PCT
};
