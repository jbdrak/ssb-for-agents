'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachTennisElo,
  tourOfCategory,
  participantsOf,
  eventDateOf,
  surfaceKey,
  loadSurfaceMap
} = require('../lib/ssb-tennis-elo-overlay');

const TOUR_CASES = [
  ['WTA - SINGLES', 'WTA'],
  ['CHALLENGER WOMEN - SINGLES', 'WTA'],
  ['ITF WOMEN - SINGLES', 'WTA'],
  ['ATP - SINGLES', 'ATP'],
  ['CHALLENGER MEN - SINGLES', 'ATP'],
  ['ITF MEN - SINGLES', 'ATP'],
  ['WTA - DOUBLES', null],
  ['', null],
  [null, null]
];

test('tourOfCategory maps only singles categories', () => {
  for (const [input, expected] of TOUR_CASES) {
    assert.equal(tourOfCategory(input), expected, `${input} -> ${expected}`);
  }
});

test('participantsOf reads the game string or the team fields', () => {
  assert.deepEqual(participantsOf({ game: 'Barthel vs Ristic' }), ['Barthel', 'Ristic']);
  assert.deepEqual(participantsOf({ game: 'De Stefano vs Tubello' }), ['De Stefano', 'Tubello']);
  assert.deepEqual(participantsOf({ homeTeam: 'A', awayTeam: 'B' }), ['A', 'B']);
  assert.equal(participantsOf({ game: 'solo' }), null);
});

test('eventDateOf takes the ISO day and refuses anything else', () => {
  assert.equal(eventDateOf({ start: '2026-09-17T13:30:00.000Z' }), '2026-09-17');
  assert.equal(eventDateOf({ start: 'Thu, Sep 17, 7:15 PM CT' }), null);
  assert.equal(eventDateOf({}), null);
});

function makeRow(over = {}) {
  return {
    league: 'Tennis',
    market: 'Moneyline',
    game: 'Sobolieva vs Samson',
    start: '2026-09-17T08:00:00.000Z',
    kaiCall: 'BET',
    verdict: 'BET',
    tier: 'TIER 1',
    edge: 2.5,
    ...over
  };
}

const MATCH = { category: 'WTA - SINGLES', tournament: 'Ljubljana', surface: 'clay' };

function attach(rows, over = {}) {
  return attachTennisElo(rows, {
    snapshot: { players: { WTA: {} } },
    // Hermetic: never let a real on-disk tournament surface map leak into a test.
    surfaceMap: {},
    lookupMatchTimeImpl: () => MATCH,
    surfaceOfImpl: () => 'clay',
    lookupMatchImpl: () => ({
      source: 'tennis_elo',
      asOf: '2026-09-16',
      records: [{ source: 'tennis_elo', selection: 'Sobolieva', modelWinProbability: 0.46 }],
      reasonKind: null
    }),
    ...over
  });
}

test('attaches the adapter record under ratings.tennis_elo', () => {
  const row = makeRow();
  const stats = attach([row]);
  assert.equal(stats.attempted, 1);
  assert.equal(stats.attached, 1);
  assert.equal(row.ratings.tennis_elo.asOf, '2026-09-16');
  assert.equal(row.ratings.tennis_elo.records.length, 1);
  assert.equal(row.ratings.tennis_elo.records[0].selection, 'Sobolieva');
});

test('never touches kaiCall, tier, verdict or edge', () => {
  const row = makeRow();
  const before = { kaiCall: row.kaiCall, verdict: row.verdict, tier: row.tier, edge: row.edge };
  attach([row]);
  assert.deepEqual({ kaiCall: row.kaiCall, verdict: row.verdict, tier: row.tier, edge: row.edge }, before);
});

test('merges into an existing ratings map instead of clobbering other sources', () => {
  const row = makeRow({ ratings: { massey: { game: 'x' }, tennis_elo: null } });
  attach([row]);
  assert.deepEqual(row.ratings.massey, { game: 'x' });
  assert.equal(row.ratings.tennis_elo.records.length, 1);
});

test('walks scan result buckets', () => {
  const buckets = [{ league: 'Tennis', market: 'Moneyline', plays: [makeRow()] }];
  const stats = attach(buckets);
  assert.equal(stats.attached, 1);
  assert.ok(buckets[0].plays[0].ratings.tennis_elo);
});

test('the point-in-time floor is the event date minus the recency window', () => {
  let seen = null;
  attach([makeRow()], {
    maxAgeDays: 14,
    lookupMatchImpl: (opts) => {
      seen = opts;
      return { records: [], reasonKind: 'snapshot_stale' };
    }
  });
  assert.equal(seen.asOf, '2026-09-17');
  assert.equal(seen.snapshotNotBefore, '2026-09-03');
  assert.equal(seen.market, 'Moneyline');
  assert.equal(seen.tour, 'WTA');
  assert.equal(seen.surface, 'clay');
});

test('fails closed per row and counts why', () => {
  const rows = [
    makeRow({ league: 'MLB' }), // not tennis
    makeRow({ market: 'Total Games' }), // unsupported market
    makeRow({ game: 'solo' }), // no participants
    makeRow({ start: 'Thu, Sep 17' }), // no event date
    makeRow() // unknown tour (no schedule match)
  ];
  const stats = attachTennisElo(rows, {
    snapshot: { players: { WTA: {} } },
    surfaceMap: {},
    lookupMatchTimeImpl: (a, _b) => (a === 'Sobolieva' ? null : MATCH),
    surfaceOfImpl: () => 'clay',
    lookupMatchImpl: () => ({ records: [], reasonKind: 'unknown_player' })
  });
  assert.equal(stats.attempted, 4); // the MLB row is not attempted at all
  assert.equal(stats.attached, 0);
  assert.equal(stats.skipped.unsupported_market, 1);
  assert.equal(stats.skipped.no_participants, 1);
  assert.equal(stats.skipped.no_event_date, 1);
  assert.equal(stats.skipped.unknown_tour, 1);
  for (const r of rows) assert.equal(r.ratings, undefined);
});

test('an unknown surface is a skip, not an attach', () => {
  const row = makeRow();
  const stats = attach([row], { surfaceOfImpl: () => null });
  assert.equal(stats.attached, 0);
  assert.equal(stats.skipped.unknown_surface, 1);
  assert.equal(row.ratings, undefined);
});

test('an unavailable adapter result leaves the row untouched and reports the reason', () => {
  const row = makeRow({ ratings: { tennis_elo: null } });
  const stats = attach([row], { lookupMatchImpl: () => ({ records: [], reasonKind: 'snapshot_stale' }) });
  assert.equal(stats.attached, 0);
  assert.equal(stats.skipped.snapshot_stale, 1);
  assert.equal(row.ratings.tennis_elo, null);
});

test('surfaceKey reduces a season-file name and a schedule-cache name to one key', () => {
  const pairs = [
    ['Ljubljana Chall. Women', 'Ljubljana (Slovenia)'],
    ['Caldas da Rainha Chall. Women', 'Caldas da Rainha (Portugal)'],
    ['Sao Paulo WTA', 'Sao Paulo (Brazil)'],
    ['US Open WTA', 'US Open (USA)'],
    ['Valencia Chall. Women - Qualification', 'Valencia (Spain)']
  ];
  for (const [a, b] of pairs) {
    assert.equal(surfaceKey(a), surfaceKey(b), `${a} vs ${b}`);
  }
  assert.equal(surfaceKey('Ljubljana Chall. Women'), 'ljubljana');
  assert.equal(surfaceKey(''), '');
});

test('a missing surface map reads as an empty map, never a throw', () => {
  assert.deepEqual(loadSurfaceMap('/nonexistent/does-not-exist.json'), {});
});

test('the tournament surface map is the fallback when the cache carries no surface', () => {
  const row = makeRow({ game: 'Sobolieva vs Samson' });
  let seenSurface = null;
  const stats = attachTennisElo([row], {
    snapshot: { players: { WTA: {} } },
    lookupMatchTimeImpl: () => ({ category: 'WTA - SINGLES', tournament: 'Ljubljana (Slovenia)', surface: '' }),
    surfaceOfImpl: () => null, // the real cache ships an empty surface
    surfaceMap: { ljubljana: 'clay' },
    lookupMatchImpl: (opts) => {
      seenSurface = opts.surface;
      return { records: [{ source: 'tennis_elo' }], reasonKind: null };
    }
  });
  assert.equal(stats.attached, 1);
  assert.equal(seenSurface, 'clay');
});

test('a cache surface wins over the map', () => {
  let seenSurface = null;
  attach([makeRow()], {
    surfaceOfImpl: () => 'grass',
    surfaceMap: { ljubljana: 'clay' },
    lookupMatchImpl: (opts) => {
      seenSurface = opts.surface;
      return { records: [{ source: 'tennis_elo' }], reasonKind: null };
    }
  });
  assert.equal(seenSurface, 'grass');
});

test('no cache surface and no map entry stays fail-closed', () => {
  const row = makeRow();
  const stats = attachTennisElo([row], {
    snapshot: { players: { WTA: {} } },
    lookupMatchTimeImpl: () => ({ category: 'WTA - SINGLES', tournament: 'Nowhere (Nowhereland)', surface: '' }),
    surfaceOfImpl: () => null,
    surfaceMap: { ljubljana: 'clay' },
    lookupMatchImpl: () => ({ records: [{ source: 'tennis_elo' }], reasonKind: null })
  });
  assert.equal(stats.attached, 0);
  assert.equal(stats.skipped.unknown_surface, 1);
  assert.equal(row.ratings, undefined);
});

test('a month-scoped map entry beats the season-level one for the same place', () => {
  // Sao Paulo is clay in February and hard in September; the season majority is
  // clay, so without the month key the September event would be mislabelled.
  const map = { 'sao paulo': 'clay', 'sao paulo|2026-09': 'hard' };
  let seenSurface = null;
  attachTennisElo([makeRow({ start: '2026-09-17T15:00:00.000Z' })], {
    snapshot: { players: { WTA: {} } },
    lookupMatchTimeImpl: () => ({ category: 'WTA - SINGLES', tournament: 'Sao Paulo (Brazil)', surface: '' }),
    surfaceOfImpl: () => null,
    surfaceMap: map,
    lookupMatchImpl: (opts) => {
      seenSurface = opts.surface;
      return { records: [{ source: 'tennis_elo' }], reasonKind: null };
    }
  });
  assert.equal(seenSurface, 'hard');
});
