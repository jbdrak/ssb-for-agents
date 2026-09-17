'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../lib/card-gate');

describe('card-gate: decimal odds and EV', () => {
  it('converts American and decimal prices to decimal odds', () => {
    assert.equal(gate.decimalOdds(-100), 2);
    assert.ok(Math.abs(gate.decimalOdds(-135) - (100 / 135 + 1)) < 1e-9);
    assert.equal(gate.decimalOdds(150), 2.5);
    assert.equal(gate.decimalOdds('1.91'), 1.91);
    assert.equal(gate.decimalOdds('49.0%'), null);
  });

  it('computes EV against a de-vigged fair probability', () => {
    // Fair 60% at +100: 0.6 * 1 - 0.4 = +20%
    assert.equal(gate.expectedValuePct(100, 0.6), 20);
    // Fair 50% at -110: 0.5 * 0.9091 - 0.5 = -4.55%
    assert.equal(gate.expectedValuePct(-110, 0.5), -4.5455);
  });

  it('refuses an EV whenever the inputs are unusable', () => {
    assert.equal(gate.expectedValuePct('49.0%', 0.6), null);
    assert.equal(gate.expectedValuePct(100, null), null);
    assert.equal(gate.expectedValuePct(100, 0), null);
    assert.equal(gate.expectedValuePct(100, 1), null);
    assert.equal(gate.expectedValuePct(100, 1.2), null);
  });
});

describe('card-gate: the price test', () => {
  it('passes a price with positive EV against the fair price', () => {
    const result = gate.priceGate({ odds: 100, marketFairProbability: 0.6 });
    assert.equal(result.pass, true);
    assert.equal(result.reason, 'positive_ev');
    assert.equal(result.evPct, 20);
  });

  it('fails the -133/-135 favourites that made up the losing card', () => {
    // A 56% fair price at -135 is a losing bet, which is the whole point.
    const result = gate.priceGate({ odds: -135, marketFairProbability: 0.56 });
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'ev_below_floor');
    assert.ok(result.evPct < 0);
  });

  it('falls back to the consensus edge when no fair price is present', () => {
    assert.equal(gate.priceGate({ odds: -110, consensusEdge: 3 }).pass, true);
    assert.equal(gate.priceGate({ odds: -110, consensusEdge: 0.5 }).pass, false);
    assert.equal(gate.priceGate({ odds: -110, consensusEdge: 0.5 }).reason, 'edge_below_floor');
  });

  it('refuses a row with no price reference at all rather than passing it', () => {
    const result = gate.priceGate({ odds: -110, movementDisposition: 'supportive_clean' });
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'no_price_reference');
  });

  it('reads the fair probability from a nested play object too', () => {
    assert.equal(gate.priceGate({ odds: 100, play: { marketFairProbability: 0.6 } }).pass, true);
  });

  it('measures the absolute margin the EV rests on', () => {
    assert.equal(gate.fairMarginPoints({ odds: 100, marketFairProbability: 0.6 }), 10);
    // -104 implies 50.98%; a 49.25% fair price is about 1.73pp UNDER it.
    const under = gate.fairMarginPoints({ odds: -104, marketFairProbability: 0.4925 });
    assert.ok(under < -1.7 && under > -1.74, `got ${under}`);
    assert.equal(gate.fairMarginPoints({ odds: '49.0%', marketFairProbability: 0.6 }), null);
  });

  it('refuses a longshot whose EV rests on a margin too thin to trust', () => {
    // The real 2026-09-17 case: fair 16.5% at +525 is +3.13% EV, which clears
    // the EV floor, but the whole edge is 0.50 percentage points of fair
    // probability - inside de-vig noise at a coarsely quoted longshot price.
    const result = gate.priceGate({ odds: 525, marketFairProbability: 0.165 });
    assert.ok(result.evPct > 3, `expected EV above the floor, got ${result.evPct}`);
    assert.equal(result.marginPoints, 0.5);
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'margin_too_thin');
  });

  it('passes a short price whose margin is real, and reports marginPoints', () => {
    const result = gate.priceGate({ odds: -110, marketFairProbability: 0.5444 });
    assert.equal(result.pass, true);
    assert.equal(result.reason, 'positive_ev');
    assert.ok(result.marginPoints >= 2);
  });

  it('honours an explicit margin floor, including zero to recover EV-only behaviour', () => {
    const thin = { odds: 525, marketFairProbability: 0.165 };
    assert.equal(gate.priceGate(thin, { minFairMarginPts: 0 }).pass, true);
    assert.equal(gate.priceGate(thin, { minFairMarginPts: 0 }).reason, 'positive_ev');
    assert.equal(gate.priceGate({ odds: -110, marketFairProbability: 0.5444 }, { minFairMarginPts: 10 }).pass, false);
  });
});

describe('card-gate: bucket evidence', () => {
  const evaluation = {
    byTier: {
      'TIER 1': { decided: 40, insufficientSample: false },
      'TIER 2': { decided: 3, insufficientSample: true }
    }
  };

  it('marks a thin bucket unproven', () => {
    assert.equal(gate.bucketEvidence(evaluation, { tier: 'TIER 1' }).proven, true);
    assert.equal(gate.bucketEvidence(evaluation, { tier: 'TIER 2' }).proven, false);
  });

  it('treats an unknown bucket as unproven, not as fine', () => {
    assert.deepEqual(gate.bucketEvidence(evaluation, { tier: 'TIER 9' }), { proven: false, sample: null });
    assert.equal(gate.bucketEvidence(null, { tier: 'TIER 1' }).proven, false);
  });
});

describe('card-gate: the whole card', () => {
  const evaluation = { byTier: { 'TIER 1': { decided: 40, insufficientSample: false } } };

  it('caps the card and demotes the overflow to leans instead of dropping it', () => {
    const rows = [
      { selection: 'A', odds: 150, marketFairProbability: 0.6, tier: 'TIER 1' },
      { selection: 'B', odds: 150, marketFairProbability: 0.6, tier: 'TIER 1' },
      { selection: 'C', odds: 150, marketFairProbability: 0.6, tier: 'TIER 1' }
    ];
    const result = gate.applyCardGate(rows, { maxBets: 2, evaluation });
    assert.equal(result.bets.length, 2);
    assert.deepEqual(
      result.bets.map((b) => b.selection),
      ['A', 'B']
    );
    assert.equal(result.leans.length, 1);
    assert.equal(result.leans[0].reason, 'card_full');
    assert.ok(result.notes.some((note) => /capped at 2/.test(note)));
  });

  it('empties the card when nothing clears the price gate, and says why', () => {
    const rows = [
      { selection: 'Brewers ML', odds: -127, marketFairProbability: 0.56, tier: 'TIER 1' },
      { selection: 'Avanesyan ML', odds: -135, marketFairProbability: 0.575, tier: 'TIER 1' }
    ];
    const result = gate.applyCardGate(rows, { evaluation });
    assert.equal(result.bets.length, 0);
    assert.equal(result.dropped.length, 2);
    assert.ok(result.notes.some((note) => /dropped Brewers ML/.test(note)));
  });

  it('labels a bet from an unmeasured bucket UNPROVEN while still reporting it', () => {
    const rows = [{ selection: 'A', odds: 150, marketFairProbability: 0.6, tier: 'TIER 3' }];
    const result = gate.applyCardGate(rows, { evaluation });
    assert.equal(result.bets.length, 1);
    assert.equal(result.bets[0].unproven, true);
    assert.equal(result.bets[0].bucketSample, null);
    assert.equal(result.bets[0].marginPoints, 20);
    assert.ok(result.notes.some((note) => /UNPROVEN/.test(note)));
  });

  it('empties a longshot-only slate, and the dropped rows carry their margin', () => {
    // Regression fixture from the real 2026-09-17 slate: five survivors, every
    // one a plus-money longshot resting on under 1.1pp of fair probability.
    const rows = [
      { selection: 'Miami Dolphins', odds: 809, marketFairProbability: 0.1209, tier: 'TIER 2' },
      { selection: 'Tuivasa', odds: 525, marketFairProbability: 0.165, tier: 'TIER 2' },
      { selection: 'Over 4.5', odds: 545, marketFairProbability: 0.1602, tier: 'TIER 2' },
      { selection: 'Tennessee Titans', odds: 300, marketFairProbability: 0.2558, tier: 'TIER 2' },
      { selection: 'Detroit Tigers -1.5', odds: 182, marketFairProbability: 0.365, tier: 'TIER 2' }
    ];
    const result = gate.applyCardGate(rows, { evaluation });
    assert.equal(result.bets.length, 0, 'not one of these should be presentable as a BET');
    assert.equal(result.dropped.length, 5);
    for (const dropped of result.dropped) {
      assert.equal(dropped.reason, 'margin_too_thin');
      assert.ok(dropped.marginPoints < 2);
    }
  });

  it('tolerates an empty card without inventing notes', () => {
    const result = gate.applyCardGate([], { evaluation });
    assert.deepEqual(result.bets, []);
    assert.deepEqual(result.notes, []);
  });
});
