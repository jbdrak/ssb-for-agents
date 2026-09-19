'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fitResidualModel,
  predictMarketResidual,
  leaveOneGroupOutPredictions,
  compareMae
} = require('../lib/market-residual-model');

describe('market residual model', () => {
  it('preserves the market baseline when fitted coefficients are zero', () => {
    const model = fitResidualModel(
      [
        { gameId: 'a', season: 2024, baseline: 3, outcome: 3, features: [1, 2] },
        { gameId: 'b', season: 2024, baseline: -4, outcome: -4, features: [2, 1] }
      ],
      { ridge: 1 }
    );

    assert.deepEqual(model.coefficients, [0, 0]);
    assert.equal(predictMarketResidual(model, { baseline: 12, features: [99, -99] }), 12);
  });

  it('approximately recovers synthetic linear residual coefficients', () => {
    const rows = Array.from({ length: 30 }, (_, i) => {
      const x = i - 15;
      const z = (i % 7) - 3;
      const residual = 2 + 1.5 * x - 0.75 * z;
      return { gameId: `g${i}`, baseline: 10, outcome: 10 + residual, features: [x, z] };
    });
    const model = fitResidualModel(rows, { ridge: 1e-8 });

    assert.ok(Math.abs(model.intercept - 2) < 1e-5);
    assert.ok(Math.abs(model.coefficients[0] - 1.5) < 1e-5);
    assert.ok(Math.abs(model.coefficients[1] + 0.75) < 1e-5);
  });

  it('standardizes using training rows only', () => {
    const predictions = leaveOneGroupOutPredictions(
      [
        { gameId: 'train-a', season: 1, baseline: 0, outcome: 0, features: [1] },
        { gameId: 'train-b', season: 1, baseline: 0, outcome: 0, features: [3] },
        { gameId: 'held-out-extreme', season: 2, baseline: 0, outcome: 0, features: [1000] }
      ],
      { groupField: 'season', ridge: 1 }
    );
    const heldOutFit = predictions.find((row) => row.gameId === 'held-out-extreme').fitMetadata;

    assert.equal(heldOutFit.featureMeans[0], 2);
    assert.equal(heldOutFit.featureScales[0], 1);
    assert.deepEqual(heldOutFit.trainingGameIds, ['train-a', 'train-b']);
  });

  it('ignores constant and missing features without NaN or Infinity', () => {
    const model = fitResidualModel(
      [
        { gameId: 'a', baseline: 0, outcome: 1, features: [null, 5, 1] },
        { gameId: 'b', baseline: 0, outcome: 2, features: [null, 5, null] },
        { gameId: 'c', baseline: 0, outcome: 3, features: [null, 5, 3] }
      ],
      { ridge: 0 }
    );

    assert.deepEqual(model.coefficients, [0, 0, 1]);
    assert.ok(model.coefficients.every(Number.isFinite));
    assert.ok(Number.isFinite(predictMarketResidual(model, { baseline: 4, features: [null, 5, null] })));
  });

  it('leaves a held-out season out of every fit', () => {
    const rows = [
      { gameId: 's1-a', season: 1, baseline: 0, outcome: 1, features: [1] },
      { gameId: 's1-b', season: 1, baseline: 0, outcome: 2, features: [2] },
      { gameId: 's2-a', season: 2, baseline: 0, outcome: 100, features: [1] },
      { gameId: 's2-b', season: 2, baseline: 0, outcome: 200, features: [2] }
    ];
    const predictions = leaveOneGroupOutPredictions(rows, { groupField: 'season', ridge: 1e-8 });
    const heldOutSeason = predictions.filter((row) => row.season === 2);

    assert.equal(heldOutSeason.length, 2);
    assert.ok(heldOutSeason.every((row) => !row.fitMetadata.trainingGroups.includes(2)));
    assert.ok(heldOutSeason.every((row) => row.fitMetadata.trainingGameIds.every((id) => !id.startsWith('s2-'))));
  });

  it('rejects duplicate game IDs in pooled rows', () => {
    assert.throws(
      () =>
        fitResidualModel([
          { gameId: 'duplicate', baseline: 0, outcome: 1, features: [1] },
          { gameId: 'duplicate', baseline: 0, outcome: 2, features: [2] }
        ]),
      /duplicate gameId/i
    );
  });

  it('rejects malformed and non-finite training rows', () => {
    const cases = [
      [{ gameId: 'bad-baseline', baseline: NaN, outcome: 1, features: [1] }, /bad-baseline.*baseline/i],
      [{ gameId: 'bad-outcome', baseline: 0, outcome: Infinity, features: [1] }, /bad-outcome.*outcome/i],
      [{ gameId: 'bad-feature', baseline: 0, outcome: 1, features: [NaN] }, /bad-feature.*feature 0/i],
      [{ gameId: 'bad-feature-string', baseline: 0, outcome: 1, features: ['1'] }, /bad-feature-string.*feature 0/i],
      [{ gameId: 'missing-features', baseline: 0, outcome: 1, features: null }, /missing-features.*features/i]
    ];
    for (const [row, error] of cases) assert.throws(() => fitResidualModel([row]), error);
  });

  it('accepts null and undefined feature values as missing', () => {
    assert.doesNotThrow(() =>
      fitResidualModel([
        { gameId: 'a', baseline: 0, outcome: 1, features: [null, undefined] },
        { gameId: 'b', baseline: 0, outcome: 2, features: [1, null] }
      ])
    );
  });

  it('rejects invalid prediction rows', () => {
    const model = fitResidualModel([{ gameId: 'a', baseline: 0, outcome: 1, features: [1, 2] }]);
    assert.throws(() => predictMarketResidual(model, { baseline: NaN, features: [1, 2] }), /baseline/i);
    assert.throws(() => predictMarketResidual(model, { baseline: 0, features: [1] }), /feature.*length/i);
  });

  it('rejects invalid held-out groups', () => {
    for (const group of [undefined, null, NaN]) {
      assert.throws(
        () => leaveOneGroupOutPredictions([{ gameId: 'a', season: group, baseline: 0, outcome: 1, features: [1] }]),
        /group/i
      );
    }
  });

  it('reuses one fit object per held-out group', () => {
    const predictions = leaveOneGroupOutPredictions(
      [
        { gameId: 'a1', season: 1, baseline: 0, outcome: 1, features: [1] },
        { gameId: 'a2', season: 1, baseline: 0, outcome: 2, features: [2] },
        { gameId: 'b1', season: 2, baseline: 0, outcome: 3, features: [1] },
        { gameId: 'b2', season: 2, baseline: 0, outcome: 4, features: [2] }
      ],
      { groupField: 'season' }
    );
    assert.strictEqual(predictions[0].fitMetadata, predictions[1].fitMetadata);
    assert.notStrictEqual(predictions[0].fitMetadata, predictions[2].fitMetadata);
  });

  it('rejects exact collinearity without ridge and fits it with positive ridge', () => {
    const rows = [
      { gameId: 'a', baseline: 0, outcome: 1, features: [1, 2] },
      { gameId: 'b', baseline: 0, outcome: 2, features: [2, 4] },
      { gameId: 'c', baseline: 0, outcome: 3, features: [3, 6] }
    ];
    assert.throws(() => fitResidualModel(rows, { ridge: 0 }), /singular/i);
    const model = fitResidualModel(rows, { ridge: 1 });
    assert.ok(Number.isFinite(predictMarketResidual(model, { baseline: 0, features: [4, 8] })));
  });

  it('fits 5,000 rows with one model per held-out season', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      gameId: `g${i}`,
      season: i % 5,
      baseline: i % 11,
      outcome: (i % 11) + 1 + i * 0.001,
      features: [i % 17, i % 19, i % 23, i % 29, i % 31]
    }));
    const started = process.hrtime.bigint();
    const predictions = leaveOneGroupOutPredictions(rows, { groupField: 'season', ridge: 1 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(predictions.length, 5000);
    assert.equal(new Set(predictions.map((row) => row.fitMetadata)).size, 5);
    assert.ok(elapsedMs < 3000, `5,000-row workload took ${elapsedMs.toFixed(1)}ms`);
  });

  it('reports known baseline and corrected MAE', () => {
    const result = compareMae([
      { actual: 10, baselinePrediction: 8, correctedPrediction: 11 },
      { actual: 4, baselinePrediction: 5, correctedPrediction: 4 },
      { actual: 0, baselinePrediction: 2, correctedPrediction: -1 }
    ]);

    assert.equal(result.baselineMae, 5 / 3);
    assert.equal(result.correctedMae, 2 / 3);
    assert.equal(result.improvement, 1);
  });
});
