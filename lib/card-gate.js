'use strict';

/**
 * The card gate: a price test and a volume cap.
 *
 * Why this exists. The 2026-09-17 card had 13 plays on it and 12 lost. Almost
 * every one was priced -133 to -135, which needs 57.1% to break even, against a
 * signal the repo's own docs score at ~50-54% on outcomes. Thirteen negative-EV
 * coin flips do not need bad luck; that shape is the expected result. Nothing in
 * the card path measured the price against the fair price, and nothing capped
 * how many plays could ride on one slate.
 *
 * Two rules, both price-based rather than prediction-based:
 *
 *   1. **A play is only a BET if the price is on the right side of the market.**
 *      Either the price returns positive EV against the decision-time de-vigged
 *      fair probability, or it beats the sharp consensus edge by a margin. A row
 *      that offers neither has no price evidence at all and becomes a LEAN.
 *      Movement is not evidence of price; it is a hypothesis, and the close is
 *      what tests it.
 *   2. **A card is capped.** Volume is the other half of the loss: at a genuine
 *      55%, a 13-leg day is variance with no upside.
 *
 * Plus `UNPROVEN`: a bucket with fewer than `minSample` decided bets is labelled,
 * because the honest state of every bucket in this ledger today is "unmeasured".
 */

const { classifyPrice } = require('./record-quality');

const DEFAULT_MIN_EV_PCT = 2;
const DEFAULT_MAX_BETS = 2;
const DEFAULT_MIN_SAMPLE = 30;

/** Decimal odds for a recorded price, or null. */
function decimalOdds(odds) {
  const classified = classifyPrice(odds);
  if (classified.decimal != null) return classified.decimal;
  if (classified.american == null) return null;
  const american = classified.american;
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

/**
 * Expected value as a percentage of stake.
 *
 * `fairProbability` must be the de-vigged probability for THIS side. Passing a
 * single-sided implied probability (which still carries the hold) would make
 * every bet look negative, so a value that is not strictly inside (0, 1) is
 * refused rather than coerced.
 *
 * @param {unknown} odds - the price available
 * @param {number} fairProbability - de-vigged fair probability for this side
 * @returns {number|null} EV in percent of stake, or null when not computable
 */
function expectedValuePct(odds, fairProbability) {
  const decimal = decimalOdds(odds);
  const fair = Number(fairProbability);
  if (decimal == null || !Number.isFinite(fair) || fair <= 0 || fair >= 1) return null;
  const ev = fair * (decimal - 1) - (1 - fair);
  return Number((ev * 100).toFixed(4));
}

/** The de-vigged fair probability on a row, from whichever field carries it. */
function fairProbabilityOf(row) {
  const candidates = [
    row && row.marketFairProbability,
    row && row.fairProbability,
    row && row.play && row.play.marketFairProbability
  ];
  for (const value of candidates) {
    const fair = Number(value);
    if (Number.isFinite(fair) && fair > 0 && fair < 1) return fair;
  }
  return null;
}

/** The sharp-consensus edge, as a percentage. */
function consensusEdgeOf(row) {
  const raw = row && (row.consensusEdge ?? row.edge);
  const edge = Number(raw);
  return Number.isFinite(edge) ? edge : null;
}

/**
 * Decide whether a single row clears the price test.
 *
 * @param {Object} row
 * @param {Object} [opts] - { minEvPct }
 * @returns {{pass: boolean, reason: string, evPct: number|null, margin: string|null}}
 */
function priceGate(row, opts = {}) {
  const minEvPct = Number.isFinite(opts.minEvPct) ? opts.minEvPct : DEFAULT_MIN_EV_PCT;
  const fair = fairProbabilityOf(row);
  const evPct = fair == null ? null : expectedValuePct(row && row.odds, fair);
  if (evPct != null) {
    return {
      pass: evPct >= minEvPct,
      reason: evPct >= minEvPct ? 'positive_ev' : 'ev_below_floor',
      evPct,
      margin: 'fair_probability'
    };
  }
  const edge = consensusEdgeOf(row);
  if (edge != null) {
    return {
      pass: edge >= minEvPct,
      reason: edge >= minEvPct ? 'consensus_edge' : 'edge_below_floor',
      evPct: null,
      margin: 'consensus_edge'
    };
  }
  // No price reference at all. The row may be a fine bet for reasons this gate
  // cannot see, but it cannot be presented as a BET on price evidence it does
  // not have.
  return { pass: false, reason: 'no_price_reference', evPct: null, margin: null };
}

/**
 * Is this tier+market bucket measured well enough to be called a BET?
 *
 * @param {Object} evaluation - a document from lib/record-metrics evaluateLedger
 * @param {Object} row
 * @param {number} minSample
 * @returns {{proven: boolean, sample: number|null}}
 */
function bucketEvidence(evaluation, row, minSample = DEFAULT_MIN_SAMPLE) {
  const byTier = (evaluation && evaluation.byTier) || {};
  const tier = (row && (row.tier || row.confidenceTier || row.finalConfidenceTier)) || 'unknown';
  const stats = byTier[tier];
  if (!stats) return { proven: false, sample: null };
  return { proven: !stats.insufficientSample && stats.decided >= minSample, sample: stats.decided };
}

/**
 * Apply the gate to a candidate card.
 *
 * @param {Array<Object>} rows - BET-verdict rows in card order
 * @param {Object} [opts] - { maxBets, minEvPct, minSample, evaluation }
 * @returns {{bets: Array<Object>, leans: Array<Object>, dropped: Array<Object>, notes: Array<string>}}
 */
function applyCardGate(rows, opts = {}) {
  const maxBets = Number.isInteger(opts.maxBets) ? opts.maxBets : DEFAULT_MAX_BETS;
  const minSample = Number.isInteger(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const list = Array.isArray(rows) ? rows : [];
  const bets = [];
  const leans = [];
  const dropped = [];
  const notes = [];
  let unsampled = 0;

  for (const row of list) {
    const gate = priceGate(row, opts);
    const evidence = bucketEvidence(opts.evaluation, row, minSample);
    if (!evidence.proven) unsampled += 1;
    if (!gate.pass) {
      dropped.push({ selection: row && row.selection, reason: gate.reason, evPct: gate.evPct });
      continue;
    }
    if (bets.length >= maxBets) {
      leans.push({ selection: row && row.selection, reason: 'card_full', evPct: gate.evPct, row });
      continue;
    }
    bets.push({
      ...row,
      evPct: gate.evPct,
      priceMargin: gate.margin,
      bucketSample: evidence.sample,
      unproven: !evidence.proven
    });
  }

  if (unsampled > 0) {
    notes.push(
      `${unsampled} row(s) come from a bucket with fewer than ${minSample} decided bets - labelled UNPROVEN, not measured`
    );
  }
  for (const droppedRow of dropped) notes.push(`dropped ${droppedRow.selection}: ${droppedRow.reason}`);
  for (const lean of leans) notes.push(`${lean.selection} would have been a BET but the card is capped at ${maxBets}`);
  return { bets, leans, dropped, notes };
}

/**
 * Render the card report (human or JSON).
 *
 * Lives here rather than in `bin/pp-cli.js` because that file sits at its
 * `max-lines` cap; the rendering is card-gate policy anyway (what a gated card
 * looks like), not CLI plumbing. `style` carries the CLI's colour codes so the
 * output is unchanged.
 *
 * @param {Object} ctx
 * @returns {string} text to print
 */
function renderCard(ctx) {
  const {
    league,
    book,
    gated,
    gateEnabled,
    maxBets,
    minEvPct,
    considerCount,
    startedCount,
    jsonOut,
    gameCounts = new Map(),
    style = {}
  } = ctx;
  const paint = (code, text) => (style[code] ? style[code] + text + (style.reset || '') : text);
  const bets = gated.bets || [];

  if (jsonOut) {
    return JSON.stringify(
      {
        league,
        book,
        card: bets,
        considerCount,
        startedDropped: startedCount,
        gate: gateEnabled
          ? {
              maxBets,
              minEvPct,
              dropped: gated.dropped,
              leans: gated.leans.map((lean) => lean.selection),
              notes: gated.notes
            }
          : { disabled: true }
      },
      null,
      2
    );
  }

  if (!bets.length) {
    const suffix =
      gateEnabled && gated.dropped.length ? ` — all ${gated.dropped.length} BET(s) failed the price gate` : '';
    return `No plays on today's ${league} card${suffix} (${considerCount} CONSIDERs, ${startedCount} already started).`;
  }

  const lines = [
    paint('bold', `${league} card`) +
      ` — ${bets.length} BET${bets.length === 1 ? '' : 's'} on ${book}` +
      (gateEnabled ? `  (price gate: EV >= ${minEvPct}%, cap ${maxBets})` : '  (gate disabled)')
  ];
  bets.forEach((row, index) => {
    const oddsStr = row.odds > 0 ? '+' + row.odds : String(row.odds);
    const when =
      row.startsIn === 'LIVE' || row.isLive
        ? paint('red', 'LIVE')
        : [row.startCT, row.startsIn].filter(Boolean).join(', ');
    const liq = row.liquidityFlag === 'thin' ? ' ' + paint('red', '[thin liq]') : '';
    const sameGame = (gameCounts.get(row.gameId || row.game) || 0) > 1 ? '  (same game as below)' : '';
    const ev = row.evPct == null ? 'EV n/a' : `EV ${row.evPct >= 0 ? '+' : ''}${row.evPct.toFixed(2)}%`;
    const evidence = row.unproven ? paint('red', 'UNPROVEN') : `measured n=${row.bucketSample}`;
    lines.push(
      `  ${index + 1}. ${row.selection} @ ${oddsStr}  [${row.market}]  (${when})${liq}${sameGame}\n` +
        `     ${row.game || ''}  |  mv ${row.movementDisposition || '?'}  |  books ${row.consensusBookCount ?? '?'}\n` +
        `     ${ev}  |  ${evidence}`
    );
  });
  return lines.join('\n');
}

/** Side notes that belong on stderr next to a rendered card. */
function cardNotes(gated, { considerCount, startedCount }) {
  const notes = [];
  if (considerCount) notes.push(`${considerCount} CONSIDERs left off — use pp rank to see them.`);
  if (startedCount) notes.push(`${startedCount} BETs already started, dropped.`);
  for (const note of gated.notes || []) notes.push(note);
  return notes;
}

/** One call that gates a card and renders it, so the caller holds no policy. */
function cardGateReport(card, opts = {}) {
  const gateEnabled = opts.gateEnabled !== false;
  const maxBets = Number.isInteger(opts.maxBets) ? opts.maxBets : DEFAULT_MAX_BETS;
  const minEvPct = Number.isFinite(opts.minEvPct) ? opts.minEvPct : DEFAULT_MIN_EV_PCT;
  const gated = gateEnabled
    ? applyCardGate(card, { maxBets, minEvPct, evaluation: opts.evaluation })
    : { bets: Array.isArray(card) ? card : [], leans: [], dropped: [], notes: [] };
  const context = opts.context || {};
  return {
    gated,
    text: renderCard({ ...context, gated, gateEnabled, maxBets, minEvPct }),
    notes: cardNotes(gated, context)
  };
}

module.exports = {
  DEFAULT_MIN_EV_PCT,
  DEFAULT_MAX_BETS,
  DEFAULT_MIN_SAMPLE,
  decimalOdds,
  expectedValuePct,
  fairProbabilityOf,
  consensusEdgeOf,
  priceGate,
  bucketEvidence,
  applyCardGate,
  renderCard,
  cardNotes,
  cardGateReport
};
