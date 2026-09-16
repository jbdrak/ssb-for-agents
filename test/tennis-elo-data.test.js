'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const eloData = require('../lib/tennis-elo-data');
const { parseMatchCsv, importMatchData, loadSnapshot, resolvePlayer, normalizeName } = eloData;

// A tiny, hand-checkable CSV. Three completed matches (2 ATP, 1 WTA) and one
// walkover the engine skips: rowCount 4, matchCount 3, playerCount 5.
const CSV = [
  'date,tour,surface,winner,loser,status',
  '2026-01-01,ATP,hard,Novak Djokovic,Carlos Alcaraz,completed',
  '2026-01-02,ATP,clay,Novak Djokovic,Rafael Nadal,completed',
  '2026-01-03,WTA,hard,Iga Swiatek,Aryna Sabalenka,completed',
  '2026-01-04,ATP,hard,Daniel Evans,Andy Murray,walkover'
].join('\n');

// Mirrors the engine's skip semantics without depending on it: only completed
// rows enter the pools. Keeps the importer tests deterministic and engine-free.
function fakeBuilder(rows) {
  const players = { ATP: {}, WTA: {} };
  let matchCount = 0;
  for (const row of rows) {
    if (row.status !== 'completed') continue;
    matchCount += 1;
    const pool = players[row.tour.toUpperCase()];
    for (const who of [row.winner, row.loser]) {
      if (!pool[who]) pool[who] = { name: who, overall: 1500 + matchCount };
    }
  }
  return { players, matchCount, constants: { k: 32, seed: 1500 } };
}

const MANIFEST_KEYS = [
  'asOf',
  'generator',
  'importedAt',
  'license',
  'matchCount',
  'modelVersion',
  'playerCount',
  'rowCount',
  'schemaVersion',
  'sourceHash',
  'sourcePath',
  'sourceUrl'
];

let tmpRoot;

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function writeCsv(dir, content = CSV) {
  const file = path.join(dir, 'matches.csv');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/** Apply env overrides and return a restore function (call in `finally`). */
function withEnv(overrides) {
  const saved = {};
  // The module reads the SSB_ spellings FIRST: keep them out of the way unless a
  // case sets one explicitly, so an ambient export cannot decide the path.
  const effective = {
    SSB_RATINGS_DIR: undefined,
    SSB_TENNIS_ELO_SNAPSHOT: undefined,
    ...overrides
  };
  for (const [key, value] of Object.entries(effective)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-elo-data-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('parseMatchCsv', () => {
  it('parses the header plus rows and numbers them from line 2', () => {
    const rows = parseMatchCsv(`${CSV}\n`);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].rowNumber, 2);
    assert.equal(rows[0].winner, 'Novak Djokovic');
    assert.equal(rows[3].status, 'walkover');
  });

  it('rejects a CSV whose header is missing a required column', () => {
    assert.throws(
      () => parseMatchCsv('date,tour,surface,winner,loser\n2026-01-01,ATP,hard,A,B\n'),
      /missing required column/
    );
  });
});

describe('importMatchData', () => {
  it('round-trips a CSV through the manifest', () => {
    const dir = freshDir('roundtrip');
    const inputPath = writeCsv(dir);
    const outputPath = path.join(dir, 'snapshot.json');
    const bytes = fs.readFileSync(inputPath);

    const snapshot = importMatchData({
      inputPath,
      outputPath,
      license: 'CC BY-NC-SA 4.0 (user-verified)',
      asOf: '2026-01-04',
      importedAt: '2026-01-05T12:00:00Z',
      modelVersion: 'tennis-elo@1.1.0',
      buildRatingsImpl: fakeBuilder
    });

    const onDisk = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.deepEqual(onDisk, snapshot, 'the returned snapshot is byte-identical to the file');

    const manifest = snapshot.manifest;
    assert.deepEqual(Object.keys(manifest).sort(), MANIFEST_KEYS, 'manifest schema is locked');
    assert.equal(manifest.sourceHash, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(manifest.asOf, '2026-01-04');
    assert.equal(manifest.importedAt, '2026-01-05T12:00:00Z');
    assert.equal(manifest.modelVersion, 'tennis-elo@1.1.0');
    assert.equal(manifest.license, 'CC BY-NC-SA 4.0 (user-verified)');
    assert.equal(manifest.sourceUrl, null);
    assert.equal(manifest.rowCount, 4);
    assert.equal(manifest.matchCount, 3);
    assert.equal(manifest.playerCount, 5);

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.modelVersion, 'tennis-elo@1.1.0');
    assert.equal(snapshot.players.ATP['NOVAK DJOKOVIC'].name, 'Novak Djokovic');
    assert.deepEqual(snapshot.engine.constants, { k: 32, seed: 1500 });
  });

  it('refuses a run missing license, asOf, importedAt, modelVersion, inputPath or outputPath', () => {
    const dir = freshDir('required');
    const inputPath = writeCsv(dir);
    const base = {
      inputPath,
      outputPath: path.join(dir, 'snapshot.json'),
      license: 'CC BY-NC-SA 4.0',
      asOf: '2026-01-04',
      importedAt: '2026-01-05T12:00:00Z',
      modelVersion: 'tennis-elo@1.1.0',
      buildRatingsImpl: fakeBuilder
    };
    for (const key of ['inputPath', 'outputPath', 'license', 'asOf', 'importedAt', 'modelVersion']) {
      const options = { ...base };
      delete options[key];
      assert.throws(() => importMatchData(options), new RegExp(`${key} is required`), `missing ${key} must be refused`);
    }
  });

  it('refuses a future-leaking row dated after asOf', () => {
    const dir = freshDir('leak');
    const inputPath = writeCsv(
      dir,
      ['date,tour,surface,winner,loser,status', '2026-02-01,ATP,hard,Novak Djokovic,Carlos Alcaraz,completed'].join(
        '\n'
      )
    );
    assert.throws(
      () =>
        importMatchData({
          inputPath,
          outputPath: path.join(dir, 'snapshot.json'),
          license: 'CC BY-NC-SA 4.0',
          asOf: '2026-01-31',
          importedAt: '2026-02-01T00:00:00Z',
          modelVersion: 'tennis-elo@1.1.0',
          buildRatingsImpl: fakeBuilder
        }),
      /future-leaking row/
    );
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    const dir = freshDir('baddate');
    const inputPath = writeCsv(
      dir,
      ['date,tour,surface,winner,loser,status', '20260101,ATP,hard,Novak Djokovic,Carlos Alcaraz,completed'].join('\n')
    );
    assert.throws(
      () =>
        importMatchData({
          inputPath,
          outputPath: path.join(dir, 'snapshot.json'),
          license: 'CC BY-NC-SA 4.0',
          asOf: '2026-12-31',
          importedAt: '2026-12-31T00:00:00Z',
          modelVersion: 'tennis-elo@1.1.0',
          buildRatingsImpl: fakeBuilder
        }),
      /is not YYYY-MM-DD/
    );
  });

  it('write:false builds and validates but writes nothing', () => {
    const dir = freshDir('nowrite');
    const inputPath = writeCsv(dir);
    const outputPath = path.join(dir, 'never-written.json');
    const snapshot = importMatchData({
      inputPath,
      outputPath,
      license: 'CC BY-NC-SA 4.0',
      asOf: '2026-01-04',
      importedAt: '2026-01-05T12:00:00Z',
      modelVersion: 'tennis-elo@1.1.0',
      buildRatingsImpl: fakeBuilder,
      write: false
    });
    assert.equal(snapshot.manifest.rowCount, 4);
    assert.equal(fs.existsSync(outputPath), false);
    assert.deepEqual(fs.readdirSync(dir), ['matches.csv'], 'only the input CSV exists');
  });

  it('refuses an alias pointing at a player the engine never produced', () => {
    const dir = freshDir('alias');
    const inputPath = writeCsv(dir);
    assert.throws(
      () =>
        importMatchData({
          inputPath,
          outputPath: path.join(dir, 'snapshot.json'),
          license: 'CC BY-NC-SA 4.0',
          asOf: '2026-01-04',
          importedAt: '2026-01-05T12:00:00Z',
          modelVersion: 'tennis-elo@1.1.0',
          buildRatingsImpl: fakeBuilder,
          aliases: { ATP: { Ghost: 'Nobody At All' } }
        }),
      /points to unknown player/
    );
  });
});

describe('local state paths', () => {
  it('defaultSnapshotPath follows PP_RATINGS_DIR and stays out of HOME', () => {
    const dir = freshDir('statedir');
    const restore = withEnv({ PP_RATINGS_DIR: dir, PP_TENNIS_ELO_SNAPSHOT: undefined });
    try {
      const resolved = eloData.defaultSnapshotPath();
      assert.equal(resolved, path.join(dir, 'tennis-elo-snapshot.json'));
      assert.ok(resolved.startsWith(dir));
      assert.ok(!resolved.startsWith(os.homedir()), 'never resolves into HOME while PP_RATINGS_DIR is set');
    } finally {
      restore();
    }
  });

  it('PP_TENNIS_ELO_SNAPSHOT wins over the ratings dir', () => {
    const dir = freshDir('envsnap');
    const explicit = path.join(dir, 'explicit.json');
    const restore = withEnv({ PP_RATINGS_DIR: dir, PP_TENNIS_ELO_SNAPSHOT: explicit });
    try {
      assert.equal(eloData.defaultSnapshotPath(), explicit);
    } finally {
      restore();
    }
  });
});

describe('loadSnapshot', () => {
  it('degrades to not_found when no snapshot exists', () => {
    const dir = freshDir('missing');
    const restore = withEnv({ PP_RATINGS_DIR: dir, PP_TENNIS_ELO_SNAPSHOT: undefined });
    try {
      const result = loadSnapshot();
      assert.equal(result.available, false);
      assert.equal(result.reason, 'not_found');
      assert.equal(result.path, path.join(dir, 'tennis-elo-snapshot.json'));
    } finally {
      restore();
    }
  });

  it('serves a strictly-older snapshot and refuses one at or after the cutoff', () => {
    const dir = freshDir('cutoff');
    const inputPath = writeCsv(dir);
    const restore = withEnv({ PP_RATINGS_DIR: dir, PP_TENNIS_ELO_SNAPSHOT: undefined });
    try {
      importMatchData({
        inputPath,
        outputPath: eloData.defaultSnapshotPath(),
        license: 'CC BY-NC-SA 4.0 (user-verified)',
        asOf: '2026-01-04',
        importedAt: '2026-01-05T12:00:00Z',
        modelVersion: 'tennis-elo@1.1.0',
        buildRatingsImpl: fakeBuilder
      });

      const ok = loadSnapshot({ asOf: '2026-06-01' });
      assert.equal(ok.available, true);
      assert.equal(ok.asOf, '2026-01-04');
      assert.equal(ok.manifest.sourceHash, ok.snapshot.manifest.sourceHash);
      assert.equal(ok.manifest.license, 'CC BY-NC-SA 4.0 (user-verified)');
      assert.ok(ok.snapshot.players.ATP);

      const newer = loadSnapshot({ asOf: '2026-01-03' });
      assert.equal(newer.available, false);
      assert.equal(newer.reason, 'after_cutoff');
      assert.equal(newer.snapshotAsOf, '2026-01-04');
      assert.equal(newer.cutoff, '2026-01-03');

      const equal = loadSnapshot({ asOf: '2026-01-04' });
      assert.equal(equal.available, false, 'a snapshot is only usable strictly before the cutoff');
      assert.equal(equal.reason, 'after_cutoff');
    } finally {
      restore();
    }
  });

  it('accepts an explicit path override (string or options object)', () => {
    const dir = freshDir('override');
    const inputPath = writeCsv(dir);
    const outputPath = path.join(dir, 'snap.json');
    importMatchData({
      inputPath,
      outputPath,
      license: 'CC BY-NC-SA 4.0',
      asOf: '2026-01-04',
      importedAt: '2026-01-05T12:00:00Z',
      modelVersion: 'tennis-elo@1.1.0',
      buildRatingsImpl: fakeBuilder
    });
    assert.equal(loadSnapshot(outputPath).available, true);
    assert.equal(loadSnapshot({ pathOverride: outputPath }).available, true);
  });

  it('reports invalid for a file with no manifest sourceHash', () => {
    const dir = freshDir('invalid');
    const file = path.join(dir, 'snapshot.json');
    fs.writeFileSync(file, JSON.stringify({ players: { ATP: {} } }), 'utf8');
    const result = loadSnapshot(file);
    assert.equal(result.available, false);
    assert.equal(result.reason, 'invalid');
    assert.match(result.error, /sourceHash/);
  });
});

describe('resolvePlayer', () => {
  function snapshotWithAliases(aliases) {
    const dir = freshDir('resolve');
    const inputPath = writeCsv(dir);
    return importMatchData({
      inputPath,
      outputPath: path.join(dir, 'snapshot.json'),
      license: 'CC BY-NC-SA 4.0',
      asOf: '2026-01-04',
      importedAt: '2026-01-05T12:00:00Z',
      modelVersion: 'tennis-elo@1.1.0',
      buildRatingsImpl: fakeBuilder,
      aliases
    });
  }

  it('resolves an exact normalized full name', () => {
    const snapshot = snapshotWithAliases();
    const hit = resolvePlayer(snapshot, { tour: 'ATP', name: 'novak djokovic' });
    assert.equal(hit.available, true);
    assert.equal(hit.id, 'NOVAK DJOKOVIC');
    assert.equal(hit.name, 'Novak Djokovic');
    assert.equal(hit.matchedBy, 'exact_name');
  });

  it('resolves a unique explicit alias, but never a bare surname', () => {
    const snapshot = snapshotWithAliases({ ATP: { 'The Joker': 'Novak Djokovic' } });
    const alias = resolvePlayer(snapshot, { tour: 'ATP', name: 'the joker' });
    assert.equal(alias.available, true);
    assert.equal(alias.matchedBy, 'alias');
    assert.equal(alias.id, 'NOVAK DJOKOVIC');

    const surname = resolvePlayer(snapshot, { tour: 'ATP', name: 'Djokovic' });
    assert.equal(surname.available, false);
    assert.equal(surname.reason, 'unknown_player');
  });

  it('reports unknown_player / unknown_tour / missing_snapshot explicitly', () => {
    const snapshot = snapshotWithAliases();
    const unknown = resolvePlayer(snapshot, { tour: 'ATP', name: 'Roger Federer' });
    assert.equal(unknown.available, false);
    assert.equal(unknown.reason, 'unknown_player');

    const tour = resolvePlayer(snapshot, { tour: 'ITF', name: 'Novak Djokovic' });
    assert.equal(tour.available, false);
    assert.equal(tour.reason, 'unknown_tour');

    const missing = resolvePlayer(null, { tour: 'ATP', name: 'Novak Djokovic' });
    assert.equal(missing.available, false);
    assert.equal(missing.reason, 'missing_snapshot');
  });

  it('never fuzzy-matches an alias that maps to two players', () => {
    const snapshot = {
      players: { ATP: { ALPHA: { name: 'Alpha' }, BETA: { name: 'Beta' } } },
      aliasIndex: { ATP: { SHARED: ['ALPHA', 'BETA'] } }
    };
    const hit = resolvePlayer(snapshot, { tour: 'ATP', name: 'shared' });
    assert.equal(hit.available, false);
    assert.equal(hit.reason, 'ambiguous');
    assert.deepEqual(hit.candidates, ['ALPHA', 'BETA']);
  });

  it('normalizeName strips diacritics but preserves punctuation', () => {
    assert.equal(normalizeName('Novák Djokovic'), 'NOVAK DJOKOVIC');
    assert.equal(normalizeName('Djokovic, Novak'), 'DJOKOVIC, NOVAK');
  });
});

describe('real engine integration', () => {
  let engineAvailable = false;
  try {
    require('../lib/tennis-elo');
    engineAvailable = true;
  } catch {
    /* engine absent: the integration case skips */
  }

  it('builds a real snapshot from the CSV via lib/tennis-elo.js', { skip: !engineAvailable }, () => {
    const dir = freshDir('engine');
    const inputPath = writeCsv(dir);
    const outputPath = path.join(dir, 'snapshot.json');
    const snapshot = importMatchData({
      inputPath,
      outputPath,
      license: 'CC BY-NC-SA 4.0 (user-verified)',
      asOf: '2026-01-04',
      importedAt: '2026-01-05T12:00:00Z',
      modelVersion: 'tennis-elo@1.1.0'
    });
    const manifest = snapshot.manifest;
    assert.equal(manifest.rowCount, 4);
    assert.equal(manifest.matchCount, 3, 'the walkover row is skipped by the engine');
    assert.equal(manifest.playerCount, 5);
    const djokovic = snapshot.players.ATP['NOVAK DJOKOVIC'];
    assert.equal(djokovic.name, 'Novak Djokovic');
    assert.ok(Number.isFinite(djokovic.overall));
    assert.notEqual(djokovic.overall, 1500, 'two wins must move the rating off the seed');
    assert.deepEqual(snapshot.engine.constants.k, 32);
  });
});
