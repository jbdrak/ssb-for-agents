'use strict';

/**
 * Source-agnostic evaluation machinery for external ratings benchmark rows.
 *
 * The generic normalize -> score -> segment pipeline lives here so each source
 * adapter (Sagarin, Massey, Sasser) only supplies its own vocabulary through
 * options. The underlying scorers stay in `ssb-backtest-metrics.js` and
 * `record-evaluation.js`; this module only adapts rows into their shape.
 */

const { scoreEvaluationRows, computeBacktestMetrics } = require('./ssb-backtest-metrics');
const { segmentEvaluationRows } = require('./record-evaluation');
const { ATTACH_MAX_AGE_DAYS, isBefore, staleCutoff } = require('./ssb-ratings-recency');

const WIN = new Set(['win', 'won']);
const LOSS = new Set(['loss', 'lost']);

const DEFAULT_SEGMENTS = ['segment'];
const DEFAULT_METRICS = ['modelWinProbability'];
const DEFAULT_PROBABILITY_FIELD = 'modelWinProbability';

function outcomeOf(value) {
  if (typeof value !== 'string') return null;
  const valueLower = value.toLowerCase();
  if (WIN.has(valueLower)) return 'win';
  if (LOSS.has(valueLower)) return 'loss';
  return valueLower === 'push' ? 'push' : null;
}

function timestampMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fallback segment resolver: uppercase the raw label, unknown -> 'other'.
 * Sources with a closed vocabulary supply their own resolver.
 * @param {unknown} value
 * @returns {string}
 */
function defaultResolveSegment(value) {
  if (typeof value !== 'string') return 'other';
  const segment = value.trim().toUpperCase();
  return segment === '' ? 'other' : segment;
}

function resolveOptions(opts = {}) {
  const segments = Array.isArray(opts.segments) && opts.segments.length ? opts.segments : DEFAULT_SEGMENTS;
  const resolveSegment = typeof opts.resolveSegment === 'function' ? opts.resolveSegment : defaultResolveSegment;
  const probabilityField = opts.probabilityField || DEFAULT_PROBABILITY_FIELD;
  return { segments, resolveSegment, probabilityField };
}

function normalizeEvaluationRow(raw, index, options) {
  const { segments, resolveSegment, probabilityField } = options;

  const row = { index, outcome: null };
  for (const field of segments) {
    row[field] = resolveSegment(raw && typeof raw === 'object' ? raw[field] : undefined);
  }

  if (!raw || typeof raw !== 'object') {
    row.status = 'unresolved';
    row.unresolvedReason = 'not-an-object';
    return row;
  }

  const outcome = outcomeOf(raw.outcome);
  // Recorded decision provenance, in precedence order. Ledger evaluation rows
  // carry `decisionTimestamp`/`capturedAt` rather than a `predictionTimestamp`,
  // and a row with a recorded decision time is usable evidence, not a defect.
  const predictionTimestamp = raw.predictionTimestamp ?? raw.sourceTimestamp ?? raw.decisionTimestamp ?? raw.capturedAt;
  const sourceTimestamp = raw.sourceTimestamp;
  const predictionMs = timestampMs(predictionTimestamp);
  const referenceMs = timestampMs(raw.gameTimestamp ?? raw.settledAt);

  row.outcome = outcome;
  row.predictionTimestamp = predictionTimestamp;
  row.sourceTimestamp = sourceTimestamp;

  if (typeof raw[probabilityField] === 'number' && raw[probabilityField] >= 0 && raw[probabilityField] <= 1) {
    row[probabilityField] = raw[probabilityField];
  }

  const explicitlyUnmatched = raw.matched === false || raw.status === 'unmatched';

  let unresolvedReason = null;
  if (outcome === null) {
    // "No outcome" is normally unusable, but it is also exactly what an
    // explicitly unmatched row looks like: it was never joined to a verified
    // result, so it belongs in the excluded `unmatched` bucket rather than the
    // `unresolved` data-defect bucket. It still never scores as a loss.
    if (!explicitlyUnmatched) unresolvedReason = 'unknown-outcome';
  } else if (predictionMs === null) {
    unresolvedReason = predictionTimestamp == null ? 'missing-provenance' : 'invalid-provenance';
  } else if (referenceMs !== null && predictionMs > referenceMs) {
    unresolvedReason = 'stale-post-decision-prediction';
  } else if (referenceMs !== null && isBefore(predictionTimestamp, staleCutoff(referenceMs, ATTACH_MAX_AGE_DAYS))) {
    // A snapshot whose own date sits far behind the game it would predict is not
    // evidence about that game - the teams have played a season since. Same
    // recency rule (and window) as the attach path in `ssb-ratings-overlay`, so
    // a record the overlay withholds can never be scored here instead. Only
    // judged when the row carries a game reference; with none there is nothing
    // to gate against, and that stays the pre-existing relaxed case.
    unresolvedReason = 'stale-snapshot';
  }

  if (unresolvedReason) {
    row.status = 'unresolved';
    row.unresolvedReason = unresolvedReason;
  } else if (explicitlyUnmatched) {
    row.status = 'unmatched';
  } else {
    row.status = 'matched';
  }
  return row;
}

/**
 * Normalize raw adapter rows into the shared scoring shape.
 * @param {Array<Object>} rows
 * @param {{segments?: string[], resolveSegment?: Function, probabilityField?: string}} [opts]
 * @returns {{rows: Array<Object>, unresolved: Array<Object>}}
 */
function normalizeEvaluationRows(rows, opts = {}) {
  const options = resolveOptions(opts);
  const normalized = (Array.isArray(rows) ? rows : []).map((raw, index) => normalizeEvaluationRow(raw, index, options));
  normalized.sort((a, b) => {
    const aMs = timestampMs(a.predictionTimestamp);
    const bMs = timestampMs(b.predictionTimestamp);
    if (aMs === null && bMs === null) return a.index - b.index;
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    return aMs - bMs;
  });
  return { rows: normalized, unresolved: normalized.filter((row) => row.status === 'unresolved') };
}

function eligibleRows(rows) {
  return rows.filter((row) => row.status === 'matched' && (row.outcome === 'win' || row.outcome === 'loss'));
}

function countRows(rows) {
  return {
    total: rows.length,
    resolved: rows.filter((row) => row.status === 'matched' && (row.outcome === 'win' || row.outcome === 'loss'))
      .length,
    unresolved: rows.filter((row) => row.status === 'unresolved').length,
    unmatched: rows.filter((row) => row.status === 'unmatched').length,
    pushed: rows.filter((row) => row.status === 'matched' && row.outcome === 'push').length
  };
}

/**
 * Score normalized rows with the shared Brier/log-loss/reliability scorer.
 * @param {Array<Object>} rows
 * @param {{segments?: string[], resolveSegment?: Function, probabilityField?: string, metrics?: string[]}} [opts]
 * @returns {{scores: Object, counts: Object}}
 */
function scoreRatingRows(rows, opts = {}) {
  const normalized = normalizeEvaluationRows(rows, opts).rows;
  const metrics = Array.isArray(opts.metrics) && opts.metrics.length ? opts.metrics : DEFAULT_METRICS;
  return {
    scores: scoreEvaluationRows(eligibleRows(normalized), metrics),
    counts: countRows(normalized)
  };
}

/**
 * Segment normalized rows by arbitrary dimensions (default: the segments list).
 * @param {Array<Object>} rows
 * @param {{segments?: string[], resolveSegment?: Function, probabilityField?: string, dimensions?: string[], minSample?: number}} [opts]
 * @returns {Object}
 */
function segmentRatingRows(rows, opts = {}) {
  const options = resolveOptions(opts);
  const normalized = normalizeEvaluationRows(rows, opts).rows;
  const dimensions = Array.isArray(opts.dimensions) && opts.dimensions.length ? opts.dimensions : options.segments;
  const segmented = segmentEvaluationRows(eligibleRows(normalized), {
    dimensions,
    ...(Number.isInteger(opts.minSample) ? { minSample: opts.minSample } : {})
  });
  return { ...segmented, counts: countRows(normalized) };
}

// ---------------------------------------------------------------------------
// Per-source evaluation (card 11)
//
// Each source is scored entirely on its own. There is deliberately no composite
// block: the Fair & Oster result is that computer rankings add nothing on top of
// the Vegas spread, so a blended number would hide which source carries the
// signal. `unresolved` and `unmatched` rows are excluded from every denominator
// (they never enter `scoreRatingRows`' eligible set or `segmentRatingRows`), and
// a source with zero resolved rows reports sample 0 with NO score block rather
// than a fabricated 0.5.
// ---------------------------------------------------------------------------

const DEFAULT_EVALUATION_DIMENSIONS = Object.freeze(['league', 'level', 'favoriteBand', 'market']);

// Bands of the PREDICTED favorite's win probability (the row's own model
// probability for the side it picked), not the market price. Ordered high -> low.
const FAVORITE_BANDS = Object.freeze([
  { min: 0.7, label: 'heavy' },
  { min: 0.6, label: 'moderate' },
  { min: 0.5, label: 'slight' }
]);

const UNKNOWN_SOURCE = 'unknown';

/**
 * Band a model probability into its favorite band. Unknown/non-finite -> unknown.
 * @param {unknown} probability
 * @returns {string}
 */
function favoriteBandOf(probability) {
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return 'unknown';
  if (probability < 0.5) return 'underdog';
  for (const band of FAVORITE_BANDS) {
    if (probability >= band.min) return band.label;
  }
  return 'underdog';
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Fill the derived segment dimensions a raw row may not carry yet. Never
 * mutates the input: `level` falls back to the Sagarin `segment` vocabulary,
 * `favoriteBand` is derived from the row's own MODEL probability, and
 * `marketFavoriteBand` is resolved from market input only (never the model).
 * @param {Object} row
 * @param {string} probabilityField
 * @returns {Object}
 */
function deriveEvaluationRow(row, probabilityField) {
  if (!row || typeof row !== 'object') return row;
  const derived = { ...row };
  if (!hasValue(derived.level) && hasValue(derived.segment)) derived.level = derived.segment;
  if (!hasValue(derived.favoriteBand)) derived.favoriteBand = favoriteBandOf(derived[probabilityField]);
  // Keyed on the BASIS rather than the band so a row that already carries an
  // explicit `marketFavoriteBand` keeps it (and is recorded as explicit), while
  // re-deriving an already-derived row stays idempotent.
  if (!hasValue(derived.marketFavoriteBandBasis)) {
    const market = resolveMarketFavorite(derived);
    derived.marketFavoriteBand = market.band;
    derived.marketFavoriteBandBasis = market.basis;
  }
  return derived;
}

function rowsFromEnvelope(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.rows)) return value.rows;
    if (Array.isArray(value.records)) return value.records;
    if (Array.isArray(value.plays)) return value.plays;
  }
  return null;
}

/**
 * Group evaluation rows by source without ever merging two sources' rows.
 * Accepts a source-keyed map (`{ sagarin: [...], massey: [...] }`), an array of
 * `{ source, rows|records|plays }` envelopes, or a flat row list where each row
 * carries its own `source`.
 * @param {unknown} input
 * @returns {Map<string, Array<Object>>}
 */
function groupRowsBySource(input) {
  const groups = new Map();
  const add = (source, rows) => {
    const key = typeof source === 'string' && source.trim() !== '' ? source : UNKNOWN_SOURCE;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...rows);
  };

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const enveloped = rowsFromEnvelope(item);
      if (enveloped !== null && typeof item.source === 'string') {
        add(item.source, enveloped);
      } else {
        add(typeof item.source === 'string' ? item.source : UNKNOWN_SOURCE, [item]);
      }
    }
    return groups;
  }

  if (input && typeof input === 'object') {
    for (const [source, value] of Object.entries(input)) {
      const rows = rowsFromEnvelope(value);
      if (rows !== null) add(source, rows);
    }
  }
  return groups;
}

/**
 * Score and segment one source's rows. `coverage` (which carries `sampleSize`)
 * is built before `scores`; both are needed to read the score honestly.
 * @param {Array<Object>} rows
 * @param {Object} options
 * @returns {{coverage: Object, scores: Object, segments: Object, dimensions: string[], marketRelative: Object}}
 */
function evaluateRatingSource(rows, options) {
  const {
    dimensions,
    resolveSegment,
    probabilityField,
    metrics,
    minSample,
    marketDimensions,
    marketMinSample,
    splitFraction
  } = options;
  const prepared = (Array.isArray(rows) ? rows : []).map((row) => deriveEvaluationRow(row, probabilityField));
  const shared = { segments: dimensions, resolveSegment, probabilityField };

  const { scores, counts } = scoreRatingRows(prepared, { ...shared, metrics });

  // Coverage first: a sample size must be visible before any score is read.
  const coverage = {
    total: counts.total,
    resolved: counts.resolved,
    unmatched: counts.unmatched,
    unresolved: counts.unresolved,
    pushed: counts.pushed,
    sampleSize: counts.resolved,
    resolvedRate: counts.total > 0 ? counts.resolved / counts.total : 0
  };

  const segmented = segmentRatingRows(prepared, {
    ...shared,
    dimensions,
    ...(minSample === undefined ? {} : { minSample })
  });

  const marketRelative = evaluateMarketRelative(prepared, {
    probabilityField,
    resolveSegment,
    dimensions: marketDimensions,
    minSample: marketMinSample,
    splitFraction
  });

  return { coverage, scores, segments: segmented.segments, dimensions: segmented.dimensions, marketRelative };
}

function resolveEvaluationOptions(opts = {}) {
  const base = resolveOptions(opts);
  return {
    dimensions:
      Array.isArray(opts.dimensions) && opts.dimensions.length ? opts.dimensions : [...DEFAULT_EVALUATION_DIMENSIONS],
    resolveSegment: base.resolveSegment,
    probabilityField: base.probabilityField,
    metrics: Array.isArray(opts.metrics) && opts.metrics.length ? opts.metrics : DEFAULT_METRICS,
    minSample: Number.isInteger(opts.minSample) ? opts.minSample : undefined,
    marketDimensions:
      Array.isArray(opts.marketDimensions) && opts.marketDimensions.length
        ? opts.marketDimensions
        : [...DEFAULT_MARKET_DIMENSIONS],
    marketMinSample: Number.isInteger(opts.marketMinSample) ? opts.marketMinSample : DEFAULT_MARKET_MIN_SAMPLE,
    splitFraction: Number.isFinite(opts.splitFraction) ? opts.splitFraction : DEFAULT_SPLIT_FRACTION
  };
}

/**
 * Evaluate multiple sources independently.
 * @param {unknown} input Source-keyed map, envelope list, or flat row list.
 * @param {{dimensions?: string[], resolveSegment?: Function, probabilityField?: string, metrics?: string[], minSample?: number, marketDimensions?: string[], marketMinSample?: number, splitFraction?: number}} [opts]
 * @returns {{dimensions: string[], bandSemantics: Object, sources: Object<string, Object>}}
 */
function evaluateRatingSources(input, opts = {}) {
  const options = resolveEvaluationOptions(opts);
  const sources = {};
  for (const [source, rows] of groupRowsBySource(input)) {
    sources[source] = { source, ...evaluateRatingSource(rows, options) };
  }
  return { dimensions: options.dimensions, bandSemantics: BAND_SEMANTICS, sources };
}

// ---------------------------------------------------------------------------
// Market-relative comparison gate (card 12)
//
// The gate that decides whether a source is worth anything at all. Each source's
// probability is compared against the DE-VIGGED closing line, never a raw price:
// `marketFairProbability` is the repo's explicit-only fair close, and a row that
// carries none is banded `unknown` and kept out of every denominator rather than
// letting the model's own probability stand in for a market price.
//
// The favourite-size band therefore comes from market input, while `favoriteBand`
// (card 11) remains a MODEL-CONFIDENCE band. `BAND_SEMANTICS` names both, so no
// reader has to guess which question a band answers.
//
// Honest baseline: Fair & Oster found computer rankings add no information on top
// of the Vegas spread. The expected value here is context, confirmation and veto.
// A source's hit rate is not a betting edge, and no field may present one as
// profitable.
// ---------------------------------------------------------------------------

const MARKET_PROBABILITY_FIELD = 'marketFairProbability';
const DEFAULT_MARKET_DIMENSIONS = Object.freeze(['marketFavoriteBand']);
// Mirrors `record-evaluation`'s DEFAULT_MIN_SAMPLE: below this, report no number.
const DEFAULT_MARKET_MIN_SAMPLE = 30;
const DEFAULT_SPLIT_FRACTION = 0.5;

const BAND_SEMANTICS = Object.freeze({
  favoriteBand: 'model_confidence',
  marketFavoriteBand: 'market_favourite_size'
});

const MARKET_RELATIVE_BASELINE =
  'Fair & Oster: computer ratings add no information on top of the Vegas spread. ' +
  'Expected value here is context, confirmation and veto - not edge. A source hit rate is not a betting edge.';

const MARKET_INTERPRETATION = 'context_confirmation_veto';

const MARKET_BAND_BASIS = Object.freeze({
  explicit: 'explicit',
  favoriteProbability: 'marketFavoriteProbability',
  fairClose: MARKET_PROBABILITY_FIELD,
  unknown: 'unknown'
});

function isProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function favoriteSizeOf(probability) {
  return Math.max(probability, 1 - probability);
}

function marketBandForFavoriteSize(size) {
  if (size >= 0.7) return 'heavy';
  if (size >= 0.6) return 'moderate';
  return 'slight';
}

/**
 * Resolve a row's MARKET favourite-size band. An explicit band wins, then a
 * recorded market favourite probability, then the recorded de-vigged close. A
 * row with none of those is `unknown`: the model's own probability is never
 * allowed to fill this slot.
 * @param {any} row
 * @returns {{band: string, basis: string}}
 */
function resolveMarketFavorite(row) {
  if (!row || typeof row !== 'object') return { band: 'unknown', basis: MARKET_BAND_BASIS.unknown };
  if (typeof row.marketFavoriteBand === 'string' && row.marketFavoriteBand.trim() !== '') {
    return { band: row.marketFavoriteBand.trim(), basis: MARKET_BAND_BASIS.explicit };
  }
  if (isProbability(row.marketFavoriteProbability)) {
    return {
      band: marketBandForFavoriteSize(favoriteSizeOf(row.marketFavoriteProbability)),
      basis: MARKET_BAND_BASIS.favoriteProbability
    };
  }
  if (isProbability(row[MARKET_PROBABILITY_FIELD])) {
    return {
      band: marketBandForFavoriteSize(favoriteSizeOf(row[MARKET_PROBABILITY_FIELD])),
      basis: MARKET_BAND_BASIS.fairClose
    };
  }
  return { band: 'unknown', basis: MARKET_BAND_BASIS.unknown };
}

function isMarketComparable(row, probabilityField) {
  return (
    Boolean(row) &&
    row.status === 'matched' &&
    (row.outcome === 'win' || row.outcome === 'loss') &&
    isProbability(row[probabilityField]) &&
    isProbability(row[MARKET_PROBABILITY_FIELD])
  );
}

function priceOddsOf(row) {
  const closing = finiteNumber(row.closingOdds);
  if (closing !== null && closing !== 0) return closing;
  const decision = finiteNumber(row.odds);
  return decision !== null && decision !== 0 ? decision : null;
}

function americanToDecimal(odds) {
  if (typeof odds !== 'number' || !Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

/**
 * Unit-stake bets on the rows where the model's own probability says the recorded
 * price is a positive-EV bet. Profit settles against the real outcome, so a source
 * that is better calibrated than the close can still post a losing ROI - that is
 * the honest answer, not a defect.
 */
function marketBets(rows, probabilityField) {
  const bets = [];
  let pricedRows = 0;
  for (const row of rows) {
    const odds = priceOddsOf(row);
    if (odds === null) continue;
    pricedRows += 1;
    const decimal = americanToDecimal(odds);
    if (decimal === null || !(row[probabilityField] * decimal - 1 > 0)) continue;
    bets.push({ odds, stake: 1, result: row.outcome === 'win' ? 'won' : 'lost' });
  }
  return { bets, pricedRows };
}

function marketMetrics(rows, probabilityField, minSample) {
  const sampleSize = rows.length;
  if (sampleSize < minSample) return { status: 'insufficient_sample', sampleSize };
  const { bets, pricedRows } = marketBets(rows, probabilityField);
  const metrics = computeBacktestMetrics(bets);
  const edge = rows.reduce((sum, row) => sum + (row[probabilityField] - row[MARKET_PROBABILITY_FIELD]), 0);
  return {
    status: 'ok',
    sampleSize,
    wins: rows.filter((row) => row.outcome === 'win').length,
    losses: rows.filter((row) => row.outcome === 'loss').length,
    roiSampleSize: pricedRows,
    bets: metrics.bets,
    // Mean (model - de-vigged close) in probability points: the model's CLV
    // against the fair close. Positive means the model is more confident than
    // the market, which is a disagreement, not a proven edge.
    clvPct: round2((edge / sampleSize) * 100),
    roi: metrics.roi,
    maxDrawdown: metrics.maxDrawdown,
    scores: scoreEvaluationRows(rows, [probabilityField, MARKET_PROBABILITY_FIELD])
  };
}

function marketSegments(rows, dimensions, probabilityField, minSample) {
  const groups = new Map();
  for (const row of rows) {
    const values = dimensions.map((dimension) => defaultResolveSegment(row[dimension]));
    const key = values.join('|');
    if (!groups.has(key)) groups.set(key, { values, rows: [] });
    groups.get(key).rows.push(row);
  }
  const segments = {};
  for (const [key, group] of groups) {
    const values = Object.fromEntries(dimensions.map((dimension, index) => [dimension, group.values[index]]));
    segments[key] = { values, ...marketMetrics(group.rows, probabilityField, minSample) };
  }
  return segments;
}

function countMarketBandSources(rows) {
  const counts = {};
  for (const row of rows) {
    if (!row || row.status !== 'matched') continue;
    if (row.outcome !== 'win' && row.outcome !== 'loss') continue;
    const basis =
      typeof row.marketFavoriteBandBasis === 'string' ? row.marketFavoriteBandBasis : MARKET_BAND_BASIS.unknown;
    counts[basis] = (counts[basis] || 0) + 1;
  }
  return counts;
}

/**
 * Score one source's rows against the de-vigged closing line.
 * @param {Array<Object>} rows Raw or already-derived rows.
 * @param {{dimensions?: string[], probabilityField?: string, resolveSegment?: Function, minSample?: number, splitFraction?: number}} [opts]
 * @returns {Object} `insufficient_sample` with no metrics below `minSample`; otherwise CLV/ROI/drawdown alongside Brier/log loss, a chronological split, and per-band segments.
 */
function evaluateMarketRelative(rows, opts = {}) {
  const probabilityField = opts.probabilityField || DEFAULT_PROBABILITY_FIELD;
  const dimensions =
    Array.isArray(opts.dimensions) && opts.dimensions.length ? opts.dimensions : [...DEFAULT_MARKET_DIMENSIONS];
  const resolveSegment = typeof opts.resolveSegment === 'function' ? opts.resolveSegment : defaultResolveSegment;
  const minSample = Number.isInteger(opts.minSample) && opts.minSample > 0 ? opts.minSample : DEFAULT_MARKET_MIN_SAMPLE;
  const fraction =
    Number.isFinite(opts.splitFraction) && opts.splitFraction > 0 && opts.splitFraction < 1
      ? opts.splitFraction
      : DEFAULT_SPLIT_FRACTION;

  const prepared = (Array.isArray(rows) ? rows : []).map((row) => deriveEvaluationRow(row, probabilityField));
  const normalized = normalizeEvaluationRows(prepared, { segments: dimensions, resolveSegment, probabilityField }).rows;
  // `normalizeEvaluationRows` whitelists only the fields named in `segments`, so
  // the recorded market inputs and the resolved band basis are re-joined onto the
  // normalized row by its original index.
  const joined = normalized.map((row) => ({ ...prepared[row.index], ...row }));
  const comparable = joined.filter((row) => isMarketComparable(row, probabilityField));

  const block = {
    dimensions,
    marketInput: MARKET_PROBABILITY_FIELD,
    marketFavoriteBandSource: countMarketBandSources(joined),
    bandSemantics: BAND_SEMANTICS,
    interpretation: MARKET_INTERPRETATION,
    baseline: MARKET_RELATIVE_BASELINE,
    minSample
  };

  if (comparable.length < minSample) {
    return { status: 'insufficient_sample', reason: 'below_min_sample', sampleSize: comparable.length, ...block };
  }

  // Chronological split only: `normalizeEvaluationRows` orders by resolved
  // prediction time, so the split is positional on that order - never shuffled.
  const splitIndex = Math.floor(comparable.length * fraction);
  return {
    status: 'ok',
    reason: null,
    ...block,
    ...marketMetrics(comparable, probabilityField, minSample),
    split: {
      fraction,
      inSample: marketMetrics(comparable.slice(0, splitIndex), probabilityField, minSample),
      outOfSample: marketMetrics(comparable.slice(splitIndex), probabilityField, minSample)
    },
    segments: marketSegments(comparable, dimensions, probabilityField, minSample)
  };
}

module.exports = {
  normalizeEvaluationRows,
  scoreRatingRows,
  segmentRatingRows,
  evaluateRatingSources,
  evaluateMarketRelative,
  favoriteBandOf,
  DEFAULT_EVALUATION_DIMENSIONS,
  DEFAULT_MARKET_DIMENSIONS,
  DEFAULT_MARKET_MIN_SAMPLE,
  MARKET_PROBABILITY_FIELD,
  MARKET_RELATIVE_BASELINE,
  BAND_SEMANTICS
};
