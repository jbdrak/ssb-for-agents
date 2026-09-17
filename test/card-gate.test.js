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
    assert.ok(result.notes.some((note) => /UNPROVEN/.test(note)));
  });

  it('tolerates an empty card without inventing notes', () => {
    const result = gate.applyCardGate([], { evaluation });
    assert.deepEqual(result.bets, []);
    assert.deepEqual(result.notes, []);
  });
});
