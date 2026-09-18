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

const { priceGate, fairProbabilityOf, expectedValuePct, DEFAULT_MIN_SAMPLE } = require('./card-gate');
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

module.exports = { gateShadowReport, gateSweepReport, candidateGateView, observationKey, summarise };
