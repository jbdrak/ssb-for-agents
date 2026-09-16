'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  VERSION,
  MODEL_VERSION,
  DEFAULT_RATING,
  DEFAULT_K,
  DEFAULT_SURFACE_WEIGHT,
  DEFAULT_MIN_SURFACE_MATCHES,
  SURFACES,
  buildRatings,
  predictMatch,
  expectedScore,
  normalizeSurface,
  normalizePlayerName
} = require('../lib/tennis-elo');

const K = 32;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal match record; overrides win. */
function match(overrides) {
  return Object.assign(
    {
      tour: 'atp',
      winner: 'A',
      loser: 'B',
      date: '2024-06-01',
      surface: 'hard',
      status: 'completed'
    },
    overrides
  );
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    Object.getOwnPropertyNames(obj).forEach((key) => deepFreeze(obj[key]));
    Object.freeze(obj);
  }
  return obj;
}

function poolPlayer(snapshot, tour, name) {
  const pool = snapshot.pools && snapshot.pools[tour];
  return (pool && pool[name]) || null;
}

/**
 * Test-local oracle: an independent, explicit reimplementation of the Elo
 * pipeline used to cross-check the engine on multi-match sequences (the
 * single-match and expected-score math are checked with hand-computed exact
 * values elsewhere).
 */
function oracleReplay(matches, opts = {}) {
  const k = opts.k === undefined ? K : opts.k;
  const players = new Map();
  const get = (name) => {
    if (!players.has(name)) {
      players.set(name, {
        overall: 1500,
        surfaces: {
          hard: { rating: 1500, matches: 0 },
          clay: { rating: 1500, matches: 0 },
          grass: { rating: 1500, matches: 0 }
        },
        totalMatches: 0
      });
    }
    return players.get(name);
  };
  for (const m of matches) {
    const winner = get(m.winner);
    const loser = get(m.loser);
    const e = expectedScore(winner.overall, loser.overall);
    winner.overall += k * (1 - e);
    loser.overall += k * (0 - (1 - e));
    if (m.surface) {
      const ws = winner.surfaces[m.surface];
      const ls = loser.surfaces[m.surface];
      const es = expectedScore(ws.rating, ls.rating);
      ws.rating += k * (1 - es);
      ls.rating += k * (0 - (1 - es));
      ws.matches += 1;
      ls.matches += 1;
    }
    winner.totalMatches += 1;
    loser.totalMatches += 1;
  }
  return players;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('tennis-elo constants', () => {
  it('exports a semver version and a namespaced model version', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(MODEL_VERSION, `tennis-elo-${VERSION}`);
  });

  it('exports documented defaults', () => {
    assert.equal(DEFAULT_RATING, 1500);
    assert.equal(DEFAULT_K, 32);
    assert.equal(DEFAULT_SURFACE_WEIGHT, 0.5);
    assert.equal(DEFAULT_MIN_SURFACE_MATCHES, 5);
  });

  it('exports the supported surface set', () => {
    assert.deepEqual(SURFACES, ['hard', 'clay', 'grass']);
  });
});

// ---------------------------------------------------------------------------
// expectedScore math
// ---------------------------------------------------------------------------

describe('expectedScore', () => {
  it('equal ratings give 0.5 exactly', () => {
    assert.equal(expectedScore(1500, 1500), 0.5);
  });

  it('400-point gap gives 1/(1+10^-1) = 0.90909...', () => {
    assert.ok(Math.abs(expectedScore(1900, 1500) - 1 / 1.1) < 1e-12);
    assert.ok(Math.abs(expectedScore(1500, 1900) - 0.1 / 1.1) < 1e-12);
  });

  it('200-point gap gives the known 0.7597469266... value', () => {
    assert.ok(Math.abs(expectedScore(1700, 1500) - 0.7597469266479578) < 1e-12);
  });

  it('is symmetric: p(A beats B) + p(B beats A) = 1', () => {
    for (const [a, b] of [
      [1500, 1500],
      [1700, 1400],
      [1450, 1620],
      [2010, 1580]
    ]) {
      assert.ok(Math.abs(expectedScore(a, b) + expectedScore(b, a) - 1) < 1e-12);
    }
  });

  it('is monotonic in rating difference', () => {
    const lo = expectedScore(1500, 1600);
    const mid = expectedScore(1500, 1500);
    const hi = expectedScore(1500, 1400);
    assert.ok(lo < mid && mid < hi);
  });

  it('rejects non-finite ratings', () => {
    assert.throws(() => expectedScore(NaN, 1500), TypeError);
    assert.throws(() => expectedScore(1500, Infinity), TypeError);
  });
});

// ---------------------------------------------------------------------------
// buildRatings: basic Elo update
// ---------------------------------------------------------------------------

describe('buildRatings — basic Elo update', () => {
  it('first match between equal players moves winner +K/2, loser -K/2', () => {
    const snapshot = buildRatings([match({ winner: 'A', loser: 'B' })]);
    const a = poolPlayer(snapshot, 'atp', 'A');
    const b = poolPlayer(snapshot, 'atp', 'B');
    assert.equal(a.overall, 1516);
    assert.equal(b.overall, 1484);
    assert.equal(a.surfaces.hard.rating, 1516);
    assert.equal(b.surfaces.hard.rating, 1484);
  });

  it('honors K=64 (double the default delta)', () => {
    const snapshot = buildRatings([match({ winner: 'A', loser: 'B' })], { k: 64 });
    assert.equal(poolPlayer(snapshot, 'atp', 'A').overall, 1532);
    assert.equal(poolPlayer(snapshot, 'atp', 'B').overall, 1468);
  });

  it('underdog win moves more rating than favorite win', () => {
    // Setup: A beats a fresh opponent, so A enters the decisive match at ~1516
    // while B is fresh at 1500 — A is the favorite.
    const setup = match({ winner: 'A', loser: 'Filler', date: '2024-06-01' });
    const favWins = buildRatings([setup, match({ winner: 'A', loser: 'B', date: '2024-06-02' })]);
    const dogWins = buildRatings([setup, match({ winner: 'B', loser: 'A', date: '2024-06-02' })]);
    const favGain = poolPlayer(favWins, 'atp', 'A').overall - 1516;
    const dogGain = poolPlayer(dogWins, 'atp', 'B').overall - 1500;
    assert.ok(favGain > 0 && favGain < 16, `favorite gain ${favGain} < K/2`);
    assert.ok(dogGain > 16 && dogGain < 32, `underdog gain ${dogGain} > K/2`);
    assert.ok(dogGain > favGain);
  });

  it('conserves total rating in the pool', () => {
    const matches = [
      match({ winner: 'A', loser: 'B', date: '2024-06-01' }),
      match({ winner: 'A', loser: 'C', date: '2024-06-02' }),
      match({ winner: 'D', loser: 'A', date: '2024-06-03' }),
      match({ winner: 'C', loser: 'D', date: '2024-06-04' })
    ];
    const snapshot = buildRatings(matches);
    const players = Object.values(snapshot.pools.atp);
    assert.equal(players.length, 4);
    const total = players.reduce((sum, p) => sum + p.overall, 0);
    assert.ok(Math.abs(total - 4 * 1500) < 1e-9);
  });

  it('matches the independent oracle on a multi-match sequence', () => {
    const matches = [
      match({ winner: 'A', loser: 'B', date: '2024-06-01' }),
      match({ winner: 'B', loser: 'C', date: '2024-06-03' }),
      match({ winner: 'A', loser: 'C', date: '2024-06-05' }),
      match({ winner: 'C', loser: 'A', date: '2024-06-07' }),
      match({ winner: 'D', loser: 'A', date: '2024-06-09' })
    ];
    const snapshot = buildRatings(matches);
    const oracle = oracleReplay(matches);
    for (const name of ['A', 'B', 'C', 'D']) {
      const p = poolPlayer(snapshot, 'atp', name);
      const o = oracle.get(name);
      assert.ok(Math.abs(p.overall - o.overall) < 1e-9, `${name} overall`);
      assert.ok(Math.abs(p.surfaces.hard.rating - o.surfaces.hard.rating) < 1e-9, `${name} hard`);
      assert.equal(p.totalMatches, o.totalMatches);
    }
  });
});

// ---------------------------------------------------------------------------
// Config validation / clamping
// ---------------------------------------------------------------------------

describe('buildRatings — config validation and clamping', () => {
  it('clamps K into [4, 128]', () => {
    const low = buildRatings([match({ winner: 'A', loser: 'B' })], { k: 0 });
    assert.equal(poolPlayer(low, 'atp', 'A').overall, 1502); // K clamped to 4
    const high = buildRatings([match({ winner: 'A', loser: 'B' })], { k: 1000 });
    assert.equal(poolPlayer(high, 'atp', 'A').overall, 1564); // K clamped to 128
  });

  it('throws TypeError for non-finite / non-number K and minSurfaceMatches', () => {
    assert.throws(() => buildRatings([], { k: '32' }), TypeError);
    assert.throws(() => buildRatings([], { k: NaN }), TypeError);
    assert.throws(() => buildRatings([], { minSurfaceMatches: 2.5 }), TypeError);
    assert.throws(() => buildRatings([], { surfaceWeight: '0.5' }), TypeError);
  });

  it('throws TypeError for non-array matches and non-object opts', () => {
    assert.throws(() => buildRatings('nope'), TypeError);
    assert.throws(() => buildRatings(null), TypeError);
    assert.throws(() => buildRatings([], 42), TypeError);
  });

  it('clamps surfaceWeight into [0, 1] and records the clamped config', () => {
    const snap = buildRatings([match({ winner: 'A', loser: 'B', date: '2024-06-01' })], { surfaceWeight: 3 });
    assert.equal(snap.config.surfaceWeight, 1);
    const snap2 = buildRatings([match({ winner: 'A', loser: 'B' })], { surfaceWeight: -2 });
    assert.equal(snap2.config.surfaceWeight, 0);
  });

  it('stores resolved config on the snapshot', () => {
    const snap = buildRatings([], { k: 40, surfaceWeight: 0.3, minSurfaceMatches: 2 });
    assert.deepEqual(snap.config, {
      k: 40,
      surfaceWeight: 0.3,
      minSurfaceMatches: 2,
      allowRetirement: false
    });
  });
});

// ---------------------------------------------------------------------------
// Overall vs per-surface ratings
// ---------------------------------------------------------------------------

describe('buildRatings — overall vs per-surface updates', () => {
  it('a hard match updates overall and hard only', () => {
    const snapshot = buildRatings([match({ winner: 'A', loser: 'B', surface: 'hard' })]);
    const a = poolPlayer(snapshot, 'atp', 'A');
    assert.equal(a.overall, 1516);
    assert.equal(a.surfaces.hard.rating, 1516);
    assert.equal(a.surfaces.clay.rating, 1500);
    assert.equal(a.surfaces.grass.rating, 1500);
  });

  it('a clay match after hard matches updates clay but leaves hard untouched', () => {
    const snapshot = buildRatings([
      match({ winner: 'A', loser: 'B', date: '2024-06-01', surface: 'hard' }),
      match({ winner: 'A', loser: 'B', date: '2024-06-02', surface: 'clay' })
    ]);
    const a = poolPlayer(snapshot, 'atp', 'A');
    // Hard E on match 2 uses hard ratings (1500 vs 1500 -> E=0.5), so clay is exact:
    assert.equal(a.surfaces.clay.rating, 1516);
    // Hard stays exactly where match 1 left it:
    assert.equal(a.surfaces.hard.rating, 1516);
    // Overall uses overall ratings (1516 vs 1484 -> E != 0.5), matches oracle:
    const oracle = oracleReplay([
      match({ winner: 'A', loser: 'B', date: '2024-06-01', surface: 'hard' }),
      match({ winner: 'A', loser: 'B', date: '2024-06-02', surface: 'clay' })
    ]);
    assert.ok(Math.abs(a.overall - oracle.get('A').overall) < 1e-9);
    assert.equal(a.surfaces.hard.matches, 1);
    assert.equal(a.surfaces.clay.matches, 1);
  });

  it('unknown surface updates overall only', () => {
    const snapshot = buildRatings([match({ winner: 'A', loser: 'B', surface: 'carpet' })]);
    const a = poolPlayer(snapshot, 'atp', 'A');
    assert.equal(snapshot.matches[0].surface, null);
    assert.equal(a.overall, 1516);
    assert.equal(a.surfaces.hard.rating, 1500);
    assert.equal(a.surfaces.clay.rating, 1500);
    assert.equal(a.surfaces.grass.rating, 1500);
  });
});

// ---------------------------------------------------------------------------
// Surface normalization
// ---------------------------------------------------------------------------

describe('surface normalization', () => {
  it('normalizeSurface maps common explicit variants', () => {
    assert.equal(normalizeSurface('hard'), 'hard');
    assert.equal(normalizeSurface('Hard Court'), 'hard');
    assert.equal(normalizeSurface('hard-court'), 'hard');
    assert.equal(normalizeSurface('HARD'), 'hard');
    assert.equal(normalizeSurface(' indoor '), 'hard');
    assert.equal(normalizeSurface('clay court'), 'clay');
    assert.equal(normalizeSurface('CLAY-COURT'), 'clay');
    assert.equal(normalizeSurface('red clay'), 'clay');
    assert.equal(normalizeSurface('grass court'), 'grass');
    assert.equal(normalizeSurface('g'), 'grass');
  });

  it('normalizeSurface returns null for unknown / missing surfaces', () => {
    assert.equal(normalizeSurface('carpet'), null);
    assert.equal(normalizeSurface('unknown'), null);
    assert.equal(normalizeSurface(''), null);
    assert.equal(normalizeSurface(undefined), null);
    assert.equal(normalizeSurface(null), null);
  });

  it('buildRatings normalizes surfaces in stored records', () => {
    const snapshot = buildRatings([
      match({ winner: 'A', loser: 'B', date: '2024-06-01', surface: 'Hard Court' }),
      match({ winner: 'A', loser: 'B', date: '2024-06-02', surface: 'CLAY-COURT' }),
      match({ winner: 'A', loser: 'B', date: '2024-06-03', surface: 'g' })
    ]);
    assert.deepEqual(
      snapshot.matches.map((m) => m.surface),
      ['hard', 'clay', 'grass']
    );
  });
});

// ---------------------------------------------------------------------------
// Player identity normalization
// ---------------------------------------------------------------------------

describe('player identity normalization', () => {
  it('normalizePlayerName trims and collapses whitespace', () => {
    assert.equal(normalizePlayerName('  Novak   Djoković '), 'Novak Djoković');
    assert.equal(normalizePlayerName('\tIga\t Swiatek\n'), 'Iga Swiatek');
  });

  it('normalizePlayerName applies Unicode NFKC (decomposed == composed)', () => {
    assert.equal(normalizePlayerName('Novak Djokovic\u0301'), 'Novak Djoković');
  });

  it('identity is exact: no case folding, no fuzzy matching', () => {
    const snapshot = buildRatings([match({ winner: 'A. Smith', loser: 'B. Jones' })]);
    const ok = predictMatch(snapshot, { tour: 'atp', player1: 'a. smith', player2: 'B. Jones' });
    assert.equal(ok.available, false);
    assert.equal(ok.reason, 'player1_unseen');
  });

  it('prediction normalizes whitespace so padded names resolve', () => {
    const snapshot = buildRatings([match({ winner: 'A. Smith', loser: 'B. Jones' })]);
    const p = predictMatch(snapshot, {
      tour: 'atp',
      player1: '  A.   Smith ',
      player2: 'B. Jones'
    });
    assert.equal(p.available, true);
    assert.equal(p.players.player1.name, 'A. Smith');
  });
});

// ---------------------------------------------------------------------------
// Chronological processing
// ---------------------------------------------------------------------------

describe('buildRatings — chronological order', () => {
  it('processes out-of-order input in date order, identical to sorted input', () => {
    const m1 = match({ winner: 'A', loser: 'B', date: '2024-06-01' });
    const m2 = match({ winner: 'A', loser: 'B', date: '2024-06-02' });
    const m3 = match({ winner: 'B', loser: 'A', date: '2024-06-03' });
    const shuffled = buildRatings([m3, m1, m2]);
    const sorted = buildRatings([m1, m2, m3]);
    assert.deepEqual(shuffled, sorted);
    assert.deepEqual(
      shuffled.matches.map((m) => m.date),
      ['2024-06-01', '2024-06-02', '2024-06-03']
    );
  });

  it('accepts Date objects and epoch-millisecond timestamps', () => {
    const m1 = match({ winner: 'A', loser: 'B', date: '2024-06-01' });
    const m2 = match({ winner: 'A', loser: 'B', date: new Date('2024-06-02T12:00:00Z') });
    const m3 = match({ winner: 'A', loser: 'B', date: 1717372800000 }); // 2024-06-03T00:00:00Z
    const a = buildRatings([m3, m1, m2]);
    const b = buildRatings([m1, m2, m3]);
    assert.deepEqual(a, b);
    assert.equal(a.matches[1].date, '2024-06-02T12:00:00.000Z');
    assert.equal(a.matches[2].date, '2024-06-03T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Date parsing: deterministic UTC semantics
// ---------------------------------------------------------------------------

describe('date parsing — deterministic UTC semantics', () => {
  it('date-only strings parse as UTC midnight and keep the date-only iso form', () => {
    const snapshot = buildRatings([match({ winner: 'A', loser: 'B', date: '2024-06-02' })]);
    assert.equal(snapshot.matches[0].date, '2024-06-02');
    assert.equal(snapshot.matches[0].dateMs, Date.UTC(2024, 5, 2));
    assert.equal(snapshot.matches[0].dateMs, 1717286400000);
  });

  it('ISO datetime without a zone is interpreted as UTC (never host-local)', () => {
    const noZone = buildRatings([match({ winner: 'A', loser: 'B', date: '2024-06-02T00:00:00' })]);
    const withZ = buildRatings([match({ winner: 'A', loser: 'B', date: '2024-06-02T00:00:00Z' })]);
    assert.deepEqual(noZone.matches, withZ.matches);
    assert.equal(noZone.matches[0].dateMs, Date.UTC(2024, 5, 2));
    assert.equal(noZone.matches[0].date, '2024-06-02T00:00:00.000Z');
  });

  it('ISO datetime with an explicit offset is honored', () => {
    const plus = buildRatings([match({ winner: 'A', loser: 'B', date: '2024-06-02T04:00:00+04:00' })]);
    assert.equal(plus.matches[0].dateMs, Date.UTC(2024, 5, 2));
    assert.equal(plus.matches[0].date, '2024-06-02T00:00:00.000Z');
    const minus = buildRatings([match({ winner: 'A', loser: 'B', date: '2024-06-01T20:00:00-04:00' })]);
    assert.equal(minus.matches[0].dateMs, Date.UTC(2024, 5, 2));
  });

  it('rejects non-zero-padded and locale date strings instead of host-guessing', () => {
    const bad = ['2024-6-2', '2024-06-2', '6/2/2024', 'June 2, 2024', 'Jun 02 2024', '02.06.2024', '2024/06/02'];
    const matches = bad.map((date, i) => match({ winner: `W${i}`, loser: `L${i}`, date }));
    const snapshot = buildRatings(matches);
    assert.equal(snapshot.summary.processed, 0);
    assert.equal(snapshot.summary.skipped.reasons.invalid_date, bad.length);
  });

  it('rejects out-of-range ISO components rather than rolling over', () => {
    const snapshot = buildRatings([
      match({ winner: 'A', loser: 'B', date: '2024-02-31' }),
      match({ winner: 'A', loser: 'B', date: '2024-13-01' }),
      match({ winner: 'A', loser: 'B', date: '2024-06-02T25:00:00' })
    ]);
    assert.equal(snapshot.summary.processed, 0);
    assert.equal(snapshot.summary.skipped.reasons.invalid_date, 3);
  });

  it('date-only is UTC midnight, so it sorts before a same-day time-bearing datetime', () => {
    const dateOnly = match({ winner: 'A', loser: 'B', date: '2024-06-02' });
    const timed = match({ winner: 'B', loser: 'A', date: '2024-06-02T12:00:00' });
    const snapshot = buildRatings([timed, dateOnly]);
    assert.equal(snapshot.matches[0].date, '2024-06-02');
    assert.equal(snapshot.matches[1].date, '2024-06-02T12:00:00.000Z');
  });

  it('date-only asOf is UTC midnight: a same-day time-bearing match is strictly excluded', () => {
    const snapshot = buildRatings([
      match({ winner: 'A', loser: 'B', date: '2024-06-01' }),
      match({ winner: 'B', loser: 'A', date: '2024-06-02T00:00:00' })
    ]);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', asOf: '2024-06-02' });
    assert.equal(p.available, true);
    assert.equal(p.matchCounts.player1, 1);
    assert.equal(p.players.player1.lastMatchDate, '2024-06-01');
  });

  it('asOf rejects non-zero-padded and locale strings with invalid_asof', () => {
    const snapshot = buildRatings([
      match({ winner: 'A', loser: 'B', date: '2024-01-01' }),
      match({ winner: 'A', loser: 'B', date: '2024-02-01' })
    ]);
    for (const asOf of ['2024-3-1', 'March 1, 2024', '03/01/2024']) {
      const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', asOf });
      assert.equal(p.available, false);
      assert.equal(p.reason, 'invalid_asof');
      assert.equal(p.asOf, null);
    }
  });
});

// ---------------------------------------------------------------------------
// Timezone determinism: identical results under different process TZ
// ---------------------------------------------------------------------------

describe('timezone determinism (TZ=UTC vs TZ=America/New_York)', () => {
  const CHILD_SCRIPT = `
    const { buildRatings, predictMatch } = require('./lib/tennis-elo');
    const matches = [
      { tour: 'atp', winner: 'A', loser: 'B', date: '2024-06-01', surface: 'hard', status: 'completed' },
      { tour: 'atp', winner: 'A', loser: 'B', date: '2024-06-02T00:00:00', surface: 'clay', status: 'completed' },
      { tour: 'atp', winner: 'B', loser: 'A', date: '2024-06-02T12:00:00', surface: 'hard', status: 'completed' },
      { tour: 'atp', winner: 'C', loser: 'D', date: '2024-06-03T00:00:00', surface: 'hard', status: 'completed' }
    ];
    const snapshot = buildRatings(matches);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', surface: 'hard', asOf: '2024-06-02T00:00:00' });
    console.log(JSON.stringify({
      dates: snapshot.matches.map((m) => m.date),
      dateMs: snapshot.matches.map((m) => m.dateMs),
      pools: snapshot.pools,
      summary: snapshot.summary,
      asOf: p.asOf,
      available: p.available,
      matchCounts: p.matchCounts,
      probability: p.probability
    }));
  `;

  function runInTz(tz) {
    const res = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, TZ: tz },
      encoding: 'utf8'
    });
    assert.equal(res.status, 0, `child probe failed under TZ=${tz}: ${res.stderr}`);
    return JSON.parse(res.stdout);
  }

  it('timezone-less ISO datetime yields identical snapshot, ratings, and order in UTC and America/New_York', () => {
    const utc = runInTz('UTC');
    const ny = runInTz('America/New_York');
    assert.deepEqual(utc, ny);
    // Absolute anchor: the no-zone datetime is UTC midnight, not host-local.
    assert.equal(utc.dateMs[1], Date.UTC(2024, 5, 2));
    assert.equal(utc.dateMs[2], Date.UTC(2024, 5, 2, 12));
    assert.equal(utc.asOf, '2024-06-02T00:00:00.000Z');
    assert.equal(utc.matchCounts.player1, 1); // strictly before asOf only
  });
});

// ---------------------------------------------------------------------------
// asOf: strict no future leakage
// ---------------------------------------------------------------------------

describe('predictMatch — asOf and no future leakage', () => {
  const m1 = match({ winner: 'A', loser: 'B', date: '2024-01-01' });
  const m2 = match({ winner: 'A', loser: 'B', date: '2024-02-01' });
  const m3 = match({ winner: 'B', loser: 'A', date: '2024-03-01' });

  it('excludes the match on the asOf date itself (strictly before)', () => {
    const snapshot = buildRatings([m1, m2, m3]);
    const p = predictMatch(snapshot, {
      tour: 'atp',
      player1: 'A',
      player2: 'B',
      surface: 'hard',
      asOf: '2024-03-01'
    });
    assert.equal(p.available, true);
    const oracle = oracleReplay([m1, m2]);
    assert.ok(Math.abs(p.players.player1.overall - oracle.get('A').overall) < 1e-9);
    assert.ok(Math.abs(p.players.player2.overall - oracle.get('B').overall) < 1e-9);
    assert.equal(p.matchCounts.player1, 2);
    assert.equal(p.players.player1.lastMatchDate, '2024-02-01');
    assert.equal(p.asOf, '2024-03-01');
  });

  it('asOf equal to the second match date leaves only the first match', () => {
    const snapshot = buildRatings([m1, m2, m3]);
    const p = predictMatch(snapshot, {
      tour: 'atp',
      player1: 'A',
      player2: 'B',
      surface: 'hard',
      asOf: '2024-02-01'
    });
    assert.equal(p.available, true);
    assert.equal(p.players.player1.overall, 1516); // exact: first match E=0.5
    assert.equal(p.players.player2.overall, 1484);
    assert.equal(p.matchCounts.player1, 1);
  });

  it('asOf with a time component includes date-only matches earlier that day', () => {
    const snapshot = buildRatings([m1, m2, m3]);
    const p = predictMatch(snapshot, {
      tour: 'atp',
      player1: 'A',
      player2: 'B',
      surface: 'hard',
      asOf: '2024-02-01T12:00:00Z'
    });
    assert.equal(p.matchCounts.player1, 2);
  });

  it('no asOf uses full history', () => {
    const snapshot = buildRatings([m1, m2, m3]);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', surface: 'hard' });
    assert.equal(p.available, true);
    assert.equal(p.asOf, null);
    assert.equal(p.matchCounts.player1, 3);
    const oracle = oracleReplay([m1, m2, m3]);
    assert.ok(Math.abs(p.players.player1.overall - oracle.get('A').overall) < 1e-9);
  });

  it('asOf before any match is unavailable, never a default-rating prediction', () => {
    const snapshot = buildRatings([m1, m2, m3]);
    const p = predictMatch(snapshot, {
      tour: 'atp',
      player1: 'A',
      player2: 'B',
      surface: 'hard',
      asOf: '2024-01-01'
    });
    assert.equal(p.available, false);
    assert.equal(p.reason, 'player1_no_history_before_asof');
    assert.equal(p.players, null);
    assert.equal(p.probability, null);
  });

  it('unparseable asOf is an explicit failure', () => {
    const snapshot = buildRatings([m1, m2, m3]);
    const p = predictMatch(snapshot, {
      tour: 'atp',
      player1: 'A',
      player2: 'B',
      surface: 'hard',
      asOf: 'not-a-date'
    });
    assert.equal(p.available, false);
    assert.equal(p.reason, 'invalid_asof');
  });
});

// ---------------------------------------------------------------------------
// ATP / WTA separation
// ---------------------------------------------------------------------------

describe('buildRatings — ATP/WTA pool separation', () => {
  const atpMatches = [
    match({ tour: 'atp', winner: 'S. Williams', loser: 'V. Williams', date: '2024-01-01' }),
    match({ tour: 'atp', winner: 'S. Williams', loser: 'V. Williams', date: '2024-01-05' }),
    match({ tour: 'atp', winner: 'R. Federer', loser: 'V. Williams', date: '2024-01-10' })
  ];
  const wtaMatches = [
    match({ tour: 'WTA', winner: 'S. Williams', loser: 'V. Williams', date: '2024-01-02' }),
    match({ tour: 'WTA', winner: 'V. Williams', loser: 'S. Williams', date: '2024-01-06' }),
    match({ tour: 'WTA', winner: 'I. Swiatek', loser: 'S. Williams', date: '2024-01-12' })
  ];

  it('keeps the same name in separate, independent pools', () => {
    const snapshot = buildRatings([...atpMatches, ...wtaMatches]);
    const atpOracle = oracleReplay(atpMatches);
    const wtaOracle = oracleReplay(wtaMatches);
    const atpSW = poolPlayer(snapshot, 'atp', 'S. Williams');
    const wtaSW = poolPlayer(snapshot, 'wta', 'S. Williams');
    assert.ok(Math.abs(atpSW.overall - atpOracle.get('S. Williams').overall) < 1e-9);
    assert.ok(Math.abs(wtaSW.overall - wtaOracle.get('S. Williams').overall) < 1e-9);
    assert.ok(Math.abs(atpSW.overall - wtaSW.overall) > 1e-9, 'pools must diverge');
    assert.equal(atpSW.totalMatches, 2);
    assert.equal(wtaSW.totalMatches, 3); // S. Williams plays 3 WTA matches
  });

  it('never exposes a player in the other tour pool', () => {
    const snapshot = buildRatings([...atpMatches, ...wtaMatches]);
    assert.equal(poolPlayer(snapshot, 'wta', 'R. Federer'), null);
    assert.equal(poolPlayer(snapshot, 'atp', 'I. Swiatek'), null);
  });

  it('prediction in one tour never uses the other tour history', () => {
    const snapshot = buildRatings([...atpMatches, ...wtaMatches]);
    const p = predictMatch(snapshot, { tour: 'wta', player1: 'R. Federer', player2: 'I. Swiatek' });
    assert.equal(p.available, false);
    assert.equal(p.reason, 'player1_unseen');
  });
});

// ---------------------------------------------------------------------------
// Surface blend for prediction
// ---------------------------------------------------------------------------

describe('predictMatch — surface blending', () => {
  // A: 6 hard wins vs fresh opponents, then 6 clay losses vs fresh opponents.
  // B: 6 hard wins, then 6 clay losses (same shape, different opponents).
  // X1: a single-match player (1 hard match).
  const matches = [];
  for (let i = 1; i <= 6; i += 1) {
    matches.push(match({ winner: 'A', loser: `HA${i}`, date: `2024-01-0${i}` }));
    matches.push(match({ winner: 'B', loser: `HB${i}`, date: `2024-01-1${i}` }));
  }
  for (let i = 1; i <= 6; i += 1) {
    matches.push(match({ winner: `CA${i}`, loser: 'A', date: `2024-02-0${i}`, surface: 'clay' }));
    matches.push(match({ winner: `CB${i}`, loser: 'B', date: `2024-02-1${i}`, surface: 'clay' }));
  }
  matches.push(match({ winner: 'A', loser: 'X1', date: '2024-03-01' }));

  it('blends when BOTH players have >= minSurfaceMatches on the surface', () => {
    const snapshot = buildRatings(matches);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', surface: 'hard' });
    assert.equal(p.available, true);
    assert.equal(p.blend.used, true);
    assert.equal(p.players.player1.surfaceMatches, 7); // 6 HA wins + the X1 match, all hard
    assert.equal(p.players.player2.surfaceMatches, 6);
    const effA = p.players.player1.overall + 0.5 * (p.players.player1.surface - p.players.player1.overall);
    const effB = p.players.player2.overall + 0.5 * (p.players.player2.surface - p.players.player2.overall);
    assert.ok(Math.abs(p.players.player1.effective - effA) < 1e-9);
    assert.ok(Math.abs(p.players.player2.effective - effB) < 1e-9);
    assert.ok(Math.abs(p.probability.player1 - expectedScore(effA, effB)) < 1e-9);
    assert.ok(Math.abs(p.probability.player1 + p.probability.player2 - 1) < 1e-12);
    assert.equal(p.expectedScore.player1, p.probability.player1);
  });

  it('uses overall only when either player is below the surface threshold', () => {
    const snapshot = buildRatings(matches);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'X1', surface: 'hard' });
    assert.equal(p.available, true);
    assert.equal(p.blend.used, false);
    assert.equal(p.players.player1.blended, false);
    assert.equal(p.players.player2.blended, false);
    assert.equal(p.players.player1.effective, p.players.player1.overall);
    assert.equal(p.players.player2.effective, p.players.player2.overall);
    assert.ok(
      Math.abs(p.probability.player1 - expectedScore(p.players.player1.overall, p.players.player2.overall)) < 1e-9
    );
  });

  it('minSurfaceMatches: 0 blends even a one-match player', () => {
    const snapshot = buildRatings(matches, { minSurfaceMatches: 0 });
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'X1', surface: 'hard' });
    assert.equal(p.blend.used, true);
    assert.equal(p.blend.minSurfaceMatches, 0);
    assert.equal(p.players.player1.blended, true);
  });

  it('surfaceWeight: 0 makes effective equal overall even when blending', () => {
    const snapshot = buildRatings(matches, { surfaceWeight: 0 });
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', surface: 'hard' });
    assert.equal(p.blend.used, true);
    assert.equal(p.players.player1.effective, p.players.player1.overall);
  });

  it('clamped surfaceWeight 3 -> 1 makes effective equal the surface rating', () => {
    const snapshot = buildRatings(matches, { surfaceWeight: 3 });
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', surface: 'hard' });
    assert.equal(snapshot.config.surfaceWeight, 1);
    assert.ok(Math.abs(p.players.player1.effective - p.players.player1.surface) < 1e-9);
  });

  it('unknown surface never blends: surface null, overall only', () => {
    const snapshot = buildRatings(matches);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', surface: 'carpet' });
    assert.equal(p.surface, null);
    assert.equal(p.blend.used, false);
    assert.equal(p.players.player1.effective, p.players.player1.overall);
    const p2 = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B' });
    assert.equal(p2.surface, null);
    assert.equal(p2.players.player1.surface, null);
    assert.equal(p2.players.player1.surfaceMatches, null);
  });

  it('reports the surface component even when not blended', () => {
    const snapshot = buildRatings(matches);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'X1', surface: 'hard' });
    assert.equal(typeof p.players.player1.surface, 'number');
    assert.equal(p.players.player1.surfaceMatches, 7);
  });
});

// ---------------------------------------------------------------------------
// Skipped statuses and malformed records
// ---------------------------------------------------------------------------

describe('buildRatings — skipped statuses and malformed records', () => {
  it('skips walkover/default/abandoned/cancelled/retired/pending with counters', () => {
    const statuses = [
      ['walkover', 'walkover'],
      ['wo', 'wo'],
      ['default', 'default'],
      ['abandoned', 'abandoned'],
      ['cancelled', 'cancelled'],
      ['canceled', 'canceled'],
      ['postponed', 'postponed'],
      ['retired', 'retired'],
      ['unknown', 'unknown'],
      ['scheduled', 'scheduled'],
      ['totally-bogus', 'unknown_status']
    ];
    const matches = statuses.map(([status], i) =>
      match({ winner: `W${i}`, loser: `L${i}`, status, date: `2024-03-${String(i + 1).padStart(2, '0')}` })
    );
    matches.push(match({ winner: 'A', loser: 'B', date: '2024-03-20', status: 'completed' })); // explicit completed
    const snapshot = buildRatings(matches);
    assert.equal(snapshot.summary.totalInput, 12);
    assert.equal(snapshot.summary.processed, 1);
    assert.equal(snapshot.summary.skipped.total, 11);
    const expected = {};
    for (const [, reason] of statuses) expected[reason] = (expected[reason] || 0) + 1;
    assert.deepEqual(snapshot.summary.skipped.reasons, expected);
    assert.equal(snapshot.matches.length, 1);
    assert.deepEqual(Object.keys(snapshot.pools.atp).sort(), ['A', 'B']);
    assert.equal(snapshot.matches[0].status, undefined); // status not stored
  });

  it('missing or blank status is skipped with an explicit missing_status reason (never assumed completed)', () => {
    const snapshot = buildRatings([
      match({ winner: 'A', loser: 'B', status: undefined, date: '2024-03-01' }),
      match({ winner: 'C', loser: 'D', status: '', date: '2024-03-02' }),
      match({ winner: 'E', loser: 'F', status: '   ', date: '2024-03-03' }),
      match({ winner: 'G', loser: 'H', status: null, date: '2024-03-04' })
    ]);
    assert.equal(snapshot.summary.processed, 0);
    assert.equal(snapshot.summary.skipped.total, 4);
    assert.equal(snapshot.summary.skipped.reasons.missing_status, 4);
  });

  it('explicit completed/finished/final/ended statuses are all processed', () => {
    const statuses = ['completed', 'finished', 'final', 'ended'];
    const matches = statuses.map((status, i) =>
      match({ winner: `W${i}`, loser: `L${i}`, status, date: `2024-03-${String(i + 1).padStart(2, '0')}` })
    );
    const snapshot = buildRatings(matches);
    assert.equal(snapshot.summary.processed, 4);
    assert.equal(snapshot.summary.skipped.total, 0);
    assert.equal(snapshot.summary.skipped.reasons.missing_status, undefined);
  });

  it('allowRetirement: true includes retired matches', () => {
    const retired = match({ winner: 'A', loser: 'B', status: 'retired', date: '2024-03-01' });
    const snap1 = buildRatings([retired]);
    assert.equal(snap1.summary.processed, 0);
    assert.equal(snap1.summary.skipped.reasons.retired, 1);
    const snap2 = buildRatings([retired], { allowRetirement: true });
    assert.equal(snap2.summary.processed, 1);
    assert.equal(snap2.summary.skipped.total, 0);
    assert.equal(snap2.config.allowRetirement, true);
  });

  it('skips missing winner/loser/tour/date and malformed records, never guesses', () => {
    const matches = [
      { tour: 'atp', winner: undefined, loser: 'B', date: '2024-05-01' }, // missing winner
      { tour: 'atp', winner: 'A', loser: undefined, date: '2024-05-01' }, // missing loser
      { winner: 'A', loser: 'B', date: '2024-05-01' }, // missing tour
      { tour: 'ITF', winner: 'A', loser: 'B', date: '2024-05-01' }, // unknown tour
      { tour: 'atp', winner: 'A', loser: 'B' }, // missing date
      { tour: 'atp', winner: 'A', loser: 'B', date: 'not-a-date' }, // invalid date
      { tour: 'atp', winner: 'A', loser: 'A', date: '2024-05-01' }, // same player
      null // malformed
    ];
    const snapshot = buildRatings(matches);
    assert.equal(snapshot.summary.totalInput, 8);
    assert.equal(snapshot.summary.processed, 0);
    assert.equal(snapshot.summary.skipped.total, 8);
    assert.deepEqual(snapshot.summary.skipped.reasons, {
      missing_winner: 1,
      missing_loser: 1,
      missing_tour: 1,
      unknown_tour: 1,
      missing_date: 1,
      invalid_date: 1,
      same_player: 1,
      malformed: 1
    });
    assert.equal(snapshot.matches.length, 0);
    assert.deepEqual(snapshot.pools.atp, {});
    assert.deepEqual(snapshot.pools.wta, {});
  });
});

// ---------------------------------------------------------------------------
// Prediction availability
// ---------------------------------------------------------------------------

describe('predictMatch — availability', () => {
  const snapshot = buildRatings([
    match({ winner: 'A', loser: 'B', date: '2024-01-01' }),
    match({ winner: 'C', loser: 'D', date: '2024-01-02' })
  ]);

  it('unseen player2 is unavailable with a coverage reason', () => {
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'Nobody' });
    assert.equal(p.available, false);
    assert.equal(p.reason, 'player2_unseen');
    assert.equal(p.players, null);
    assert.equal(p.probability, null);
    assert.deepEqual(p.matchCounts, { player1: 1, player2: 0 });
  });

  it('unseen player1 is unavailable', () => {
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'Nobody', player2: 'AlsoNobody' });
    assert.equal(p.available, false);
    assert.equal(p.reason, 'player1_unseen');
  });

  it('missing or unknown tour is unavailable', () => {
    assert.equal(predictMatch(snapshot, { player1: 'A', player2: 'B' }).reason, 'missing_tour');
    assert.equal(predictMatch(snapshot, { tour: '', player1: 'A', player2: 'B' }).reason, 'missing_tour');
    assert.equal(predictMatch(snapshot, { tour: 'xyz', player1: 'A', player2: 'B' }).reason, 'unknown_tour');
    assert.equal(predictMatch(snapshot, { tour: '  atp  ', player1: 'A', player2: 'B' }).available, true);
  });

  it('missing players and identical players are unavailable', () => {
    assert.equal(predictMatch(snapshot, { tour: 'atp', player1: 'A' }).reason, 'missing_players');
    assert.equal(predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: '  A ' }).reason, 'same_player');
  });

  it('rejects invalid snapshot and args objects', () => {
    assert.throws(() => predictMatch({}, { tour: 'atp', player1: 'A', player2: 'B' }), TypeError);
    assert.throws(() => predictMatch(snapshot, 'nope'), TypeError);
    assert.throws(() => predictMatch(snapshot, null), TypeError);
  });

  it('unavailable results keep a stable, JSON-safe shape', () => {
    const p = predictMatch(snapshot, { tour: 'wta', player1: 'A', player2: 'B' });
    assert.deepEqual(Object.keys(p).sort(), [
      'asOf',
      'available',
      'blend',
      'expectedScore',
      'lastMatchDate',
      'matchCounts',
      'modelVersion',
      'players',
      'probability',
      'reason',
      'surface',
      'tour'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('same-date ties resolve by input order, consistently', () => {
    const mAB = match({ winner: 'A', loser: 'B', date: '2024-06-01' });
    const mBA = match({ winner: 'B', loser: 'A', date: '2024-06-01' });
    const s1 = buildRatings([mAB, mBA]);
    const s2 = buildRatings([mAB, mBA]);
    assert.deepEqual(s1, s2); // identical input -> identical snapshot
    const s3 = buildRatings([mBA, mAB]); // input order matters for ties
    assert.notDeepEqual(s1, s3);
    // s1 must equal the oracle applied in the same input order:
    const oracle = oracleReplay([mAB, mBA]);
    assert.ok(Math.abs(s1.pools.atp.A.overall - oracle.get('A').overall) < 1e-9);
    assert.ok(Math.abs(s1.pools.atp.B.overall - oracle.get('B').overall) < 1e-9);
  });

  it('independent same-date matches are order-insensitive', () => {
    const m1 = match({ winner: 'A', loser: 'B', date: '2024-06-01' });
    const m2 = match({ winner: 'C', loser: 'D', date: '2024-06-01' });
    const a = buildRatings([m1, m2]);
    const b = buildRatings([m2, m1]);
    // Ratings and summary are identical; only the stored matches array keeps
    // input order for ties, so compare pools + summary rather than the array.
    assert.deepEqual(a.pools, b.pools);
    assert.deepEqual(a.summary, b.summary);
    assert.deepEqual(a.config, b.config);
    assert.deepEqual(
      Object.values(a.pools.atp)
        .map((p) => p.overall)
        .sort(),
      Object.values(b.pools.atp)
        .map((p) => p.overall)
        .sort()
    );
  });

  it('repeated builds with identical input are byte-identical', () => {
    const matches = [
      match({ winner: 'A', loser: 'B', date: '2024-06-01', surface: 'hard' }),
      match({ winner: 'A', loser: 'C', date: '2024-06-03', surface: 'clay' })
    ];
    const a = buildRatings(matches, { k: 40 });
    const b = buildRatings(matches, { k: 40 });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Input immutability and JSON safety
// ---------------------------------------------------------------------------

describe('immutability and JSON safety', () => {
  it('never mutates frozen input matches or opts', () => {
    const matches = deepFreeze([
      match({ winner: 'A', loser: 'B', date: '2024-01-01', surface: 'hard' }),
      match({ winner: 'A', loser: 'C', date: '2024-01-05', surface: 'clay' })
    ]);
    const before = JSON.parse(JSON.stringify(matches));
    const opts = deepFreeze({ k: 40, surfaceWeight: 0.3, minSurfaceMatches: 2 });
    const snapshot = buildRatings(matches, opts);
    const p = predictMatch(snapshot, deepFreeze({ tour: 'atp', player1: 'A', player2: 'B', surface: 'hard' }));
    assert.equal(p.available, true);
    assert.deepEqual(matches, before);
    assert.deepEqual(opts, { k: 40, surfaceWeight: 0.3, minSurfaceMatches: 2 });
  });

  it('snapshot and prediction are JSON-safe (no functions, Dates, or undefined)', () => {
    const snapshot = buildRatings([
      match({ winner: 'A', loser: 'B', date: '2024-01-01' }),
      match({ winner: 'A', loser: 'C', date: '2024-01-05', surface: 'clay' })
    ]);
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    assert.deepEqual(roundTripped, snapshot);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B' });
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
    assert.equal(typeof snapshot.modelVersion, 'string');
    assert.equal(typeof p.players.player1.overall, 'number');
    assert.equal(typeof p.players.player1.lastMatchDate, 'string');
    assert.equal(typeof p.probability.player1, 'number');
  });
});

// ---------------------------------------------------------------------------
// Elo module isolation (ported invariant)
// ---------------------------------------------------------------------------

describe('Elo module isolation', () => {
  it('lib/tennis-elo.js requires nothing — never the ranker/verdict/calibration layers', () => {
    const fs = require('node:fs');
    const eloSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tennis-elo.js'), 'utf8');
    // The engine is dependency-free by design: pulling in the ranking, analysis,
    // risk or calibration modules would let a rating feed back into the signals
    // it is meant to sit beside.
    assert.ok(!/require\s*\(/.test(eloSource), 'tennis-elo must not require any module');
    for (const name of ['screen-ranker', 'ssb-analysis', 'risk-score', 'signal-calibration']) {
      assert.ok(!eloSource.includes(name), `tennis-elo must not reference ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Ported contract — the properties this port must not regress
// ---------------------------------------------------------------------------

describe('ported contract — required properties', () => {
  it('chronological only: a later match is invisible to an asOf prediction', () => {
    const before = match({ winner: 'A', loser: 'B', date: '2024-01-01' });
    const onTheDay = match({ winner: 'A', loser: 'B', date: '2024-02-01' });
    const after = match({ winner: 'B', loser: 'A', date: '2024-03-01' });
    const snapshot = buildRatings([before, onTheDay, after]);
    const asOf = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B', asOf: '2024-02-01' });
    assert.equal(asOf.available, true);
    // Only the first match is strictly before the cutoff; the same-day match is excluded.
    assert.equal(asOf.matchCounts.player1, 1);
    assert.equal(asOf.players.player1.overall, 1516); // hand value: 1500 + 32*(1-0.5)
    // The later results are in the same snapshot but stay out of the cutoff view.
    const full = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B' });
    assert.equal(full.matchCounts.player1, 3);
    assert.notEqual(full.players.player1.overall, asOf.players.player1.overall);
  });

  it('surface-aware: a clay result never moves the hard rating and vice versa', () => {
    const snapshot = buildRatings([
      match({ winner: 'A', loser: 'B', date: '2024-01-01', surface: 'hard' }),
      match({ winner: 'B', loser: 'A', date: '2024-01-02', surface: 'clay' })
    ]);
    const a = poolPlayer(snapshot, 'atp', 'A');
    assert.equal(a.surfaces.hard.rating, 1516); // hard win only
    assert.equal(a.surfaces.clay.rating, 1484); // clay loss only
    assert.equal(a.surfaces.hard.matches, 1);
    assert.equal(a.surfaces.clay.matches, 1);
    assert.equal(a.surfaces.grass.rating, 1500); // untouched
  });

  it('no surface history falls back to overall explicitly, never a silent blended rate', () => {
    const matches = [];
    for (let i = 1; i <= 6; i += 1) {
      matches.push(match({ winner: 'A', loser: `HB${i}`, date: `2024-01-0${i}`, surface: 'hard' }));
    }
    matches.push(match({ winner: 'A', loser: 'Rookie', date: '2024-02-01', surface: 'hard' }));
    const snapshot = buildRatings(matches);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'Rookie', surface: 'hard' });
    assert.equal(p.available, true);
    // Rookie has 1 hard match (< minSurfaceMatches), so no blend; overall only.
    assert.equal(p.blend.used, false);
    assert.equal(p.players.player2.blended, false);
    assert.equal(p.players.player2.effective, p.players.player2.overall);
  });

  it('ATP and WTA never pool: the same name stays in two independent pools', () => {
    const snapshot = buildRatings([
      match({ tour: 'atp', winner: 'Same Name', loser: 'X', date: '2024-01-01' }),
      match({ tour: 'wta', winner: 'X', loser: 'Same Name', date: '2024-01-02' })
    ]);
    const atp = poolPlayer(snapshot, 'atp', 'Same Name');
    const wta = poolPlayer(snapshot, 'wta', 'Same Name');
    assert.ok(atp && wta);
    assert.equal(atp.totalMatches, 1); // ATP pool sees only the ATP match
    assert.equal(wta.totalMatches, 1); // WTA pool sees only the WTA match
    assert.notEqual(atp.overall, wta.overall); // 1516 vs 1484
  });

  it('missing or unknown player resolves to explicit unavailable/null, never a default rating', () => {
    const snapshot = buildRatings([match({ winner: 'Known', loser: 'Other', date: '2024-01-01' })]);
    for (const [args, reason] of [
      [{ tour: 'atp', player1: 'Known', player2: 'Ghost' }, 'player2_unseen'],
      [{ tour: 'atp', player1: 'Ghost', player2: 'Known' }, 'player1_unseen'],
      [{ tour: 'atp', player1: 'Ghost', player2: 'Phantom' }, 'player1_unseen']
    ]) {
      const p = predictMatch(snapshot, args);
      assert.equal(p.available, false);
      assert.equal(p.reason, reason);
      assert.equal(p.players, null);
      assert.equal(p.probability, null);
    }
  });

  it('known value verifiable by hand: equal players after one completed match', () => {
    // E = 1 / (1 + 10^0) = 0.5, K = 32 -> winner 1500 + 32*0.5 = 1516, loser 1484.
    const snapshot = buildRatings([match({ winner: 'A', loser: 'B', date: '2024-06-01', surface: 'hard' })]);
    assert.equal(poolPlayer(snapshot, 'atp', 'A').overall, 1516);
    assert.equal(poolPlayer(snapshot, 'atp', 'B').overall, 1484);
    const p = predictMatch(snapshot, { tour: 'atp', player1: 'A', player2: 'B' });
    // 1516 vs 1484 -> 1 / (1 + 10^(-32/400)).
    assert.ok(Math.abs(p.probability.player1 - 1 / (1 + Math.pow(10, -32 / 400))) < 1e-12);
    assert.ok(Math.abs(p.probability.player1 + p.probability.player2 - 1) < 1e-12);
  });
});
