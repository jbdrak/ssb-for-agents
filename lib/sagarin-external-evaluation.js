'use strict';

/**
 * Sagarin adapter for the external-ratings benchmark layer.
 *
 * The generic normalize/score/segment machinery lives in
 * `ssb-external-ratings-evaluation.js`; this module only supplies the
 * Sagarin-specific vocabulary (the FBS/FCS segment resolver).
 */

const { normalizeEvaluationRows, scoreRatingRows, segmentRatingRows } = require('./ssb-external-ratings-evaluation');

function resolveSagarinSegment(value) {
  const segment = typeof value === 'string' ? value.toUpperCase() : '';
  return segment === 'FBS' || segment === 'FCS' ? segment : 'other';
}

const SAGARIN_OPTIONS = { segments: ['segment'], resolveSegment: resolveSagarinSegment };

function normalizeSagarinRows(rows) {
  return normalizeEvaluationRows(rows, SAGARIN_OPTIONS);
}

function scoreSagarinRows(rows) {
  return scoreRatingRows(rows, SAGARIN_OPTIONS);
}

function segmentSagarinRows(rows, opts = {}) {
  return segmentRatingRows(rows, { ...SAGARIN_OPTIONS, ...opts });
}

module.exports = { normalizeSagarinRows, scoreSagarinRows, segmentSagarinRows };
