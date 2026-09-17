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
    // Compare every FILE in the state dir, retained copies included, so the
    // assertion covers the whole store and not just its top level.
    const stateOf = () => {
      const state = {};
      const walk = (base, prefix = '') => {
        for (const entry of fs.readdirSync(base).sort()) {
          const full = path.join(base, entry);
          if (fs.statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
          else state[`${prefix}${entry}`] = fs.readFileSync(full, 'utf8');
        }
      };
      walk(dir);
      return state;
    };

    const before = stateOf();

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

    assert.deepEqual(stateOf(), before, 'no file was added, removed or changed');
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

// ---------------------------------------------------------------------------
// Evidence gate (`pp ratings --evaluate`)
// ---------------------------------------------------------------------------

/** Point PP_RECORD_LEDGER at a throwaway ledger, optionally seeding it. */
function useLedger(t, ledger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ratings-ledger-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const previous = process.env.PP_RECORD_LEDGER;
  if (ledger) fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  process.env.PP_RECORD_LEDGER = ledgerPath;
  t.after(() => {
    if (previous === undefined) delete process.env.PP_RECORD_LEDGER;
    else process.env.PP_RECORD_LEDGER = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ledgerPath;
}

/** One Sagarin NCAAF fixture that carries its page's own published WIN%. */
function seedSagarinWithProbability() {
  const sourceHash = 'sha256:sagarin:NCAAF:2026';
  const saved = store.saveSnapshot({
    source: 'sagarin',
    league: 'NCAAF',
    season: 2026,
    method: 'overall',
    sourceUrl: 'https://example.invalid/sagarin/NCAAF',
    asOf: AS_OF,
    fetchedAt: FETCHED_AT,
    sourceHash,
    records: [
      {
        source: 'sagarin',
        league: 'NCAAF',
        sourceHash,
        // The bridge carries the prediction time from the RECORD's own asOf.
        asOf: AS_OF,
        coverage: 'full',
        matchStatus: 'unmatched',
        teamA: 'Syracuse',
        teamB: 'Pittsburgh',
        modelWinProbability: 0.75,
        modelWinProbabilityKind: 'published'
      }
    ]
  });
  assert.equal(saved.ok, true, 'the probability fixture must save');
  return saved;
}

function settledMoneylineBet(overrides = {}) {
  return {
    id: 'bet-1',
    gameId: 'g-1',
    game: 'Pittsburgh vs Syracuse',
    league: 'NCAAF',
    market: 'Moneyline',
    selection: 'Pittsburgh',
    oddsAtDecision: -120,
    stake: 1,
    status: 'loss',
    ...overrides
  };
}

function ledgerWith(bets) {
  return { version: 2, scans: [], candidates: [], bets, settlements: [] };
}

describe('pp ratings --evaluate', () => {
  it('scores a probability-carrying source against a settled moneyline outcome', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    // Selected side lost, so the winner is the other side of the matchup.
    useLedger(t, ledgerWith([settledMoneylineBet()]));

    const { result } = await runRatings(['ratings', '--evaluate', '--json']);

    assert.equal(result.ok, true);
    assert.equal(result.records, 1);
    assert.equal(result.outcomes, 1, 'the settled moneyline bet became one outcome');
    assert.equal(result.counts.rows, 1, 'the record joined the settled outcome');
    assert.equal(result.sources.sagarin.probability.available, true);
    assert.equal(result.scores.sagarin.coverage.sampleSize, 1, 'one scored sample');
    assert.ok(Object.keys(result.scores.sagarin.scores).length > 0, 'a scored source reports its metrics');
  });

  it('never derives an outcome from a non-moneyline settlement', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    // A run-line W-L says nothing about which side won the game.
    useLedger(
      t,
      ledgerWith([
        settledMoneylineBet({ id: 'bet-1', market: 'Run Line', selection: 'Pittsburgh -1.5', status: 'win' }),
        settledMoneylineBet({ id: 'bet-2', market: 'Total Games', selection: 'Under 21.5', status: 'win' })
      ])
    );

    const { result } = await runRatings(['ratings', '--evaluate', '--json']);

    assert.equal(result.outcomes, 0, 'no non-moneyline bet becomes an outcome');
    // The record still builds a row, but with no settled result it stays
    // unmatched and is never graded.
    assert.equal(result.counts.unmatched, 1);
    assert.equal(result.scores.sagarin.coverage.sampleSize, 0);
    assert.equal(result.scores.sagarin.coverage.unmatched, 1);
  });

  it('names a declined source and its reason instead of scoring an invented mapping', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    store.saveSnapshot(
      snapshotInput('massey', 'MLB', 2026, 1) // Massey publishes no win probability
    );
    useLedger(t, ledgerWith([settledMoneylineBet()]));

    const { result } = await runRatings(['ratings', '--evaluate', '--json']);

    assert.equal(result.sources.massey.probability.available, false);
    assert.match(result.sources.massey.probability.reason, /never a win probability/);
    // Declined is reported, not silently missing.
    assert.equal(Object.prototype.hasOwnProperty.call(result.scores, 'massey'), false);
  });

  it('reports the market-relative gate as insufficient_sample with no closes, and reads --markets when given', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    useLedger(t, ledgerWith([settledMoneylineBet()]));

    const bare = await runRatings(['ratings', '--evaluate', '--json']);
    assert.equal(bare.result.marketRelative.status, 'insufficient_sample');
    assert.equal(bare.result.marketRelative.sampleSize, 0);
    assert.equal(bare.result.markets, 0);

    const marketsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ratings-markets-')), 'markets.json');
    fs.writeFileSync(
      marketsPath,
      JSON.stringify([
        { league: 'NCAAF', game: 'Pittsburgh vs Syracuse', marketFairProbability: 0.7, closingOdds: -233 }
      ])
    );
    const withMarkets = await runRatings(['ratings', '--evaluate', '--json', '--markets', marketsPath]);

    assert.equal(withMarkets.result.markets, 1);
    assert.notEqual(withMarkets.result.marketRelative.sampleSize, 0, 'the supplied close reaches the gate');
  });

  it('scores a source from a supplied --outcomes file, with an empty ledger', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    // An empty ledger on purpose: a source's calibration must not depend on the
    // bettor having picked its games, which is why the resolver exists.
    useLedger(t, ledgerWith([]));

    const bare = await runRatings(['ratings', '--evaluate', '--json']);
    assert.equal(bare.result.fileOutcomes, 0);
    assert.equal(bare.result.scores.sagarin.coverage.resolved, 0, 'nothing settles this fixture yet');

    // The ledger holds no result for this fixture; the file does. A source's
    // calibration must not depend on the bettor having picked its games, which is
    // the whole reason scripts/resolve-ratings-outcomes.js exists.
    const outcomesPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ratings-outcomes-')), 'outcomes.json');
    fs.writeFileSync(
      outcomesPath,
      JSON.stringify({ outcomes: [{ league: 'NCAAF', game: 'Pittsburgh vs Syracuse', winner: 'Syracuse' }] })
    );
    const withFile = await runRatings(['ratings', '--evaluate', '--json', '--outcomes', outcomesPath]);

    assert.equal(withFile.result.fileOutcomes, 1);
    assert.equal(withFile.result.outcomes, withFile.result.ledgerOutcomes + 1, 'file and ledger are additive');
    const coverage = withFile.result.scores.sagarin.coverage;
    assert.equal(coverage.resolved, 1, 'the file result reaches the gate');
    assert.equal(coverage.sampleSize, 1);
    // The point of an outcome is that a probability can finally be scored.
    assert.equal(typeof withFile.result.scores.sagarin.scores.modelWinProbability.brier.value, 'number');
  });

  it('takes the market closes a recorded scan wrote, with no --markets file', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    // A settled outcome AND a recorded de-vigged close for the same fixture: the
    // two halves of the market gate, arriving from the two places they now live.
    useLedger(t, {
      version: 2,
      scans: [],
      candidates: [
        {
          candidateId: 'c1',
          game: 'Pittsburgh vs Syracuse',
          league: 'NCAAF',
          market: 'Moneyline',
          selection: 'Syracuse',
          odds: -140,
          marketFairProbability: 0.63
        }
      ],
      bets: [settledMoneylineBet()],
      settlements: []
    });

    const { result } = await runRatings(['ratings', '--evaluate', '--json']);

    assert.equal(result.ledgerMarkets, 1, 'the recorded close reached the gate by itself');
    assert.equal(result.fileMarkets, 0);
    assert.notEqual(result.marketRelative.sampleSize, 0, 'the market gate has a close to work with');
  });

  it('reads the de-vigged price from the feature snapshot, where a real scan writes it', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    useLedger(t, {
      version: 2,
      scans: [],
      candidates: [
        {
          candidateId: 'c1',
          game: 'Pittsburgh vs Syracuse',
          league: 'NCAAF',
          market: 'Moneyline',
          selection: 'Syracuse',
          odds: -140,
          // The producer writes it onto the candidate's immutable feature
          // snapshot, not onto the mutable top-level row.
          featureSnapshot: { marketFairProbability: 0.63 }
        }
      ],
      bets: [settledMoneylineBet()],
      settlements: []
    });

    const { result } = await runRatings(['ratings', '--evaluate', '--json']);

    assert.equal(result.ledgerMarkets, 1);
    assert.ok(Math.abs(result.marketCloses[0].marketFairProbability - 0.63) < 1e-9);
  });

  it('turns a one-sided UNDERDOG record into the favourite price the gate needs', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    useLedger(t, {
      version: 2,
      scans: [],
      candidates: [
        {
          candidateId: 'c1',
          game: 'Pittsburgh vs Syracuse',
          league: 'NCAAF',
          market: 'Moneyline',
          selection: 'Pittsburgh',
          odds: 120,
          // A scan usually records only the side it considers playable, and that is
          // often the dog. A two-way de-vig's sides sum to 1 by construction, so
          // 0.37 IS the favourite's 0.63 seen from the other end.
          featureSnapshot: { marketFairProbability: 0.37 }
        }
      ],
      bets: [settledMoneylineBet()],
      settlements: []
    });

    const { result } = await runRatings(['ratings', '--evaluate', '--json']);

    assert.equal(result.ledgerMarkets, 1, 'a one-sided record still yields a favourite price');
    assert.ok(Math.abs(result.marketCloses[0].marketFairProbability - 0.63) < 1e-9);
    assert.notEqual(result.marketRelative.sampleSize, 0);
  });

  it('ignores a recorded candidate that is not a moneyline close', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    useLedger(t, {
      version: 2,
      scans: [],
      candidates: [
        {
          candidateId: 'c1',
          game: 'Pittsburgh vs Syracuse',
          league: 'NCAAF',
          market: 'Total Games',
          selection: 'Over 21.5',
          odds: -110,
          marketFairProbability: 0.58
        }
      ],
      bets: [settledMoneylineBet()],
      settlements: []
    });

    const { result } = await runRatings(['ratings', '--evaluate', '--json']);

    // The gate's inputs are market-WILDCARD, so a totals close would be compared
    // against a win probability. It must never be picked up.
    assert.equal(result.ledgerMarkets, 0);
  });

  it('scores a RETAINED snapshot with --as-of, and never falls back to the current file', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    useLedger(t, ledgerWith([]));

    const current = await runRatings(['ratings', '--evaluate', '--json']);
    assert.equal(current.result.asOf, null, 'no --as-of means the current snapshot');
    assert.equal(current.result.records, 1);

    // Every refresh now retains a dated copy, which is the only reason a past
    // week's predictions still exist to be scored.
    const retained = await runRatings(['ratings', '--evaluate', '--json', '--as-of', AS_OF]);
    assert.equal(retained.result.asOf, AS_OF);
    assert.equal(retained.result.records, 1, 'the retained copy is what --as-of reads');

    // Decisive: a date with no retained copy must NOT quietly fall back to the
    // current file. Falling back would score this week's predictions as if they
    // were that week's, which is the exact error retention exists to prevent.
    const absent = await runRatings(['ratings', '--evaluate', '--json', '--as-of', '2026-01-01']);
    assert.equal(absent.result.records, 0);
    assert.equal(absent.result.asOf, '2026-01-01');
  });

  it('renders the human path without throwing', async (t) => {
    useRatingsDir(t);
    seedSagarinWithProbability();
    useLedger(t, ledgerWith([settledMoneylineBet()]));

    const { logs } = await runRatings(['ratings', '--evaluate']);

    const rendered = logs.join('\n');
    assert.match(rendered, /External-ratings evaluation/);
    assert.match(rendered, /Market-relative gate/);
    assert.match(rendered, /Fair & Oster/, 'the honest baseline is restated');
  });
});
