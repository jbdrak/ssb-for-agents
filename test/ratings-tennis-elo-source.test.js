'use strict';

// Tennis-elo port, part 3: the surface-aware Elo model as a first-class source
// in the SAME external-ratings layer (contract + overlay), not a parallel path.
//
// The adapter is a pure normalizer fed by the local snapshot data layer
// (`lib/tennis-elo-data.js`): no network, no fetch, no bundled data. Every test
// here is hermetic — fixtures come from `importMatchData` with an injected
// builder, so the real resolver/data-layer shape is exercised without touching
// the network or the real state dir.
//
// Three reason strings this layer must never collapse into one (a reason is a
// claim that must be literally true): "player not in snapshot", "snapshot not
// valid for this prediction date", and "surface unknown". Each carries its own
// `reasonKind`.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { importMatchData, loadSnapshot } = require('../lib/tennis-elo-data');
const { SOURCES, supportedLeagues, validateRatingRecord } = require('../lib/ssb-ratings-contract');
const { applyRatingsOverlay } = require('../lib/ssb-ratings-overlay');
const tennisElo = require('../lib/ratings-sources/tennis-elo');

// A minimal, hand-checkable match CSV: the importer only needs parseable rows
// on/before `asOf` with distinct players. The ratings themselves come from the
// injected builder below (the engine's native pool shape).
const CSV = [
  'date,tour,surface,winner,loser,status',
  '2026-01-01,ATP,hard,Novak Djokovic,Carlos Alcaraz,completed',
  '2026-01-02,ATP,clay,Novak Djokovic,Carlos Alcaraz,completed',
  '2026-01-03,WTA,hard,Iga Swiatek,Aryna Sabalenka,completed'
].join('\n');

// The engine's serialized pool entry: `overall` + per-surface `{rating, matches}`.
// Two hand-computed blend cases:
//   - hard:  Djokovic hard.matches 20 and Alcaraz 12, both >= minSurfaceMatches,
//            so BOTH use the blended (surface-aware) rating:
//            Djokovic 2100 + 0.5*(2150-2100) = 2125; Alcaraz 2050 + 0.5*(2080-2050) = 2065.
//   - clay:  Djokovic 10 >= 5 but Alcaraz 4 < 5, so the pair does NOT blend and
//            BOTH fall back to `overall` (2100 / 2050) — the engine's pair rule.
// `Alias Twin One`/`Two` share the alias "Twin" so the resolver reports
// `ambiguous` rather than picking one.
function surfaces(overall, hardRating, hardMatches, clayRating, clayMatches, grassRating, grassMatches) {
  return {
    hard: { rating: hardRating, matches: hardMatches },
    clay: { rating: clayRating, matches: clayMatches },
    grass: { rating: grassRating, matches: grassMatches }
  };
}

function fakeBuilder() {
  const players = {
    ATP: {
      'Novak Djokovic': {
        name: 'Novak Djokovic',
        overall: 2100,
        surfaces: surfaces(2100, 2150, 20, 2080, 10, 2000, 3),
        totalMatches: 33,
        lastMatchDate: '2026-01-02'
      },
      'Carlos Alcaraz': {
        name: 'Carlos Alcaraz',
        overall: 2050,
        surfaces: surfaces(2050, 2080, 12, 2000, 4, 1900, 2),
        totalMatches: 18,
        lastMatchDate: '2026-01-02'
      },
      'Alias Twin One': {
        name: 'Alias Twin One',
        aliases: ['Twin'],
        overall: 1600,
        surfaces: surfaces(1600, 1600, 0, 1600, 0, 1600, 0),
        totalMatches: 0
      },
      'Alias Twin Two': {
        name: 'Alias Twin Two',
        aliases: ['Twin'],
        overall: 1500,
        surfaces: surfaces(1500, 1500, 0, 1500, 0, 1500, 0),
        totalMatches: 0
      }
    },
    WTA: {
      'Iga Swiatek': {
        name: 'Iga Swiatek',
        overall: 2200,
        surfaces: surfaces(2200, 2250, 30, 2300, 25, 2100, 5),
        totalMatches: 60
      },
      'Aryna Sabalenka': {
        name: 'Aryna Sabalenka',
        overall: 2150,
        surfaces: surfaces(2150, 2180, 22, 2100, 8, 2050, 4),
        totalMatches: 34
      }
    }
  };
  return { players, constants: { k: 32, surfaceWeight: 0.5, minSurfaceMatches: 5 }, matchCount: 3 };
}

const MANIFEST_AS_OF = '2026-09-13';
const IMPORTED_AT = '2026-09-14T00:00:00Z';
const SOURCE_URL = 'https://example.invalid/tennis_atp.csv';
const PREDICTION_DATE = '2026-09-20';

let tmpRoot;

function writeCsv(dir) {
  const file = path.join(dir, 'matches.csv');
  fs.writeFileSync(file, CSV, 'utf8');
  return file;
}

function build(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'snap-'));
  const write = overrides.write === true;
  return importMatchData({
    inputPath: writeCsv(dir),
    outputPath: write ? path.join(dir, 'tennis-elo-snapshot.json') : undefined,
    license: 'CC BY-NC-SA 4.0 (user-verified)',
    asOf: MANIFEST_AS_OF,
    importedAt: IMPORTED_AT,
    modelVersion: 'tennis-elo-1.1.0',
    sourceUrl: SOURCE_URL,
    buildRatingsImpl: fakeBuilder,
    write,
    ...overrides
  });
}

/** The happy-path call: a resolved ATP hard-court moneyline lookup. */
function lookup(snapshot, overrides = {}) {
  return tennisElo.lookupMatch({
    snapshot,
    tour: 'atp',
    playerA: 'Novak Djokovic',
    playerB: 'Carlos Alcaraz',
    surface: 'hard',
    market: 'Moneyline',
    asOf: PREDICTION_DATE,
    ...overrides
  });
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-elo-source-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('tennis-elo source adapter: coverage', () => {
  it('is a first-class source in the contract', () => {
    assert.ok(SOURCES.includes('tennis_elo'), 'the contract must know the tennis_elo source');
    assert.deepEqual(supportedLeagues('tennis_elo'), ['TENNIS']);
    assert.equal(tennisElo.SOURCE, 'tennis_elo');
  });

  it('claims TENNIS only, and never calls a repo league unrecognized', () => {
    assert.deepEqual(tennisElo.supportedLeagues(), ['TENNIS']);
    assert.equal(tennisElo.unsupportedReason('TENNIS'), null);
    assert.equal(tennisElo.unsupportedReason('tennis'), null);

    const nfl = tennisElo.unsupportedReason('NFL');
    assert.ok(nfl);
    assert.match(nfl, /tennis_elo/);
    assert.ok(nfl.includes('NFL'));
    assert.doesNotMatch(nfl, /not a recognized league code/i);

    const typo = tennisElo.unsupportedReason('NCAFF');
    assert.match(typo, /not a recognized league code/i);
    assert.notEqual(typo, nfl);
  });
});

describe('tennis-elo source adapter: resolved match', () => {
  it('emits surface-aware ratings for both sides from the snapshot manifest', () => {
    const result = lookup(build());

    assert.equal(result.source, 'tennis_elo');
    assert.equal(result.league, 'TENNIS');
    assert.equal(result.coverage, 'full');
    assert.equal(result.unresolvedReason, null);
    assert.equal(result.reasonKind, null);
    assert.equal(result.records.length, 1);

    const record = result.records[0];
    assert.equal(record.teamA, 'Novak Djokovic');
    assert.equal(record.teamB, 'Carlos Alcaraz');
    // Blended (surface-aware) hard-court Elo, not the bare overall rating.
    assert.equal(record.ratingA, 2125);
    assert.equal(record.ratingB, 2065);
    // Per-row provenance comes from the snapshot manifest.
    assert.equal(record.asOf, MANIFEST_AS_OF);
    assert.equal(record.fetchedAt, IMPORTED_AT);
    assert.equal(record.sourceUrl, SOURCE_URL);
    assert.equal(record.sourceHash, result.sourceHash);
    assert.match(record.sourceHash, /^[0-9a-f]{64}$/);
  });

  it('uses overall ratings when the PAIR does not both have the surface sample', () => {
    // clay: Djokovic 10 surface matches, Alcaraz only 4 -> no blend for the pair.
    const result = lookup(build(), { surface: 'clay' });
    const record = result.records[0];
    assert.equal(record.ratingA, 2100);
    assert.equal(record.ratingB, 2050);
  });

  it('resolves a WTA pair from the same snapshot (tours never pool)', () => {
    const result = lookup(build(), {
      tour: 'wta',
      playerA: 'Iga Swiatek',
      playerB: 'Aryna Sabalenka'
    });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].ratingA, 2225);
    assert.equal(result.records[0].ratingB, 2165);
  });

  it('resolves an explicit alias to the snapshot identity', () => {
    const result = lookup(build(), {
      playerA: 'Alias Twin One',
      playerB: 'Novak Djokovic'
    });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].teamA, 'Alias Twin One');
    assert.equal(result.records[0].ratingA, 1600);
  });

  it('produces a record the shared contract validator accepts', () => {
    const record = lookup(build()).records[0];
    const { ok, errors } = validateRatingRecord(record);
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
  });

  it('scopes the record to Moneyline so it cannot imply a totals opinion', () => {
    const record = lookup(build()).records[0];
    assert.equal(record.market, 'Moneyline');
  });

  it('consumes a real loadSnapshot({ asOf }) result end to end', () => {
    const snapshotPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'file-')), 'snap.json');
    build({ write: true, outputPath: snapshotPath });

    const loaded = loadSnapshot({ pathOverride: snapshotPath, asOf: PREDICTION_DATE });
    assert.equal(loaded.available, true);

    const result = lookup(loaded);
    assert.equal(result.coverage, 'full');
    assert.equal(result.records[0].ratingA, 2125);
  });
});

describe('tennis-elo source adapter: honest unavailability', () => {
  it('refuses a non-Moneyline market without touching the snapshot', () => {
    // A snapshot that throws on ANY read proves zero snapshot I/O for a market
    // Elo cannot model — the same fail-closed shape the old overlay used.
    const boobyTrap = {
      get players() {
        throw new Error('snapshot must not be read for a non-Moneyline market');
      }
    };
    for (const market of ['Total Games', 'Set Handicap', 'Game Handicap']) {
      const result = lookup(boobyTrap, { market });
      assert.equal(result.coverage, 'unavailable');
      assert.equal(result.reasonKind, 'unsupported_market');
      assert.deepEqual(result.records, []);
      assert.ok(result.unresolvedReason.includes(market));
      assert.match(result.unresolvedReason, /[Mm]oneyline/);
    }
  });

  it('names an unknown player, distinctly from every other cause', () => {
    const result = lookup(build(), { playerB: 'Nobody Known' });
    assert.equal(result.coverage, 'unavailable');
    assert.deepEqual(result.records, []);
    assert.equal(result.reasonKind, 'unknown_player');
    assert.ok(result.unresolvedReason.includes('Nobody Known'));
    assert.doesNotMatch(result.unresolvedReason, /surface|Too old|not before/i);
  });

  it('names an ambiguous alias instead of guessing a player', () => {
    const result = lookup(build(), { playerA: 'Twin', playerB: 'Novak Djokovic' });
    assert.equal(result.reasonKind, 'ambiguous_player');
    assert.match(result.unresolvedReason, /[Aa]mbiguous/);
  });

  it('names an unknown tour', () => {
    const result = lookup(build(), { tour: 'itf' });
    assert.equal(result.reasonKind, 'unknown_tour');
    assert.deepEqual(result.records, []);
  });

  it('names an unknown surface, distinctly from a player or snapshot cause', () => {
    const result = lookup(build(), { surface: 'carpet' });
    assert.equal(result.coverage, 'unavailable');
    assert.equal(result.reasonKind, 'unknown_surface');
    assert.ok(result.unresolvedReason.includes('carpet'));
    assert.doesNotMatch(result.unresolvedReason, /player|snapshot/i);
  });

  it('refuses a snapshot that is not strictly before the prediction date', () => {
    const snapshot = build();
    for (const asOf of [MANIFEST_AS_OF, '2026-09-01']) {
      const result = lookup(snapshot, { asOf });
      assert.equal(result.coverage, 'unavailable');
      assert.equal(result.reasonKind, 'snapshot_after_cutoff');
      assert.ok(result.unresolvedReason.includes(MANIFEST_AS_OF));
      assert.ok(result.unresolvedReason.includes(asOf));
      assert.doesNotMatch(result.unresolvedReason, /player|surface/i);
    }
  });

  it('refuses a snapshot older than the caller-supplied freshness cutoff', () => {
    const result = lookup(build(), { snapshotNotBefore: '2026-09-18' });
    assert.equal(result.coverage, 'unavailable');
    assert.equal(result.reasonKind, 'snapshot_stale');
    assert.ok(result.unresolvedReason.includes(MANIFEST_AS_OF));
    assert.ok(result.unresolvedReason.includes('2026-09-18'));
    assert.deepEqual(result.records, []);
  });

  it('requires a prediction date rather than skipping point-in-time discipline', () => {
    const result = lookup(build(), { asOf: undefined });
    assert.equal(result.reasonKind, 'missing_asof');
    assert.deepEqual(result.records, []);
  });

  it('reports a missing snapshot honestly (never a fabricated record)', () => {
    for (const snapshot of [null, undefined, { available: false, reason: 'not_found', path: '/tmp/x.json' }]) {
      const result = lookup(snapshot);
      assert.equal(result.coverage, 'unavailable');
      assert.deepEqual(result.records, []);
      assert.ok(result.unresolvedReason.length > 0);
    }
    assert.equal(
      lookup({ available: false, reason: 'not_found', path: '/tmp/x.json' }).reasonKind,
      'snapshot_unavailable'
    );
  });

  it('maps the data-layer after_cutoff refusal through without inventing a record', () => {
    const snapshotPath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'stale-')), 'snap.json');
    build({ write: true, outputPath: snapshotPath });
    const loaded = loadSnapshot({ pathOverride: snapshotPath, asOf: '2026-09-01' });
    assert.equal(loaded.reason, 'after_cutoff');

    const result = lookup(loaded, { asOf: '2026-09-01' });
    assert.equal(result.reasonKind, 'snapshot_after_cutoff');
    assert.deepEqual(result.records, []);
  });

  it('never emits an event-shaped record for a single player (team-list lesson)', () => {
    const result = lookup(build(), { playerB: 'Novak Djokovic' });
    assert.equal(result.reasonKind, 'same_player');
    assert.deepEqual(result.records, []);
    assert.ok(!result.records.some((record) => record.teamA === record.teamB));
  });

  it('fails closed when the snapshot manifest carries no sourceUrl provenance', () => {
    const result = lookup(build({ sourceUrl: null }));
    assert.equal(result.coverage, 'unavailable');
    assert.equal(result.reasonKind, 'missing_provenance');
    assert.match(result.unresolvedReason, /sourceUrl/);
    // The refusal must name the fix, not just the gap: the only remaining way
    // to reach this state is an engine-only or hand-built snapshot.
    assert.match(result.unresolvedReason, /--source-url/);
    assert.deepEqual(result.records, []);
  });
});

describe('tennis-elo source adapter: overlay join', () => {
  it('attaches a tennis Elo record to a tennis Moneyline row', () => {
    const [record] = lookup(build()).records;
    const rows = applyRatingsOverlay(
      [
        { league: 'TENNIS', market: 'Moneyline', game: 'Carlos Alcaraz vs Novak Djokovic', selection: 'Novak Djokovic' }
      ],
      { ratings: [record] }
    );

    assert.ok(Object.prototype.hasOwnProperty.call(rows[0].ratings, 'tennis_elo'));
    assert.equal(rows[0].ratings.tennis_elo.game, 'Carlos Alcaraz vs Novak Djokovic');
    assert.equal(rows[0].ratings.tennis_elo.records[0].ratingA, 2125);
    assert.equal(rows[0].ratings.tennis_elo.records[0].ratingB, 2065);
  });

  it('joins order-independently and does not bleed onto a different fixture', () => {
    const [record] = lookup(build()).records;
    const rows = applyRatingsOverlay(
      [
        { league: 'TENNIS', market: 'Moneyline', game: 'Novak Djokovic vs Carlos Alcaraz' },
        { league: 'TENNIS', market: 'Moneyline', game: 'Iga Swiatek vs Aryna Sabalenka' }
      ],
      { ratings: [record] }
    );
    assert.equal(rows[0].ratings.tennis_elo.records.length, 1);
    assert.equal(rows[1].ratings.tennis_elo, null);
  });

  it('does not attach a Moneyline-scoped Elo record to a totals row', () => {
    const [record] = lookup(build()).records;
    const rows = applyRatingsOverlay(
      [{ league: 'TENNIS', market: 'Total Games', game: 'Novak Djokovic vs Carlos Alcaraz' }],
      { ratings: [record] }
    );
    assert.equal(rows[0].ratings.tennis_elo, null);
  });

  it('leaves every other source null, and stays rank-neutral', () => {
    const [record] = lookup(build()).records;
    const row = {
      league: 'TENNIS',
      market: 'Moneyline',
      game: 'Novak Djokovic vs Carlos Alcaraz',
      kaiCall: 'BET',
      displayTier: 'TIER 1',
      finalVerdict: 'BET',
      consensusEdge: 3.1,
      screenScore: 7.7,
      riskScore: 0.2
    };
    const [out] = applyRatingsOverlay([structuredClone(row)], { ratings: [record] });
    assert.equal(out.ratings.massey, null);
    assert.equal(out.ratings.sagarin, null);
    assert.equal(out.ratings.sasser, null);
    for (const field of ['kaiCall', 'displayTier', 'finalVerdict', 'consensusEdge', 'screenScore', 'riskScore']) {
      assert.equal(out[field], row[field], `${field} changed`);
    }
  });
});
