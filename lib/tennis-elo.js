'use strict';

/**
 * tennis-elo.js — pure chronological, surface-aware tennis Elo engine.
 *
 * Port provenance
 * ---------------
 * Ported from the pre-refactor engine (lib/tennis-elo.js at 7f4780b^, released
 * as MODEL_VERSION tennis-elo-1.1.0), which commit 7f4780b removed during a
 * broad reliability refactor. This is a PORT, not a new design: the algorithm,
 * status handling, date semantics and tuned constants are carried over
 * unchanged. No downloader, no bundled third-party data, no network access.
 *
 * Named constants (ORIGINAL values — change deliberately, not silently):
 *   DEFAULT_RATING              1500  seed rating for an unseen player
 *   DEFAULT_K                   32    Elo K-factor (clamped to [4, 128])
 *   DEFAULT_SURFACE_WEIGHT      0.5   overall<->surface blend weight ([0, 1])
 *   DEFAULT_MIN_SURFACE_MATCHES 5     min surface matches required to blend
 * There is intentionally no time-decay term here: ratings are plain
 * chronological Elo updates. Adding decay would be a new model decision.
 *
 * Design contract
 * ---------------
 * - Pure CommonJS module: no IO, no network, no clock, no Date.now().
 * - Chronological replay: matches are processed strictly in date order
 *   (stable input order breaks same-date ties). Nothing about the future
 *   ever influences a rating at an earlier point in time.
 * - Separate ATP and WTA pools. Ratings never cross-contaminate tours.
 * - Every player carries an overall rating plus per-surface ratings for
 *   hard / clay / grass. A match updates the overall ratings with overall
 *   expected scores and the surface ratings (when the surface is known)
 *   with surface expected scores. Unknown surfaces update overall only.
 * - Prediction blends overall and surface rating ONLY when BOTH players
 *   have >= minSurfaceMatches completed matches on that surface;
 *   otherwise the overall rating is used alone.
 * - Only completed normal matches are processed. Walkover / default /
 *   abandoned / cancelled / postponed / retired / unknown / scheduled /
 *   pending statuses are skipped with coverage counters, never guessed.
 *   Retirement is included only when opts.allowRetirement is true.
 *   A missing or blank status field is skipped with an explicit
 *   `missing_status` counter — never assumed completed.
 * - Player identity is exact: names are canonicalized with Unicode NFKC,
 *   trimming, and whitespace collapsing only. No case folding, no fuzzy
 *   or last-name resolution. An unseen/ambiguous player yields an
 *   explicit unavailable result — never a default-rating prediction.
 * - Input is never mutated. All outputs are JSON-safe (numbers, strings,
 *   null — no functions, Dates, or undefined values).
 *
 * Match record fields understood by buildRatings():
 *   tour    'atp' | 'wta' (case-insensitive; anything else is skipped)
 *   winner  winner name (required)
 *   loser   loser name (required, must differ from winner)
 *   date    parseable date: zero-padded 'YYYY-MM-DD' (UTC midnight), strict
 *           ISO 8601 datetime string, Date object, or epoch milliseconds
 *           (required). An ISO datetime with an explicit Z/offset honors it;
 *           a datetime lacking a zone is interpreted as UTC. Locale /
 *           non-ISO / non-zero-padded strings are rejected with
 *           'invalid_date' — never Date.parse host-guessed.
 *           NOTE: a date-only string means UTC midnight, so it sorts before
 *           any same-day time-bearing datetime, and a same-day date-only
 *           asOf cutoff strictly excludes time-bearing matches.
 *   surface 'hard' | 'clay' | 'grass' plus common variants ('hard court',
 *           'clay-court', 'indoor', ...); unknown values update overall
 *           only and are stored as null
 *   status  'completed' | 'finished' | 'final' | 'ended' is processed;
 *           missing/blank is skipped with 'missing_status'; everything else
 *           is skipped (see above)
 */

const VERSION = '1.1.0';
const MODEL_VERSION = `tennis-elo-${VERSION}`;

// Original values carried over from the removed engine (see provenance above).
const DEFAULT_RATING = 1500; // unseen-player seed
const DEFAULT_K = 32; // Elo K-factor; clamped to [K_MIN, K_MAX]
const DEFAULT_SURFACE_WEIGHT = 0.5; // overall<->surface blend weight; clamped to [0, 1]
const DEFAULT_MIN_SURFACE_MATCHES = 5; // surface matches required before blending

const SURFACES = Object.freeze(['hard', 'clay', 'grass']);
const TOURS = Object.freeze(['atp', 'wta']);

const K_MIN = 4;
const K_MAX = 128;
const SURFACE_WEIGHT_MIN = 0;
const SURFACE_WEIGHT_MAX = 1;
const MIN_SURFACE_MATCHES_MAX = 10000;

/** Statuses that count as a completed, normal match. */
const COMPLETED_STATUSES = Object.freeze(new Set(['completed', 'finished', 'final', 'ended']));
/** Statuses treated as retirements (included only with allowRetirement). */
const RETIREMENT_STATUSES = Object.freeze(new Set(['retired', 'ret']));
/** Statuses always skipped (walkover, default, abandoned, cancelled, ...). */
const SKIPPED_STATUSES = Object.freeze(
  new Set([
    'walkover',
    'wo',
    'walk-over',
    'default',
    'abandoned',
    'cancelled',
    'canceled',
    'postponed',
    'suspended',
    'unknown',
    'pending',
    'scheduled',
    'live',
    'in-progress',
    'interrupted'
  ])
);

const SURFACE_ALIASES = Object.freeze({
  hard: Object.freeze([
    'hard',
    'hard court',
    'hard-court',
    'hardcourt',
    'h',
    'indoor',
    'indoor hard',
    'hard (indoor)',
    'outdoor hard'
  ]),
  clay: Object.freeze(['clay', 'clay court', 'clay-court', 'claycourt', 'c', 'red clay', 'green clay']),
  grass: Object.freeze(['grass', 'grass court', 'grass-court', 'grasscourt', 'g'])
});

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Strict ISO 8601 datetime: 'YYYY-MM-DDTHH:mm(:ss(.frac)?)?(zone)?' with
 * zone forms Z, +HH, +HHMM, +HH:MM. A missing zone means UTC — never the
 * host's local time, so parsing is identical under any TZ env var.
 */
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

function daysInMonth(year, month) {
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

/**
 * Zero-padded date-only 'YYYY-MM-DD' -> epoch ms at UTC midnight, or null.
 * Out-of-range months/days are rejected instead of rolling over.
 */
function parseDateOnly(s) {
  const m = DATE_ONLY_RE.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return Date.UTC(year, month - 1, day);
}

/**
 * Strict ISO 8601 datetime -> epoch ms, or null. A missing zone is treated
 * as UTC (append-Z semantics). Explicit Z/offsets are honored. Locale,
 * non-ISO, and non-zero-padded strings never reach Date.parse, so results
 * are deterministic across hosts and TZ settings.
 */
function parseIsoDatetime(s) {
  const m = ISO_DATETIME_RE.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  let ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (m[7] !== undefined) {
    ms += Number(m[7].slice(0, 3).padEnd(3, '0'));
  }
  if (m[8] !== undefined && m[8] !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].slice(1).replace(':', '');
    const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0);
    if (offsetMinutes > 23 * 60 + 59) return null;
    ms -= sign * offsetMinutes * 60000;
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a deterministic rating snapshot from a chronological match list.
 *
 * @param {Array<object>} matches - raw match records (see module docblock).
 * @param {object} [opts] - { k, surfaceWeight, minSurfaceMatches, allowRetirement }
 * @returns {object} JSON-safe snapshot with pools, matches, summary, config.
 */
function buildRatings(matches, opts) {
  if (!Array.isArray(matches)) {
    throw new TypeError('buildRatings: matches must be an array');
  }
  const config = resolveConfig(opts);
  const reasons = new Map();
  const records = [];

  matches.forEach((raw, index) => {
    const record = normalizeMatch(raw, config);
    if (!record.ok) {
      bumpReason(reasons, record.reason);
      return;
    }
    record.index = index;
    records.push(record);
  });

  records.sort(compareRecords);

  const pools = { atp: new Map(), wta: new Map() };
  for (const record of records) {
    applyMatch(pools[record.tour], record, config);
  }

  return serializeSnapshot(matches.length, records, reasons, pools, config);
}

/**
 * Predict a match between two players as of a point in time.
 *
 * The prediction replays only matches strictly before `asOf` (no future
 * leakage). `asOf` follows the same strict date rules as match dates
 * (zero-padded date-only -> UTC midnight; timezone-less ISO datetime ->
 * UTC); when omitted the full history is used.
 *
 * @param {object} snapshot - output of buildRatings().
 * @param {object} args - { tour, player1, player2, surface, asOf }.
 * @returns {object} availability + coverage reason, ratings/components,
 *   probabilities, match counts, and last match dates.
 */
function predictMatch(snapshot, args) {
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    !Array.isArray(snapshot.matches) ||
    typeof snapshot.modelVersion !== 'string'
  ) {
    throw new TypeError('predictMatch: invalid snapshot (expected output of buildRatings)');
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('predictMatch: args must be an object');
  }

  const config = snapshotConfig(snapshot);
  const tour = normalizeTour(args.tour);
  const player1 = normalizePlayerName(args.player1);
  const player2 = normalizePlayerName(args.player2);
  const surface = normalizeSurface(args.surface);
  const asOf = parseAsOf(args.asOf);

  const base = {
    available: false,
    reason: null,
    tour: tour.ok ? tour.tour : null,
    surface,
    asOf: asOf.iso,
    modelVersion: snapshot.modelVersion,
    blend: {
      used: false,
      surfaceWeight: config.surfaceWeight,
      minSurfaceMatches: config.minSurfaceMatches
    },
    players: null,
    probability: null,
    expectedScore: null,
    matchCounts: { player1: 0, player2: 0 },
    lastMatchDate: { player1: null, player2: null }
  };

  if (!tour.ok) return { ...base, reason: tour.reason };
  if (!player1 || !player2) return { ...base, reason: 'missing_players' };
  if (player1 === player2) return { ...base, reason: 'same_player' };
  if (!asOf.ok) return { ...base, reason: 'invalid_asof' };

  const cutoffMs = asOf.ms === null ? Infinity : asOf.ms;
  const before = snapshot.matches.filter((m) => m.tour === tour.tour && m.dateMs < cutoffMs);
  const pool = new Map();
  for (const record of before) {
    applyMatch(pool, record, config);
  }

  const p1 = pool.get(player1);
  const p2 = pool.get(player2);
  const seen1 = isPooled(snapshot, tour.tour, player1);
  const seen2 = isPooled(snapshot, tour.tour, player2);

  const matchCounts = {
    player1: p1 ? p1.totalMatches : 0,
    player2: p2 ? p2.totalMatches : 0
  };
  const lastMatchDate = {
    player1: p1 ? p1.lastMatchDate : null,
    player2: p2 ? p2.lastMatchDate : null
  };
  const unavailable = (reason) => ({
    ...base,
    reason,
    matchCounts,
    lastMatchDate
  });

  if (!seen1) return unavailable('player1_unseen');
  if (!seen2) return unavailable('player2_unseen');
  if (!p1) return unavailable('player1_no_history_before_asof');
  if (!p2) return unavailable('player2_no_history_before_asof');

  const blendUsed =
    surface !== null &&
    p1.surfaces[surface].matches >= config.minSurfaceMatches &&
    p2.surfaces[surface].matches >= config.minSurfaceMatches;

  const effective1 = blendUsed
    ? p1.overall + config.surfaceWeight * (p1.surfaces[surface].rating - p1.overall)
    : p1.overall;
  const effective2 = blendUsed
    ? p2.overall + config.surfaceWeight * (p2.surfaces[surface].rating - p2.overall)
    : p2.overall;

  const prob1 = expectedScore(effective1, effective2);
  const prob2 = 1 - prob1;

  return {
    ...base,
    available: true,
    tour: tour.tour,
    blend: {
      used: blendUsed,
      surfaceWeight: config.surfaceWeight,
      minSurfaceMatches: config.minSurfaceMatches
    },
    players: {
      player1: playerInfo(player1, p1, surface, effective1, blendUsed),
      player2: playerInfo(player2, p2, surface, effective2, blendUsed)
    },
    probability: { player1: prob1, player2: prob2 },
    expectedScore: { player1: prob1, player2: prob2 },
    matchCounts,
    lastMatchDate
  };
}

/**
 * Standard Elo expected score: 1 / (1 + 10^((ratingB - ratingA) / 400)).
 *
 * @param {number} ratingA
 * @param {number} ratingB
 * @returns {number} probability in [0, 1] that A beats B.
 */
function expectedScore(ratingA, ratingB) {
  if (!Number.isFinite(ratingA) || !Number.isFinite(ratingB)) {
    throw new TypeError('expectedScore: ratings must be finite numbers');
  }
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Normalize a surface label to 'hard' | 'clay' | 'grass' or null.
 *
 * @param {*} surface
 * @returns {string|null}
 */
function normalizeSurface(surface) {
  if (surface === undefined || surface === null) return null;
  if (typeof surface !== 'string') surface = String(surface);
  const key = surface.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  for (const canonical of SURFACES) {
    if (SURFACE_ALIASES[canonical].includes(key)) return canonical;
  }
  return null;
}

/**
 * Canonical player name: Unicode NFKC + trim + collapsed whitespace.
 * Exact-match only; no case folding or fuzzy resolution.
 *
 * @param {*} name
 * @returns {string} canonical name ('' for non-string input).
 */
function normalizePlayerName(name) {
  if (typeof name !== 'string') return '';
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveConfig(opts) {
  if (opts === undefined || opts === null) opts = {};
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('buildRatings: opts must be a plain object');
  }
  const k = finiteNumber(opts.k, DEFAULT_K, 'k');
  const surfaceWeight = finiteNumber(opts.surfaceWeight, DEFAULT_SURFACE_WEIGHT, 'surfaceWeight');
  const minSurfaceMatches = finiteNumber(opts.minSurfaceMatches, DEFAULT_MIN_SURFACE_MATCHES, 'minSurfaceMatches');
  if (!Number.isInteger(minSurfaceMatches)) {
    throw new TypeError('buildRatings: minSurfaceMatches must be an integer');
  }
  return {
    k: clamp(k, K_MIN, K_MAX),
    surfaceWeight: clamp(surfaceWeight, SURFACE_WEIGHT_MIN, SURFACE_WEIGHT_MAX),
    minSurfaceMatches: clamp(minSurfaceMatches, 0, MIN_SURFACE_MATCHES_MAX),
    allowRetirement: opts.allowRetirement === true
  };
}

function snapshotConfig(snapshot) {
  const c = snapshot.config;
  if (c !== null && typeof c === 'object') {
    return {
      k: finiteNumber(c.k, DEFAULT_K, 'k'),
      surfaceWeight: finiteNumber(c.surfaceWeight, DEFAULT_SURFACE_WEIGHT, 'surfaceWeight'),
      minSurfaceMatches: Number.isInteger(c.minSurfaceMatches) ? c.minSurfaceMatches : DEFAULT_MIN_SURFACE_MATCHES,
      allowRetirement: c.allowRetirement === true
    };
  }
  return resolveConfig({});
}

function finiteNumber(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`buildRatings: ${name} must be a finite number`);
  }
  return value;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function normalizeTour(tour) {
  if (tour === undefined || tour === null) return { ok: false, reason: 'missing_tour' };
  if (typeof tour !== 'string') return { ok: false, reason: 'unknown_tour' };
  const t = tour.trim().toLowerCase();
  if (!t) return { ok: false, reason: 'missing_tour' };
  if (!TOURS.includes(t)) return { ok: false, reason: 'unknown_tour' };
  return { ok: true, tour: t };
}

function normalizeStatus(status) {
  if (status === undefined || status === null) return { ok: false, reason: 'missing_status' };
  const s = String(status).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { ok: false, reason: 'missing_status' };
  if (COMPLETED_STATUSES.has(s)) return { ok: true, status: s };
  if (RETIREMENT_STATUSES.has(s)) return { ok: false, reason: 'retired' };
  if (SKIPPED_STATUSES.has(s)) return { ok: false, reason: s };
  return { ok: false, reason: 'unknown_status' };
}

function parseMatchDate(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: false, reason: 'missing_date' };
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return { ok: false, reason: 'invalid_date' };
    return { ok: true, ms, iso: new Date(ms).toISOString() };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, reason: 'invalid_date' };
    return { ok: true, ms: value, iso: new Date(value).toISOString() };
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return { ok: false, reason: 'missing_date' };
    const dateOnlyMs = parseDateOnly(s);
    if (dateOnlyMs !== null) return { ok: true, ms: dateOnlyMs, iso: s };
    const ms = parseIsoDatetime(s);
    if (ms === null) return { ok: false, reason: 'invalid_date' };
    return { ok: true, ms, iso: new Date(ms).toISOString() };
  }
  return { ok: false, reason: 'invalid_date' };
}

function parseAsOf(asOf) {
  if (asOf === undefined || asOf === null || asOf === '') {
    return { ok: true, ms: null, iso: null };
  }
  const parsed = parseMatchDate(asOf);
  return {
    ok: parsed.ok,
    ms: parsed.ok ? parsed.ms : null,
    iso: parsed.ok ? parsed.iso : null
  };
}

function normalizeMatch(raw, config) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed' };
  }
  const tour = normalizeTour(raw.tour);
  if (!tour.ok) return { ok: false, reason: tour.reason };
  const winner = normalizePlayerName(raw.winner);
  const loser = normalizePlayerName(raw.loser);
  if (!winner) return { ok: false, reason: 'missing_winner' };
  if (!loser) return { ok: false, reason: 'missing_loser' };
  if (winner === loser) return { ok: false, reason: 'same_player' };
  const date = parseMatchDate(raw.date);
  if (!date.ok) return { ok: false, reason: date.reason };
  const status = normalizeStatus(raw.status);
  if (!status.ok && !(status.reason === 'retired' && config.allowRetirement)) {
    return { ok: false, reason: status.reason };
  }
  return {
    ok: true,
    tour: tour.tour,
    winner,
    loser,
    surface: normalizeSurface(raw.surface),
    dateMs: date.ms,
    date: date.iso
  };
}

function compareRecords(a, b) {
  return a.dateMs - b.dateMs || a.index - b.index;
}

function bumpReason(map, reason) {
  map.set(reason, (map.get(reason) || 0) + 1);
}

function getPlayer(pool, name) {
  let player = pool.get(name);
  if (!player) {
    player = {
      name,
      overall: DEFAULT_RATING,
      surfaces: {
        hard: { rating: DEFAULT_RATING, matches: 0 },
        clay: { rating: DEFAULT_RATING, matches: 0 },
        grass: { rating: DEFAULT_RATING, matches: 0 }
      },
      totalMatches: 0,
      lastMatchDate: null
    };
    pool.set(name, player);
  }
  return player;
}

/**
 * Apply one completed match to a pool. Records are replayed in
 * chronological order by both buildRatings() and predictMatch(), so a
 * prediction strictly before `asOf` never sees later results.
 */
function applyMatch(pool, record, config) {
  const winner = getPlayer(pool, record.winner);
  const loser = getPlayer(pool, record.loser);
  const k = config.k;

  // Standard Elo: winner scores 1, loser scores 0, each against their own
  // expected score. The loser's expected score is (1 - eOverall), so the
  // pair's deltas cancel and the pool total rating is conserved.
  const eOverall = expectedScore(winner.overall, loser.overall);
  winner.overall += k * (1 - eOverall);
  loser.overall += k * (0 - (1 - eOverall));

  if (record.surface) {
    const wSurf = winner.surfaces[record.surface];
    const lSurf = loser.surfaces[record.surface];
    const eSurface = expectedScore(wSurf.rating, lSurf.rating);
    wSurf.rating += k * (1 - eSurface);
    lSurf.rating += k * (0 - (1 - eSurface));
    wSurf.matches += 1;
    lSurf.matches += 1;
  }

  winner.totalMatches += 1;
  loser.totalMatches += 1;
  winner.lastMatchDate = record.date;
  loser.lastMatchDate = record.date;
}

function isPooled(snapshot, tour, name) {
  const pool = snapshot.pools && snapshot.pools[tour];
  return Boolean(pool && Object.prototype.hasOwnProperty.call(pool, name));
}

function playerInfo(name, player, surface, effective, blended) {
  return {
    name,
    overall: player.overall,
    surface: surface !== null ? player.surfaces[surface].rating : null,
    surfaceMatches: surface !== null ? player.surfaces[surface].matches : null,
    effective,
    blended,
    matchCount: player.totalMatches,
    lastMatchDate: player.lastMatchDate
  };
}

function serializePool(pool) {
  const out = {};
  for (const [name, player] of pool) {
    out[name] = {
      name: player.name,
      overall: player.overall,
      surfaces: {
        hard: { rating: player.surfaces.hard.rating, matches: player.surfaces.hard.matches },
        clay: { rating: player.surfaces.clay.rating, matches: player.surfaces.clay.matches },
        grass: { rating: player.surfaces.grass.rating, matches: player.surfaces.grass.matches }
      },
      totalMatches: player.totalMatches,
      lastMatchDate: player.lastMatchDate
    };
  }
  return out;
}

function serializeSnapshot(totalInput, records, reasons, pools, config) {
  return {
    modelVersion: MODEL_VERSION,
    version: VERSION,
    config: { ...config },
    summary: {
      totalInput,
      processed: records.length,
      skipped: {
        total: totalInput - records.length,
        reasons: Object.fromEntries([...reasons.entries()].sort())
      }
    },
    matches: records.map((r) => ({
      tour: r.tour,
      winner: r.winner,
      loser: r.loser,
      surface: r.surface,
      date: r.date,
      dateMs: r.dateMs
    })),
    pools: {
      atp: serializePool(pools.atp),
      wta: serializePool(pools.wta)
    }
  };
}

module.exports = {
  VERSION,
  MODEL_VERSION,
  DEFAULT_RATING,
  DEFAULT_K,
  DEFAULT_SURFACE_WEIGHT,
  DEFAULT_MIN_SURFACE_MATCHES,
  SURFACES,
  TOURS,
  COMPLETED_STATUSES,
  RETIREMENT_STATUSES,
  SKIPPED_STATUSES,
  buildRatings,
  predictMatch,
  expectedScore,
  normalizeSurface,
  normalizePlayerName
};
