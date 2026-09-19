'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FEATURE_NAMES,
  makeCfbFeatureVector,
  buildCfbResidualRows,
  cfbClusterKey,
  selectRidgeChronologically,
  expandingSeasonPredictions,
  summarizeCfbPredictions,
  bootstrapMaeImprovements,
  clusterBootstrapMae
} = require('../lib/cfb-residual-validation');

function featureRow(overrides = {}) {
  return {
    homeOffEpa: 5,
    awayDefEpaAllowed: 1,
    awayOffEpa: 2,
    homeDefEpaAllowed: 0,
    homeOffSuccess: 5,
    awayDefSuccessAllowed: 1,
    awayOffSuccess: 2,
    homeDefSuccessAllowed: 0,
    homeOffExplosive: 5,
    awayDefExplosiveAllowed: 1,
    awayOffExplosive: 2,
    homeDefExplosiveAllowed: 0,
    homeDefHavoc: 4,
    awayDefHavoc: 1,
    homeOffHavocAllowed: 3,
    awayOffHavocAllowed: 2,
    homeEarlyDownEpa: 2,
    awayEarlyDownEpa: 1,
    homePassingDownEpa: 3,
    awayPassingDownEpa: 1,
    homeEarlyDownPassRate: 0.6,
    awayEarlyDownPassRate: 0.4,
    homeSackRateAllowed: 0.1,
    awaySackRateAllowed: 0.2,
    homeTurnoverRate: 0.03,
    awayTurnoverRate: 0.05,
    homeFinishingDrives: 4,
    awayFinishingDrives: 3,
    homePace: 70,
    awayPace: 65,
    homeGamesObserved: 4,
    awayGamesObserved: 3,
    ...overrides
  };
}

function game(gameId, season, outcome, extra = {}) {
  return {
    gameId,
    season,
    startDate: `${season}-09-06T12:00:00Z`,
    openingHomeLine: 0,
    margin: outcome,
    features: featureRow(extra),
    closingHomeLine: 1
  };
}

test('feature vector has fixed order and signed/null derived values', () => {
  assert.equal(FEATURE_NAMES.length, 14);
  assert.deepEqual(
    makeCfbFeatureVector({ features: featureRow(), neutralSite: true }),
    [2, 2, 2, 3, 1, 1, 2, 0.19999999999999996, -0.1, -0.020000000000000004, 1, 5, 1, 3]
  );
  const values = makeCfbFeatureVector({
    features: featureRow({ homeOffEpa: NaN, homeDefHavoc: Infinity, homePace: undefined }),
    neutralSite: false
  });
  assert.equal(values[0], null);
  assert.equal(values[3], null);
  assert.equal(values[11], null);
  assert.equal(values[12], 0);
});

test('row builder reports ineligible rows and duplicate game IDs', () => {
  const result = buildCfbResidualRows([game('ok', 2024, 3), game('bad', 2024, 2, { homeOffEpa: null })]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.exclusions.missing_core_matchup_features, 1);
  assert.throws(() => buildCfbResidualRows([game('dup', 2024, 1), game('dup', 2024, 2)]), /Duplicate/);
});

test('cluster key uses the Sunday-starting UTC week', () => {
  assert.equal(cfbClusterKey(2024, '2024-09-01T00:01:00Z'), '2024:2024-09-01');
  assert.equal(cfbClusterKey(2024, '2024-09-07T23:59:00Z'), '2024:2024-09-01');
  assert.notEqual(cfbClusterKey(2024, '2024-09-08T00:00:00Z'), cfbClusterKey(2024, '2024-09-07T23:59:00Z'));
});

test('expanding predictions use only prior seasons and predict each game once', () => {
  const rows = buildCfbResidualRows([
    game('a', 2022, 1),
    game('b', 2023, 2),
    game('c', 2023, 3),
    game('d', 2024, 4)
  ]).rows;
  const predictions = expandingSeasonPredictions(rows);
  assert.deepEqual(
    predictions.map((row) => row.gameId),
    ['b', 'c', 'd']
  );
  assert.deepEqual(predictions[0].trainingSeasons, [2022]);
  assert.deepEqual(predictions[2].trainingSeasons, [2022, 2023]);
  assert.equal(new Set(predictions.map((row) => row.gameId)).size, predictions.length);
});

test('inner ridge selection is chronological and deterministic on ties', () => {
  const rows = buildCfbResidualRows([game('a', 2022, 1), game('b', 2023, 2), game('c', 2024, 3)]).rows;
  const selection = selectRidgeChronologically(rows, { candidates: [10, 1], defaultRidge: 10 });
  assert.equal(selection.ridge, 1);
  assert.equal(selectRidgeChronologically([rows[0]], { defaultRidge: 7 }).ridge, 7);
});

test('metrics include opening, corrected, closing and movement diagnostics', () => {
  const predictions = [
    {
      gameId: 'a',
      season: 2023,
      actual: 3,
      baselinePrediction: 0,
      correctedPrediction: 2,
      closingHomeLine: 1,
      clusterKey: 'x'
    },
    {
      gameId: 'b',
      season: 2023,
      actual: 0,
      baselinePrediction: 2,
      correctedPrediction: 1,
      closingHomeLine: 1,
      clusterKey: 'x'
    }
  ];
  const summary = summarizeCfbPredictions(predictions);
  assert.equal(summary.baselineMae, 2.5);
  assert.equal(summary.correctedMae, 1);
  assert.equal(summary.closingMae, 1.5);
  assert.equal(summary.movement.sameDirectionRate, 1);
  assert.ok(summary.perSeason[2023]);
});

test('cluster bootstrap is deterministic, cluster-preserving, and positive-control aware', () => {
  const predictions = [
    { gameId: 'a', actual: 1, baselinePrediction: 0, correctedPrediction: 1, clusterKey: 'one' },
    { gameId: 'b', actual: 1, baselinePrediction: 0, correctedPrediction: 1, clusterKey: 'one' },
    { gameId: 'c', actual: 0, baselinePrediction: 1, correctedPrediction: 0, clusterKey: 'two' },
    { gameId: 'd', actual: 0, baselinePrediction: 1, correctedPrediction: 0, clusterKey: 'two' }
  ];
  const first = bootstrapMaeImprovements(predictions, { iterations: 25, seed: 9 });
  assert.deepEqual(first, bootstrapMaeImprovements(predictions, { iterations: 25, seed: 9 }));
  assert.ok(first.every((value) => value > 0));
  const summary = clusterBootstrapMae(predictions, { iterations: 25, seed: 9 });
  assert.equal(summary.improvedFraction, 1);
  assert.equal(summary.profitableFraction, 1);
  assert.throws(() => clusterBootstrapMae(predictions.map((row) => ({ ...row, clusterKey: undefined }))), /clusterKey/);
});
