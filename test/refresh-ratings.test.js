'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
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
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (/masseyratings\.com/.test(url) && failFor.has('massey')) {
      return { ok: false, status: 503, text: async () => '' };
    }
    if (/sagarin\.com/.test(url)) return { ok: true, status: 200, text: async () => SAGARIN_RAW };
    if (/davidsasser\.com/.test(url)) return { ok: true, status: 200, text: async () => SASSER_HTML };
    return { ok: false, status: 404, text: async () => '' };
  };
}

function useTmpRatingsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-refresh-ratings-'));
  const previous = process.env.PP_RATINGS_DIR;
  process.env.PP_RATINGS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PP_RATINGS_DIR;
    else process.env.PP_RATINGS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
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
