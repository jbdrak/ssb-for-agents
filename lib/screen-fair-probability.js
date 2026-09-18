'use strict';

// Decision-time de-vigged fair probability for a scan row's OWN side, derived
// from the market's two-sided book prices.
//
// WHY THIS LIVES HERE, ON ITS OWN: the scan pipeline whitelists fields at five
// separate layers (expander -> ranker row builders -> candidate mapper ->
// formatter keep-set -> recorder), so a value computed early is silently dropped
// by whichever layer does not know it. Deriving it once, at the single point that
// still holds the market's own two-sided prices (`row.allBookOdds`), avoids
// threading a new field through every whitelist - the brittle part - and keeps
// the arithmetic in one testable place.
//
// The value is the price a model's probability is compared against by the ratings
// evidence gate (`pp ratings --evaluate`). It is a DECISION-time fair price: it is
// NOT a game-time close, and it is never presented as one.
//
// Fail closed: if we cannot say which side the row is, the answer is null, never a
// guess. A wrong side would publish the OPPOSITE side's probability as this side's
// fair price, which is worse than no number.

const { americanOddsToImpliedProbability, average } = require('./ssb-shared-utils');
const { getSharpBookComparisonSet, canonicalizeScreenBookName } = require('./ssb-sharp-books');

/**
 * Which leg of a book's `odds1`/`odds2` pair is THIS row's side.
 *
 * Two exact rules, in order:
 *   1. The row's own side labels. Most shapes carry `selection1`/`selection2`
 *      (or the participant pair) and the row's `selection` matches one exactly.
 *   2. The row's own price on its own resolved book. Run-line and other shapes
 *      arrive without the side labels, but `row.odds` IS the resolved book's
 *      quote for this side, so whichever leg it equals is our side.
 *
 * Anything else returns null. Nothing is inferred from fuzzy text.
 *
 * @param {Object} row
 * @param {Object} oddsMap
 * @returns {'odds1' | 'odds2' | null}
 */
function resolveSideOddsKey(row, oddsMap) {
  const selection = String(row.selection || row.participant || row.pick || '').trim();
  const sideA = String(row.selection1 || row.participant1 || '').trim();
  const sideB = String(row.selection2 || row.participant2 || '').trim();
  if (selection && sideA && selection === sideA) return 'odds1';
  if (selection && sideB && selection === sideB) return 'odds2';

  const own = Number(row.odds);
  if (!Number.isFinite(own)) return null;
  const resolved = oddsMap[String(row.book || '')];
  const candidates = resolved && typeof resolved === 'object' ? [resolved] : Object.values(oddsMap);
  // An unambiguous match first: -110/-110 would match either leg, and pinning it
  // arbitrarily is harmless (both sides de-vig to 0.5), but we still prefer a
  // book that says which leg is which.
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const one = Number(entry.odds1);
    const two = Number(entry.odds2);
    if (one === own && two !== own) return 'odds1';
    if (two === own && one !== own) return 'odds2';
  }
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    if (Number(entry.odds1) === own) return 'odds1';
    if (Number(entry.odds2) === own) return 'odds2';
  }
  return null;
}

/**
 * De-vigged fair probability for this row's side, or null.
 *
 * Each book's `odds1`/`odds2` pair is the market's TWO sides, so removing the
 * hold is exact per book: `fair(own) = p(own) / (p(own) + p(other))`. The result
 * is the mean over the books that quote BOTH legs; a book quoting one leg cannot
 * be de-vigged and is skipped. If no book quotes both legs the answer is null,
 * never the single-sided implied probability that still carries the hold.
 *
 * @param {Object} row - a scan/ranker row carrying `allBookOdds`
 * @returns {number|null} Fair probability in (0, 1), else null.
 */
function fairProbabilityForRow(row) {
  const oddsMap = row && typeof row.allBookOdds === 'object' && row.allBookOdds ? row.allBookOdds : null;
  if (!oddsMap) return null;
  const oddsKey = resolveSideOddsKey(row, oddsMap);
  if (!oddsKey) return null;
  const otherKey = oddsKey === 'odds2' ? 'odds1' : 'odds2';

  const fairs = [];
  for (const book of Object.values(oddsMap)) {
    if (!book || typeof book !== 'object') continue;
    const own = americanOddsToImpliedProbability(book[oddsKey]);
    const other = americanOddsToImpliedProbability(book[otherKey]);
    if (!Number.isFinite(own) || !Number.isFinite(other) || own + other <= 0) continue;
    fairs.push(own / (own + other));
  }
  return fairs.length ? average(fairs) : null;
}

/**
 * Sharp-anchored fair probability, with its contributor count.
 *
 * WHY THIS EXISTS NEXT TO THE ALL-BOOKS VERSION. `fairProbabilityForRow` averages
 * the de-vig across EVERY book that quotes both legs. Averaging square books into a
 * "fair" price drags it toward square pricing, so `EV = fair * decimal - 1` stops
 * measuring value and starts measuring "is this price above the average of the books
 * we already scanned" — a line-shopping detector, contaminated by soft numbers, and
 * circular: you cannot derive an edge from the same book population you bet into.
 *
 * The measured consequence on the live ledger: higher all-books "EV" performed WORSE
 * (40% beat-the-close at EV>=0 falling to 0% at EV>=2). This variant re-anchors the
 * fair on the repo's own sharp comparison set (Pinnacle/Circa/BookMaker/BetOnline plus
 * majors, per league and market), so the resulting EV measures our price against the
 * SHARP market — the defensible definition of +EV.
 *
 * FAIL CLOSED, and NEVER fall back to the all-books answer: a silent fallback would
 * reintroduce exactly the contamination this exists to remove, while looking like it
 * had been handled. Null when no sharp book quotes both legs.
 *
 * @param {Object} row - a scan/ranker row carrying `allBookOdds`
 * @returns {{ fair: number, sharpBooks: number } | null}
 */
function sharpFairDetail(row) {
  const oddsMap = row && typeof row.allBookOdds === 'object' && row.allBookOdds ? row.allBookOdds : null;
  if (!oddsMap) return null;
  const oddsKey = resolveSideOddsKey(row, oddsMap);
  if (!oddsKey) return null;
  const otherKey = oddsKey === 'odds2' ? 'odds1' : 'odds2';

  const sharpSet = new Set(
    getSharpBookComparisonSet({ league: row && row.league, market: row && row.market }).map(canonicalizeScreenBookName)
  );
  if (!sharpSet.size) return null;

  const fairs = [];
  for (const [bookName, book] of Object.entries(oddsMap)) {
    if (!sharpSet.has(canonicalizeScreenBookName(bookName))) continue;
    if (!book || typeof book !== 'object') continue;
    const own = americanOddsToImpliedProbability(book[oddsKey]);
    const other = americanOddsToImpliedProbability(book[otherKey]);
    if (!Number.isFinite(own) || !Number.isFinite(other) || own + other <= 0) continue;
    fairs.push(own / (own + other));
  }
  if (!fairs.length) return null;
  return { fair: average(fairs), sharpBooks: fairs.length };
}

/**
 * Sharp-anchored fair probability for this row's side, or null.
 * @param {Object} row
 * @returns {number|null}
 */
function sharpFairProbabilityForRow(row) {
  const detail = sharpFairDetail(row);
  return detail ? detail.fair : null;
}

module.exports = { fairProbabilityForRow, sharpFairProbabilityForRow, sharpFairDetail, resolveSideOddsKey };
