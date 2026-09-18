'use strict';

/**
 * Gate shadow: what would the card gate have said about each candidate, and how did
 * each side actually do?
 *
 * WHY THIS EXISTS
 *
 * `beatTheCloseReport` measures the RAW SCAN. That population includes every play the
 * gate rejects, so a low beat-the-close rate there is not evidence the card is broken,
 * and a high one would not be evidence it works. Measuring the scan and calling it a
 * verdict on the card is the single easiest way to reach a confidently wrong conclusion.
 *
 * This report splits only the candidates that have a close-relative CLV by the gate's
 * own verdict, so the two rates are directly comparable:
 *
 *   gate-PASSED rows beating the close more often than gate-REJECTED rows is evidence
 *   the gate is doing something. No separation (or the reverse) is evidence it is not.
 *
 * Read-only and deterministic. Nothing is persisted, so it runs retroactively over rows
 * recorded long before anyone thought to ask this question — which is the only reason
 * the answer is available at all, since no gate verdict was ever recorded per candidate.
 */

const { priceGate, fairProbabilityOf, fairMarginPoints, expectedValuePct, DEFAULT_MIN_SAMPLE } = require('./card-gate');
const { DEFAULT_MAX_PLAUSIBLE_MARGIN_PCT } = require('./arb-scan');
const { wilsonInterval } = require('./record-metrics');

/**
 * The gate reads `marketFairProbability` / `consensusEdge` off the row it is handed,
 * but a recorded candidate keeps them inside `featureSnapshot`. Flatten the snapshot
 * under the row so the gate sees the same fields it would have seen at decision time.
 * The candidate's own top-level fields win, because those are what the card was built
 * from.
 *
 * @param {Object} candidate
 * @returns {Object}
 */
function candidateGateView(candidate) {
  const snapshot = candidate && typeof candidate.featureSnapshot === 'object' ? candidate.featureSnapshot : {};
  return { ...snapshot, ...candidate };
}

/**
 * Dedupe key matching `beatTheCloseReport`, so both reports count the same
 * observations and their numbers can be compared directly.
 *
 * @param {Object} candidate
 * @returns {string}
 */
function observationKey(candidate) {
  return [
    candidate.gameId || candidate.game || candidate.candidateId,
    candidate.market,
    candidate.selection,
    candidate.odds
  ]
    .map((value) =>
      String(value == null ? '' : value)
        .toLowerCase()
        .trim()
    )
    .join('|');
}

function summarise(list, minSample) {
  const beat = list.filter((row) => row.beat).length;
  const sample = list.length;
  return {
    sample,
    beat,
    rate: sample > 0 ? Number((beat / sample).toFixed(4)) : null,
    rateCi: sample > 0 ? wilsonInterval(beat, sample) : null,
    meanClvPct: sample > 0 ? Number((list.reduce((sum, row) => sum + row.clvPct, 0) / sample).toFixed(4)) : null,
    insufficientSample: sample < minSample
  };
}

/**
 * @param {Object} ledger
 * @param {Object} [opts] - { minSample, minEvPct, minFairMarginPts } forwarded to priceGate
 * @returns {Object}
 */
function gateShadowReport(ledger, opts = {}) {
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const seen = new Set();
  const rows = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    // Only rows with a real close-relative CLV can be graded at all.
    if (typeof candidate.clvPct !== 'number' || !Number.isFinite(candidate.clvPct)) continue;
    const key = observationKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);

    const gate = priceGate(candidateGateView(candidate), opts);
    rows.push({
      pass: gate.pass === true,
      reason: gate.reason || 'unknown',
      clvPct: candidate.clvPct,
      beat: candidate.clvPct > 0
    });
  }

  const passed = rows.filter((row) => row.pass);
  const rejected = rows.filter((row) => !row.pass);
  const byReason = {};
  for (const reason of new Set(rows.map((row) => row.reason))) {
    byReason[reason] = summarise(
      rows.filter((row) => row.reason === reason),
      minSample
    );
  }

  return {
    sample: rows.length,
    passed: summarise(passed, minSample),
    rejected: summarise(rejected, minSample),
    byReason,
    // The comparison is only meaningful once BOTH sides have enough rows to read.
    // A single closed candidate on one side is not a finding.
    insufficientSample: passed.length < minSample || rejected.length < minSample
  };
}

/**
 * EV threshold sweep over the closed candidates.
 *
 * The binary gate is too strict to ever be tested by this route: on the live ledger it
 * passes ZERO of the closed candidates, so `gateShadowReport` has an empty PASSED side
 * and can never separate. A sweep works instead — for each EV floor, how did the rows at
 * or above it actually do? That answers the question the binary gate cannot, and it keeps
 * answering it as more closes arrive.
 *
 * A rising beat-rate / mean-CLV across thresholds is evidence the EV signal has content.
 * A flat line is evidence it does not, and would mean the gate is filtering on noise.
 *
 * @param {Object} ledger
 * @param {Object} [opts] - { evThresholds: number[], minSample }
 * @returns {Object}
 */
function gateSweepReport(ledger, opts = {}) {
  const thresholds = Array.isArray(opts.evThresholds) ? opts.evThresholds : [0, 1, 2, 3, 5, 8];
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const seen = new Set();
  const rows = [];
  let ungradable = 0;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (typeof candidate.clvPct !== 'number' || !Number.isFinite(candidate.clvPct)) continue;
    const key = observationKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);

    const view = candidateGateView(candidate);
    const fair = fairProbabilityOf(view);
    const evPct = fair == null ? null : expectedValuePct(view.odds, fair);
    if (evPct == null) {
      ungradable += 1;
      continue;
    }
    rows.push({ evPct, clvPct: candidate.clvPct, beat: candidate.clvPct > 0 });
  }

  const bands = thresholds.map((threshold) => {
    const list = rows.filter((row) => row.evPct >= threshold);
    const summary = summarise(list, minSample);
    return { minEvPct: threshold, ...summary };
  });

  return {
    graded: rows.length,
    ungradable,
    thresholds,
    bands,
    // The whole sweep needs enough closes before any band means anything. Report it
    // once, at the top, so no single band can be read as a result in isolation.
    insufficientSample: rows.length < minSample
  };
}

/**
 * The signals worth sweeping: every one of these actually varies across the recorded
 * closed candidates. `verdict` is deliberately absent — all 18 closed rows are labelled
 * BET, so the scan's own verdict has no spread and cannot separate anything.
 */
const NUMERIC_SIGNALS = [
  {
    key: 'evPct',
    label: 'EV %',
    thresholds: [0, 1, 2, 3, 5],
    extract: (view) => {
      const fair = fairProbabilityOf(view);
      return fair == null ? null : expectedValuePct(view.odds, fair);
    }
  },
  {
    key: 'fairMarginPts',
    label: 'fair margin (pp)',
    thresholds: [0, 1, 2, 3, 5],
    extract: (view) => fairMarginPoints(view)
  },
  {
    key: 'signalQualityScore',
    label: 'signal quality',
    thresholds: [3, 5, 7, 9],
    extract: (view) => toNumber(view.signalQualityScore)
  },
  {
    // The system's core thesis is supportive movement, so this is the signal that most
    // deserves a test: does a bigger move in our favour predict a better close?
    key: 'openToCurrentPct',
    label: 'open->current move %',
    thresholds: [0.5, 1, 2, 3],
    extract: (view) => toNumber(view.openToCurrentPct != null ? view.openToCurrentPct : view.clvProxyPct)
  },
  {
    key: 'consensusBookCount',
    label: 'consensus books',
    thresholds: [5, 10, 15, 20],
    extract: (view) => toNumber(view.consensusBookCount)
  },
  {
    key: 'consensusEdgePct',
    label: 'consensus edge %',
    thresholds: [0, 0.5, 1, 2],
    extract: (view) => toNumber(view.consensusEdgePct != null ? view.consensusEdgePct : view.edge)
  }
];

const CATEGORICAL_SIGNALS = [
  { key: 'movementDisposition', label: 'movement grade', extract: (view) => view.movementDisposition || view.movement },
  { key: 'tier', label: 'tier', extract: (view) => view.tier },
  { key: 'market', label: 'market', extract: (view) => view.market }
];

function toNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * A numeric signal "separates" only in the narrow case where the extreme bands are both
 * readable AND move the same direction on BOTH metrics — a higher threshold must raise
 * the beat rate AND the mean CLV. Requiring both stops a single big win in a small band
 * from being reported as a finding.
 *
 * @param {Array<Object>} bands
 * @param {number} minSample
 * @returns {boolean}
 */
function numericSeparates(bands, minSample) {
  const usable = bands.filter((band) => band.sample >= minSample);
  if (usable.length < 2) return false;
  const first = usable[0];
  const last = usable[usable.length - 1];
  const clvGap = (last.meanClvPct == null ? 0 : last.meanClvPct) - (first.meanClvPct == null ? 0 : first.meanClvPct);
  const beatGap = (last.rate == null ? 0 : last.rate) - (first.rate == null ? 0 : first.rate);
  return clvGap > 0 && beatGap > 0;
}

/**
 * Same idea for categorical groups: the best and worst readable groups must differ on
 * both metrics in the same direction.
 *
 * @param {Array<Object>} groups
 * @param {number} minSample
 * @returns {boolean}
 */
function categoricalSeparates(groups, minSample) {
  const usable = groups.filter((group) => group.sample >= minSample);
  if (usable.length < 2) return false;
  const byClv = [...usable].sort((a, b) => (b.meanClvPct || 0) - (a.meanClvPct || 0));
  const best = byClv[0];
  const worst = byClv[byClv.length - 1];
  return (best.meanClvPct || 0) > (worst.meanClvPct || 0) && (best.rate || 0) > (worst.rate || 0);
}

/**
 * Generic signal sweep: does ANY signal we record separate winners from losers?
 *
 * This is the question that actually matters. If no threshold on any recorded signal
 * separates the closed candidates, then the edge inputs carry no usable signal and the
 * fix is upstream in the signal, not in the gate's calibration — tightening a gate that
 * filters on noise only rejects more plays for no reason.
 *
 * `separates` is deliberately conservative and is computed, never assumed: it requires
 * two READABLE extremes that agree on both beat rate and mean CLV. At small n the correct
 * output is "not yet determinable", not a direction.
 *
 * @param {Object} ledger
 * @param {Object} [opts] - { minSample }
 * @returns {Object}
 */
function signalSweepReport(ledger, opts = {}) {
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const seen = new Set();
  const rows = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (typeof candidate.clvPct !== 'number' || !Number.isFinite(candidate.clvPct)) continue;
    const key = observationKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ view: candidateGateView(candidate), clvPct: candidate.clvPct, beat: candidate.clvPct > 0 });
  }

  const numeric = NUMERIC_SIGNALS.map((signal) => {
    const valued = [];
    let missing = 0;
    for (const row of rows) {
      const value = signal.extract(row.view);
      if (value == null) missing += 1;
      else valued.push({ ...row, value });
    }
    const bands = signal.thresholds.map((threshold) => {
      const list = valued.filter((row) => row.value >= threshold);
      return { min: threshold, ...summarise(list, minSample) };
    });
    return { key: signal.key, label: signal.label, missing, bands, separates: numericSeparates(bands, minSample) };
  });

  const categorical = CATEGORICAL_SIGNALS.map((signal) => {
    const groups = new Map();
    let missing = 0;
    for (const row of rows) {
      const value = signal.extract(row.view);
      if (value == null || value === '') {
        missing += 1;
        continue;
      }
      const bucket = groups.get(String(value)) || [];
      bucket.push(row);
      groups.set(String(value), bucket);
    }
    const out = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([value, list]) => ({ value, ...summarise(list, minSample) }));
    return {
      key: signal.key,
      label: signal.label,
      missing,
      groups: out,
      separates: categoricalSeparates(out, minSample)
    };
  });

  const separating = [...numeric, ...categorical].filter((signal) => signal.separates).map((signal) => signal.key);

  return {
    graded: rows.length,
    numeric,
    categorical,
    // Named explicitly so a reader cannot miss WHICH signal, if any, separated.
    separatingSignals: separating,
    insufficientSample: rows.length < minSample,
    separates: separating.length > 0
  };
}

/**
 * Head-to-head: which FAIR ANCHOR's EV actually predicts beating the close?
 *
 * Two candidate definitions of "fair" are recorded on every candidate:
 *
 *   marketFairProbability      - de-vig averaged over EVERY book that quotes both legs
 *   sharpMarketFairProbability - de-vig averaged over the sharp comparison set only
 *
 * The all-books number averages square prices into the fair, so its EV degrades into
 * "is this price above the average of the books we already scanned" — a line-shopping
 * detector contaminated by soft numbers, and circular, since it derives an edge from
 * the same book population we bet into. The sharp-anchored number measures our price
 * against the sharp market instead, which is the defensible definition of +EV.
 *
 * This report sweeps BOTH across EV thresholds and shows which one's bands actually
 * separate winners from losers. It exists because the alternative is re-measuring the
 * contaminated number forever and concluding, wrongly, that no edge definition works.
 *
 * Note on coverage: `sharpMarketFairProbability` was only added recently, so older
 * candidates carry null and are counted in `withoutSharpFair` rather than silently
 * treated as zero. The comparison fills in as new scans are recorded.
 *
 * @param {Object} ledger
 * @param {Object} [opts] - { evThresholds: number[], minSample }
 * @returns {Object}
 */
function fairAnchorReport(ledger, opts = {}) {
  const thresholds = Array.isArray(opts.evThresholds) ? opts.evThresholds : [0, 1, 2, 3, 5];
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const seen = new Set();
  const rows = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (typeof candidate.clvPct !== 'number' || !Number.isFinite(candidate.clvPct)) continue;
    const key = observationKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);

    const view = candidateGateView(candidate);
    const odds = view.odds;
    const allFair = fairProbabilityOf(view);
    const sharpFair = toNumber(view.sharpMarketFairProbability);
    rows.push({
      odds,
      evAll: allFair == null ? null : expectedValuePct(odds, allFair),
      evSharp: sharpFair == null ? null : expectedValuePct(odds, sharpFair),
      clvPct: candidate.clvPct,
      beat: candidate.clvPct > 0
    });
  }

  const band = (list, threshold, extract) => {
    const subset = list.filter((row) => {
      const value = extract(row);
      return value != null && value >= threshold;
    });
    return { min: threshold, ...summarise(subset, minSample) };
  };

  const withAll = rows.filter((row) => row.evAll != null);
  const withSharp = rows.filter((row) => row.evSharp != null);

  return {
    graded: rows.length,
    withAllFair: withAll.length,
    // Explicitly surfaced: a small number here means the comparison is not yet
    // meaningful, and it must not read as "the sharp anchor found nothing".
    withoutSharpFair: rows.length - withSharp.length,
    allBooks: thresholds.map((t) => band(withAll, t, (r) => r.evAll)),
    sharp: thresholds.map((t) => band(withSharp, t, (r) => r.evSharp)),
    thresholds,
    insufficientSample: withSharp.length < minSample
  };
}

/**
 * American odds to decimal payout multiple, or null when unusable.
 * American prices are NOT linearly comparable (`-110` is better than `-115`, while
 * `+110` is better than `+105`), so a shopping gap must be judged on DECIMAL value.
 */
function americanToDecimal(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

/**
 * How much price is being left on the table, and does it matter?
 *
 * Line shopping is the most reliable retail edge there is: taking the best available
 * number for the same selection is worth real EV and requires no prediction at all.
 * The ledger could not answer this before — `executionQuality` records a GRADE
 * ('best'/'playable'/'bad') but the graded price was never carried, so "how much did
 * we give up?" was unanswerable.
 *
 * IMPORTANT — what `bestAvailableOdds` actually is: the expander computes it as the
 * best price across the COMPARISON books, which EXCLUDE the resolved/target book
 * (`computeComparisonBooks` filters it out). So it can legitimately be WORSE than our
 * own price. A gap therefore exists only when the comparison best BEATS our price in
 * decimal terms; testing mere inequality would count every row where we already hold
 * the best number as "value left on the table", which is the exact inverse of the
 * truth and would report a fabricated emergency.
 *
 * Reports, over every deduped candidate with both prices:
 *
 *   - how often a genuinely better price existed at another book,
 *   - the EV foregone in percentage points (EV at the best price minus EV at ours,
 *     reusing the same `expectedValuePct` the gate uses so the units match),
 *   - and the realised close-relative CLV split between rows where we held the best
 *     price and rows where we did not.
 *
 * The last split is the point: if holding the best price does not improve realised
 * CLV, execution is not the leak and the effort belongs elsewhere. If it does, the fix
 * is to bet the book that has the number, not to find a better signal.
 *
 * Rows missing either price land in `unmeasurable`, never a zero gap — a fabricated
 * zero would report perfectly efficient execution that was never observed.
 *
 * @param {Object} ledger
 * @param {Object} [opts] - { minSample }
 * @returns {Object}
 */
function shoppingGapReport(ledger, opts = {}) {
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const seen = new Set();
  const rows = [];
  let unmeasurable = 0;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const view = candidateGateView(candidate);
    const odds = toNumber(view.odds);
    const best = toNumber(view.bestAvailableOdds);
    if (odds == null || best == null) {
      unmeasurable += 1;
      continue;
    }
    const dOdds = americanToDecimal(odds);
    const dBest = americanToDecimal(best);
    if (dOdds == null || dBest == null) {
      unmeasurable += 1;
      continue;
    }
    const key = `${observationKey(candidate)}|${best}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Decimal comparison, not inequality: see the note above.
    const betterExists = dBest > dOdds + 1e-9;
    const fair = fairProbabilityOf(view);
    const evAtBest = fair == null ? null : expectedValuePct(best, fair);
    const evAtOurs = fair == null ? null : expectedValuePct(odds, fair);
    rows.push({
      odds,
      best,
      betterExists,
      evForegonePct: evAtBest == null || evAtOurs == null ? null : evAtBest - evAtOurs,
      tookBest: !betterExists,
      clvPct: typeof candidate.clvPct === 'number' && Number.isFinite(candidate.clvPct) ? candidate.clvPct : null
    });
  }

  const withGap = rows.filter((row) => row.evForegonePct != null && row.evForegonePct > 0);
  const tookBest = rows.filter((row) => row.tookBest);
  const leftValue = rows.filter((row) => row.betterExists);
  const graded = (list) => list.filter((row) => row.clvPct != null);

  return {
    measured: rows.length,
    // Surfaced so a low number cannot read as "execution is perfect".
    unmeasurable,
    betterPriceExisted: leftValue.length,
    tookBestPrice: tookBest.length,
    meanEvForegonePct: withGap.length
      ? withGap.reduce((sum, row) => sum + row.evForegonePct, 0) / withGap.length
      : null,
    totalEvForegonePct: withGap.length ? withGap.reduce((sum, row) => sum + row.evForegonePct, 0) : null,
    tookBest: summarise(graded(tookBest), minSample),
    leftValue: summarise(graded(leftValue), minSample),
    insufficientSample: graded(tookBest).length + graded(leftValue).length < minSample
  };
}

/**
 * Were any RECORDED candidates cross-venue arbitrage opportunities?
 *
 * Arbitrage is the one edge the literature documents as retail-accessible and entirely
 * prediction-free: back one side at venue A and the other at venue B and the result is
 * fixed. `arbMarginPct` is recorded on every candidate (`1 - sum(best implied per side)`,
 * in percentage points), so this is measurable without re-scanning.
 *
 * IMPORTANT SCOPE LIMIT: this only sees the candidates the SCAN chose to record, which is
 * a biased subset of the market — an arb is usually filtered out long before it becomes a
 * candidate, because the scan ranks on movement and EV, not on price disagreement. A low
 * count here therefore means "our candidates were not arbs", NOT "the market had no
 * arbs". Finding arbs properly requires scanning the full market, which this does not do.
 *
 * @param {Object} ledger
 * @returns {Object}
 */
function arbReport(ledger) {
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const seen = new Set();
  const rows = [];
  let scanned = 0;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const view = candidateGateView(candidate);
    // `arbMarginPct` is only present on rows recorded after it was added; a missing
    // field means unscanned, not "not an arb", so those rows are excluded from the
    // denominator rather than counted as non-opportunities.
    if (!('arbMarginPct' in view)) continue;
    const key = observationKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    scanned += 1;
    const margin = toNumber(view.arbMarginPct);
    if (margin == null) continue;
    rows.push({
      marginPct: margin,
      suspicious: margin > DEFAULT_MAX_PLAUSIBLE_MARGIN_PCT,
      league: candidate.league ?? null,
      market: candidate.market ?? null
    });
  }

  rows.sort((a, b) => b.marginPct - a.marginPct);
  return {
    scanned,
    opportunities: rows.length,
    bestMarginPct: rows.length ? rows[0].marginPct : null,
    meanMarginPct: rows.length ? rows.reduce((sum, row) => sum + row.marginPct, 0) / rows.length : null,
    suspiciousCount: rows.filter((row) => row.suspicious).length,
    top: rows.slice(0, 5)
  };
}

module.exports = {
  gateShadowReport,
  gateSweepReport,
  signalSweepReport,
  fairAnchorReport,
  shoppingGapReport,
  arbReport,
  candidateGateView,
  observationKey,
  summarise,
  NUMERIC_SIGNALS,
  CATEGORICAL_SIGNALS
};
