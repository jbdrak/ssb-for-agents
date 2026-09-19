'use strict';

const { assertUniqueGameIds, fitResidualModel, predictMarketResidual, compareMae } = require('./market-residual-model');

const FEATURE_NAMES = Object.freeze([
  'epaMatchup',
  'successMatchup',
  'explosiveMatchup',
  'defHavocDiff',
  'offHavocAllowedDiff',
  'earlyDownEpaDiff',
  'passingDownEpaDiff',
  'earlyDownPassRateDiff',
  'sackRateAllowedDiff',
  'turnoverRateDiff',
  'finishingDrivesDiff',
  'paceDiff',
  'neutralSite',
  'experienceMin'
]);

const finite = (value) => (Number.isFinite(value) ? value : null);
const difference = (left, right) => (Number.isFinite(left) && Number.isFinite(right) ? left - right : null);
const matchup = (homeOff, awayDef, awayOff, homeDef) =>
  Number.isFinite(homeOff) && Number.isFinite(awayDef) && Number.isFinite(awayOff) && Number.isFinite(homeDef)
    ? homeOff - awayDef - awayOff + homeDef
    : null;

function rowFeatures(row) {
  return row && row.features && typeof row.features === 'object' ? row.features : row || {};
}

function makeCfbFeatureVector(row) {
  const f = rowFeatures(row);
  const neutral = row && row.neutralSite !== undefined ? row.neutralSite : f.neutralSite;
  const neutralSite = neutral === true || neutral === 1 ? 1 : 0;
  return [
    matchup(f.homeOffEpa, f.awayDefEpaAllowed, f.awayOffEpa, f.homeDefEpaAllowed),
    matchup(f.homeOffSuccess, f.awayDefSuccessAllowed, f.awayOffSuccess, f.homeDefSuccessAllowed),
    matchup(f.homeOffExplosive, f.awayDefExplosiveAllowed, f.awayOffExplosive, f.homeDefExplosiveAllowed),
    difference(f.homeDefHavoc, f.awayDefHavoc),
    difference(f.homeOffHavocAllowed, f.awayOffHavocAllowed),
    difference(f.homeEarlyDownEpa, f.awayEarlyDownEpa),
    difference(f.homePassingDownEpa, f.awayPassingDownEpa),
    difference(f.homeEarlyDownPassRate, f.awayEarlyDownPassRate),
    difference(f.homeSackRateAllowed, f.awaySackRateAllowed),
    difference(f.homeTurnoverRate, f.awayTurnoverRate),
    difference(f.homeFinishingDrives, f.awayFinishingDrives),
    difference(f.homePace, f.awayPace),
    neutralSite,
    Number.isFinite(f.homeGamesObserved) && Number.isFinite(f.awayGamesObserved)
      ? Math.min(f.homeGamesObserved, f.awayGamesObserved)
      : null
  ];
}

function sundayWeekKey(startDate) {
  const timestamp = Date.parse(startDate);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const sunday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()));
  return sunday.toISOString().slice(0, 10);
}

function cfbClusterKey(season, startDate) {
  const week = sundayWeekKey(startDate);
  return week === null ? null : `${season}:${week}`;
}

function addExclusion(exclusions, reason) {
  exclusions[reason] = (exclusions[reason] || 0) + 1;
}

function buildCfbResidualRows(extractedRows) {
  if (!Array.isArray(extractedRows)) throw new Error('extractedRows must be an array');
  const rows = [];
  const exclusions = {};
  const seen = new Set();
  for (const source of extractedRows) {
    const gameId = source && source.gameId;
    if (seen.has(gameId)) throw new Error(`Duplicate eligible or input gameId: ${gameId}`);
    seen.add(gameId);
    const reason =
      !source || (typeof gameId !== 'string' && typeof gameId !== 'number') || gameId === ''
        ? 'invalid_game_id'
        : !Number.isFinite(source.season) || !Number.isInteger(source.season)
          ? 'invalid_season'
          : typeof source.startDate !== 'string' || !Number.isFinite(Date.parse(source.startDate))
            ? 'invalid_start_date'
            : !Number.isFinite(source.openingHomeLine)
              ? 'missing_opening_home_line'
              : !Number.isFinite(source.margin)
                ? 'missing_margin'
                : makeCfbFeatureVector(source)
                      .slice(0, 3)
                      .some((value) => value === null)
                  ? 'missing_core_matchup_features'
                  : cfbClusterKey(source.season, source.startDate) === null
                    ? 'invalid_cluster_key'
                    : null;
    if (reason) {
      addExclusion(exclusions, reason);
      continue;
    }
    rows.push({
      gameId,
      season: source.season,
      startDate: source.startDate,
      baseline: source.openingHomeLine,
      outcome: source.margin,
      features: makeCfbFeatureVector(source),
      closingHomeLine: finite(source.closingHomeLine),
      clusterKey: cfbClusterKey(source.season, source.startDate)
    });
  }
  return { rows, exclusions };
}

function seasonsOf(rows) {
  return [...new Set(rows.map((row) => row.season))].sort((a, b) => a - b);
}

function selectRidgeChronologically(trainingRows, { candidates = [0.1, 1, 10, 100], defaultRidge = 10 } = {}) {
  if (!Array.isArray(trainingRows) || !trainingRows.length) return { ridge: defaultRidge, reason: 'no_training_rows' };
  const seasons = seasonsOf(trainingRows);
  if (seasons.length < 2) return { ridge: defaultRidge, reason: 'fewer_than_two_seasons' };
  const validCandidates = candidates.filter((ridge) => Number.isFinite(ridge) && ridge >= 0);
  if (!validCandidates.length) throw new Error('candidates must contain a finite non-negative ridge');
  const scores = [];
  for (const ridge of validCandidates) {
    const foldErrors = [];
    for (let index = 1; index < seasons.length; index += 1) {
      const validationSeason = seasons[index];
      const train = trainingRows.filter((row) => row.season < validationSeason);
      const validation = trainingRows.filter((row) => row.season === validationSeason);
      if (!train.length || !validation.length) continue;
      const model = fitResidualModel(train, { ridge, groupField: 'season' });
      for (const row of validation) foldErrors.push(Math.abs(row.outcome - predictMarketResidual(model, row)));
    }
    if (foldErrors.length) scores.push({ ridge, mae: foldErrors.reduce((a, b) => a + b, 0) / foldErrors.length });
  }
  if (!scores.length) return { ridge: defaultRidge, reason: 'no_valid_inner_folds' };
  scores.sort((a, b) => a.mae - b.mae || a.ridge - b.ridge);
  return { ridge: scores[0].ridge, scores, reason: 'selected' };
}

function expandingSeasonPredictions(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('At least one residual row is required');
  assertUniqueGameIds(rows);
  const seasons = seasonsOf(rows);
  if (seasons.length < 2) return [];
  const predictions = [];
  for (let index = 1; index < seasons.length; index += 1) {
    const season = seasons[index];
    const trainingRows = rows.filter((row) => row.season < season);
    const testRows = rows.filter((row) => row.season === season);
    if (!trainingRows.length) throw new Error(`Cannot fit season ${season}: no prior-season training rows`);
    const selection = selectRidgeChronologically(trainingRows, options);
    const ridge = selection.ridge ?? options.defaultRidge ?? 10;
    const model = fitResidualModel(trainingRows, { ridge, groupField: 'season' });
    for (const row of testRows) {
      predictions.push({
        gameId: row.gameId,
        season: row.season,
        startDate: row.startDate,
        actual: row.outcome,
        baselinePrediction: row.baseline,
        correctedPrediction: predictMarketResidual(model, row),
        closingHomeLine: finite(row.closingHomeLine),
        clusterKey: row.clusterKey,
        trainingSeasons: seasons.filter((candidate) => candidate < season),
        ridge,
        ridgeSelection: selection
      });
    }
  }
  const predictionIds = new Set();
  for (const prediction of predictions) {
    if (predictionIds.has(prediction.gameId))
      throw new Error(`Duplicate gameId in residual predictions: ${prediction.gameId}`);
    predictionIds.add(prediction.gameId);
  }
  return predictions;
}

function movementSummary(predictions) {
  const moved = predictions.filter(
    (row) => Number.isFinite(row.closingHomeLine) && row.closingHomeLine !== row.baselinePrediction
  );
  const directed = moved.filter((row) => row.correctedPrediction !== row.baselinePrediction);
  const sameDirection = directed.filter(
    (row) =>
      Math.sign(row.correctedPrediction - row.baselinePrediction) ===
      Math.sign(row.closingHomeLine - row.baselinePrediction)
  ).length;
  const mean = (key) =>
    moved.length ? moved.reduce((sum, row) => sum + Math.abs(row[key] - row.closingHomeLine), 0) / moved.length : null;
  return {
    movedCount: moved.length,
    correctionCount: directed.length,
    sameDirectionCount: sameDirection,
    sameDirectionRate: directed.length ? sameDirection / directed.length : null,
    meanOpeningToCloseDistance: mean('baselinePrediction'),
    meanCorrectedToCloseDistance: mean('correctedPrediction')
  };
}

function summarizeOne(predictions) {
  const summary = { ...compareMae(predictions), closingMae: null, movement: movementSummary(predictions) };
  const finiteClose = predictions.filter((row) => Number.isFinite(row.closingHomeLine));
  if (finiteClose.length)
    summary.closingMae =
      finiteClose.reduce((sum, row) => sum + Math.abs(row.actual - row.closingHomeLine), 0) / finiteClose.length;
  return summary;
}

function summarizeCfbPredictions(predictions) {
  if (!Array.isArray(predictions) || !predictions.length) throw new Error('At least one prediction row is required');
  const summary = { ...summarizeOne(predictions), perSeason: {} };
  for (const season of seasonsOf(predictions))
    summary.perSeason[season] = summarizeOne(predictions.filter((row) => row.season === season));
  return summary;
}

function seededRandom(seed) {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function bootstrapMaeImprovements(predictions, { iterations = 2000, seed = 1 } = {}) {
  if (!Array.isArray(predictions) || !predictions.length) throw new Error('predictions must be non-empty');
  if (!predictions.every((row) => row.clusterKey !== null && row.clusterKey !== undefined && row.clusterKey !== ''))
    throw new Error('Every prediction must have a clusterKey');
  if (!Number.isInteger(iterations) || iterations <= 0) throw new Error('iterations must be a positive integer');
  const groups = [
    ...new Map(
      predictions.map((row) => [
        row.clusterKey,
        predictions.filter((candidate) => candidate.clusterKey === row.clusterKey)
      ])
    ).values()
  ];
  const random = seededRandom(seed);
  const improvements = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    for (let draw = 0; draw < groups.length; draw += 1) sample.push(...groups[Math.floor(random() * groups.length)]);
    improvements.push(compareMae(sample).improvement);
  }
  return improvements;
}

function quantile(sorted, probability) {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function clusterBootstrapMae(predictions, options = {}) {
  const improvements = bootstrapMaeImprovements(predictions, options).sort((a, b) => a - b);
  return {
    p2_5: quantile(improvements, 0.025),
    median: quantile(improvements, 0.5),
    p97_5: quantile(improvements, 0.975),
    improvedFraction: improvements.filter((value) => value > 0).length / improvements.length,
    profitableFraction: improvements.filter((value) => value > 0).length / improvements.length,
    iterations: improvements.length
  };
}

module.exports = {
  FEATURE_NAMES,
  makeCfbFeatureVector,
  buildCfbResidualRows,
  sundayWeekKey,
  cfbClusterKey,
  selectRidgeChronologically,
  expandingSeasonPredictions,
  summarizeCfbPredictions,
  bootstrapMaeImprovements,
  clusterBootstrapMae
};
