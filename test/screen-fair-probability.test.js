'use strict';

// Coverage for the decision-time de-vigged fair probability
// (lib/screen-fair-probability.js).
//
// This value is what the ratings evidence gate compares a model's probability
// against, so the two ways it can be WRONG matter more than the way it can be
// right: naming the opposite side would publish the other side's probability as
// this side's fair price, and falling back to a single-sided implied probability
// would publish a price that still contains the book's hold. Both are asserted
// against, not just the happy path.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  fairProbabilityForRow,
  sharpFairProbabilityForRow,
  sharpFairDetail,
  resolveSideOddsKey
} = require('../lib/screen-fair-probability');

/** A book entry in the live /screen shape: one market's TWO sides. */
const book = (odds1, odds2) => ({ odds1, odds2, liquidity1: 0, liquidity2: 0 });

describe('screen-fair-probability: side resolution', () => {
  it('uses the row own side labels when they name the selection', () => {
    const map = { NoVigApp: book(-140, 118) };
    assert.equal(
      resolveSideOddsKey(
        { selection: 'Arizona Diamondbacks', selection1: 'Arizona Diamondbacks', selection2: 'Chicago Cubs' },
        map
      ),
      'odds1'
    );
    assert.equal(
      resolveSideOddsKey(
        { selection: 'Chicago Cubs', selection1: 'Arizona Diamondbacks', selection2: 'Chicago Cubs' },
        map
      ),
      'odds2'
    );
  });

  it('falls back to the resolved book price when the side labels are absent (run line)', () => {
    const map = { NoVigApp: book(285, -360) };
    assert.equal(resolveSideOddsKey({ selection: 'Rockies -1.5', book: 'NoVigApp', odds: 285 }, map), 'odds1');
    assert.equal(resolveSideOddsKey({ selection: 'Padres +1.5', book: 'NoVigApp', odds: -360 }, map), 'odds2');
  });

  it('refuses to guess a side it cannot identify', () => {
    const map = { NoVigApp: book(-140, 118) };
    assert.equal(resolveSideOddsKey({ selection: 'Some Other Team', book: 'NoVigApp', odds: -110 }, map), null);
    // No side labels AND a price that is neither leg: nothing to key on.
    assert.equal(
      resolveSideOddsKey({ selection: 'A', selection1: '', selection2: '', book: 'X', odds: -110 }, map),
      null
    );
  });
});

describe('screen-fair-probability: de-vig', () => {
  it('de-vigs each book and returns the mean of the fair probabilities', () => {
    // -140/118 -> 0.58333/0.45872 -> fair 0.55977 ; -136/126 -> 0.57627/0.44248 -> fair 0.56565
    const row = {
      selection: 'A',
      selection1: 'A',
      selection2: 'B',
      book: 'NoVigApp',
      odds: -140,
      allBookOdds: { NoVigApp: book(-140, 118), Circa: book(-136, 126) }
    };
    const fair = fairProbabilityForRow(row);
    assert.ok(Math.abs(fair - (0.55977 + 0.56565) / 2) < 1e-4, `unexpected fair ${fair}`);
  });

  it('never returns the vigged single-sided implied probability', () => {
    // -140 alone implies 0.5833; the de-vigged price must be strictly lower.
    const row = {
      selection: 'A',
      selection1: 'A',
      selection2: 'B',
      book: 'NoVigApp',
      odds: -140,
      allBookOdds: { NoVigApp: book(-140, 118) }
    };
    const fair = fairProbabilityForRow(row);
    assert.ok(fair < 0.5833334, 'de-vigged price must sit below the raw implied probability');
    assert.ok(fair > 0.5, 'and above a coin flip for a favoured side');
  });

  it('skips books that quote only one leg, and is null when none quote both', () => {
    const partial = {
      selection: 'A',
      selection1: 'A',
      selection2: 'B',
      book: 'NoVigApp',
      odds: -140,
      allBookOdds: { NoVigApp: book(-140, 118), Half: { odds1: -130 } }
    };
    const withBoth = fairProbabilityForRow(partial);
    assert.ok(withBoth !== null, 'the two-sided book still yields a number');

    const onlyHalf = { ...partial, allBookOdds: { Half: { odds1: -130 } } };
    assert.equal(fairProbabilityForRow(onlyHalf), null, 'a one-legged book cannot be de-vigged');
  });

  it('is null without market data or an identifiable side, never a guess', () => {
    assert.equal(fairProbabilityForRow({ selection: 'A', selection1: 'A', odds: -110 }), null);
    assert.equal(fairProbabilityForRow({}), null);
    assert.equal(fairProbabilityForRow(null), null);
    assert.equal(
      fairProbabilityForRow({
        selection: 'Z',
        book: 'NoVigApp',
        odds: 999,
        allBookOdds: { NoVigApp: book(-140, 118) }
      }),
      null
    );
  });

  it('the two sides of one market de-vig to complements', () => {
    const map = { NoVigApp: book(-140, 118), Circa: book(-136, 126) };
    const sideOne = fairProbabilityForRow({
      selection: 'A',
      selection1: 'A',
      selection2: 'B',
      book: 'NoVigApp',
      odds: -140,
      allBookOdds: map
    });
    const sideTwo = fairProbabilityForRow({
      selection: 'B',
      selection1: 'A',
      selection2: 'B',
      book: 'NoVigApp',
      odds: 118,
      allBookOdds: map
    });
    assert.ok(Math.abs(sideOne + sideTwo - 1) < 1e-9, 'fair probabilities of both sides must sum to 1');
  });
});

describe('screen-fair-probability: the sharp-anchored variant removes soft-book contamination', () => {
  // The all-books fair averages EVERY book's de-vig, so a square price drags the
  // "fair" toward square pricing and turns EV into "is this above the average of the
  // books we already scanned". This variant de-vigs only the sharp comparison set.
  const sharpMap = {
    Pinnacle: { odds1: -120, odds2: 100 },
    Circa: { odds1: -118, odds2: 98 },
    BookMaker: { odds1: -115, odds2: 95 }
  };
  const withSoftBook = { ...sharpMap, SomeSquareBook: { odds1: -140, odds2: 120 } };
  const row = (allBookOdds) => ({
    league: 'MLB',
    market: 'Moneyline',
    selection: 'Yankees',
    selection1: 'Yankees',
    selection2: 'Red Sox',
    book: 'FanDuel',
    odds: -120,
    allBookOdds
  });

  it('is UNCHANGED by adding a soft book, while the all-books fair moves', () => {
    const sharpOnly = sharpFairProbabilityForRow(row(sharpMap));
    const sharpWithSoft = sharpFairProbabilityForRow(row(withSoftBook));
    assert.ok(Math.abs(sharpOnly - sharpWithSoft) < 1e-12, 'a soft book must not move the sharp fair');

    const allOnly = fairProbabilityForRow(row(sharpMap));
    const allWithSoft = fairProbabilityForRow(row(withSoftBook));
    assert.ok(
      Math.abs(allOnly - allWithSoft) > 0.005,
      'the all-books fair SHOULD move — that movement is the contamination'
    );
  });

  it('reports how many sharp books contributed', () => {
    assert.equal(sharpFairDetail(row(sharpMap)).sharpBooks, 3);
    assert.equal(sharpFairDetail(row(withSoftBook)).sharpBooks, 3, 'the soft book is not a contributor');
  });

  it('FAILS CLOSED and never falls back to the all-books answer', () => {
    // Only a non-sharp book quotes both legs: the honest answer is null, not the
    // contaminated number wearing the sharp label.
    const onlySoft = { SomeSquareBook: { odds1: -140, odds2: 120 } };
    assert.equal(sharpFairProbabilityForRow(row(onlySoft)), null);
    assert.notEqual(fairProbabilityForRow(row(onlySoft)), null, 'the all-books version still answers');
  });

  it('is null when there are no two-sided prices at all', () => {
    assert.equal(sharpFairProbabilityForRow(row(undefined)), null);
    assert.equal(sharpFairProbabilityForRow(row({})), null);
  });
});
