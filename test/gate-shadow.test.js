'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  gateShadowReport,
  gateSweepReport,
  signalSweepReport,
  fairAnchorReport,
  candidateGateView
} = require('../lib/gate-shadow');

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

describe('gate-shadow: signalSweepReport', () => {
  const withQuality = (score, clvPct) => {
    seq += 1;
    return {
      candidateId: `c-q-${seq}`,
      gameId: `gq-${seq}`,
      market: 'Moneyline',
      selection: `Q${seq}`,
      odds: -110,
      clvPct,
      tier: 'TIER 2',
      movementDisposition: 'supportive_clean',
      featureSnapshot: { marketFairProbability: 0.5, signalQualityScore: score }
    };
  };

  it('bands a numeric signal and keeps the sample monotone', () => {
    const report = signalSweepReport({
      candidates: [withQuality(9, 3), withQuality(8, 2), withQuality(3, -3), withQuality(2, -2)]
    });
    const signal = report.numeric.find((entry) => entry.key === 'signalQualityScore');
    const sizes = signal.bands.map((band) => band.sample);
    for (let i = 1; i < sizes.length; i += 1) {
      assert.ok(sizes[i] <= sizes[i - 1], `band ${i} must not be larger than band ${i - 1}`);
    }
  });

  it('groups a categorical signal by value', () => {
    const report = signalSweepReport({ candidates: [withQuality(5, 1), withQuality(5, -1)] });
    const signal = report.categorical.find((entry) => entry.key === 'tier');
    assert.equal(signal.groups.length, 1);
    assert.equal(signal.groups[0].value, 'TIER 2');
    assert.equal(signal.groups[0].sample, 2);
  });

  it('reports separates ONLY when the readable extremes agree on both metrics', () => {
    // High quality => beats and positive CLV. Low quality => loses and negative CLV.
    const report = signalSweepReport(
      { candidates: [withQuality(9, 3), withQuality(9, 4), withQuality(3, -3), withQuality(3, -4)] },
      { minSample: 2 }
    );
    const signal = report.numeric.find((entry) => entry.key === 'signalQualityScore');
    assert.equal(signal.separates, true, 'a real spread across readable bands must separate');
    assert.ok(report.separatingSignals.includes('signalQualityScore'));
    assert.equal(report.separates, true);
  });

  it('does NOT report separates when the sample is too small to read', () => {
    const report = signalSweepReport({ candidates: [withQuality(9, 3), withQuality(3, -3)] }, { minSample: 5 });
    assert.equal(report.separates, false, 'one row per band is not a finding');
  });

  it('does NOT report separates when the metrics disagree', () => {
    // Better beat rate but WORSE mean CLV: not a usable separation.
    const report = signalSweepReport(
      { candidates: [withQuality(9, 0.1), withQuality(9, -5), withQuality(3, -1), withQuality(3, -1)] },
      { minSample: 2 }
    );
    const signal = report.numeric.find((entry) => entry.key === 'signalQualityScore');
    assert.equal(signal.separates, false);
    assert.equal(report.separates, false);
  });

  it('excludes rows without a close and dedupes repeats', () => {
    const row = withQuality(5, 1);
    const report = signalSweepReport({
      candidates: [row, { ...row, candidateId: 'dup' }, { ...withQuality(5, 1), clvPct: null }]
    });
    assert.equal(report.graded, 1);
  });
});

describe('fairAnchorReport: all-books EV vs sharp-anchored EV, head to head', () => {
  // A play priced -110 (decimal 1.9091). The all-books fair has been dragged up to
  // 0.55 by a soft price in the scan, while the sharp-anchored fair says 0.50.
  //   all-books EV : 0.55 * 1.9091 - 1 = +5.0%   -> "bet it"
  //   sharp EV     : 0.50 * 1.9091 - 1 = -4.5%   -> "do not"
  // This disagreement IS the bug being hunted: the contaminated anchor manufactures
  // value out of a square number. The report must show the two anchors disagreeing.
  const contaminated = {
    candidateId: 'c1',
    gameId: 'g1',
    league: 'MLB',
    market: 'Moneyline',
    selection: 'Yankees',
    odds: -110,
    clvPct: 0.01,
    featureSnapshot: { marketFairProbability: 0.55, sharpMarketFairProbability: 0.5 }
  };

  it('shows the anchors disagreeing at the same threshold', () => {
    const report = fairAnchorReport({ candidates: [contaminated] }, { evThresholds: [2] });
    assert.equal(report.allBooks[0].sample, 1, 'contaminated anchor sees a +EV play');
    assert.equal(report.sharp[0].sample, 0, 'sharp-anchored anchor correctly rejects it');
  });

  it('counts candidates with no sharp fair as missing, never as zero', () => {
    const noSharp = {
      ...contaminated,
      candidateId: 'c2',
      gameId: 'g2',
      featureSnapshot: { marketFairProbability: 0.55 }
    };
    const report = fairAnchorReport({ candidates: [contaminated, noSharp] }, { evThresholds: [2] });
    assert.equal(report.graded, 2);
    assert.equal(report.withoutSharpFair, 1);
    assert.equal(report.withAllFair, 2);
    assert.equal(report.insufficientSample, true, 'coverage below minSample must be flagged');
  });

  it('dedupes the same observation across repeat scans', () => {
    const report = fairAnchorReport(
      { candidates: [contaminated, { ...contaminated, candidateId: 'dup', scanId: 'later' }] },
      { evThresholds: [2] }
    );
    assert.equal(report.graded, 1);
  });

  it('ignores candidates with no close-relative CLV', () => {
    const report = fairAnchorReport(
      { candidates: [contaminated, { ...contaminated, candidateId: 'c3', clvPct: null }] },
      { evThresholds: [2] }
    );
    assert.equal(report.graded, 1);
  });
});
