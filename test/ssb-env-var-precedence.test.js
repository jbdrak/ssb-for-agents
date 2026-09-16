'use strict';

// The SSB_/PP_ env rename: the canonical name wins, the pre-rename alias still works.
//
// The ratings state dir and the tennis-Elo snapshot path were both introduced
// AFTER the PP_ -> SSB_ rename but minted in the OLD namespace, so one feature
// ended up reading two prefixes and neither name said which one was current.
// `lib/ssb-env-var.js` resolves such a pair canonical-first, and its two
// consumers each need BOTH guarantees pinned:
//
//   - the canonical `SSB_` name is honoured (and preferred when both are set);
//   - the deprecated `PP_` name still resolves to the same place, because a
//     local shell profile that exports the old name must not silently start
//     writing snapshots into a different directory.
//
// Those are separate failures, so they get separate cases. No network, no HOME
// state: every dir here is a throwaway, and the real env is restored.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/ssb-ratings-snapshot');
const eloData = require('../lib/tennis-elo-data');
const { resolveEnvVar } = require('../lib/ssb-env-var');

/** Every env key these tests read or set; all are cleared before each case. */
const ENV_KEYS = Object.freeze([
  'SSB_RATINGS_DIR',
  'PP_RATINGS_DIR',
  'SSB_TENNIS_ELO_SNAPSHOT',
  'PP_TENNIS_ELO_SNAPSHOT',
  'SSB_DEBUG'
]);

const tmpDirs = [];

function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssb-env-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Apply env overrides and return a restore function. Every key in ENV_KEYS is
 * cleared first, so an ambient export can never decide the outcome of a case.
 */
function pin(overrides = {}) {
  const wanted = Object.fromEntries(ENV_KEYS.map((key) => [key, undefined]));
  Object.assign(wanted, overrides);
  const saved = {};
  for (const [key, value] of Object.entries(wanted)) {
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

function sampleSnapshot() {
  const shared = {
    source: 'sagarin',
    method: 'overall',
    league: 'NCAAF',
    season: 2026,
    asOf: '2026-09-06T00:00:00.000Z',
    fetchedAt: '2026-09-08T12:00:00.000Z',
    sourceUrl: 'https://sagarin.example/cfsend.htm',
    sourceHash: 'sha256:aaa111'
  };
  return {
    ...shared,
    records: [
      {
        ...shared,
        eventId: null,
        teamA: 'Ohio State',
        teamB: 'Michigan',
        coverage: 'full',
        matchStatus: 'matched',
        unresolvedReason: null
      }
    ]
  };
}

describe('resolveEnvVar: canonical name wins, alias still resolves', () => {
  it('returns the canonical value when only it is set', () => {
    const restore = pin({ SSB_RATINGS_DIR: '/canonical' });
    try {
      assert.deepEqual(resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR'), {
        value: '/canonical',
        source: 'SSB_RATINGS_DIR',
        shadowed: null
      });
    } finally {
      restore();
    }
  });

  it('falls back to the deprecated alias when the canonical name is unset', () => {
    const restore = pin({ PP_RATINGS_DIR: '/legacy' });
    try {
      assert.deepEqual(resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR'), {
        value: '/legacy',
        source: 'PP_RATINGS_DIR',
        shadowed: null
      });
    } finally {
      restore();
    }
  });

  it('prefers the canonical name and reports the shadowed alias when both are set', () => {
    const restore = pin({ SSB_RATINGS_DIR: '/canonical', PP_RATINGS_DIR: '/legacy' });
    try {
      const resolved = resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR');
      assert.equal(resolved.value, '/canonical');
      assert.equal(resolved.source, 'SSB_RATINGS_DIR');
      assert.equal(resolved.shadowed, 'PP_RATINGS_DIR');
    } finally {
      restore();
    }
  });

  it('treats a blank or whitespace-only value as unset, like the callers did', () => {
    const restore = pin({ SSB_RATINGS_DIR: '   ', PP_RATINGS_DIR: '/legacy' });
    try {
      const resolved = resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR');
      assert.equal(resolved.value, '/legacy');
      assert.equal(resolved.source, 'PP_RATINGS_DIR');
    } finally {
      restore();
    }
  });

  it('reports nothing at all when neither name is set', () => {
    const restore = pin();
    try {
      assert.deepEqual(resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR'), {
        value: null,
        source: null,
        shadowed: null
      });
    } finally {
      restore();
    }
  });

  it('reads an injected environment instead of process.env when given one', () => {
    const resolved = resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR', { PP_RATINGS_DIR: '/injected' });
    assert.equal(resolved.value, '/injected');
    assert.equal(resolved.source, 'PP_RATINGS_DIR');
  });

  it('names the winning variable under SSB_DEBUG=true, and stays silent otherwise', () => {
    const originalError = console.error;
    const errors = [];
    console.error = (message) => errors.push(String(message));

    try {
      // Control: both set, debug OFF -> no log at all.
      let restore = pin({ SSB_RATINGS_DIR: '/canonical', PP_RATINGS_DIR: '/legacy' });
      try {
        resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR');
        assert.equal(errors.length, 0);
      } finally {
        restore();
      }

      // Debug ON -> exactly one line naming the loser.
      restore = pin({ SSB_RATINGS_DIR: '/canonical', PP_RATINGS_DIR: '/legacy', SSB_DEBUG: 'true' });
      try {
        resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR');
        assert.equal(errors.length, 1);
        assert.match(errors[0], /SSB_RATINGS_DIR wins over deprecated PP_RATINGS_DIR/);
      } finally {
        restore();
      }
    } finally {
      console.error = originalError;
    }
  });
});

describe('ratings snapshot store: SSB_RATINGS_DIR is canonical', () => {
  it('reads from SSB_RATINGS_DIR', () => {
    const dir = tmpDir('ssb-only');
    const restore = pin({ SSB_RATINGS_DIR: dir });
    try {
      const loaded = store.loadSnapshot('sagarin', 'NCAAF', 2026);
      assert.equal(loaded.path, path.join(dir, 'sagarin-NCAAF-2026.json'));
    } finally {
      restore();
    }
  });

  it('still reads from the deprecated PP_RATINGS_DIR', () => {
    const dir = tmpDir('pp-only');
    const restore = pin({ PP_RATINGS_DIR: dir });
    try {
      const loaded = store.loadSnapshot('sagarin', 'NCAAF', 2026);
      assert.equal(loaded.path, path.join(dir, 'sagarin-NCAAF-2026.json'));
    } finally {
      restore();
    }
  });

  it('prefers SSB_RATINGS_DIR over the deprecated alias when both are set', () => {
    const canonical = tmpDir('ssb-wins');
    const legacy = tmpDir('pp-loses');
    const restore = pin({ SSB_RATINGS_DIR: canonical, PP_RATINGS_DIR: legacy });
    try {
      const loaded = store.loadSnapshot('sagarin', 'NCAAF', 2026);
      assert.equal(loaded.path, path.join(canonical, 'sagarin-NCAAF-2026.json'));
      assert.ok(!loaded.path.startsWith(legacy));
    } finally {
      restore();
    }
  });

  it('WRITES to the canonical dir, not the deprecated one', () => {
    const canonical = tmpDir('ssb-write');
    const legacy = tmpDir('pp-unwritten');
    const restore = pin({ SSB_RATINGS_DIR: canonical, PP_RATINGS_DIR: legacy });
    try {
      const saved = store.saveSnapshot(sampleSnapshot());
      assert.equal(saved.ok, true, (saved.errors || []).join('; '));
      assert.equal(saved.path, path.join(canonical, 'sagarin-NCAAF-2026.json'));
      assert.equal(fs.existsSync(path.join(canonical, 'sagarin-NCAAF-2026.json')), true);
      assert.deepEqual(fs.readdirSync(legacy), [], 'the deprecated dir must stay untouched');
    } finally {
      restore();
    }
  });
});

describe('tennis-Elo snapshot path: SSB_ names are canonical', () => {
  it('resolves under SSB_RATINGS_DIR', () => {
    const dir = tmpDir('elo-ssb');
    const restore = pin({ SSB_RATINGS_DIR: dir });
    try {
      assert.equal(eloData.defaultSnapshotPath(), path.join(dir, 'tennis-elo-snapshot.json'));
    } finally {
      restore();
    }
  });

  it('still resolves under the deprecated PP_RATINGS_DIR', () => {
    const dir = tmpDir('elo-pp');
    const restore = pin({ PP_RATINGS_DIR: dir });
    try {
      assert.equal(eloData.defaultSnapshotPath(), path.join(dir, 'tennis-elo-snapshot.json'));
    } finally {
      restore();
    }
  });

  it('prefers SSB_RATINGS_DIR over the deprecated alias', () => {
    const canonical = tmpDir('elo-ssb-wins');
    const legacy = tmpDir('elo-pp-loses');
    const restore = pin({ SSB_RATINGS_DIR: canonical, PP_RATINGS_DIR: legacy });
    try {
      assert.equal(eloData.defaultSnapshotPath(), path.join(canonical, 'tennis-elo-snapshot.json'));
    } finally {
      restore();
    }
  });

  it('honours SSB_TENNIS_ELO_SNAPSHOT above every directory var', () => {
    const canonical = tmpDir('elo-explicit');
    const legacy = tmpDir('elo-explicit-legacy');
    const explicit = path.join(canonical, 'explicit.json');
    const restore = pin({
      SSB_TENNIS_ELO_SNAPSHOT: explicit,
      SSB_RATINGS_DIR: canonical,
      PP_RATINGS_DIR: legacy,
      PP_TENNIS_ELO_SNAPSHOT: path.join(legacy, 'legacy.json')
    });
    try {
      assert.equal(eloData.defaultSnapshotPath(), explicit);
    } finally {
      restore();
    }
  });

  it('still honours the deprecated PP_TENNIS_ELO_SNAPSHOT, and the SSB_ path outranks it', () => {
    const legacy = tmpDir('elo-pp-explicit');

    let restore = pin({ PP_TENNIS_ELO_SNAPSHOT: path.join(legacy, 'legacy.json') });
    try {
      assert.equal(eloData.defaultSnapshotPath(), path.join(legacy, 'legacy.json'));
    } finally {
      restore();
    }

    const canonical = tmpDir('elo-ssb-explicit');
    const canonicalPath = path.join(canonical, 'canonical.json');
    restore = pin({
      SSB_TENNIS_ELO_SNAPSHOT: canonicalPath,
      PP_TENNIS_ELO_SNAPSHOT: path.join(legacy, 'legacy.json')
    });
    try {
      assert.equal(eloData.defaultSnapshotPath(), canonicalPath);
    } finally {
      restore();
    }
  });
});
