'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/ssb-ratings-snapshot');

const ORIGINAL_RATINGS_DIR = process.env.PP_RATINGS_DIR;
const REPO_ROOT = path.resolve(__dirname, '..');

let tmpDir = null;

function useTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ratings-snapshot-'));
  process.env.PP_RATINGS_DIR = tmpDir;
  return tmpDir;
}

function sampleRecord(overrides = {}) {
  return {
    source: 'sagarin',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-06T00:00:00.000Z',
    fetchedAt: '2026-09-08T12:00:00.000Z',
    sourceUrl: 'https://sagarin.example/cfsend.htm',
    sourceHash: 'sha256:aaa111',
    eventId: null,
    teamA: 'Ohio State',
    teamB: 'Michigan',
    coverage: 'full',
    matchStatus: 'matched',
    unresolvedReason: null,
    ...overrides
  };
}

function sampleSnapshot(overrides = {}) {
  return {
    source: 'sagarin',
    league: 'NCAAF',
    season: 2026,
    method: 'overall',
    asOf: '2026-09-06T00:00:00.000Z',
    fetchedAt: '2026-09-08T12:00:00.000Z',
    sourceUrl: 'https://sagarin.example/cfsend.htm',
    sourceHash: 'sha256:aaa111',
    records: [sampleRecord(), sampleRecord({ teamA: 'Alabama', teamB: 'Georgia' })],
    ...overrides
  };
}

beforeEach(() => {
  useTmpDir();
});

afterEach(() => {
  if (ORIGINAL_RATINGS_DIR === undefined) delete process.env.PP_RATINGS_DIR;
  else process.env.PP_RATINGS_DIR = ORIGINAL_RATINGS_DIR;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('ssb-ratings-snapshot store', () => {
  it('round-trips a saved snapshot through loadSnapshot', () => {
    const saved = store.saveSnapshot(sampleSnapshot());
    assert.equal(saved.ok, true, JSON.stringify(saved.errors));
    assert.equal(path.dirname(saved.path), tmpDir);
    assert.equal(path.basename(saved.path), 'sagarin-NCAAF-2026.json');

    const loaded = store.loadSnapshot('sagarin', 'NCAAF', 2026);
    assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
    assert.equal(loaded.snapshot.schemaVersion, 1);
    assert.equal(loaded.snapshot.source, 'sagarin');
    assert.equal(loaded.snapshot.league, 'NCAAF');
    assert.equal(loaded.snapshot.season, 2026);
    assert.equal(loaded.snapshot.method, 'overall');
    assert.equal(loaded.snapshot.asOf, '2026-09-06T00:00:00.000Z');
    assert.equal(loaded.snapshot.fetchedAt, '2026-09-08T12:00:00.000Z');
    assert.equal(loaded.snapshot.sourceHash, 'sha256:aaa111');
    assert.equal(loaded.snapshot.records.length, 2);
    assert.deepEqual(loaded.snapshot.records, sampleSnapshot().records);
    assert.equal(loaded.stale, false);
  });

  it('writes the snapshot beside the state dir, never into the repo', () => {
    const saved = store.saveSnapshot(sampleSnapshot());
    assert.equal(saved.ok, true);
    assert.equal(fs.existsSync(saved.path), true);
    assert.equal(saved.path.startsWith(REPO_ROOT + path.sep), false);
  });

  it('flags an asOf older than the supplied cutoff as stale instead of accepting it', () => {
    store.saveSnapshot(sampleSnapshot());

    const stale = store.loadSnapshot('sagarin', 'NCAAF', 2026, { asOfCutoff: '2026-09-12T00:00:00.000Z' });
    assert.equal(stale.ok, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.snapshot.asOf, '2026-09-06T00:00:00.000Z');

    const fresh = store.loadSnapshot('sagarin', 'NCAAF', 2026, { asOfCutoff: '2026-09-01T00:00:00.000Z' });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.stale, false);
  });

  it('reports no staleness when no cutoff is supplied', () => {
    store.saveSnapshot(sampleSnapshot());
    const loaded = store.loadSnapshot('sagarin', 'NCAAF', 2026);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.stale, false);
  });

  it('rejects a record whose sourceHash disagrees with the snapshot', () => {
    const result = store.saveSnapshot(sampleSnapshot({ records: [sampleRecord({ sourceHash: 'sha256:bbb222' })] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /sourceHash/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'sagarin-NCAAF-2026.json')), false);
  });

  it('rejects a record with no sourceHash at all', () => {
    const result = store.saveSnapshot(sampleSnapshot({ records: [sampleRecord({ sourceHash: undefined })] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /sourceHash/);
  });

  it('rejects a corrupted on-disk snapshot whose records disagree with its hash', () => {
    const saved = store.saveSnapshot(sampleSnapshot());
    assert.equal(saved.ok, true);

    const corrupted = JSON.parse(fs.readFileSync(saved.path, 'utf8'));
    corrupted.records[0].sourceHash = 'sha256:bbb222';
    fs.writeFileSync(saved.path, JSON.stringify(corrupted), 'utf8');

    const loaded = store.loadSnapshot('sagarin', 'NCAAF', 2026);
    assert.equal(loaded.ok, false);
    assert.match(loaded.errors.join('; '), /sourceHash/);
  });

  it('rejects a snapshot for a league the source does not publish', () => {
    // Sagarin's baseball page is player ratings: MLB team ratings do not exist there.
    const result = store.saveSnapshot(sampleSnapshot({ league: 'MLB' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /MLB/);
    assert.equal(fs.existsSync(path.join(tmpDir, 'sagarin-MLB-2026.json')), false);
  });

  it('refuses to write a snapshot directory inside the repo', () => {
    const inRepo = path.join(REPO_ROOT, '.tmp-ratings-probe');
    process.env.PP_RATINGS_DIR = inRepo;
    const result = store.saveSnapshot(sampleSnapshot());
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /repo/i);
    assert.equal(fs.existsSync(inRepo), false);
  });

  it('returns ok:false when the snapshot does not exist', () => {
    const loaded = store.loadSnapshot('massey', 'MLB', 2025);
    assert.equal(loaded.ok, false);
    assert.match(loaded.errors.join('; '), /not found/i);
  });

  it('lists saved snapshots with their record counts and source provenance', () => {
    store.saveSnapshot(sampleSnapshot());
    store.saveSnapshot(
      sampleSnapshot({
        source: 'sasser',
        league: 'NCAAF',
        method: 'model_v1',
        sourceUrl: 'https://davidsasser.example/cfb',
        sourceHash: 'sha256:ccc333',
        records: [sampleRecord({ source: 'sasser', sourceHash: 'sha256:ccc333' })]
      })
    );
    // Unrelated files in the directory are ignored, not misparsed as snapshots.
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a snapshot', 'utf8');

    const listed = store.listSnapshots();
    assert.equal(listed.ok, true);
    assert.equal(listed.snapshots.length, 2);
    const bySource = Object.fromEntries(listed.snapshots.map((entry) => [entry.source, entry]));
    assert.equal(bySource.sagarin.league, 'NCAAF');
    assert.equal(bySource.sagarin.season, 2026);
    assert.equal(bySource.sagarin.recordCount, 2);
    assert.equal(bySource.sagarin.asOf, '2026-09-06T00:00:00.000Z');
    assert.equal(bySource.sasser.recordCount, 1);
    assert.equal(bySource.sasser.method, 'model_v1');
  });

  it('returns an empty list when the snapshot directory does not exist yet', () => {
    process.env.PP_RATINGS_DIR = path.join(tmpDir, 'missing-subdir');
    const listed = store.listSnapshots();
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.snapshots, []);
  });

  it('falls back to the ~/.ssb-for-agents/ratings state dir when PP_RATINGS_DIR is unset', () => {
    delete process.env.PP_RATINGS_DIR;
    const expected = path.join(os.homedir(), '.ssb-for-agents', 'ratings', 'sagarin-NCAAF-2026.json');
    const loaded = store.loadSnapshot('sagarin', 'NCAAF', 2026);
    // The fallback directory is deterministic, but whether a real snapshot already
    // lives there is ambient machine state (a live `refresh-ratings` run writes it).
    // Assert the resolved path only; the ok:false missing-snapshot contract is
    // covered hermetically by 'returns ok:false when the snapshot does not exist'.
    assert.equal(loaded.path, expected);
  });
});
