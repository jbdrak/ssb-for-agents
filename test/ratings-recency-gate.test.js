'use strict';

// Recency gate for the external-ratings layer (card: "months-old snapshots
// attach to current games").
//
// The layer had one recency mechanism — `loadSnapshot`'s caller-supplied
// `asOfCutoff` -> `stale` — and the scan path never armed it, so a snapshot at
// `asOf 2026-06-13` attached to a 2026-10-25 event with nothing blocking it.
// The fix is NOT a second recency rule: it is the same cutoff/`stale`
// vocabulary, computed per row from the event's own start time at the join.
//
// These tests are hermetic: pure records and rows in, no network, no I/O, and
// no wall clock (the gate is event-relative by construction).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { applyRatingsOverlay } = require('../lib/ssb-ratings-overlay');
const { normalizeEvaluationRows, evaluateRatingSources } = require('../lib/ssb-external-ratings-evaluation');
const recency = require('../lib/ssb-ratings-recency');

const HASH = 'a'.repeat(64);
const FETCHED_AT = '2026-09-15T10:00:00.000Z';
const SOURCE_URL = 'http://sagarin.com/sports/cfsend.htm';

// The proven defect, verbatim from the local state dir: a Sagarin NBA snapshot
// whose own `asOf` is 2026-06-13 (last update of the finished 2025-26 season)
// attached to a 2026-10-25 game.
const JUNE_AS_OF = '2026-06-13';
const OCTOBER_EVENT = '2026-10-25T23:00:00Z';

function sagarinRecord(asOf, overrides = {}) {
  return {
    source: 'sagarin',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf,
    fetchedAt: FETCHED_AT,
    sourceUrl: SOURCE_URL,
    sourceHash: HASH,
    teamA: 'Michigan',
    teamB: 'Ohio State',
    neutral: false,
    predictedScoreA: 31,
    predictedScoreB: 24,
    predictedTotal: 55,
    predictedMargin: -7.5,
    coverage: 'full',
    matchStatus: 'unmatched',
    ...overrides
  };
}

// Team-scoped Massey row (`teamA === teamB`): a rating, not a prediction. It
// must be gated by the same rule as a game-scoped row.
function masseyRecord(asOf) {
  return {
    source: 'massey',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf,
    fetchedAt: FETCHED_AT,
    sourceUrl: 'https://masseyratings.com/cf/fbs/ratings',
    sourceHash: HASH,
    teamA: 'Michigan',
    teamB: 'Michigan',
    neutral: null,
    ratingA: 88.1,
    ratingB: 88.1,
    coverage: 'full',
    matchStatus: 'unmatched'
  };
}

function row(start) {
  return {
    league: 'NCAAF',
    market: 'Moneyline',
    game: 'Michigan vs Ohio State',
    selection: 'Michigan',
    odds: -140,
    ...(start === undefined ? {} : { start })
  };
}

describe('ratings recency: the shared cutoff primitive', () => {
  it('derives a cutoff from the event start, not from fetch time', () => {
    const cutoff = recency.staleCutoff(OCTOBER_EVENT, recency.ATTACH_MAX_AGE_DAYS);
    // 2026-10-25 minus the documented window.
    assert.equal(cutoff.slice(0, 10), '2026-10-11');
    assert.equal(recency.staleCutoff(OCTOBER_EVENT, 3).slice(0, 10), '2026-10-22');
    assert.equal(recency.staleCutoff(null), null);
  });

  it('is the same date-order primitive the snapshot store already used', () => {
    // The store's `asOfCutoff` -> `stale` comparison and the overlay's gate are
    // one rule: `isBefore(asOf, cutoff)`.
    assert.equal(recency.isBefore('2026-09-13', '2026-09-20'), true);
    assert.equal(recency.isBefore('2026-09-20', '2026-09-20'), false);
    assert.equal(recency.isBefore('2026-09-21', '2026-09-20'), false);
    // Unparseable input is never "before" (fail closed, never a guessed order).
    assert.equal(recency.isBefore(null, '2026-09-20'), false);
    assert.equal(recency.isBefore('2026-09-13', 'nonsense'), false);
  });

  it('reads an event start from the row field names the pipeline uses', () => {
    assert.equal(recency.eventStartMs({ start: '2026-10-25T23:00:00Z' }), Date.parse('2026-10-25T23:00:00Z'));
    // Upstream /screen sends epoch seconds for MLB/NBA/NFL/NHL.
    assert.equal(recency.eventStartMs({ start: 1793055600 }), 1793055600000);
    assert.equal(recency.eventStartMs({ startTime: '2026-10-25T23:00:00Z' }), Date.parse('2026-10-25T23:00:00Z'));
    assert.equal(recency.eventStartMs({}), null);
    assert.equal(recency.eventStartMs(null), null);
  });
});

describe('ratings recency gate at attach time (overlay)', () => {
  it('does not attach a months-old snapshot to a current game', () => {
    const [out] = applyRatingsOverlay([row(OCTOBER_EVENT)], { ratings: [sagarinRecord(JUNE_AS_OF)] });

    const entry = out.ratings.sagarin;
    // Not presented as live context: no records, and an explicit marker.
    assert.ok(entry, 'the source must be reported, not silently dropped');
    assert.deepEqual(entry.records, []);
    assert.equal(entry.stale, true);
    assert.equal(entry.reasonKind, 'snapshot_stale');
    assert.equal(entry.withheld, 1);

    // The reason names both ages and the window (card requirement 2).
    assert.match(entry.reason, /2026-06-13/);
    assert.match(entry.reason, /2026-10-25/);
    assert.match(entry.reason, /134 days/);
    assert.match(entry.reason, /14-day/);
  });

  it('still attaches a same-week snapshot normally (positive control)', () => {
    const [out] = applyRatingsOverlay([row('2026-09-16T23:00:00Z')], { ratings: [sagarinRecord('2026-09-13')] });

    const entry = out.ratings.sagarin;
    assert.equal(entry.records.length, 1);
    assert.equal(entry.records[0].predictedMargin, -7.5);
    assert.equal(entry.asOf, '2026-09-13');
    // A verified entry carries no withholding marker.
    assert.equal(entry.stale, undefined);
    assert.equal(entry.withheld, undefined);
  });

  it('covers the boundary on both sides of the window', () => {
    const event = '2026-09-20T20:00:00Z';
    const cutoffDay = '2026-09-06'; // exactly ATTACH_MAX_AGE_DAYS (14) before the event
    const dayBefore = '2026-09-05';

    const [fresh] = applyRatingsOverlay([row(event)], { ratings: [sagarinRecord(cutoffDay)] });
    const [stale] = applyRatingsOverlay([row(event)], { ratings: [sagarinRecord(dayBefore)] });

    assert.equal(fresh.ratings.sagarin.records.length, 1, 'age == window must still attach');
    assert.deepEqual(stale.ratings.sagarin.records, [], 'age > window must be withheld');
    assert.match(stale.ratings.sagarin.reason, /15 days/);
  });

  it('honours a caller-supplied window', () => {
    const records = [sagarinRecord('2026-09-13')];
    const [tight] = applyRatingsOverlay([row('2026-09-20T20:00:00Z')], { ratings: records, maxAgeDays: 3 });
    assert.deepEqual(tight.ratings.sagarin.records, []);
    assert.match(tight.ratings.sagarin.reason, /3-day/);
  });

  it('gates a team-scoped (no-opponent) rating by the same rule', () => {
    const [out] = applyRatingsOverlay([row(OCTOBER_EVENT)], { ratings: [masseyRecord(JUNE_AS_OF)] });
    assert.deepEqual(out.ratings.massey.records, []);
    assert.equal(out.ratings.massey.reasonKind, 'snapshot_stale');
  });

  it('fails closed when the row carries no event start', () => {
    const [out] = applyRatingsOverlay([row()], { ratings: [sagarinRecord(JUNE_AS_OF)] });
    const entry = out.ratings.sagarin;
    assert.deepEqual(entry.records, []);
    assert.equal(entry.reasonKind, 'event_start_unknown');
    assert.equal(entry.withheld, 1);
    assert.match(entry.reason, /no event start/);
  });

  it('fails closed on an undated record rather than attaching it as current', () => {
    const [out] = applyRatingsOverlay([row('2026-09-20T20:00:00Z')], {
      ratings: [sagarinRecord(null)]
    });
    const entry = out.ratings.sagarin;
    assert.deepEqual(entry.records, []);
    assert.equal(entry.reasonKind, 'snapshot_undated');
    assert.equal(entry.withheld, 1);
    assert.match(entry.reason, /no asOf date/);
  });

  it('keeps a fresh record when a stale one shares the same row', () => {
    // Two seasons of the same source can both match; only the current one ships.
    const [out] = applyRatingsOverlay([row('2026-09-16T23:00:00Z')], {
      ratings: [sagarinRecord(JUNE_AS_OF, { season: 2026 }), sagarinRecord('2026-09-13', { season: 2027 })]
    });
    const entry = out.ratings.sagarin;
    assert.equal(entry.records.length, 1);
    assert.equal(entry.records[0].asOf, '2026-09-13');
    assert.equal(entry.withheld, 1);
  });

  it('leaves a row whose game identity does not resolve as null (unchanged)', () => {
    const [out] = applyRatingsOverlay(
      [{ league: 'NCAAF', market: 'Moneyline', game: 'Michigan', start: OCTOBER_EVENT }],
      {
        ratings: [sagarinRecord(JUNE_AS_OF)]
      }
    );
    assert.equal(out.ratings.sagarin, null);
  });
});

describe('ratings recency gate in the evaluation pipeline', () => {
  function evaluationRow(overrides = {}) {
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

  it('refuses a months-old snapshot as evidence', () => {
    const { rows, unresolved } = normalizeEvaluationRows([
      evaluationRow({ predictionTimestamp: JUNE_AS_OF, gameTimestamp: OCTOBER_EVENT })
    ]);
    assert.equal(rows[0].status, 'unresolved');
    assert.equal(rows[0].unresolvedReason, 'stale-snapshot');
    assert.equal(unresolved.length, 1);
  });

  it('keeps a current snapshot as evidence', () => {
    const { rows } = normalizeEvaluationRows([
      evaluationRow({ predictionTimestamp: '2026-09-13', gameTimestamp: '2026-09-16T23:00:00Z' })
    ]);
    assert.equal(rows[0].status, 'matched');
    assert.equal(rows[0].unresolvedReason, undefined);
  });

  it('a stale source reports sample 0 and no fabricated score', () => {
    const block = evaluateRatingSources({
      sagarin: [evaluationRow({ predictionTimestamp: JUNE_AS_OF, gameTimestamp: OCTOBER_EVENT })]
    }).sources.sagarin;
    assert.equal(block.coverage.total, 1);
    assert.equal(block.coverage.resolved, 0);
    assert.equal(block.coverage.sampleSize, 0);
    assert.deepEqual(block.scores, {});
  });

  it('does not judge a row with no game timestamp (no reference to gate against)', () => {
    const { rows } = normalizeEvaluationRows([evaluationRow({ predictionTimestamp: JUNE_AS_OF })]);
    assert.equal(rows[0].status, 'matched');
  });
});
