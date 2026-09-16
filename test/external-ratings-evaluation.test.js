'use strict';

// Per-source evaluation for the external-ratings benchmark layer (card 11).
//
// The contract under test: each source is scored entirely on its own. There is
// no composite/blended number anywhere in the output, `unresolved` and
// `unmatched` rows are excluded from every denominator, and a source with no
// resolvable rows reports sample 0 with NO score block rather than a fabricated
// 0.5.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateRatingSources,
  evaluateMarketRelative,
  favoriteBandOf,
  DEFAULT_EVALUATION_DIMENSIONS,
  DEFAULT_MARKET_MIN_SAMPLE
} = require('../lib/ssb-external-ratings-evaluation');

function resolvedRow(overrides = {}) {
  return {
    outcome: 'win',
    modelWinProbability: 0.6,
    predictionTimestamp: '2026-09-03T16:00:00Z',
    matched: true,
    league: 'NCAAF',
    level: 'FBS',
    market: 'Moneyline',
    ...overrides
  };
}

// Never joined to a verified result: outcome is absent by construction.
function unmatchedRow(overrides = {}) {
  return {
    outcome: null,
    matched: false,
    predictionTimestamp: '2026-09-03T16:00:00Z',
    league: 'NCAAF',
    level: 'FBS',
    market: 'Moneyline',
    ...overrides
  };
}

// Matched, but with no usable prediction provenance.
function unresolvedRow(overrides = {}) {
  return {
    outcome: 'win',
    modelWinProbability: 0.6,
    matched: true,
    league: 'NCAAF',
    level: 'FBS',
    market: 'Moneyline',
    ...overrides
  };
}

describe('external-ratings per-source evaluation', () => {
  it('scores each source independently and never emits a blended number', () => {
    const result = evaluateRatingSources({
      sagarin: [
        resolvedRow({ outcome: 'win', modelWinProbability: 0.9 }),
        resolvedRow({ outcome: 'loss', modelWinProbability: 0.9 })
      ],
      massey: [resolvedRow({ outcome: 'win', modelWinProbability: 0.55 })]
    });

    assert.deepEqual(Object.keys(result.sources).sort(), ['massey', 'sagarin']);

    const sagarinBrier = result.sources.sagarin.scores.modelWinProbability.brier;
    const masseyBrier = result.sources.massey.scores.modelWinProbability.brier;

    // Each source carries its own denominator and its own score.
    assert.equal(sagarinBrier.samples, 2);
    assert.equal(masseyBrier.samples, 1);
    assert.equal(sagarinBrier.value, 0.41); // (0.1^2 + 0.9^2) / 2
    assert.equal(masseyBrier.value, 0.2025); // 0.45^2
    assert.notEqual(sagarinBrier.value, masseyBrier.value);

    // No rolled-up/composite block exists to blend them.
    assert.equal(result.scores, undefined);
    assert.equal(result.composite, undefined);
    assert.equal(result.sources.sagarin.source, 'sagarin');
    assert.equal(result.sources.massey.source, 'massey');
  });

  it('reports sample 0 and no score for a source with zero resolved rows', () => {
    const result = evaluateRatingSources({
      sasser: [unmatchedRow(), unresolvedRow()]
    });

    const block = result.sources.sasser;
    assert.equal(block.coverage.total, 2);
    assert.equal(block.coverage.resolved, 0);
    assert.equal(block.coverage.sampleSize, 0);
    assert.equal(block.coverage.unmatched, 1);
    assert.equal(block.coverage.unresolved, 1);

    // No fabricated 0.5, no score block at all.
    assert.deepEqual(block.scores, {});
    assert.deepEqual(block.segments, {});
  });

  it('reports coverage and sample size ahead of the score', () => {
    const result = evaluateRatingSources({
      sagarin: [resolvedRow(), unmatchedRow(), unresolvedRow()]
    });
    const block = result.sources.sagarin;

    const keys = Object.keys(block);
    assert.ok(keys.indexOf('coverage') >= 0);
    assert.ok(keys.indexOf('scores') > keys.indexOf('coverage'));

    // The resolved row is the only one in any denominator.
    assert.equal(block.coverage.total, 3);
    assert.equal(block.coverage.sampleSize, 1);
    assert.equal(block.scores.modelWinProbability.brier.samples, 1);
  });

  it('keeps unmatched and unresolved rows out of every denominator', () => {
    const result = evaluateRatingSources(
      {
        sagarin: [
          resolvedRow({ outcome: 'win', modelWinProbability: 0.8, league: 'NCAAF' }),
          unmatchedRow({ league: 'NFL' }),
          unresolvedRow({ league: 'NBA' })
        ]
      },
      { minSample: 1 }
    );

    const block = result.sources.sagarin;
    assert.equal(block.coverage.sampleSize, 1);
    assert.equal(block.scores.modelWinProbability.brier.samples, 1);

    // Only the one resolved row ever reaches a segment. Segment keys are
    // normalized by the shared `defaultResolveSegment` (uppercased).
    const segmentKeys = Object.keys(block.segments);
    assert.deepEqual(segmentKeys, ['NCAAF|FBS|HEAVY|MONEYLINE']);
    assert.equal(block.segments[segmentKeys[0]].totalDecided, 1);
  });

  it('segments on league, level, favorite band and market', () => {
    const result = evaluateRatingSources(
      {
        massey: [
          resolvedRow({ outcome: 'win', modelWinProbability: 0.75, market: 'Point Spread' }),
          resolvedRow({ outcome: 'loss', modelWinProbability: 0.55, market: 'Point Spread' })
        ]
      },
      { minSample: 1 }
    );

    assert.deepEqual(result.dimensions, DEFAULT_EVALUATION_DIMENSIONS);
    assert.deepEqual(DEFAULT_EVALUATION_DIMENSIONS, ['league', 'level', 'favoriteBand', 'market']);

    const block = result.sources.massey;
    assert.deepEqual(block.dimensions, DEFAULT_EVALUATION_DIMENSIONS);
    assert.equal(block.segments['NCAAF|FBS|HEAVY|POINT SPREAD'].wins, 1);
    assert.equal(block.segments['NCAAF|FBS|SLIGHT|POINT SPREAD'].losses, 1);
  });

  it('derives level from the Sagarin `segment` field and honors an explicit favoriteBand', () => {
    const result = evaluateRatingSources(
      {
        sagarin: [
          resolvedRow({ level: undefined, segment: 'fcs', modelWinProbability: 0.9, favoriteBand: 'market_heavy' })
        ]
      },
      { minSample: 1 }
    );

    const block = result.sources.sagarin;
    // `level` fell back to `segment`, and the explicit band beat the derived one.
    assert.deepEqual(Object.keys(block.segments), ['NCAAF|FCS|MARKET_HEAVY|MONEYLINE']);
  });

  it('groups a flat row list by its own source field without blending', () => {
    const result = evaluateRatingSources([
      resolvedRow({ source: 'sagarin', outcome: 'win', modelWinProbability: 0.8 }),
      resolvedRow({ source: 'massey', outcome: 'loss', modelWinProbability: 0.8 })
    ]);

    assert.deepEqual(Object.keys(result.sources).sort(), ['massey', 'sagarin']);
    assert.equal(result.sources.sagarin.coverage.sampleSize, 1);
    assert.equal(result.sources.massey.coverage.sampleSize, 1);
  });

  it('accepts adapter result envelopes ({source, records}) without blending them', () => {
    const result = evaluateRatingSources([
      { source: 'sagarin', coverage: 'full', records: [resolvedRow({ outcome: 'win', modelWinProbability: 0.8 })] },
      { source: 'massey', coverage: 'full', records: [resolvedRow({ outcome: 'loss', modelWinProbability: 0.8 })] }
    ]);

    assert.deepEqual(Object.keys(result.sources).sort(), ['massey', 'sagarin']);
    assert.equal(result.sources.sagarin.coverage.sampleSize, 1);
    assert.equal(result.sources.sagarin.segments['NCAAF|FBS|HEAVY|MONEYLINE'].wins, 1);
    assert.equal(result.sources.massey.segments['NCAAF|FBS|HEAVY|MONEYLINE'].losses, 1);
  });

  it('scores nothing for a source whose only matched rows are pushes', () => {
    const result = evaluateRatingSources({
      sagarin: [resolvedRow({ outcome: 'push' })]
    });

    const block = result.sources.sagarin;
    assert.equal(block.coverage.resolved, 0);
    assert.equal(block.coverage.pushed, 1);
    assert.equal(block.coverage.sampleSize, 0);
    assert.deepEqual(block.scores, {});
  });
});

// Card 12: the market-relative comparison gate. The whole point is that a
// source is compared against the DE-VIGGED closing line (`marketFairProbability`,
// the repo's explicit-only fair close) and never against a raw price, and that
// the favourite-size band comes from that market input rather than from the
// model's own confidence. Below the sample threshold the gate returns
// `insufficient_sample` and no number at all.
describe('external-ratings market-relative comparison gate', () => {
  // Model opinion AND the recorded de-vigged close: the only shape this gate
  // is allowed to score. Model 55% against a fair close of 62% is deliberately
  // a source that is more accurate than the close yet still loses to it.
  function marketRow(overrides = {}) {
    return resolvedRow({
      modelWinProbability: 0.55,
      marketFairProbability: 0.62,
      closingOdds: 120,
      ...overrides
    });
  }

  it('returns insufficient_sample instead of a number below the sample threshold', () => {
    const result = evaluateRatingSources({ sagarin: [marketRow(), marketRow(), marketRow()] });
    const market = result.sources.sagarin.marketRelative;

    assert.equal(market.status, 'insufficient_sample');
    assert.equal(market.reason, 'below_min_sample');
    assert.equal(market.minSample, 30);
    assert.equal(market.sampleSize, 3);

    // No metric may leak through below the gate.
    for (const field of ['clvPct', 'roi', 'maxDrawdown', 'scores', 'split', 'segments']) {
      assert.equal(market[field], undefined, `${field} must not be reported below the sample threshold`);
    }
  });

  it('reports a source that is accurate but loses to the close as exactly that', () => {
    const result = evaluateRatingSources(
      {
        massey: [
          marketRow({ outcome: 'win' }),
          marketRow({ outcome: 'loss' }),
          marketRow({ outcome: 'loss' }),
          marketRow({ outcome: 'loss' })
        ]
      },
      { marketMinSample: 1 }
    );
    const market = result.sources.massey.marketRelative;

    assert.equal(market.status, 'ok');
    assert.equal(market.sampleSize, 4);

    // Accurate: the model's Brier beats the market's on the very same rows.
    assert.equal(market.scores.modelWinProbability.brier.value, 0.2775);
    assert.equal(market.scores.marketFairProbability.brier.value, 0.3244);
    assert.ok(market.scores.modelWinProbability.brier.value < market.scores.marketFairProbability.brier.value);

    // ...and it STILL loses to the close: negative CLV, negative ROI, drawdown.
    assert.equal(market.clvPct, -7); // 0.55 - 0.62 on every row
    assert.equal(market.roi, -45); // (1.2 - 3) / 4
    assert.equal(market.maxDrawdown, -3); // peak 1.2 -> trough -1.8
    assert.equal(market.bets, 4);
  });

  it('splits chronologically by position and never shuffles', () => {
    const rows = [
      marketRow({ outcome: 'win', predictionTimestamp: '2026-09-07T16:00:00Z' }),
      marketRow({ outcome: 'loss', predictionTimestamp: '2026-09-05T16:00:00Z' }),
      marketRow({ outcome: 'loss', predictionTimestamp: '2026-09-03T16:00:00Z' })
    ];
    const market = evaluateRatingSources({ sagarin: rows }, { marketMinSample: 1 }).sources.sagarin.marketRelative;

    assert.equal(market.split.fraction, 0.5);
    // The earliest row is the single in-sample row even though it was LAST in
    // the input array: ordering is by prediction timestamp, never by position.
    assert.equal(market.split.inSample.sampleSize, 1);
    assert.equal(market.split.inSample.wins, 0);
    assert.equal(market.split.inSample.losses, 1);
    assert.equal(market.split.outOfSample.sampleSize, 2);
    assert.equal(market.split.outOfSample.wins, 1);

    // Deterministic: identical input, identical output (no random shuffle).
    assert.deepEqual(
      evaluateRatingSources({ sagarin: rows }, { marketMinSample: 1 }),
      evaluateRatingSources({ sagarin: rows }, { marketMinSample: 1 })
    );
  });

  it('segments on the market-derived favourite size, not the model confidence band', () => {
    // The model is 75% confident about a game the market priced near pick'em.
    const rows = [
      resolvedRow({ outcome: 'win', modelWinProbability: 0.75, marketFairProbability: 0.51, closingOdds: -140 })
    ];
    const block = evaluateRatingSources({ sagarin: rows }, { minSample: 1, marketMinSample: 1 }).sources.sagarin;

    // Card 11's band still reports the model's own confidence...
    assert.equal(block.segments['NCAAF|FBS|HEAVY|MONEYLINE'].wins, 1);
    // ...while the market-relative gate bands by the recorded market price only.
    assert.deepEqual(Object.keys(block.marketRelative.segments), ['SLIGHT']);
    assert.equal(block.marketRelative.segments.SLIGHT.sampleSize, 1);
    assert.equal(block.marketRelative.segments.SLIGHT.wins, 1);
  });

  it('names which band answers which question', () => {
    const result = evaluateRatingSources({ sagarin: [marketRow()] }, { marketMinSample: 1 });
    const market = result.sources.sagarin.marketRelative;

    assert.deepEqual(market.bandSemantics, {
      favoriteBand: 'model_confidence',
      marketFavoriteBand: 'market_favourite_size'
    });
    assert.deepEqual(result.bandSemantics, market.bandSemantics);
  });

  it('bands the market favourite unknown when no market price is available', () => {
    const rows = [
      marketRow({ outcome: 'win', marketFairProbability: 0.58 }),
      resolvedRow({ outcome: 'loss', modelWinProbability: 0.6 })
    ];
    const market = evaluateRatingSources({ massey: rows }, { marketMinSample: 1 }).sources.massey.marketRelative;

    assert.equal(market.sampleSize, 1);
    assert.deepEqual(market.marketFavoriteBandSource, { marketFairProbability: 1, unknown: 1 });
    // The market-less row never reaches a band, so it is in no denominator.
    assert.deepEqual(Object.keys(market.segments), ['SLIGHT']);
    assert.equal(market.segments.SLIGHT.sampleSize, 1);
  });

  it('honors an explicit market band and never derives one from the model', () => {
    // The price alone would band this game `moderate`; the explicit market band
    // wins. Either way the model's 51% plays no part.
    const rows = [
      resolvedRow({
        outcome: 'win',
        modelWinProbability: 0.51,
        marketFairProbability: 0.62,
        marketFavoriteBand: 'heavy'
      })
    ];
    const market = evaluateRatingSources({ sasser: rows }, { marketMinSample: 1 }).sources.sasser.marketRelative;

    assert.deepEqual(Object.keys(market.segments), ['HEAVY']);
    assert.deepEqual(market.marketFavoriteBandSource, { explicit: 1 });
    assert.equal(market.sampleSize, 1);
  });

  it('accepts recorded decision provenance and never claims edge', () => {
    const rows = [
      {
        outcome: 'win',
        matched: true,
        modelWinProbability: 0.55,
        marketFairProbability: 0.58,
        closingOdds: 120,
        decisionTimestamp: '2026-09-03T16:00:00Z',
        league: 'NCAAF',
        level: 'FBS',
        market: 'Moneyline'
      },
      {
        outcome: 'loss',
        matched: true,
        modelWinProbability: 0.55,
        marketFairProbability: 0.58,
        closingOdds: 120,
        capturedAt: '2026-09-04T16:00:00Z',
        league: 'NCAAF',
        level: 'FBS',
        market: 'Moneyline'
      }
    ];
    const market = evaluateRatingSources({ sagarin: rows }, { marketMinSample: 1 }).sources.sagarin.marketRelative;

    assert.equal(market.status, 'ok');
    assert.equal(market.sampleSize, 2);
    assert.equal(market.marketInput, 'marketFairProbability');
    assert.equal(market.interpretation, 'context_confirmation_veto');
    assert.match(market.baseline, /Fair & Oster/);
    assert.match(market.baseline, /not edge/);

    // A source is never presented as profitable or as a positive-EV signal.
    for (const forbidden of ['profitable', 'positiveExpectedValue', 'expectedValue', 'ev', 'edge']) {
      assert.equal(market[forbidden], undefined, `${forbidden} must not be reported`);
    }
  });
});

// Tennis Elo (port, part 4): the SAME market-relative gate applied to tennis.
// Surface is a real context variable for tennis, not a nicety, and ATP/WTA are
// never pooled - so the gate is fed `surface` + `tour` (+ the market-derived
// band). Moneyline is the only tennis market Elo models, so `market` is kept as
// a dimension: a totals row forms its own segment and can never merge into the
// ML evaluation. Below DEFAULT_MARKET_MIN_SAMPLE (30) a segment reports
// `insufficient_sample` and no number at all.
describe('external-ratings market-relative gate: tennis Elo (surface x tour)', () => {
  const DIMENSIONS = ['surface', 'tour', 'marketFavoriteBand'];

  // An evaluation row for a tennis Elo play: the Elo selected-player probability
  // is the model probability, compared against the de-vigged close.
  function tennisRow(overrides = {}) {
    return {
      outcome: 'win',
      matched: true,
      modelWinProbability: 0.55,
      marketFairProbability: 0.6,
      closingOdds: -110,
      surface: 'hard',
      tour: 'ATP',
      market: 'Moneyline',
      league: 'TENNIS',
      predictionTimestamp: '2026-06-01T12:00:00Z',
      ...overrides
    };
  }

  function repeat(count, overrides = {}) {
    return Array.from({ length: count }, (_value, index) =>
      tennisRow({ ...overrides, predictionTimestamp: `2026-06-${String(index + 1).padStart(2, '0')}T12:00:00Z` })
    );
  }

  it('segments by surface and tour and never pools the two tours', () => {
    const rows = [...repeat(30, { surface: 'hard', tour: 'ATP' }), ...repeat(30, { surface: 'clay', tour: 'WTA' })];
    const market = evaluateMarketRelative(rows, { dimensions: DIMENSIONS });

    assert.equal(market.status, 'ok');
    assert.equal(market.sampleSize, 60);
    assert.deepEqual(market.dimensions, DIMENSIONS);

    // marketFair 0.60 -> market favourite size 0.60 -> 'moderate'.
    assert.deepEqual(Object.keys(market.segments).sort(), ['CLAY|WTA|MODERATE', 'HARD|ATP|MODERATE']);
    assert.equal(market.segments['HARD|ATP|MODERATE'].sampleSize, 30);
    assert.equal(market.segments['CLAY|WTA|MODERATE'].sampleSize, 30);

    // ATP and WTA are never blended into one segment.
    assert.ok(!Object.keys(market.segments).some((key) => key.includes('ATP') && key.includes('WTA')));
  });

  it('reports insufficient_sample per segment below 30 while a full segment still reports', () => {
    const rows = [...repeat(30, { surface: 'hard', tour: 'ATP' }), ...repeat(3, { surface: 'grass', tour: 'ATP' })];
    const market = evaluateMarketRelative(rows, { dimensions: DIMENSIONS });

    assert.equal(market.status, 'ok');
    assert.equal(market.sampleSize, 33);

    const hard = market.segments['HARD|ATP|MODERATE'];
    assert.equal(hard.status, 'ok');
    assert.equal(hard.sampleSize, 30);
    assert.equal(typeof hard.clvPct, 'number');

    const grass = market.segments['GRASS|ATP|MODERATE'];
    assert.equal(grass.status, 'insufficient_sample');
    assert.equal(grass.sampleSize, 3);
    // No metric may leak through below the segment's sample threshold.
    for (const field of ['clvPct', 'roi', 'maxDrawdown', 'scores']) {
      assert.equal(grass[field], undefined, `${field} must not leak below the segment sample threshold`);
    }
  });

  it('returns insufficient_sample for the whole sport below 30 rows, with no number at all', () => {
    const market = evaluateMarketRelative(repeat(29, { surface: 'hard', tour: 'ATP' }), { dimensions: DIMENSIONS });

    assert.equal(market.status, 'insufficient_sample');
    assert.equal(market.reason, 'below_min_sample');
    assert.equal(market.sampleSize, 29);
    assert.equal(market.minSample, DEFAULT_MARKET_MIN_SAMPLE);
    assert.equal(DEFAULT_MARKET_MIN_SAMPLE, 30);
    for (const field of ['clvPct', 'roi', 'maxDrawdown', 'scores', 'split', 'segments']) {
      assert.equal(market[field], undefined, `${field} must not be reported below the sport sample threshold`);
    }
  });

  it('bands the market favourite from the market price, never the model confidence', () => {
    // Model 80% on a game the market priced near even money: the MODEL band
    // would be HEAVY, the MARKET band is SLIGHT. The gate must use the market.
    const market = evaluateMarketRelative(repeat(30, { modelWinProbability: 0.8, marketFairProbability: 0.55 }), {
      dimensions: DIMENSIONS
    });

    assert.equal(favoriteBandOf(0.8), 'heavy'); // the band the gate must NOT use
    assert.deepEqual(Object.keys(market.segments), ['HARD|ATP|SLIGHT']);
    assert.deepEqual(market.marketFavoriteBandSource, { marketFairProbability: 30 });
    assert.equal(market.bandSemantics.marketFavoriteBand, 'market_favourite_size');
    assert.equal(market.bandSemantics.favoriteBand, 'model_confidence');
  });

  it('keeps a non-Moneyline row in its own segment, out of the ML evaluation', () => {
    const rows = [
      ...repeat(30, { surface: 'hard', tour: 'ATP', market: 'Moneyline' }),
      tennisRow({ surface: 'hard', tour: 'ATP', market: 'Total Games' })
    ];
    const market = evaluateMarketRelative(rows, {
      dimensions: ['surface', 'tour', 'market', 'marketFavoriteBand']
    });

    assert.equal(market.segments['HARD|ATP|MONEYLINE|MODERATE'].sampleSize, 30);
    // The totals row is a distinct, under-sampled segment and never merges in.
    assert.equal(market.segments['HARD|ATP|TOTAL GAMES|MODERATE'].sampleSize, 1);
    assert.equal(market.segments['HARD|ATP|TOTAL GAMES|MODERATE'].status, 'insufficient_sample');
  });

  it('repeats the honest baseline and never presents tennis Elo as edge', () => {
    const market = evaluateMarketRelative(repeat(30), { dimensions: DIMENSIONS });

    assert.equal(market.interpretation, 'context_confirmation_veto');
    assert.match(market.baseline, /Fair & Oster/);
    assert.match(market.baseline, /not edge/);
    assert.equal(market.marketInput, 'marketFairProbability');
    for (const forbidden of ['profitable', 'positiveExpectedValue', 'expectedValue', 'ev', 'edge']) {
      assert.equal(market[forbidden], undefined, `${forbidden} must not be reported`);
    }
  });
});
