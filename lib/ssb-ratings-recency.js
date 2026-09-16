'use strict';

// The single recency rule for the external-ratings layer.
//
// A snapshot's `asOf` is the date its ratings actually describe. The layer must
// never present a record as live context for an event that record cannot
// describe, so every consumer asks the same question through the same
// primitive:
//
//     isBefore(record.asOf, cutoff)
//
// where `cutoff` is the oldest `asOf` still usable for the thing being attached.
// That comparison is not new: `lib/ssb-ratings-snapshot.js` already used exactly
// it for its caller-supplied `asOfCutoff` -> `stale`. It is defined here once and
// imported by both, so there is one recency rule, not two that drift apart.
//
// Callers differ only in how they choose the cutoff, never in the rule:
//
//   - the snapshot store: an absolute date the caller supplies (unchanged);
//   - the overlay, per candidate row: the event's own start minus
//     ATTACH_MAX_AGE_DAYS — this is the gate the scan path was missing, and it
//     is enforced at the JOIN, per row, because only there is there an event to
//     compare against (`loadRatingsRecords()` aggregates every snapshot with no
//     per-event context, so arming a cutoff there is the wrong lever);
//   - the evaluation pipeline, per row: the settled game's timestamp minus
//     ATTACH_MAX_AGE_DAYS, so a stale snapshot is not scored as evidence;
//   - tennis Elo: the prediction date strictly, plus an optional caller floor —
//     the strictest of the four, deliberately, and left exactly as it was.
//
// Two documented windows, one age concept:
//
//   - ATTACH_MAX_AGE_DAYS (14) answers "does this record describe this event?".
//     Team-sport sources re-publish after every game day while their season is
//     running, so a wider gap means the season has ended (an off-season
//     snapshot: `sagarin NBA asOf 2026-06-13` attached to a 2026-10-25 game is
//     134 days) or the refresh stopped silently.
//   - REFRESH_STALE_AFTER_DAYS (30) answers "has this source gone quiet?" for
//     the refresh health summary, where age is measured against the fetch time
//     instead of an event. Deliberately looser: it is a display default, not a
//     data rule.
//
// Everything here is pure: no clock, no I/O, no network. A caller that needs
// "now" passes it in.

const { parseGameStartMs } = require('./ssb-shared-utils');

const DAY_MS = 24 * 60 * 60 * 1000;

/** How old a record's `asOf` may be relative to the EVENT it attaches to. */
const ATTACH_MAX_AGE_DAYS = 14;

/** How old a page's own `asOf` may be relative to NOW before the refresh summary flags it. */
const REFRESH_STALE_AFTER_DAYS = 30;

/**
 * Epoch ms for a Date, number (epoch ms), or parseable date string, else null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * UTC midnight of the calendar day a value falls on, else null. The rule is
 * expressed on calendar days so a cutoff is a date, which is the granularity a
 * source's "through games of" heading actually has.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function dayStartMs(value) {
  const ms = toMs(value);
  if (ms === null) return null;
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** `YYYY-MM-DD` for a value, else null. */
function dateOnly(value) {
  const day = dayStartMs(value);
  return day === null ? null : new Date(day).toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `from` to `to`, or null when either is unparseable.
 * Negative when `from` is later than `to`.
 *
 * @param {unknown} from
 * @param {unknown} to
 * @returns {number|null}
 */
function daysBetween(from, to) {
  const a = dayStartMs(from);
  const b = dayStartMs(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/**
 * The layer's one date-order primitive. Unparseable input is never "before",
 * so an absent date can only fail closed.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function isBefore(a, b) {
  const aMs = toMs(a);
  const bMs = toMs(b);
  return aMs !== null && bMs !== null && aMs < bMs;
}

/**
 * The oldest `asOf` still usable for an event: that event's own calendar day
 * minus the window. Returned as an ISO instant at the cutoff day's UTC midnight,
 * so `isBefore(asOf, cutoff)` and "the calendar-day gap exceeds the window" are
 * the same statement.
 *
 * @param {unknown} eventStart - event start (ISO, epoch ms, or Date)
 * @param {number} [maxAgeDays]
 * @returns {string|null} cutoff ISO string, or null when the event is unparseable
 */
function staleCutoff(eventStart, maxAgeDays = ATTACH_MAX_AGE_DAYS) {
  const day = dayStartMs(eventStart);
  if (day === null) return null;
  const window = Number.isFinite(maxAgeDays) && maxAgeDays >= 0 ? maxAgeDays : ATTACH_MAX_AGE_DAYS;
  return new Date(day - window * DAY_MS).toISOString();
}

// The row field names the pipeline carries an event start under. Raw /screen
// rows send epoch seconds for MLB/WNBA/NBA/NFL/NHL and ISO strings for
// Soccer/Tennis, and the ranked row spreads the raw row, so the canonical parser
// (lib/ssb-shared-utils.js) does the format detection rather than a second copy
// of it living here.
const EVENT_START_FIELDS = Object.freeze([
  'start',
  'startTime',
  'startsAt',
  'eventStart',
  'eventStartTime',
  'startMs',
  'start_ms',
  'startRaw',
  'startCST'
]);

/**
 * Event start (epoch ms) for a candidate row, or null when the row carries none.
 *
 * @param {unknown} row
 * @returns {number|null}
 */
function eventStartMs(row) {
  if (!row || typeof row !== 'object') return null;
  for (const field of EVENT_START_FIELDS) {
    const ms = parseGameStartMs(/** @type {Record<string, any>} */ (row)[field]);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function windowOf(maxAgeDays) {
  return Number.isFinite(maxAgeDays) && maxAgeDays >= 0 ? maxAgeDays : ATTACH_MAX_AGE_DAYS;
}

/**
 * Is one record usable as current context for one event?
 *
 * Returns `{ current: true }` or a refusal that names which way it failed and
 * the ages involved, so the caller never has to do the arithmetic itself.
 *
 * @param {{ source?: string, asOf?: unknown, eventStart?: unknown, maxAgeDays?: number }} options
 * @returns {{ current: boolean, reasonKind?: string, reason?: string, ageDays?: number|null }}
 */
function assessRecency(options = {}) {
  const source = typeof options.source === 'string' && options.source.trim() !== '' ? options.source.trim() : 'rating';
  const maxAgeDays = windowOf(options.maxAgeDays);
  const eventMs = dayStartMs(options.eventStart);

  if (eventMs === null) {
    return {
      current: false,
      reasonKind: 'event_start_unknown',
      reason: `${source} records withheld: the row carries no event start time, so their recency cannot be verified`,
      ageDays: null
    };
  }
  if (toMs(options.asOf) === null) {
    return {
      current: false,
      reasonKind: 'snapshot_undated',
      reason: `${source} records withheld: the snapshot record carries no asOf date, so its age against the ${dateOnly(eventMs)} event cannot be verified`,
      ageDays: null
    };
  }

  const cutoff = /** @type {string} */ (staleCutoff(eventMs, maxAgeDays));
  if (!isBefore(options.asOf, cutoff)) return { current: true, ageDays: daysBetween(options.asOf, eventMs) };

  return {
    current: false,
    reasonKind: 'snapshot_stale',
    reason:
      `${source} snapshot asOf ${dateOnly(options.asOf)} is ${daysBetween(options.asOf, eventMs)} days before the event start ` +
      `${dateOnly(eventMs)}, beyond the ${maxAgeDays}-day recency window`,
    ageDays: daysBetween(options.asOf, eventMs)
  };
}

/**
 * Whole days between a source's own `asOf` and a reference time (its fetch
 * time), or null. Used by the refresh health summary, where the question is
 * "has this source gone quiet?" rather than "does this record describe this
 * event?".
 *
 * @param {unknown} from - the source's `asOf`
 * @param {unknown} to - the reference time
 * @returns {number|null}
 */
function ageInDays(from, to) {
  const fromMs = toMs(from);
  const toMsValue = toMs(to);
  if (fromMs === null || toMsValue === null) return null;
  return Math.floor((toMsValue - fromMs) / DAY_MS);
}

module.exports = {
  DAY_MS,
  ATTACH_MAX_AGE_DAYS,
  REFRESH_STALE_AFTER_DAYS,
  toMs,
  dayStartMs,
  dateOnly,
  daysBetween,
  isBefore,
  staleCutoff,
  eventStartMs,
  assessRecency,
  ageInDays
};
