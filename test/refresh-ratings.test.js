'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/pp-cli');
const store = require('../lib/ssb-ratings-snapshot');
const refresh = require('../scripts/refresh-ratings');

const { refreshRatings, formatSummary } = refresh;

// A refresh must be schedulable, which means it may touch ONLY the free
// third-party rating pages and the local state dir. Nothing on this path may
// reach PropProfessor, so the transport is injected and this file proves the
// fan-out, the partial-success contract, and the absent PP client.

const NOW = new Date('2026-09-15T12:00:00.000Z');

const SAGARIN_URL = 'http://sagarin.com/sports/cfsend.htm';
const SASSER_URL = 'https://davidsasser.com/cfb';

// Format-accurate excerpt of Sagarin's legacy fixed-width CFB page (real row
// layout: home favorite, neutral-site favorite). Two readable rows.
const SAGARIN_RAW = [
  'Predictions_with_Totals_and_Moneylines',
  '',
  '2026 College Football through games of September 12 Saturday - Week 2',
  'HOME ADVANTAGE=                  2.41   2.41   2.41   2.41   2.41',
  '',
  '          FAVORITE             Rating   Pred  Golden Recent Strong  UNDERDOG                MONEY  WIN%    home   away  TOTAL  HMARG WIN% MONEY',
  '    1   @ Pittsburgh            10.26   9.30  11.61  10.39  10.41   Syracuse                 297    75%   27.46  17.20  44.66  10.26  75%   297',
  '   28 N   Arizona State          6.02   3.72   3.28  10.18  11.88 @ Kansas                   193    66%   28.89  34.91  63.79  -6.02 -66%   193'
].join('\n');

const SASSER_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'ratings', 'sasser-cfb-2026-w3.html'), 'utf8');

/**
 * Injected transport: routes each vendor URL to its fixture, records every
 * call, and can fail a named source outright.
 */
function makeFetch(calls, options = {}) {
  const failFor = new Set(options.failFor || []);
  const sagarinRaw = options.sagarinRaw || SAGARIN_RAW;
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (/masseyratings\.com/.test(url) && failFor.has('massey')) {
      return { ok: false, status: 503, text: async () => '' };
    }
    if (/sagarin\.com/.test(url)) return { ok: true, status: 200, text: async () => sagarinRaw };
    if (/davidsasser\.com/.test(url)) return { ok: true, status: 200, text: async () => SASSER_HTML };
    return { ok: false, status: 404, text: async () => '' };
  };
}

const NBA_CAPTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ratings', 'sagarin-nba-2026-09-16.html'), 'utf8');

function useTmpRatingsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-refresh-ratings-'));
  useRatingsDir(t, dir);
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Point the snapshot store at an explicit dir, restored after the test. */
function useRatingsDir(t, dir) {
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
  });
  return dir;
}

function captureConsole() {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  return {
    logs,
    restore() {
      console.log = originalLog;
    }
  };
}

function sampleSnapshot(overrides = {}) {
  const hash = overrides.sourceHash || 'sha256:aaa111';
  return {
    source: 'sagarin',
    league: 'NCAAF',
    season: 2026,
    method: 'overall',
    asOf: '2026-09-12T00:00:00.000Z',
    fetchedAt: '2026-09-15T12:00:00.000Z',
    sourceUrl: SAGARIN_URL,
    sourceHash: hash,
    records: [
      {
        source: 'sagarin',
        league: 'NCAAF',
        sourceHash: hash,
        coverage: 'full',
        matchStatus: 'unmatched',
        teamA: 'Pittsburgh',
        teamB: 'Syracuse'
      }
    ],
    ...overrides
  };
}

describe('refresh-ratings: fan-out', () => {
  it('calls the injected transport exactly once per source/league pair', async (t) => {
    const dir = useTmpRatingsDir(t);
    const calls = [];

    const result = await refreshRatings({
      sources: ['sagarin'],
      leagues: ['NCAAF', 'NFL'],
      fetchImpl: makeFetch(calls),
      now: NOW
    });

    assert.equal(calls.length, 2);
    assert.equal(new Set(calls.map((call) => call.url)).size, 2);
    assert.equal(result.totals.ok, 2);
    assert.equal(result.ok, true);

    for (const row of result.results) {
      assert.equal(row.status, 'ok');
      assert.equal(row.coverage, 'full');
      assert.equal(row.recordCount, 2);
      assert.equal(row.asOf, '2026-09-12');
      assert.equal(row.fetchedAt, NOW.toISOString());
    }
    assert.ok(fs.existsSync(path.join(dir, 'sagarin-NCAAF-2026.json')));
    assert.ok(fs.existsSync(path.join(dir, 'sagarin-NFL-2026.json')));
  });

  it('calls each adapter exactly once for one league across sources', async (t) => {
    useTmpRatingsDir(t);
    const calls = [];

    const result = await refreshRatings({
      sources: ['sagarin', 'sasser'],
      leagues: ['NCAAF'],
      fetchImpl: makeFetch(calls),
      now: NOW
    });

    assert.deepEqual(calls.map((call) => call.url).sort(), [SAGARIN_URL, SASSER_URL].sort());
    assert.equal(result.totals.ok, 2);
    assert.equal(result.results.find((row) => row.source === 'sasser').recordCount, 5);
    assert.equal(result.results.find((row) => row.source === 'sasser').coverage, 'partial');
  });

  it('defaults to every league a source publishes when --league is omitted', async (t) => {
    useTmpRatingsDir(t);
    const calls = [];

    const result = await refreshRatings({ sources: ['sasser'], fetchImpl: makeFetch(calls), now: NOW });

    assert.equal(calls.length, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].league, 'NCAAF');
  });
});

describe('refresh-ratings: a source that fails does not abort the others', () => {
  it('reports partial success when one adapter fails', async (t) => {
    useTmpRatingsDir(t);
    const calls = [];

    const result = await refreshRatings({
      sources: ['massey', 'sagarin'],
      leagues: ['NCAAF'],
      fetchImpl: makeFetch(calls, { failFor: ['massey'] }),
      now: NOW
    });

    assert.equal(calls.length, 2, 'the failing source is still attempted');
    assert.equal(result.ok, true);
    assert.equal(result.totals.ok, 1);
    assert.equal(result.totals.error, 1);

    const failed = result.results.find((row) => row.source === 'massey');
    assert.equal(failed.status, 'error');
    assert.match(failed.reason, /massey/);

    const ok = result.results.find((row) => row.source === 'sagarin');
    assert.equal(ok.status, 'ok');
    assert.equal(ok.recordCount, 2);
  });

  it('names an unknown source and keeps going', async (t) => {
    useTmpRatingsDir(t);
    const calls = [];

    const result = await refreshRatings({
      sources: ['nope', 'sagarin'],
      leagues: ['NCAAF'],
      fetchImpl: makeFetch(calls),
      now: NOW
    });

    assert.equal(calls.length, 1);
    assert.equal(result.totals.error, 1);
    assert.match(result.results.find((row) => row.source === 'nope').reason, /unknown ratings source/);
    assert.equal(result.results.find((row) => row.source === 'sagarin').status, 'ok');
  });
});

describe('refresh-ratings: fail closed', () => {
  it('reports an unsupported league without fetching it', async (t) => {
    useTmpRatingsDir(t);
    const calls = [];

    // Sagarin publishes player ratings for MLB, not team ratings.
    const result = await refreshRatings({
      sources: ['sagarin'],
      leagues: ['MLB'],
      fetchImpl: makeFetch(calls),
      now: NOW
    });

    assert.equal(calls.length, 0);
    assert.equal(result.results[0].status, 'unsupported');
    assert.match(result.results[0].reason, /MLB/);
    assert.equal(result.ok, false);
  });

  it('reports unusable upstream content as unavailable and stores nothing', async (t) => {
    const dir = useTmpRatingsDir(t);

    const result = await refreshRatings({
      sources: ['sagarin'],
      leagues: ['NCAAF'],
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>no predictions block here</html>' }),
      now: NOW
    });

    assert.equal(result.results[0].status, 'unavailable');
    assert.equal(result.results[0].recordCount, 0);
    assert.ok(result.results[0].reason);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe('refresh-ratings: summary and PP-free contract', () => {
  it('summarizes each source/league with source, league, asOf, fetchedAt, records, coverage', async (t) => {
    useTmpRatingsDir(t);

    const result = await refreshRatings({
      sources: ['sagarin'],
      leagues: ['NCAAF'],
      fetchImpl: makeFetch([]),
      now: NOW
    });

    const summary = formatSummary(result).join('\n');
    assert.match(summary, /sagarin NCAAF ok/);
    assert.match(summary, /asOf=2026-09-12/);
    assert.match(summary, new RegExp(`fetchedAt=${NOW.toISOString()}`));
    assert.match(summary, /records=2/);
    assert.match(summary, /coverage=full/);
    assert.match(summary, /totals: 1\/1 ok/);
  });

  it('never imports the PropProfessor client', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'refresh-ratings.js'), 'utf8');
    assert.equal(/require\([^)]*ssb-api/.test(source), false);
    assert.equal(/createSSBClient/.test(source), false);
    assert.equal(/require\([^)]*ssb-auth/.test(source), false);
  });
});

describe("refresh-ratings: staleness of a source's own asOf", () => {
  it('flags a source whose own heading is far behind, and says so in the summary', async (t) => {
    useTmpRatingsDir(t);

    // Real NBA capture: a finals page whose own heading is 2026-06-13 while the
    // refresh runs 2026-09-15. The two regular-block rows are genuine, and the
    // page's per-team RATINGS table contributes all 30 programs (a finals page
    // still prints a full table), but a consumer must not read the pair as a
    // live source.
    const result = await refreshRatings({
      sources: ['sagarin'],
      leagues: ['NBA'],
      fetchImpl: makeFetch([], { sagarinRaw: NBA_CAPTURE }),
      now: NOW
    });

    const row = result.results[0];
    assert.equal(row.status, 'ok');
    assert.equal(row.asOf, '2026-06-13');
    assert.equal(row.recordCount, 32);
    assert.equal(row.ageDays, 94);
    assert.equal(row.stale, true);
    assert.match(row.coverageReason, /32 of 32 candidate rows parsed/);

    const summary = formatSummary(result).join('\n');
    assert.match(summary, /asOf=2026-06-13/);
    assert.match(summary, /age=94d/);
    assert.match(summary, /stale=true/);
  });

  it('does not flag an asOf inside the freshness window', async (t) => {
    useTmpRatingsDir(t);

    const result = await refreshRatings({
      sources: ['sagarin'],
      leagues: ['NCAAF'],
      fetchImpl: makeFetch([]),
      now: NOW
    });

    const row = result.results[0];
    assert.equal(row.asOf, '2026-09-12');
    assert.equal(row.ageDays, 3);
    assert.equal(row.stale, false);
    const summary = formatSummary(result).join('\n');
    assert.match(summary, /age=3d/);
    assert.doesNotMatch(summary, /stale=true/);
  });
});

describe('refresh-ratings: a seasonal (undated) page is not an adapter error', () => {
  // An out-of-season Massey page parses perfectly but its heading carries no
  // date (`Using games thru Preseason`), so nothing can be snapshotted. That must
  // surface as the benign seasonal condition it is, not as the snapshot-write
  // refusal it causes - and never as `records=0 coverage=full`.
  const NBA_PRESEASON = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'ratings', 'massey-nba-2026-09-16.csv'),
    'utf8'
  );
  const NBA_EXPORT_URL = 'https://masseyratings.com/nba/ratings?export=1';

  it('reports the preseason heading instead of a snapshot-write failure', async (t) => {
    const dir = useTmpRatingsDir(t);
    const calls = [];

    const result = await refreshRatings({
      sources: ['massey'],
      leagues: ['NBA'],
      exportUrl: NBA_EXPORT_URL,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return { ok: true, status: 200, text: async () => NBA_PRESEASON };
      },
      now: NOW
    });

    assert.deepEqual(calls, [NBA_EXPORT_URL]);
    const row = result.results[0];
    assert.equal(row.status, 'unavailable');
    assert.equal(row.recordCount, 0);
    assert.notEqual(row.coverage, 'full');
    assert.equal(row.coverage, 'unavailable');
    assert.match(row.reason, /no games played yet/i);
    assert.match(row.reason, /Using games thru Preseason/);
    assert.doesNotMatch(row.reason, /snapshot/i);
    // Nothing to persist, so the state dir stays untouched.
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(result.ok, false, 'a season that has not started is not a success');
  });

  it('still snapshots a dated page from the same source', async (t) => {
    const dir = useTmpRatingsDir(t);
    const dated = fs.readFileSync(path.join(__dirname, 'fixtures', 'ratings', 'massey-ncaaf-2026-09-16.csv'), 'utf8');

    const result = await refreshRatings({
      sources: ['massey'],
      leagues: ['NCAAF'],
      exportUrl: 'https://masseyratings.com/cf/fbs/ratings?export=1',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => dated }),
      now: NOW
    });

    const row = result.results[0];
    assert.equal(row.status, 'ok');
    assert.equal(row.coverage, 'full');
    assert.equal(row.recordCount, 138);
    assert.equal(row.asOf, '2026-09-13');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['history', 'massey-NCAAF-2026.json']);
    // And the dated copy retention keeps, which is what a later week is scored from.
    assert.deepEqual(fs.readdirSync(path.join(dir, 'history')), ['massey-NCAAF-2026-2026-09-13.json']);
  });

  it('never reports full coverage beside zero records, whatever the status', async (t) => {
    // A refused snapshot write: point the store INSIDE the repo, which it refuses
    // before creating anything. The row must not keep `coverage: 'full'` while
    // reporting `records=0` - the contradiction this card is about.
    const dir = path.join(__dirname, '..', 'tmp-ratings-should-never-be-created');
    useRatingsDir(t, dir);

    const result = await refreshRatings({
      sources: ['sagarin'],
      leagues: ['NCAAF'],
      fetchImpl: makeFetch([]),
      now: NOW
    });

    const row = result.results[0];
    assert.equal(row.status, 'error');
    assert.equal(row.recordCount, 0);
    assert.notEqual(row.coverage, 'full');
    assert.equal(row.coverage, 'unavailable');
    assert.match(row.reason, /snapshot not written/);
    assert.equal(fs.existsSync(dir), false, 'the store must refuse before writing anything');

    for (const candidate of result.results) {
      assert.ok(
        !(candidate.recordCount === 0 && candidate.coverage === 'full'),
        `${candidate.source} ${candidate.league} reported coverage=full with zero records`
      );
    }
  });
});

describe('pp-cli ratings (read-only)', () => {
  it('reads snapshots from the state dir and filters by source and league', async (t) => {
    useTmpRatingsDir(t);
    const saved = store.saveSnapshot(sampleSnapshot());
    assert.equal(saved.ok, true);
    assert.equal(
      store.saveSnapshot(sampleSnapshot({ source: 'massey', league: 'MLB', sourceHash: 'sha256:bbb222' })).ok,
      true
    );

    const capture = captureConsole();
    let result;
    try {
      result = await cli.cmdRatings(['ratings'], { source: 'sagarin', league: 'CFB' });
    } finally {
      capture.restore();
    }

    assert.equal(result.ok, true);
    assert.equal(result.snapshots.length, 1, 'CFB is the frontend alias for the canonical NCAAF snapshot');
    assert.equal(result.snapshots[0].league, 'NCAAF');
    assert.match(capture.logs.join('\n'), /sagarin NCAAF 2026 records=1/);
  });

  it('--show prints the snapshot detail', async (t) => {
    useTmpRatingsDir(t);
    store.saveSnapshot(sampleSnapshot());

    const capture = captureConsole();
    let result;
    try {
      result = await cli.cmdRatings(['ratings', '--show'], { show: true });
    } finally {
      capture.restore();
    }

    const out = capture.logs.join('\n');
    assert.equal(result.snapshots.length, 1);
    assert.match(out, /method: overall/);
    assert.match(out, /fetchedAt: 2026-09-15T12:00:00\.000Z/);
    assert.match(out, /records: 1/);
  });

  it('reports an empty state dir without throwing', async (t) => {
    useTmpRatingsDir(t);

    const capture = captureConsole();
    let result;
    try {
      result = await cli.cmdRatings(['ratings'], {});
    } finally {
      capture.restore();
    }

    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshots, []);
    assert.match(capture.logs.join('\n'), /no .*snapshots/i);
  });
});

describe('refresh-ratings: a closed stdout is a clean exit, not an EPIPE crash', () => {
  const CLI = path.join(__dirname, '..', 'scripts', 'refresh-ratings.js');
  const REPO = path.join(__dirname, '..');

  // Spawn a writer whose stdout read end is already gone, so its first write
  // lands on a closed pipe. The child has to boot Node first, so the pipe is
  // closed well before it writes.
  function runWithClosedStdout(scriptPath, args) {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdout.destroy();
    return new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') }));
    });
  }

  it('exits 0 with no stack when its stdout reader goes away', async () => {
    // `--source nope` writes a summary without any network, and its all-error
    // totals make `main` RETURN 1 — so a reported exit code of 0 can only come
    // from the EPIPE guard's `process.exit(0)`, not from the normal path.
    const result = await runWithClosedStdout(CLI, ['--source', 'nope', '--json']);
    assert.equal(result.signal, null, 'the child was not killed by a signal');
    assert.doesNotMatch(result.stderr, /EPIPE/);
    assert.equal(result.code, 0, `expected a clean EPIPE exit, got code=${result.code}: ${result.stderr}`);
  });

  // Control: prove this harness really does produce EPIPE. An unguarded writer
  // on the same closed pipe must crash with an EPIPE stack — the exact failure
  // the guard suppresses — otherwise the assertion above would hold whether or
  // not the guard exists.
  it('control: an unguarded writer on the same closed pipe does crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-epipe-control-'));
    try {
      const unguarded = path.join(dir, 'unguarded.js');
      fs.writeFileSync(unguarded, "process.stdout.write('x'.repeat(4096) + '\\n');\n", 'utf8');
      const result = await runWithClosedStdout(unguarded, []);
      assert.equal(result.signal, null);
      assert.match(result.stderr, /EPIPE/, 'the harness must actually trigger EPIPE');
      assert.notEqual(result.code, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Control: the same run WITHOUT the guard is not a clean exit. Requiring the
  // module as a library never arms the guard (it is installed only when the
  // file IS the entry point), so this is the CLI minus the guard, on the same
  // closed pipe with the same arguments. Without this, `code === 0` above could
  // be an accident of the environment rather than the guard doing its job.
  //
  // Note the guard here converts a spurious exit 1 into a clean 0 rather than
  // suppressing a stack: this script writes via `console.log`, and Console
  // swallows a closed-pipe error when no 'error' listener exists. The sibling
  // (scripts/refresh-tennis-elo.js) uses `process.stdout.write`, which does
  // crash unhandled — hence the raw-writer control above.
  it('control: the same invocation without the guard is not a clean exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-epipe-noguard-'));
    try {
      const wrapper = path.join(dir, 'no-guard.js');
      fs.writeFileSync(
        wrapper,
        `const cli = require(${JSON.stringify(CLI)});\n` +
          "cli.main(['--source', 'nope', '--json']).then((code) => { process.exitCode = code; });\n",
        'utf8'
      );
      const result = await runWithClosedStdout(wrapper, []);
      assert.notEqual(result.code, 0, 'without the guard a closed stdout is not a clean exit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
