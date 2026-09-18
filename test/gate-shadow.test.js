'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { gateShadowReport, gateSweepReport, candidateGateView } = require('../lib/gate-shadow');

let seq = 0;

// fair 0.55 at +100 (decimal 2.0) => EV +10%, margin 5pp: passes the default gate.
// Each fixture gets a UNIQUE key, or the dedupe collapses them into one observation.
const passing = (overrides = {}) => {
  seq += 1;
  return {
    candidateId: `c-pass-${seq}`,
    gameId: `gpass-${seq}`,
    market: 'Moneyline',
    selection: `A${seq}`,
    odds: 100,
    clvPct: 2,
    featureSnapshot: { marketFairProbability: 0.55 },
    ...overrides
  };
};

// fair 0.50 at -110 (decimal 1.909) => negative EV: rejected as ev_below_floor.
const failing = (overrides = {}) => {
  seq += 1;
  return {
    candidateId: `c-fail-${seq}`,
    gameId: `gfail-${seq}`,
    market: 'Moneyline',
    selection: `B${seq}`,
    odds: -110,
    clvPct: -2,
    featureSnapshot: { marketFairProbability: 0.5 },
    ...overrides
  };
};

describe('gate-shadow: candidateGateView', () => {
  it('flattens featureSnapshot under the row so the gate can see the fair probability', () => {
    const view = candidateGateView({ odds: -110, featureSnapshot: { marketFairProbability: 0.55 } });
    assert.equal(view.marketFairProbability, 0.55);
    assert.equal(view.odds, -110);
  });

  it('lets the candidate own top-level fields win over the snapshot', () => {
    const view = candidateGateView({ marketFairProbability: 0.6, featureSnapshot: { marketFairProbability: 0.4 } });
    assert.equal(view.marketFairProbability, 0.6);
  });
});

describe('gate-shadow: gateShadowReport', () => {
  it('splits closed candidates by what the gate would have said', () => {
    const report = gateShadowReport({ candidates: [passing(), passing(), failing(), failing(), failing()] });
    assert.equal(report.sample, 5);
    assert.equal(report.passed.sample, 2);
    assert.equal(report.rejected.sample, 3);
    assert.equal(report.passed.beat, 2, 'both passing rows have a positive CLV');
    assert.equal(report.rejected.beat, 0);
  });

  it('excludes candidates that have no close-relative CLV', () => {
    const report = gateShadowReport({ candidates: [passing(), { ...passing(), clvPct: null }] });
    assert.equal(report.sample, 1);
  });

  it('dedupes so a play recorded twice counts once', () => {
    const dup = { ...passing(), candidateId: 'x' };
    const report = gateShadowReport({ candidates: [dup, { ...dup, candidateId: 'y' }] });
    assert.equal(report.sample, 1);
  });

  it('is flagged insufficient unless BOTH sides have a readable sample', () => {
    // A comparison needs two sides. One closed row on the passing side is not a finding.
    const report = gateShadowReport({ candidates: [passing(), failing()], minSample: 5 });
    assert.equal(report.insufficientSample, true);
  });

  it('groups by gate reason', () => {
    const report = gateShadowReport({ candidates: [passing(), failing()] });
    assert.ok(report.byReason.positive_ev, 'expected a positive_ev bucket');
    assert.ok(report.byReason.ev_below_floor, 'expected an ev_below_floor bucket');
  });
});

describe('gate-shadow: gateSweepReport', () => {
  it('narrows the sample as the EV floor rises, and never widens it', () => {
    const candidates = [passing(), passing(), failing(), failing(), failing()];
    const report = gateSweepReport({ candidates }, { evThresholds: [0, 1, 2, 5, 99] });
    assert.deepEqual(
      report.bands.map((band) => band.minEvPct),
      [0, 1, 2, 5, 99],
      'the caller-supplied thresholds must be used'
    );
    const sizes = report.bands.map((band) => band.sample);
    for (let i = 1; i < sizes.length; i += 1) {
      assert.ok(sizes[i] <= sizes[i - 1], `band ${i} must not be larger than band ${i - 1}`);
    }
    assert.equal(report.bands[report.bands.length - 1].sample, 0, 'a 99% floor selects nothing');
  });

  it('reports graded and ungradable counts', () => {
    const report = gateSweepReport({
      candidates: [passing(), failing(), { ...passing(), featureSnapshot: {} }]
    });
    assert.equal(report.graded, 2, 'the row with no fair probability is ungradable');
    assert.equal(report.ungradable, 1);
  });

  it('flags the whole sweep as insufficient below the sample floor', () => {
    const report = gateSweepReport({ candidates: [passing()] }, { minSample: 30 });
    assert.equal(report.insufficientSample, true);
  });
});
