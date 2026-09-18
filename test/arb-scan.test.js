'use strict';

// Cross-venue arbitrage detection (lib/arb-scan.js).
//
// The mechanism is arithmetic, so the tests pin the arithmetic: the margin, the stake
// split, and — most importantly — the cases that must NOT be reported as opportunities,
// because a false arb is a confident instruction to place two bets.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findArbs, bestQuotes, rowsFromRankOutput, impliedOf, DEFAULT_MIN_ARB_MARGIN_PCT } = require('../lib/arb-scan');

const row = (allBookOdds, extra = {}) => ({
  league: 'MLB',
  market: 'Moneyline',
  game: 'Yankees vs Red Sox',
  selection1: 'Yankees',
  selection2: 'Red Sox',
  allBookOdds,
  ...extra
});

describe('arb-scan: implied probability helper', () => {
  it('returns 1/decimal as a FRACTION, not a percentage', () => {
    // -110 is decimal 1.90909..., so implied is 0.5238. If this ever returns 52.38 the
    // whole module silently stops detecting arbs, so pin the scale.
    assert.ok(Math.abs(impliedOf(-110) - 0.52381) < 1e-4);
    // +120 is decimal 2.20 -> 0.4545
    assert.ok(Math.abs(impliedOf(120) - 0.45455) < 1e-4);
  });

  it('returns null for unusable prices rather than guessing', () => {
    assert.equal(impliedOf(0), null);
    assert.equal(impliedOf(null), null);
    assert.equal(impliedOf(undefined), null);
    assert.equal(impliedOf('nonsense'), null);
  });
});

describe('arb-scan: detection', () => {
  it('finds a genuine cross-venue arb and reports the margin', () => {
    // +120 / +120 at two different books: 0.4545 + 0.4545 = 0.9091, so 9.09% margin.
    const report = findArbs([
      row({
        BookA: { odds1: 120, odds2: -140 },
        BookB: { odds1: -140, odds2: 120 }
      })
    ]);
    assert.equal(report.opportunities.length, 1);
    const arb = report.opportunities[0];
    assert.ok(Math.abs(arb.marginPct - 9.09) < 0.05, `expected ~9.09, got ${arb.marginPct}`);
    assert.equal(arb.sameBook, false);
    assert.equal(arb.side1.book, 'BookA');
    assert.equal(arb.side2.book, 'BookB');
  });

  it('reports NO arb when the implied probabilities sum to 1 or more', () => {
    // -110 / -110 sums to 1.0476: the normal vigged market. Reporting this would be
    // telling the user to place two losing bets.
    const report = findArbs([
      row({
        BookA: { odds1: -110, odds2: -110 },
        BookB: { odds1: -110, odds2: -110 }
      })
    ]);
    assert.equal(report.opportunities.length, 0);
    assert.equal(report.examined, 1);
  });

  it('flags a single-book arb separately as sameBook', () => {
    // One book pricing both sides into an arb is a mispricing books routinely void.
    const report = findArbs(
      [
        row({
          BookA: { odds1: 130, odds2: 130 },
          BookB: { odds1: -200, odds2: -200 }
        })
      ],
      { minMarginPct: 0.25 }
    );
    const arb = report.opportunities[0];
    assert.equal(arb.sameBook, true, 'both best legs come from BookA');
  });

  it('ignores margins below the threshold', () => {
    // ~0.1% is smaller than slippage between seeing the price and getting it down.
    const marginal = findArbs([row({ BookA: { odds1: 100, odds2: -110 }, BookB: { odds1: -110, odds2: 100 } })], {
      minMarginPct: 50
    });
    assert.equal(marginal.opportunities.length, 0, 'a 0.1% edge must not clear a 50% floor');
    assert.ok(DEFAULT_MIN_ARB_MARGIN_PCT > 0);
  });

  it('does not report a row whose two sides are the SAME selection', () => {
    // Both sides naming the same selection is not a two-way market, so there is
    // nothing to arbitrage. (Two DISTINCT selections both priced +120 is a different
    // thing: a single-book mispricing, reported with sameBook: true.)
    const sameSelection = row({ BookA: { odds1: 120, odds2: 120 } }, { selection2: 'Yankees' });
    assert.equal(findArbs([sameSelection]).opportunities.length, 0);
  });

  it('ignores rows with no usable two-sided prices', () => {
    const report = findArbs([
      row({}),
      row({ BookA: { odds1: -110 } }),
      row(undefined),
      row({ BookA: { odds1: null, odds2: null } }),
      {}
    ]);
    assert.equal(report.opportunities.length, 0);
    assert.equal(report.examined, 0);
  });
});

describe('arb-scan: the stake split must equalise the payout', () => {
  it('produces an identical return on both sides, equal to stake/(1-margin)', () => {
    const report = findArbs([row({ BookA: { odds1: 110, odds2: -105 }, BookB: { odds1: -105, odds2: 110 } })]);
    const arb = report.opportunities[0];
    // Derive decimals from the legs that were ACTUALLY selected, so this assertion
    // cannot drift away from the data it is testing.
    const dec = (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
    const stake = 100;
    const return1 = arb.stakeSplit.side1 * stake * dec(arb.side1.odds);
    const return2 = arb.stakeSplit.side2 * stake * dec(arb.side2.odds);
    // Both legs return the same amount, whatever the outcome. That IS the arb.
    assert.ok(Math.abs(return1 - return2) < 1e-6, `payouts differ: ${return1} vs ${return2}`);
    // And that return must exceed the total staked.
    assert.ok(return1 > stake, `return ${return1} should exceed the ${stake} staked`);
    // NOTE the two different denominators. `marginPct` is 1 - sum(implied), which is
    // relative to the PAYOUT. Profit measured against the STAKE is larger, and the
    // exact relation is return = stake / (1 - marginPct/100), not stake*(1+margin/100).
    // Asserting the wrong one is how a correct arb gets reported as broken.
    assert.ok(
      Math.abs(return1 - stake / (1 - arb.marginPct / 100)) < 0.01,
      `return ${return1} should equal stake/(1-margin) = ${stake / (1 - arb.marginPct / 100)}`
    );
  });

  it('splits the stake into fractions that sum to 1', () => {
    const report = findArbs([row({ BookA: { odds1: 110, odds2: -105 }, BookB: { odds1: -105, odds2: 110 } })]);
    const { side1, side2 } = report.opportunities[0].stakeSplit;
    assert.ok(Math.abs(side1 + side2 - 1) < 1e-9);
  });
});

describe('arb-scan: bestQuotes picks the biggest payout, not the biggest number', () => {
  it('prefers the lower implied probability on each side independently', () => {
    const { side1, side2 } = bestQuotes({
      allBookOdds: {
        BookA: { odds1: -150, odds2: 130 },
        BookB: { odds1: 110, odds2: -170 }
      }
    });
    // Side 1: +110 beats -150 (bigger payout). Side 2: +130 beats -170.
    assert.equal(side1.book, 'BookB');
    assert.equal(side1.odds, 110);
    assert.equal(side2.book, 'BookA');
    assert.equal(side2.odds, 130);
  });
});

describe('arb-scan: implausible margins are flagged as data problems', () => {
  it('flags a broken row rather than presenting a 67% arb as free money', () => {
    // Both sides at +500 implies 0.1667 + 0.1667 = 0.333. That is a corrupt row, not
    // an opportunity — but it must be VISIBLE, not silently dropped.
    const report = findArbs([row({ BookA: { odds1: 500, odds2: 500 }, BookB: { odds1: 500, odds2: 500 } })]);
    assert.equal(report.opportunities.length, 1);
    assert.equal(report.opportunities[0].suspicious, true);
    assert.ok(report.opportunities[0].marginPct > 60);
  });

  it('does not flag a realistic sub-5% arb as suspicious', () => {
    const report = findArbs([row({ BookA: { odds1: 105, odds2: -115 }, BookB: { odds1: -115, odds2: 105 } })]);
    assert.equal(report.opportunities[0].suspicious, false);
  });
});

describe('arb-scan: parsing a `pp rank -j` capture', () => {
  it('skips the progress lines that precede the payload', () => {
    // `pp ... -j` writes human progress before the JSON, so a naive parse throws
    // "Unexpected token". Losing the whole sweep to a parse bug is the failure here.
    const noisy = [
      'Fetching MLB:GAME:A:B:123 [Cubs]...',
      'Ranking MLB on NoVigApp...',
      '{"result":[{"market":"Moneyline"}]}',
      'Done in 12s'
    ].join('\n');
    const rows = rowsFromRankOutput(noisy);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].market, 'Moneyline');
  });

  it('accepts a bare array and a plain object payload', () => {
    assert.equal(rowsFromRankOutput('[{"a":1}]').length, 1);
    assert.equal(rowsFromRankOutput('{"result":[{"a":1},{"b":2}]}').length, 2);
  });

  it('returns [] instead of throwing on unusable input', () => {
    // A report must degrade to "no rows", never crash and lose the run.
    assert.deepEqual(rowsFromRankOutput(''), []);
    assert.deepEqual(rowsFromRankOutput(null), []);
    assert.deepEqual(rowsFromRankOutput('no json here at all'), []);
    assert.deepEqual(rowsFromRankOutput('{"result":"not an array"}'), []);
    assert.deepEqual(rowsFromRankOutput('{broken'), []);
  });

  it('is not fooled by brackets inside the progress lines', () => {
    // The real output contains lines like "Fetching ... [Cubs]..." BEFORE the payload.
    // Taking the first bracket grabbed "[Cubs]" and lost the entire sweep.
    const noisy = ['Fetching MLB:GAME:X:Y:1 [Cubs]...', '{"result":[{"market":"Moneyline"}]}', 'Done in 3s'].join('\n');
    assert.equal(rowsFromRankOutput(noisy).length, 1);
  });
});

describe('arb-scan: one market is reported once, not once per side', () => {
  // `pp rank` emits one row per SIDE, both carrying the same two-sided price map. Without
  // dedupe every opportunity is reported twice and the count is inflated ~2x.
  const sideRow = (selection) => ({
    league: 'UFC',
    market: 'Moneyline',
    gameId: 'UFC:GAME:A:B:1',
    game: 'A vs B',
    selection1: 'A',
    selection2: 'B',
    selection,
    allBookOdds: { BookA: { odds1: 120, odds2: -140 }, BookB: { odds1: -140, odds2: 120 } }
  });

  it('collapses the two side-rows of one market into a single opportunity', () => {
    const report = findArbs([sideRow('A'), sideRow('B')]);
    assert.equal(report.opportunities.length, 1);
    assert.equal(report.examined, 1, 'examined counts unique markets, not rows');
  });

  it('keeps genuinely different markets in the same game', () => {
    const report = findArbs([
      sideRow('A'),
      { ...sideRow('A'), market: 'Total Rounds', selection1: 'Over 2.5', selection2: 'Under 2.5' }
    ]);
    assert.equal(report.opportunities.length, 2);
  });
});

describe('arb-scan: selection labels fall back to the nested selections map', () => {
  it('resolves spread/total labels that the top level leaves null', () => {
    // Real rank rows for spread/total markets have selection1/selection2 === null and
    // carry "Over 8"/"Under 8" in the nested map.
    const row = {
      gameId: 'MLB:GAME:A:B:1',
      market: 'Total Runs',
      selection1: null,
      selection2: null,
      selections: { null: { selection1: 'Over 8', selection2: 'Under 8' } },
      allBookOdds: { BookA: { odds1: 130, odds2: -150 }, BookB: { odds1: -150, odds2: 130 } }
    };
    const arb = findArbs([row]).opportunities[0];
    assert.equal(arb.selection1, 'Over 8');
    assert.equal(arb.selection2, 'Under 8');
  });

  it('does NOT fall back to participant, which cannot distinguish the two sides', () => {
    const row = {
      gameId: 'MLB:GAME:A:B:2',
      market: 'Total Runs',
      participant: 'Over 8.5',
      selections: {},
      allBookOdds: { BookA: { odds1: 130, odds2: -150 }, BookB: { odds1: -150, odds2: 130 } }
    };
    const arb = findArbs([row]).opportunities[0];
    assert.equal(arb.selection1, null, 'printing participant for both sides would misdescribe the market');
    assert.equal(arb.selection2, null);
  });
});
