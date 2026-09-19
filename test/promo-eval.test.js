'use strict';

// Profit-boost promo evaluation (lib/promo-eval.js).
//
// The arithmetic here is small enough to check by hand, which is exactly why it is worth
// pinning: the two failure modes (the boost factor, and the payoff-vs-stake denominator)
// both produce plausible-looking numbers that are simply wrong by a constant factor.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  boostFactor,
  americanToDecimal,
  decimalToAmerican,
  maxBoostEv,
  cardEconomics,
  enumerateCards
} = require('../lib/promo-eval');

describe('promo-eval: the boost factor', () => {
  it('treats a 40% PROFIT boost as k = 1.40, not 0.40', () => {
    // Reading "40%" as a factor of 0.40 scales every answer down by 100x.
    assert.equal(boostFactor(40), 1.4);
    assert.equal(boostFactor(100), 2);
    assert.equal(boostFactor(0), 1);
  });

  it('returns null for an unusable boost', () => {
    assert.equal(boostFactor(null), null);
    assert.equal(boostFactor(-5), null);
    assert.equal(boostFactor('abc'), null);
  });
});

describe('promo-eval: odds conversion round-trips', () => {
  it('converts both signs correctly', () => {
    assert.ok(Math.abs(americanToDecimal(-110) - 1.90909) < 1e-4);
    assert.equal(americanToDecimal(150), 2.5);
    assert.equal(decimalToAmerican(1.90909), -110);
    assert.equal(decimalToAmerican(2.5), 150);
  });

  it('rejects odds that cannot be a price', () => {
    assert.equal(americanToDecimal(0), null);
    assert.equal(americanToDecimal(null), null);
    assert.equal(americanToDecimal('x'), null);
    assert.equal(decimalToAmerican(1), null);
  });
});

describe('promo-eval: the ceiling', () => {
  it("prices tonight's real offer: 40% boost, 10 stake, +300 floor", () => {
    // EV = S*(k-1)*(1-1/d) = 10 * 0.4 * 0.75 = 3.00
    assert.ok(Math.abs(maxBoostEv({ stake: 10, boostPct: 40, minDecimal: 4 }) - 3) < 1e-9);
  });

  it('barely moves with parlay price — which is why we rank on probability', () => {
    const at300 = maxBoostEv({ stake: 10, boostPct: 40, minDecimal: 4 });
    const at3900 = maxBoostEv({ stake: 10, boostPct: 40, minDecimal: 40 });
    assert.ok(at300 > 2.9 && at300 < 3.1);
    assert.ok(at3900 > 3.8 && at3900 < 4.0, `expected ~3.90, got ${at3900}`);
    // A 10x longer parlay buys ~30% more EV. That is the whole trade.
    assert.ok(at3900 / at300 < 1.35);
  });

  it('is null when the boost is unusable', () => {
    assert.equal(maxBoostEv({ stake: 10, boostPct: null, minDecimal: 4 }), null);
  });
});

describe('promo-eval: card economics reproduce the hand-computed real card', () => {
  // The card built live on 2026-09-18. Fair probabilities are sharp-devigged, not implied.
  const legs = [
    { selection: 'Cubs ML', odds: -149, fairProbability: 0.574, gameId: 'g1' },
    { selection: 'Mets ML', odds: -126, fairProbability: 0.538, gameId: 'g2' },
    { selection: 'ATL/HOU U8.5', odds: -129, fairProbability: 0.527, gameId: 'g3' },
    { selection: 'STL/WAS U7.5', odds: -105, fairProbability: 0.492, gameId: 'g4' }
  ];

  it('matches the numbers computed by hand for that card', () => {
    const e = cardEconomics(legs, { stake: 10, boostPct: 40 });
    assert.equal(e.american, 939);
    assert.ok(Math.abs(e.pWin - 0.08) < 0.001, `pWin ${e.pWin}`);
    assert.ok(Math.abs(e.profit - 131.44) < 0.05, `profit ${e.profit}`);
    assert.ok(Math.abs(e.ev - 1.33) < 0.02, `ev ${e.ev}`);
  });

  it('reports the most likely outcome plainly', () => {
    const e = cardEconomics(legs, { stake: 10, boostPct: 40 });
    // ~92% of the time this loses the stake. The EV is real but the mode is a loss.
    assert.ok(e.pWin < 0.1);
    assert.ok(e.profit > 100);
  });

  it('is null without a boost or without legs', () => {
    assert.equal(cardEconomics(legs, { stake: 10 }), null);
    assert.equal(cardEconomics([], { stake: 10, boostPct: 40 }), null);
  });
});

describe('promo-eval: enumeration', () => {
  const leg = (gameId, odds, p) => ({ gameId, game: gameId, selection: gameId, odds, fairProbability: p });

  it('never puts two legs from the SAME game on one card', () => {
    // Legs within a game are correlated, so the probability product would overstate the
    // chance of winning — the card is not the independent wager it claims to be.
    const cards = enumerateCards(
      [leg('g1', -150, 0.6), leg('g1', -140, 0.58), leg('g2', -150, 0.6), leg('g3', -150, 0.6), leg('g4', -150, 0.6)],
      { minLegs: 4, minDecimal: 2, stake: 10, boostPct: 40 }
    );
    for (const card of cards.top) {
      const games = card.legs.map((l) => l.gameId);
      assert.equal(new Set(games).size, games.length, 'a game appears twice');
    }
  });

  it('respects the minimum parlay price', () => {
    const cards = enumerateCards(
      [leg('g1', -200, 0.66), leg('g2', -200, 0.66), leg('g3', -200, 0.66), leg('g4', -200, 0.66)],
      {
        minLegs: 4,
        minDecimal: 4,
        stake: 10,
        boostPct: 40
      }
    );
    // Four -200 legs is decimal 5.06, which clears +300.
    assert.equal(cards.qualifying, 1);
    assert.ok(cards.best.decimal >= 4);
  });

  it('returns nothing when the floor cannot be reached', () => {
    const cards = enumerateCards(
      [leg('g1', -300, 0.75), leg('g2', -300, 0.75), leg('g3', -300, 0.75), leg('g4', -300, 0.75)],
      {
        minLegs: 4,
        minDecimal: 4,
        stake: 10,
        boostPct: 40
      }
    );
    // Four -300 legs is decimal 3.16, short of +300.
    assert.equal(cards.qualifying, 0);
    assert.equal(cards.best, null);
  });

  it('ranks by devigged probability, not by price', () => {
    const cards = enumerateCards(
      [leg('g1', -400, 0.82), leg('g2', -110, 0.5), leg('g3', 200, 0.3), leg('g4', -250, 0.72), leg('g5', -120, 0.55)],
      { minLegs: 4, minDecimal: 2, stake: 10, boostPct: 40 }
    );
    assert.ok(cards.qualifying > 1);
    // The top card must have the highest pWin of any qualifying card.
    const maxP = Math.max(...cards.top.map((c) => c.pWin));
    assert.equal(cards.best.pWin, maxP);
  });

  it('drops legs with no usable price or probability', () => {
    const cards = enumerateCards(
      [leg('g1', -150, 0.6), leg('g2', 0, 0.6), leg('g3', -150, NaN), leg('g4', -150, 0.6), leg('g5', -150, 0.6)],
      { minLegs: 3, minDecimal: 2, stake: 10, boostPct: 40 }
    );
    assert.equal(cards.examined, 3, 'only three legs are usable');
  });

  it('carries the ceiling alongside the cards', () => {
    const cards = enumerateCards(
      [leg('g1', -150, 0.6), leg('g2', -150, 0.6), leg('g3', -150, 0.6), leg('g4', -150, 0.6)],
      {
        minLegs: 4,
        minDecimal: 4,
        stake: 10,
        boostPct: 40
      }
    );
    assert.ok(cards.ceiling > 2.9 && cards.ceiling < 3.1);
  });
});

describe('promo-card CLI: extracting legs from a scan payload', () => {
  const { legsFromScanPayload, fairOf } = require('../scripts/promo-card');

  const payload = {
    results: [
      {
        league: 'MLB',
        market: 'Moneyline',
        plays: [
          {
            odds: -149,
            selection: 'Cubs',
            game: 'Cubs vs Reds',
            gameId: 'g1',
            featureSnapshot: { sharpMarketFairProbability: 0.574 }
          },
          // falls back to the all-books fair when no sharp one exists
          {
            odds: -126,
            selection: 'Mets',
            game: 'Mets vs PHI',
            gameId: 'g2',
            featureSnapshot: { marketFairProbability: 0.538 }
          },
          // no price at all -> dropped
          { odds: null, selection: 'X', gameId: 'g3', featureSnapshot: { marketFairProbability: 0.5 } },
          // no fair probability -> dropped (cannot rank on implied, that is just price)
          { odds: -110, selection: 'Y', gameId: 'g4', featureSnapshot: {} }
        ]
      }
    ]
  };

  it('keeps priced legs with a fair probability and drops the rest', () => {
    const legs = legsFromScanPayload(payload);
    assert.equal(legs.length, 2);
    assert.deepEqual(
      legs.map((l) => l.selection),
      ['Cubs', 'Mets']
    );
    assert.equal(legs[0].league, 'MLB', 'group league/market is carried onto the leg');
    assert.equal(legs[1].fairProbability, 0.538, 'falls back to the all-books fair');
  });

  it('prefers the sharp-anchored fair when present', () => {
    assert.equal(
      fairOf({ featureSnapshot: { sharpMarketFairProbability: 0.51, marketFairProbability: 0.55 } }).p,
      0.51
    );
  });

  it('rejects a fair probability that is not a probability', () => {
    // 55 would be a percentage, not a fraction — never silently treated as 0.55.
    assert.equal(fairOf({ featureSnapshot: { marketFairProbability: 55 } }), null);
    assert.equal(fairOf({ featureSnapshot: { marketFairProbability: 0 } }), null);
    assert.equal(fairOf({ featureSnapshot: { marketFairProbability: null } }), null);
  });
});
