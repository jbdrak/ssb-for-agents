'use strict';

// Versioned, hash-carrying external-ratings snapshots.
//
// Snapshots live OUTSIDE the repo, under the local state dir
// (`SSB_RATINGS_DIR`, default `~/.ssb-for-agents/ratings/`), following the
// repo-wide state-dir override convention. `PP_RATINGS_DIR` is the pre-rename
// spelling (the older `PP_RECORD_LEDGER` / `PP_SIGNAL_CALIBRATION_FILE` survive
// the same way) and is still read as a DEPRECATED fallback, so an existing
// shell profile keeps writing to the directory it always used; `SSB_RATINGS_DIR`
// wins when both are set. Third-party rating data must never be committed to
// the repo (Massey's terms reserve all rights; the removed tennis-Elo overlay
// was deleted for exactly this reason), so this is the only place a normalized
// ratings payload is allowed to land.
//
// The store fails closed on read AND write:
//   - an unsupported source/league pair is rejected rather than stored;
//   - every record must carry the same `sourceHash` as the snapshot, so a
//     snapshot can never mix payloads or survive a swapped hash;
//   - a snapshot whose `asOf` predates a supplied cutoff loads as `stale: true`
//     instead of being silently accepted as current.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SOURCES, supportedLeagues } = require('./ssb-ratings-contract');
const { isBefore } = require('./ssb-ratings-recency');
const { resolveEnvVar } = require('./ssb-env-var');

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
  const { value } = resolveEnvVar('SSB_RATINGS_DIR', 'PP_RATINGS_DIR');
  return value || path.join(os.homedir(), '.ssb-for-agents', 'ratings');
}

function isInsideRepo(target) {
  const resolved = path.resolve(target);
  return resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep);
}

function snapshotPath(source, league, season) {
  return path.join(ratingsDir(), `${source}-${league}-${season}.json`);
}

// Retained snapshots live in a `history/` subdir, NOT beside the latest file.
// `listSnapshots` enumerates the top level, so keeping them separate is what
// guarantees the retention added here cannot change any existing read path.
const HISTORY_DIR_NAME = 'history';
const HISTORY_FILE_PATTERN = /^([a-z]+)-([A-Za-z0-9]+)-(\d{4})-(\d{4}-\d{2}-\d{2})\.json$/;

function historyDir() {
  return path.join(ratingsDir(), HISTORY_DIR_NAME);
}

/**
 * The date component of a snapshot's `asOf`, or null when it has no usable one.
 *
 * A filename cannot carry a colon or a space, and an `asOf` that is not a plain
 * date is REFUSED rather than mangled into one: a snapshot filed under a date it
 * did not have would later be scored against the wrong week's games, which is the
 * exact error retention exists to prevent.
 *
 * @param {unknown} asOf
 * @returns {string|null}
 */
function historyStamp(asOf) {
  if (typeof asOf !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(asOf.trim());
  return match ? match[1] : null;
}

function snapshotHistoryPath(source, league, season, stamp) {
  return path.join(historyDir(), `${source}-${league}-${season}-${stamp}.json`);
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
 * Write one payload to `target` atomically: a temp file in the SAME directory,
 * then a rename onto the target. A reader therefore never observes a partial
 * file at the final path — a kill or a full disk mid-write can only leave a
 * temp file, which the failure path unlinks. (A hard kill between create and
 * rename can strand the temp, but the target itself is never truncated, which
 * is the invariant `loadSnapshot`/`listSnapshots` depend on.) Same temp+rename
 * shape as `writeJsonAtomic` in lib/tennis-elo-data.js and the ledger store, so
 * all three land snapshots the same way.
 *
 * @param {string} target
 * @param {string} payload
 */
function writeSnapshotAtomic(target, payload) {
  const directory = path.dirname(target);
  const tmpPath = path.join(
    directory,
    `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o644);
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, target);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* temp never created or already moved */
    }
    throw error;
  }
}

/**
 * Persist one snapshot to `<SSB_RATINGS_DIR>/<source>-<league>-<season>.json`.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, path?: string, historyPath?: string, snapshot?: Record<string, any>, errors?: string[] }}
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
  const payload = JSON.stringify(snapshot, null, 2) + '\n';
  const stamp = historyStamp(snapshot.asOf);
  const historyTarget = stamp ? snapshotHistoryPath(snapshot.source, snapshot.league, snapshot.season, stamp) : null;

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Retain the dated copy FIRST. The latest file is overwritten by every
    // refresh, so without a retained copy the predictions that a later settled
    // result would be scored against are gone before the games are played.
    // Writing it first means a failure here reports the snapshot as NOT saved,
    // rather than updating the latest file while quietly dropping the copy that
    // is what makes it scoreable later. Re-refreshing the same source week
    // overwrites its own history entry, which is correct: same source, same asOf.
    if (historyTarget) {
      fs.mkdirSync(path.dirname(historyTarget), { recursive: true });
      writeSnapshotAtomic(historyTarget, payload);
    }
    writeSnapshotAtomic(target, payload);
  } catch (error) {
    return { ok: false, errors: [`unable to write snapshot: ${error && error.code ? error.code : 'unknown error'}`] };
  }
  return { ok: true, path: target, historyPath: historyTarget || undefined, snapshot };
}

/**
 * Read, parse and normalize one snapshot file. Shared by the latest-file loader
 * and the retained-snapshot loader, so both fail closed identically on a missing,
 * unreadable, or inconsistent file.
 *
 * @param {string} target
 * @returns {{ ok: boolean, path: string, snapshot?: Record<string, any>, errors?: string[] }}
 */
function readSnapshotFile(target) {
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

  return {
    ok: true,
    path: target,
    snapshot: /** @type {Record<string, any>} */ (normalized.snapshot)
  };
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
  const read = readSnapshotFile(target);
  if (!read.ok || !read.snapshot) {
    return { ok: false, path: target, errors: read.errors || ['unable to read snapshot'] };
  }

  const snapshot = read.snapshot;
  // The layer's one recency primitive (lib/ssb-ratings-recency.js). The store and
  // the per-row attach gate in `ssb-ratings-overlay.js` therefore cannot
  // disagree about what "current" means: both ask `isBefore(asOf, cutoff)` and
  // differ only in which cutoff they supply.
  const stale = isDateString(options.asOfCutoff) ? isBefore(snapshot.asOf, options.asOfCutoff) : false;

  return { ok: true, path: target, snapshot, stale };
}

/**
 * Load one RETAINED snapshot - the dated copy `saveSnapshot` writes into
 * `history/` - by the `asOf` it was captured at.
 *
 * This is what makes a past week's predictions scoreable. The latest file has
 * already been overwritten by a later refresh, so the retained copies are the
 * only ones that still exist.
 *
 * @param {string} source
 * @param {string} league
 * @param {number} season
 * @param {unknown} at - the snapshot's `asOf`: a plain YYYY-MM-DD, or a timestamp whose date part is used
 * @returns {{ ok: boolean, path: string, snapshot?: Record<string, any>, errors?: string[] }}
 */
function loadSnapshotAt(source, league, season, at) {
  const stamp = historyStamp(at);
  if (!stamp) return { ok: false, path: '', errors: [`invalid asOf date: ${String(at)}`] };
  return readSnapshotFile(snapshotHistoryPath(source, league, season, stamp));
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

/**
 * Summarize every RETAINED snapshot, newest `asOf` first: the same summary shape
 * `listSnapshots` returns, plus the `stamp` the file is filed under.
 *
 * Deliberately separate from `listSnapshots`: that function answers "what is
 * current", and a retained snapshot is by definition not current. Keeping them
 * apart is also what stops retention from changing any existing read path.
 *
 * @returns {{ ok: boolean, snapshots: Array<Record<string, any>>, errors?: string[] }}
 */
function listSnapshotHistory() {
  const dir = historyDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, snapshots: [] };
    return { ok: false, snapshots: [], errors: ['unable to read ratings history dir'] };
  }

  const snapshots = /** @type {Array<Record<string, any>>} */ ([]);
  for (const entry of entries) {
    const match = HISTORY_FILE_PATTERN.exec(entry);
    if (!match) continue;
    const target = path.join(dir, entry);
    const summary = {
      path: target,
      source: match[1],
      league: match[2],
      season: Number(match[3]),
      stamp: match[4]
    };
    const read = readSnapshotFile(target);
    if (!read.ok || !read.snapshot) {
      snapshots.push({ ...summary, valid: false, errors: read.errors || ['unable to read snapshot'] });
      continue;
    }
    const snapshot = read.snapshot;
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

  snapshots.sort(
    (a, b) => String(b.asOf || b.stamp).localeCompare(String(a.asOf || a.stamp)) || a.path.localeCompare(b.path)
  );
  return { ok: true, snapshots };
}

module.exports = {
  saveSnapshot,
  loadSnapshot,
  loadSnapshotAt,
  listSnapshots,
  listSnapshotHistory,
  historyStamp
};
