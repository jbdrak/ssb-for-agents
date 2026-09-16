'use strict';

// Focused coverage for the `pp ratings` CLI surface (bin/pp-cli.js):
// `RATINGS_LEAGUE_ALIASES`, `canonicalRatingsLeague`, `ratingsList` and
// `cmdRatings`.
//
// Two things this command must never get wrong:
//
//   1. It is READ-ONLY. `pp ratings` lists snapshots another process wrote
//      (`node scripts/refresh-ratings.js`); it must never fetch and never build
//      a PropProfessor client. The read-only guarantee is proven three ways:
//      a process-level network recorder (with a positive control proving the
//      recorder fires), an in-process `globalThis.fetch` spy, and a structural
//      scan of the command's own source region.
//   2. The frontend vocabulary (`CFB`/`CBB`) must resolve to the canonical
//      snapshot leagues (`NCAAF`/`NCAAB`). A silent alias miss is exactly the
//      failure these aliases exist to prevent, so the aliases are asserted
//      against real snapshots on disk, not against the map itself.
//
// Everything is hermetic: snapshots are written through the production store
// into a temp `PP_RATINGS_DIR`, and no test path reaches the network.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/pp-cli');
const store = require('../lib/ssb-ratings-snapshot');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'pp-cli.js');

const FETCHED_AT = '2026-09-15T12:00:00.000Z';
const AS_OF = '2026-09-13';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Point PP_RATINGS_DIR at a throwaway dir, restored (and removed) after the test. */
function useRatingsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cli-ratings-'));
  const previous = process.env.PP_RATINGS_DIR;
  const previousSsb = process.env.SSB_RATINGS_DIR;
  process.env.PP_RATINGS_DIR = dir;
  // Canonical name wins over the deprecated alias, so it must not be ambient.
  delete process.env.SSB_RATINGS_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PP_RATINGS_DIR;
    else process.env.PP_RATINGS_DIR = previous;
    if (previousSsb === undefined) delete process.env.SSB_RATINGS_DIR;
    else process.env.SSB_RATINGS_DIR = previousSsb;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function captureConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

/**
 * Run `cmdRatings` exactly the way the CLI does: parse a real argv (so `-j`,
 * `--show`, `--source a,b` all go through the production flag parser) and pass
 * the resulting positional/flags pair to the command.
 */
async function runRatings(argv) {
  const { positional, flags } = cli.parseArgs(['node', 'pp', ...argv]);
  const capture = captureConsole();
  let result;
  try {
    result = await cli.cmdRatings(positional, flags);
  } finally {
    capture.restore();
  }
  return { result, logs: capture.logs, errors: capture.errors, flags };
}

function snapshotInput(source, league, season, recordCount = 2) {
  const sourceHash = ['sha256', source, league, season].join(':');
  return {
    source,
    league,
    season,
    method: 'overall',
    sourceUrl: `https://example.invalid/${source}/${league}`,
    asOf: AS_OF,
    fetchedAt: FETCHED_AT,
    sourceHash,
    records: Array.from({ length: recordCount }, (_unused, index) => ({
      source,
      league,
      sourceHash,
      coverage: 'full',
      matchStatus: 'unmatched',
      teamA: `Team${index}A`,
      teamB: `Team${index}B`
    }))
  };
}

function seed(dir, { source, league, season, recordCount = 2 }) {
  const saved = store.saveSnapshot(snapshotInput(source, league, season, recordCount));
  assert.equal(saved.ok, true, `fixture snapshot ${source}/${league}/${season} must save`);
  return saved.path;
}

// The fixture set deliberately mixes sources, leagues, aliased leagues and
// seasons so each filter has something to exclude.
const FIXTURES = [
  { source: 'sagarin', league: 'NCAAF', season: 2026, recordCount: 2 },
  { source: 'sasser', league: 'NCAAF', season: 2026, recordCount: 3 },
  { source: 'massey', league: 'NCAAB', season: 2026, recordCount: 4 },
  { source: 'massey', league: 'NBA', season: 2025, recordCount: 1 },
  { source: 'sagarin', league: 'NFL', season: 2025, recordCount: 2 }
];

// `listSnapshots` sorts by path, so this is the expected full listing order.
const ALL_IDS = ['massey NBA 2025', 'massey NCAAB 2026', 'sagarin NCAAF 2026', 'sagarin NFL 2025', 'sasser NCAAF 2026'];

function seedAll(t) {
  const dir = useRatingsDir(t);
  for (const fixture of FIXTURES) seed(dir, fixture);
  return dir;
}

const ids = (snapshots) => snapshots.map((snapshot) => `${snapshot.source} ${snapshot.league} ${snapshot.season}`);

const idsOf = async (argv) => {
  const { result } = await runRatings(argv);
  return ids(result.snapshots);
};

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('pp ratings: listing', () => {
  it('lists every snapshot in the state dir, sorted, one line each', async (t) => {
    seedAll(t);

    const { result, logs } = await runRatings(['ratings', '-j']);
    assert.equal(result.ok, true);
    assert.deepEqual(ids(result.snapshots), ALL_IDS, 'all fixtures are listed in path order');
    assert.deepEqual(
      result.snapshots.map((snapshot) => snapshot.valid),
      [true, true, true, true, true]
    );
    assert.deepEqual(
      result.snapshots.map((snapshot) => snapshot.recordCount),
      [1, 4, 2, 2, 3]
    );

    // Human listing: one line per snapshot with the summary fields.
    const { logs: humanLogs } = await runRatings(['ratings']);
    assert.equal(humanLogs.length, FIXTURES.length, 'exactly one line per snapshot');
    assert.equal(humanLogs[2], `sagarin NCAAF 2026 records=2 asOf=${AS_OF} fetchedAt=${FETCHED_AT}`);
    assert.match(humanLogs.join('\n'), /massey NCAAB 2026 records=4/);
    assert.equal(logs.length, 1, 'JSON mode prints a single payload and no listing lines');
  });

  it('reports a malformed snapshot as invalid instead of throwing', async (t) => {
    const dir = useRatingsDir(t);
    fs.writeFileSync(path.join(dir, 'sagarin-NCAAF-2026.json'), '{}\n', 'utf8');

    const { result, logs } = await runRatings(['ratings']);
    assert.equal(result.ok, true);
    assert.equal(result.snapshots.length, 1);
    assert.equal(result.snapshots[0].valid, false);
    assert.match(logs.join('\n'), /sagarin NCAAF 2026 invalid \(/);

    const { logs: showLogs } = await runRatings(['ratings', '--show']);
    const out = showLogs.join('\n');
    assert.match(out, /sagarin NCAAF 2026\s+invalid/);
    assert.match(out, /errors: invalid source/);
    assert.match(out, new RegExp(`path: .*sagarin-NCAAF-2026\\.json`));
  });
});

// ---------------------------------------------------------------------------
// League aliases
// ---------------------------------------------------------------------------

describe('pp ratings: league aliases resolve the frontend vocabulary', () => {
  it('--league CFB finds the canonical NCAAF snapshots (and only those)', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--league', 'CFB']), ['sagarin NCAAF 2026', 'sasser NCAAF 2026']);
  });

  it('--league CBB finds the canonical NCAAB snapshot', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--league', 'CBB']), ['massey NCAAB 2026']);
  });

  it('a canonical code works directly and is a no-op through the alias map', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--league', 'NCAAF']), await idsOf(['ratings', '--league', 'CFB']));
    assert.deepEqual(await idsOf(['ratings', '--league', 'NCAAB']), await idsOf(['ratings', '--league', 'CBB']));
  });

  it('the alias is case-insensitive and trims whitespace', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--league', 'cfb']), await idsOf(['ratings', '--league', 'CFB']));
    // A single (comma-nested) token with padding still canonicalizes.
    const direct = await runRatings(['ratings', '--league', ' cfb ']);
    assert.equal(direct.result.snapshots.length, 2);
  });

  it('an unmapped league passes through unchanged rather than silently matching NCAAF', async (t) => {
    seedAll(t);
    const { result } = await runRatings(['ratings', '--league', 'NBA']);
    assert.deepEqual(ids(result.snapshots), ['massey NBA 2025']);
  });

  it('a mis-typoed alias is an empty result, not a silent wrong-league match', async (t) => {
    seedAll(t);
    const { result, logs } = await runRatings(['ratings', '--league', 'CBF']);
    assert.deepEqual(result.snapshots, []);
    assert.match(logs.join('\n'), /No ratings snapshots found/);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('pp ratings: --source / --league / --season narrow the listing', () => {
  it('--source filters by source name', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--source', 'sagarin']), ['sagarin NCAAF 2026', 'sagarin NFL 2025']);
    assert.deepEqual(await idsOf(['ratings', '--source', 'sasser']), ['sasser NCAAF 2026']);
  });

  it('--source takes a comma list', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--source', 'sagarin,sasser']), [
      'sagarin NCAAF 2026',
      'sagarin NFL 2025',
      'sasser NCAAF 2026'
    ]);
  });

  it('--source is case-insensitive', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--source', 'SAGARIN']), ['sagarin NCAAF 2026', 'sagarin NFL 2025']);
  });

  it('--league takes a comma list of mixed aliases and canonical codes', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--league', 'CFB,NBA']), [
      'massey NBA 2025',
      'sagarin NCAAF 2026',
      'sasser NCAAF 2026'
    ]);
  });

  it('--season filters by season and accepts a comma list', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--season', '2025']), ['massey NBA 2025', 'sagarin NFL 2025']);
    assert.deepEqual(await idsOf(['ratings', '--season', '2025,2026']), ALL_IDS);
  });

  it('a non-numeric --season is ignored rather than matching everything', async (t) => {
    seedAll(t);
    // `Number('latest')` is NaN, which the command filters out, so no season
    // predicate is applied and the full listing survives.
    assert.deepEqual(await idsOf(['ratings', '--season', 'latest']), ALL_IDS);
  });

  it('combined filters intersect', async (t) => {
    seedAll(t);
    assert.deepEqual(await idsOf(['ratings', '--source', 'sagarin', '--league', 'CFB', '--season', '2026']), [
      'sagarin NCAAF 2026'
    ]);
    // Same source, aliased league, wrong source => nothing.
    assert.deepEqual(await idsOf(['ratings', '--source', 'massey', '--league', 'CFB']), []);
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe('pp ratings: -j / --json', () => {
  it('-j emits one valid JSON payload carrying the filtered snapshots', async (t) => {
    seedAll(t);

    const short = await runRatings(['ratings', '--source', 'sagarin', '-j']);
    assert.equal(short.logs.length, 1);
    const parsed = JSON.parse(short.logs[0]);
    assert.ok(Array.isArray(parsed.snapshots));
    assert.deepEqual(ids(parsed.snapshots), ['sagarin NCAAF 2026', 'sagarin NFL 2025']);
    for (const snapshot of parsed.snapshots) {
      assert.equal(snapshot.valid, true);
      assert.equal(typeof snapshot.path, 'string');
      assert.equal(snapshot.asOf, AS_OF);
      assert.equal(snapshot.fetchedAt, FETCHED_AT);
    }

    // `--json` is the long form of the same flag.
    const long = await runRatings(['ratings', '--source', 'sagarin', '--json']);
    assert.deepEqual(JSON.parse(long.logs[0]), parsed);
  });

  it('-j on an empty listing is still valid JSON (empty array, not the human message)', async (t) => {
    seedAll(t);
    const { logs } = await runRatings(['ratings', '--source', 'nope', '-j']);
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), { snapshots: [] });
  });
});

// ---------------------------------------------------------------------------
// --show
// ---------------------------------------------------------------------------

describe('pp ratings: --show', () => {
  it('prints per-snapshot detail without mutating the state dir', async (t) => {
    const dir = seedAll(t);
    const before = fs.readdirSync(dir).sort();
    const bytesBefore = Object.fromEntries(
      before.map((entry) => [entry, fs.readFileSync(path.join(dir, entry), 'utf8')])
    );

    const { result, logs } = await runRatings(['ratings', '--show', '--league', 'CFB']);
    const out = logs.join('\n');

    assert.deepEqual(ids(result.snapshots), ['sagarin NCAAF 2026', 'sasser NCAAF 2026']);
    assert.match(out, /sagarin NCAAF 2026/);
    assert.match(out, /method: overall/);
    assert.match(out, new RegExp(`asOf: ${AS_OF}`));
    assert.match(out, new RegExp(`fetchedAt: ${FETCHED_AT}`));
    assert.match(out, /records: 2/);
    assert.match(out, /sourceUrl: https:\/\/example\.invalid\/sagarin\/NCAAF/);
    assert.match(out, /sourceHash: sha256:sagarin:NCAAF:2026/);
    assert.match(out, /path: .*sagarin-NCAAF-2026\.json/);
    // Detail mode does NOT emit the one-line summary format.
    assert.doesNotMatch(out, /records=\d/);

    const after = fs.readdirSync(dir).sort();
    assert.deepEqual(after, before, 'no files added or removed');
    for (const entry of after) {
      assert.equal(fs.readFileSync(path.join(dir, entry), 'utf8'), bytesBefore[entry], `${entry} is unchanged`);
    }
  });

  it('--show on an empty listing prints the empty state, not a blank screen', async (t) => {
    seedAll(t);
    const { result, logs } = await runRatings(['ratings', '--show', '--league', 'CBB', '--season', '2025']);
    assert.deepEqual(result.snapshots, []);
    assert.match(logs.join('\n'), /No ratings snapshots found/);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('pp ratings: empty state', () => {
  it('an existing but empty state dir lists nothing and names how to create one', async (t) => {
    useRatingsDir(t);
    const { result, logs } = await runRatings(['ratings']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshots, []);
    const out = logs.join('\n');
    assert.match(out, /No ratings snapshots found/);
    assert.match(out, /node scripts\/refresh-ratings\.js --source <sources> --league <league>/);
  });

  it('a missing state dir (never refreshed) is not an error', async (t) => {
    const dir = useRatingsDir(t);
    fs.rmdirSync(dir);

    const { result, logs } = await runRatings(['ratings', '--show']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshots, []);
    assert.match(logs.join('\n'), /No ratings snapshots found/);
    assert.equal(fs.existsSync(dir), false, 'listing must not create the state dir');
  });

  it('the real CLI exits 0 with the guidance on stdout', (t) => {
    const dir = useRatingsDir(t);
    const result = spawnCli({ args: ['ratings'], ratingsDir: dir });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /No ratings snapshots found/);
    assert.match(result.stdout, /scripts\/refresh-ratings\.js/);
    assert.doesNotMatch(result.stderr, /Error|throw|\bat /, 'no throw on the empty path');
  });
});

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

const PRELOAD_SOURCE = `'use strict';
const fs = require('node:fs');
const out = process.env.PP_NETWORK_RECORD;
function record(kind) {
  if (!out) return;
  try {
    fs.appendFileSync(out, kind + '\\n');
  } catch {
    /* best effort */
  }
}
function wrap(mod, name) {
  const original = mod[name];
  if (typeof original !== 'function') return;
  mod[name] = function wrapped(...args) {
    record(name);
    return original.apply(this, args);
  };
}
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');
for (const [mod, name] of [
  [http, 'request'],
  [http, 'get'],
  [https, 'request'],
  [https, 'get'],
  [net, 'connect'],
  [net, 'createConnection'],
  [dns, 'lookup'],
  [dns, 'resolve']
]) {
  wrap(mod, name);
}
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function wrappedFetch(...args) {
    record('fetch');
    return originalFetch.apply(this, args);
  };
}
`;

/** Spawn the real CLI with PP_RATINGS_DIR pinned and no Ego fallback. */
function spawnCli({ args, ratingsDir, netRecord }) {
  const env = { ...process.env, PP_RATINGS_DIR: ratingsDir, PP_NO_EGO_FALLBACK: '1' };
  delete env.SSB_RATINGS_DIR;
  const argv = [];
  if (netRecord) {
    env.PP_NETWORK_RECORD = netRecord;
    argv.push('--require', path.join(ratingsDir, 'net-preload.js'));
  }
  argv.push(CLI, ...args);
  return spawnSync(process.execPath, argv, { cwd: REPO_ROOT, encoding: 'utf8', env });
}

/** Every recorded network primitive touch; missing file means none. */
function readNetRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function installPreload(dir) {
  fs.writeFileSync(path.join(dir, 'net-preload.js'), PRELOAD_SOURCE, 'utf8');
  return path.join(dir, 'net-preload.js');
}

describe('pp ratings: read-only (never fetches)', () => {
  it('the network recorder is not vacuous: a control call is recorded', (t) => {
    const dir = useRatingsDir(t);
    installPreload(dir);
    const record = path.join(dir, 'control.txt');
    const control = path.join(dir, 'control-net.js');
    fs.writeFileSync(control, "globalThis.fetch('http://127.0.0.1:9/').catch(() => {});\n", 'utf8');

    const result = spawnSync(process.execPath, ['--require', path.join(dir, 'net-preload.js'), control], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PP_NETWORK_RECORD: record }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      readNetRecords(record).includes('fetch'),
      'the recorder must observe a deliberate fetch, or the guarantee below proves nothing'
    );
  });

  it('the real CLI makes zero network calls while listing real snapshots', (t) => {
    const dir = seedAll(t);
    installPreload(dir);
    const record = path.join(dir, 'net-records.txt');

    const result = spawnCli({ args: ['ratings', '--show'], ratingsDir: dir, netRecord: record });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sagarin NCAAF 2026/, 'the command actually did its work');
    assert.deepEqual(readNetRecords(record), [], 'pp ratings must not touch any network primitive');
  });

  it('the ratings command region of bin/pp-cli.js contains no network or PP client', () => {
    const source = fs.readFileSync(CLI, 'utf8');
    const start = source.indexOf('const RATINGS_LEAGUE_ALIASES');
    const end = source.indexOf('async function main(', start);
    assert.ok(start > -1 && end > start, 'the ratings region must be locatable in bin/pp-cli.js');
    const region = source.slice(start, end);

    assert.match(region, /async function cmdRatings/, 'the extracted region is the ratings command');
    assert.match(region, /function canonicalRatingsLeague/);

    for (const pattern of [
      /createSSBClient/,
      /require\s*\(/,
      /ssb-api/,
      /ssb-auth/,
      /\bfetch\s*\(/,
      /fetchImpl/,
      /requestJSON|getTrpcJSON/
    ]) {
      assert.doesNotMatch(region, pattern, `ratings command must not use ${pattern}`);
    }
  });

  it('global fetch is never invoked by an in-process run', async (t) => {
    seedAll(t);
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = (...args) => {
      calls.push(args);
      return Promise.reject(new Error('network is disabled in this test'));
    };
    try {
      const { result } = await runRatings(['ratings', '--show']);
      assert.equal(result.ok, true);
      assert.equal(result.snapshots.length, FIXTURES.length);
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(calls, []);
  });
});
