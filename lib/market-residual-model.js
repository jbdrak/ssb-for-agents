'use strict';

/**
 * @typedef {{gameId: string|number, baseline: number, outcome: number, features: Array<number|null|undefined>, [key: string]: unknown}} ResidualRow
 * @typedef {{intercept: number, coefficients: number[], featureMeans: number[], featureScales: number[], activeFeatures: boolean[], ridge: number, trainingGameIds: Array<string|number>, trainingGroups: unknown[]}} ResidualModel
 * @typedef {{gameId: string|number, group: unknown, season: unknown, actual: number, baselinePrediction: number, correctedPrediction: number, fitMetadata: ResidualModel}} PredictionRow
 */

/**
 * Validate the shape and finite-value contract for residual rows.
 * @param {unknown} rows
 * @returns {asserts rows is ResidualRow[]}
 */
function assertValidRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('At least one residual row is required');
  let featureCount;
  rows.forEach((row, rowIndex) => {
    const label = row && typeof row === 'object' && 'gameId' in row ? `row/game ${row.gameId}` : `row ${rowIndex}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label} must be an object`);
    if (
      (typeof row.gameId !== 'string' && typeof row.gameId !== 'number') ||
      row.gameId === '' ||
      (typeof row.gameId === 'number' && !Number.isFinite(row.gameId))
    ) {
      throw new Error(`${label} must have a nonempty string or finite number gameId`);
    }
    if (!Number.isFinite(row.baseline)) throw new Error(`${label} has a non-finite baseline`);
    if (!Number.isFinite(row.outcome)) throw new Error(`${label} has a non-finite outcome`);
    if (!Array.isArray(row.features)) throw new Error(`${label} must have a features array`);
    if (featureCount === undefined) featureCount = row.features.length;
    if (row.features.length !== featureCount) throw new Error(`${label} has inconsistent feature vector length`);
    row.features.forEach((value, featureIndex) => {
      if (value !== null && value !== undefined && !Number.isFinite(value)) {
        throw new Error(`${label} has invalid feature ${featureIndex}; expected a finite number or null/undefined`);
      }
    });
  });
}

/**
 * Validate that a pooled data set contains one row per game.
 * @param {ResidualRow[]} rows
 */
function assertUniqueGameIds(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.gameId)) throw new Error(`Duplicate gameId in residual rows: ${row.gameId}`);
    seen.add(row.gameId);
  }
}

/** @param {number[]} values */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Solve a small dense linear system using Gaussian elimination.
 * @param {number[][]} matrix
 * @param {number[]} vector
 * @returns {number[]}
 */
function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  const matrixScale = Math.max(...matrix.flat().map((value) => Math.abs(value)), 0);
  const tolerance = Math.max(matrixScale, 1) * 1e-12;
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (!Number.isFinite(a[pivot][column]) || Math.abs(a[pivot][column]) <= tolerance) {
      throw new Error('Cannot fit residual model: singular or ill-conditioned normal-equation system');
    }
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = column + 1; row < n; row += 1) {
      const factor = a[row][column] / a[column][column];
      for (let value = column; value <= n; value += 1) a[row][value] -= factor * a[column][value];
    }
  }
  const solution = Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let remainder = a[row][n];
    for (let column = row + 1; column < n; column += 1) remainder -= a[row][column] * solution[column];
    solution[row] = remainder / a[row][row];
  }
  if (!solution.every(Number.isFinite)) throw new Error('Cannot fit residual model: non-finite solution');
  return solution;
}

/**
 * Fit a ridge model to outcome minus market baseline. The intercept is not
 * penalized, and means/scales are calculated from these rows only.
 * @param {ResidualRow[]} rows
 * @param {{ridge?: number, groupField?: string}} [options]
 * @returns {ResidualModel}
 */
function fitResidualModel(rows, options = {}) {
  assertValidRows(rows);
  assertUniqueGameIds(rows);
  const featureCount = rows[0].features.length;
  const ridge = options.ridge ?? 1;
  if (!Number.isFinite(ridge) || ridge < 0) throw new Error('ridge must be a finite non-negative number');

  const featureMeans = [];
  const featureScales = [];
  const activeFeatures = [];
  for (let feature = 0; feature < featureCount; feature += 1) {
    const observed = rows.map((row) => row.features[feature]).filter((value) => Number.isFinite(value));
    const featureMean = observed.length ? mean(observed) : 0;
    const variance = observed.length ? mean(observed.map((value) => (value - featureMean) ** 2)) : 0;
    const scale = Math.sqrt(variance);
    featureMeans.push(featureMean);
    featureScales.push(scale > Number.EPSILON ? scale : 1);
    activeFeatures.push(scale > Number.EPSILON);
  }

  const active = activeFeatures.map((isActive, index) => (isActive ? index : -1)).filter((index) => index >= 0);
  const design = rows.map((row) => [
    1,
    ...active.map((feature) => {
      const value = Number.isFinite(row.features[feature]) ? row.features[feature] : featureMeans[feature];
      return (value - featureMeans[feature]) / featureScales[feature];
    })
  ]);
  const targets = rows.map((row) => row.outcome - row.baseline);
  const width = design[0].length;
  const normal = Array.from({ length: width }, () => Array(width).fill(0));
  const rhs = Array(width).fill(0);
  for (let row = 0; row < design.length; row += 1) {
    for (let left = 0; left < width; left += 1) {
      rhs[left] += design[row][left] * targets[row];
      for (let right = 0; right < width; right += 1) normal[left][right] += design[row][left] * design[row][right];
    }
  }
  for (let diagonal = 1; diagonal < width; diagonal += 1) normal[diagonal][diagonal] += ridge;
  const standardized = solveLinearSystem(normal, rhs);
  const coefficients = Array(featureCount).fill(0);
  for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
    const feature = active[activeIndex];
    coefficients[feature] = standardized[activeIndex + 1] / featureScales[feature];
  }
  const intercept =
    standardized[0] - coefficients.reduce((sum, coefficient, feature) => sum + coefficient * featureMeans[feature], 0);
  if (!Number.isFinite(intercept) || !coefficients.every(Number.isFinite)) {
    throw new Error('Cannot fit residual model: non-finite coefficients or intercept');
  }

  return {
    intercept,
    coefficients,
    featureMeans,
    featureScales,
    activeFeatures,
    ridge,
    trainingGameIds: rows.map((row) => row.gameId),
    trainingGroups: [...new Set(rows.map((row) => (options.groupField ? row[options.groupField] : undefined)))]
  };
}

/** @param {ResidualModel} model @param {{baseline: number, features: Array<number|null|undefined>}} row @returns {number} */
function predictMarketResidual(model, row) {
  if (!row || typeof row !== 'object') throw new Error('Prediction row must be an object');
  if (!Number.isFinite(row.baseline)) throw new Error('Prediction baseline must be finite');
  if (!Array.isArray(row.features) || row.features.length !== model.coefficients.length) {
    throw new Error(`Prediction feature vector length must be ${model.coefficients.length}`);
  }
  row.features.forEach((value, featureIndex) => {
    if (value !== null && value !== undefined && !Number.isFinite(value)) {
      throw new Error(`Prediction has invalid feature ${featureIndex}; expected a finite number or null/undefined`);
    }
  });
  const residual =
    model.intercept +
    model.coefficients.reduce((sum, coefficient, feature) => {
      const value = Number.isFinite(row.features[feature]) ? row.features[feature] : model.featureMeans[feature];
      return sum + coefficient * value;
    }, 0);
  const prediction = row.baseline + residual;
  if (!Number.isFinite(prediction)) throw new Error('Prediction is non-finite');
  return prediction;
}

/**
 * Produce one prediction per row, fitting on all other groups.
 * @param {ResidualRow[]} rows
 * @param {{groupField?: string, ridge?: number}} [options]
 * @returns {PredictionRow[]}
 */
function leaveOneGroupOutPredictions(rows, options = {}) {
  assertValidRows(rows);
  assertUniqueGameIds(rows);
  const groupField = options.groupField || 'group';
  const groups = new Map();
  for (const row of rows) {
    const group = row[groupField];
    if (group === null || group === undefined || (typeof group === 'number' && !Number.isFinite(group))) {
      throw new Error(`Invalid held-out group: ${group}`);
    }
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  const models = new Map();
  for (const group of groups.keys()) {
    const training = rows.filter((candidate) => candidate[groupField] !== group);
    if (training.length === 0) throw new Error(`Cannot fit held-out group with no training rows: ${group}`);
    models.set(group, fitResidualModel(training, { ridge: options.ridge, groupField }));
  }
  return rows.map((row) => {
    const model = models.get(row[groupField]);
    return {
      gameId: row.gameId,
      group: row[groupField],
      season: row.season,
      actual: row.outcome,
      baselinePrediction: row.baseline,
      correctedPrediction: predictMarketResidual(model, row),
      fitMetadata: model
    };
  });
}

/**
 * Compare mean absolute errors for baseline and corrected predictions.
 * @param {Array<{actual: number, baselinePrediction: number, correctedPrediction: number}>} rows
 */
function compareMae(rows) {
  if (!rows.length) throw new Error('At least one prediction row is required');
  const absoluteError = (key) => rows.reduce((sum, row) => sum + Math.abs(row.actual - row[key]), 0) / rows.length;
  const baselineMae = absoluteError('baselinePrediction');
  const correctedMae = absoluteError('correctedPrediction');
  return { baselineMae, correctedMae, improvement: baselineMae - correctedMae };
}

module.exports = {
  assertUniqueGameIds,
  fitResidualModel,
  predictMarketResidual,
  leaveOneGroupOutPredictions,
  compareMae
};
