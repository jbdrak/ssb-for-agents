'use strict';

/**
 * Profit-boost promo evaluation.
 *
 * WHY THIS EXISTS. Promotions are one of the only two lanes this repo supports with
 * evidence (the scan was measured and has no edge — see docs/STATUS.md). A promo card was
 * built by hand in a scratch script, which means every future offer repeats the same
 * ad-hoc work and the same chances to get the arithmetic wrong. This module makes it a
 * two-minute job and keeps the traps in one tested place.
 *
 * THE ARITHMETIC, and the two ways it is easy to get wrong.
 *
 * A "40% profit boost" multiplies PROFIT by 1.4 — so the factor is `k = 1 + pct/100`, NOT
 * `pct/100`. Getting this wrong scales every answer by 100.
 *
 * With stake `S`, parlay decimal `d`, and factor `k`:
 *
 *     payout = S + S * (d - 1) * k        // stake returned, boosted profit on top
 *     EV     = pWin * payout - S
 *
 * At fair prices (`p = 1/d`) that reduces to the CEILING:
 *
 *     EV = S * (k - 1) * (1 - 1/d)
 *
 * which is why a stake-capped boost is nearly flat in parlay price: `(1 - 1/d)` is already
 * 0.75 at +300 and only reaches 0.975 at +3900. The practical consequence is that chasing a
 * longer card buys almost no EV while costing real win probability. State the ceiling
 * before building anything, so the card is chosen on leg quality rather than on price.
 *
 * Ranking is on DEVIGGED probability (the honest "will it win"), never on price. A
 * stake-capped boost's EV barely moves with `d`, so the price is not the objective.
 */

/**
 * Profit-boost factor: a 40% boost is `1.40`, not `0.40`.
 *
 * `boostPct == null` is rejected BEFORE `Number(...)`: `Number(null)` is `0`, which is
 * finite and non-negative, so a missing boost would silently become a factor of 1.0 and
 * every EV would come back as a plausible-looking zero-edge parlay. That coercion has now
 * caused three separate defects in this repo, so it is guarded explicitly wherever an
 * absent value and a legitimate zero are different facts.
 */
function boostFactor(boostPct) {
  if (boostPct == null || boostPct === '') return null;
  const pct = Number(boostPct);
  if (!Number.isFinite(pct) || pct < 0) return null;
  return 1 + pct / 100;
}

/** American odds to decimal payout multiple, or null when unusable. */
function americanToDecimal(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

/** Decimal payout multiple back to American odds. */
function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}

/**
 * The fair-price ceiling: the most this offer can be worth, in currency.
 * Use it to set expectations BEFORE building a card, because it is usually small and it
 * determines whether the effort is worth anyone's time.
 *
 * @param {Object} [spec]
 * @param {number} [spec.stake] - stake cap
 * @param {number} [spec.boostPct] - profit boost percent (40 means k = 1.40)
 * @param {number} [spec.minDecimal] - the promo's minimum parlay decimal
 * @returns {number|null}
 */
function maxBoostEv({ stake = 10, boostPct, minDecimal = 2 } = {}) {
  const k = boostFactor(boostPct);
  const d = Number(minDecimal);
  if (k == null || !Number.isFinite(d) || d <= 1) return null;
  return stake * (k - 1) * (1 - 1 / d);
}

/**
 * Payout and EV for one specific selection of legs.
 *
 * @param {Array} legs
 * @param {Object} [opts]
 * @param {number} [opts.stake]
 * @param {number} [opts.boostPct]
 * @returns {Object|null}
 */
function cardEconomics(legs, { stake = 10, boostPct } = {}) {
  const k = boostFactor(boostPct);
  if (k == null || !Array.isArray(legs) || !legs.length) return null;
  const decimal = legs.reduce((acc, leg) => {
    const d = americanToDecimal(leg.odds);
    return d == null ? acc : acc * d;
  }, 1);
  const pWin = legs.reduce((acc, leg) => {
    const p = Number(leg.fairProbability);
    return Number.isFinite(p) && p > 0 && p < 1 ? acc * p : acc;
  }, 1);
  const payout = stake + stake * (decimal - 1) * k;
  return {
    decimal,
    american: decimalToAmerican(decimal),
    pWin,
    stake,
    payout,
    profit: payout - stake,
    ev: pWin * payout - stake,
    evPctOfStake: ((pWin * payout - stake) / stake) * 100
  };
}

/**
 * Enumerate qualifying cards and rank them by DEVIGGED win probability.
 *
 * Constraints enforced:
 *   - one leg per GAME (legs in the same game are correlated; a parlay of them is not the
 *     independent wager the probability product assumes)
 *   - at least `minLegs` legs
 *   - parlay decimal at or above `minDecimal` (the promo's minimum odds)
 *
 * @param {Array} legs - [{gameId, game, league, market, selection, odds, fairProbability}]
 * @param {Object} [opts] - { minLegs, minDecimal, maxCombos, stake, boostPct }
 * @returns {Object}
 */
function enumerateCards(legs, opts = {}) {
  const minLegs = Number.isInteger(opts.minLegs) ? opts.minLegs : 4;
  const minDecimal = Number.isFinite(opts.minDecimal) ? opts.minDecimal : 2;
  const maxCombos = Number.isInteger(opts.maxCombos) ? opts.maxCombos : 400000;
  const stake = Number.isFinite(opts.stake) ? opts.stake : 10;
  const boostPct = opts.boostPct;

  const usable = (Array.isArray(legs) ? legs : []).filter((leg) => {
    if (!leg || typeof leg !== 'object') return false;
    if (americanToDecimal(leg.odds) == null) return false;
    const p = Number(leg.fairProbability);
    return Number.isFinite(p) && p > 0 && p < 1;
  });

  // One leg per game: take the most likely leg from each. This both shrinks the search and
  // guarantees the independence the probability product assumes.
  const byGame = new Map();
  for (const leg of usable) {
    const key = leg.gameId || leg.game || leg.selection;
    const current = byGame.get(key);
    if (!current || leg.fairProbability > current.fairProbability) byGame.set(key, leg);
  }
  const pool = [...byGame.values()];

  const results = [];
  let truncated = false;
  const pick = new Array(minLegs);

  const recurse = (start, depth) => {
    if (results.length >= maxCombos) {
      truncated = true;
      return;
    }
    if (depth === minLegs) {
      const chosen = pick.slice();
      const economics = cardEconomics(chosen, { stake, boostPct });
      if (economics && economics.decimal >= minDecimal) {
        results.push({ legs: chosen, ...economics });
      }
      return;
    }
    // Not enough remaining legs to fill the card.
    for (let i = start; i <= pool.length - (minLegs - depth); i += 1) {
      pick[depth] = pool[i];
      recurse(i + 1, depth + 1);
    }
  };
  if (pool.length >= minLegs) recurse(0, 0);

  results.sort((a, b) => b.pWin - a.pWin);
  return {
    qualifying: results.length,
    examined: pool.length,
    distinctGames: pool.length,
    minLegs,
    minDecimal,
    truncated,
    ceiling: maxBoostEv({ stake, boostPct, minDecimal }),
    best: results[0] || null,
    top: results.slice(0, 5)
  };
}

module.exports = {
  boostFactor,
  americanToDecimal,
  decimalToAmerican,
  maxBoostEv,
  cardEconomics,
  enumerateCards
};
