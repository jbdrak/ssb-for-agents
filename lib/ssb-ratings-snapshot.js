'use strict';

// Versioned, hash-carrying external-ratings snapshots.
//
// Snapshots live OUTSIDE the repo, under the local state dir
// (`PP_RATINGS_DIR`, default `~/.ssb-for-agents/ratings/`), matching the
// existing `PP_RECORD_LEDGER` / `PP_SIGNAL_CALIBRATION_FILE` override
// convention. Third-party rating data must never be committed to the repo
// (Massey's terms reserve all rights; the removed tennis-Elo overlay was
// deleted for exactly this reason), so this is the only place a normalized
// ratings payload is allowed to land.
//
// The store fails closed on read AND write:
//   - an unsupported source/league pair is rejected rather than stored;
//   - every record must carry the same `sourceHash` as the snapshot, so a
//     snapshot can never mix payloads or survive a swapped hash;
//   - a snapshot whose `asOf` predates a supplied cutoff loads as `stale: true`
//     instead of being silently accepted as current.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SOURCES, supportedLeagues } = require('./ssb-ratings-contract');

const SCHEMA_VERSION = 1;

// Repo root for the "never write into the repo" guard.
const REPO_ROOT = path.resolve(__dirname, '..');

const SNAPSHOT_FILE_PATTERN = /^([a-z]+)-([A-Za-z0-9]+)-(\d{4})\.json$/;

/**
 * @typedef {Object} SnapshotRecord
 * @property {string} sourceHash
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function ratingsDir() {
  return process.env.PP_RATINGS_DIR || path.join(os.homedir(), '.ssb-for-agents', 'ratings');
}

function isInsideRepo(target) {
  const resolved = path.resolve(target);
  return resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep);
}

function snapshotPath(source, league, season) {
  return path.join(ratingsDir(), `${source}-${league}-${season}.json`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isDateString(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isSeason(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 1900;
}

/**
 * Normalize and validate a snapshot before it is stored.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, snapshot: Record<string, any> | null, errors: string[] }}
 */
function normalizeSnapshot(input) {
  if (!isPlainObject(input)) {
    return { ok: false, snapshot: null, errors: ['snapshot must be a plain object'] };
  }
  const raw = /** @type {Record<string, any>} */ (input);
  const errors = [];

  const source = SOURCES.includes(raw.source) ? raw.source : null;
  if (source === null) errors.push(`invalid source: ${String(raw.source)}`);

  const league = typeof raw.league === 'string' && raw.league.trim() !== '' ? raw.league : null;
  if (league === null) {
    errors.push('missing or invalid league');
  } else if (source !== null && !supportedLeagues(source).includes(league)) {
    errors.push(`league ${league} is not published by ${source}`);
  }

  if (!isSeason(raw.season)) {
    errors.push(`missing or invalid season: ${String(raw.season)}`);
  }

  for (const field of ['method', 'sourceUrl']) {
    if (!isNonEmptyString(raw[field])) errors.push(`missing or invalid ${field}`);
  }

  for (const field of ['asOf', 'fetchedAt']) {
    if (!isDateString(raw[field])) errors.push(`missing or invalid ${field}`);
  }

  if (!isNonEmptyString(raw.sourceHash)) errors.push('missing or invalid sourceHash');

  if (!Array.isArray(raw.records)) {
    errors.push('records must be an array');
  } else if (isNonEmptyString(raw.sourceHash)) {
    // Fail closed: one payload per snapshot. A record carrying a different (or
    // absent) hash means the file mixes payloads or the hash was swapped.
    raw.records.forEach((record, index) => {
      if (!isPlainObject(record)) {
        errors.push(`records[${index}] must be a plain object`);
        return;
      }
      if (record.sourceHash !== raw.sourceHash) {
        errors.push(`records[${index}].sourceHash disagrees with the snapshot sourceHash`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, snapshot: null, errors };

  return {
    ok: true,
    snapshot: {
      schemaVersion: SCHEMA_VERSION,
      source,
      league,
      season: raw.season,
      method: raw.method,
      asOf: raw.asOf,
      fetchedAt: raw.fetchedAt,
      sourceUrl: raw.sourceUrl,
      sourceHash: raw.sourceHash,
      records: raw.records.map((record) => ({ ...record }))
    },
    errors: []
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persist one snapshot to `<PP_RATINGS_DIR>/<source>-<league>-<season>.json`.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, path?: string, snapshot?: Record<string, any>, errors?: string[] }}
 */
function saveSnapshot(input) {
  const normalized = normalizeSnapshot(input);
  if (!normalized.ok) return { ok: false, errors: normalized.errors };

  const snapshot = /** @type {Record<string, any>} */ (normalized.snapshot);
  const dir = ratingsDir();
  if (isInsideRepo(dir)) {
    return { ok: false, errors: [`refusing to write ratings snapshots into the repo: ${dir}`] };
  }

  const target = snapshotPath(snapshot.source, snapshot.league, snapshot.season);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  } catch (error) {
    return { ok: false, errors: [`unable to write snapshot: ${error && error.code ? error.code : 'unknown error'}`] };
  }
  return { ok: true, path: target, snapshot };
}

/**
 * Load one snapshot, failing closed on a missing, unreadable, or inconsistent file.
 *
 * @param {string} source
 * @param {string} league
 * @param {number} season
 * @param {{ asOfCutoff?: string }} [options]
 * @returns {{ ok: boolean, path: string, snapshot?: Record<string, any>, stale?: boolean, errors?: string[] }}
 */
function loadSnapshot(source, league, season, options = {}) {
  const target = snapshotPath(source, league, season);

  let content;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'snapshot not found' : 'unable to read snapshot';
    return { ok: false, path: target, errors: [`${reason}: ${target}`] };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, path: target, errors: ['invalid snapshot JSON'] };
  }

  const normalized = normalizeSnapshot(parsed);
  if (!normalized.ok) return { ok: false, path: target, errors: normalized.errors };

  const snapshot = /** @type {Record<string, any>} */ (normalized.snapshot);
  let stale = false;
  if (isDateString(options.asOfCutoff)) {
    stale = Date.parse(snapshot.asOf) < Date.parse(options.asOfCutoff);
  }

  return { ok: true, path: target, snapshot, stale };
}

/**
 * Summarize every snapshot in the state dir. Unrelated files are ignored;
 * a malformed snapshot is reported with `valid: false` rather than throwing.
 *
 * @returns {{ ok: boolean, snapshots: Array<Record<string, any>>, errors?: string[] }}
 */
function listSnapshots() {
  const dir = ratingsDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, snapshots: [] };
    return { ok: false, snapshots: [], errors: ['unable to read ratings dir'] };
  }

  const snapshots = [];
  for (const entry of entries) {
    const match = SNAPSHOT_FILE_PATTERN.exec(entry);
    if (!match) continue;
    const target = path.join(dir, entry);
    const summary = { path: target, source: match[1], league: match[2], season: Number(match[3]) };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      snapshots.push({ ...summary, valid: false, errors: ['invalid snapshot JSON'] });
      continue;
    }
    const normalized = normalizeSnapshot(parsed);
    if (!normalized.ok) {
      snapshots.push({ ...summary, valid: false, errors: normalized.errors });
      continue;
    }
    const snapshot = /** @type {Record<string, any>} */ (normalized.snapshot);
    snapshots.push({
      ...summary,
      valid: true,
      method: snapshot.method,
      asOf: snapshot.asOf,
      fetchedAt: snapshot.fetchedAt,
      sourceUrl: snapshot.sourceUrl,
      sourceHash: snapshot.sourceHash,
      recordCount: snapshot.records.length
    });
  }

  snapshots.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, snapshots };
}

module.exports = { saveSnapshot, loadSnapshot, listSnapshots };
