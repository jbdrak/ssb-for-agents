'use strict';

// Attach the locally-built tennis Elo to tennis candidate rows.
//
// The aggregate external-ratings overlay (lib/ssb-ratings-overlay.js) reads the
// snapshot STORE under `SSB_RATINGS_DIR`. Tennis Elo has no snapshot in that store
// by design: its adapter (lib/ratings-sources/tennis-elo.js) is a per-matchup
// `lookupMatch` over a locally-built snapshot, not a table source, so that path can
// never attach a tennis record - it only ever writes `tennis_elo: null`. This
// module is the missing half: it resolves each tennis row's tour and surface and
// calls the adapter directly.
//
// Same additive contract as the aggregate overlay: it only fills
// `row.ratings.tennis_elo` and never reads or writes kaiCall, tier, verdict, edge
// or any score. Fail-closed throughout - a row whose tour or surface cannot be
// established, or whose players do not resolve, keeps whatever the aggregate
// overlay left there (normally `null`).

const { lookupMatch } = require('./ratings-sources/tennis-elo');
const { loadSnapshot } = require('./tennis-elo-data');
const { lookupMatchTime } = require('./flashscore-times');
const { guessSurfaceFromFlashscoreMatch } = require('./ssb-tennis-context');
const { ATTACH_MAX_AGE_DAYS } = require('./ssb-ratings-recency');

const fs = require('node:fs');
const path = require('node:path');

/** Default location of the tournament -> surface map (state dir, never the repo). */
function defaultSurfaceMapPath() {
  const dir = process.env.SSB_RATINGS_DIR || path.join(process.env.HOME || '', '.ssb-for-agents');
  return path.join(dir, 'tennis-surface-map.json');
}

// Reduce a tournament name to a comparable place key, so a season file's
// "Ljubljana Chall. Women" and the Flashscore cache's "Ljubljana (Slovenia)" land
// on the same key. Tournament-scoped metadata only - never a player identity.
const LEVEL_WORDS = new Set([
  'wta',
  'atp',
  'itf',
  'chall',
  'challenger',
  'women',
  'womens',
  'men',
  'mens',
  'qualification',
  'qualifying',
  'q',
  'doubles',
  'singles',
  'w15',
  'w25',
  'w35',
  'w50',
  'w75',
  'w100',
  'm15',
  'm25'
]);

function surfaceKey(name) {
  let s = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  s = s.split('(')[0];
  s = s.split(' - ')[0];
  return s
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !LEVEL_WORDS.has(w))
    .join(' ');
}

/** Read the tournament -> surface map. A missing or broken file is an empty map. */
function loadSurfaceMap(mapPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(mapPath || defaultSurfaceMapPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Flashscore category -> Elo tour. Only singles exists for this model. */
function tourOfCategory(category) {
  const c = String(category || '').toUpperCase();
  if (!c || !/SINGLES/.test(c)) return null;
  if (/WOMEN|WTA/.test(c)) return 'WTA';
  if (/\bMEN\b|ATP/.test(c)) return 'ATP';
  return null;
}

/** Pull the two participants off a scan row, whatever shape the row carries. */
function participantsOf(row) {
  const a = row.participant1 || row.homeTeam;
  const b = row.participant2 || row.awayTeam;
  if (a && b) return [String(a), String(b)];
  const game = String(row.game || '');
  const parts = game.split(/\s+vs\.?\s+/i);
  if (parts.length === 2 && parts[0] && parts[1]) return [parts[0].trim(), parts[1].trim()];
  return null;
}

/** The row's own event date, ISO. The snapshot must predate it. */
function eventDateOf(row) {
  const iso = row.start || row.startTime;
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  return null;
}

function shiftDays(isoDate, days) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Fill `row.ratings.tennis_elo` on tennis rows in place.
 *
 * @param {unknown} rows - flat candidate rows, or scan result buckets of them
 * @param {{ snapshot?: object, maxAgeDays?: number, lookupMatchImpl?: Function,
 *   lookupMatchTimeImpl?: Function, surfaceOfImpl?: Function,
 *   surfaceMap?: Record<string, string>, surfaceMapPath?: string }} [options]
 *   Injected seams default to the real adapter, the Flashscore schedule cache and
 *   the surface guess, so no test path has to reach the filesystem or the network.
 *   `surfaceMap` (or `surfaceMapPath`) supplies the tournament -> surface fallback
 *   for events whose schedule-cache surface is empty.
 * @returns {{ attempted: number, attached: number, skipped: Record<string, number> }}
 */
function attachTennisElo(rows, options = {}) {
  const legs = Array.isArray(rows) ? rows : [];
  const flat = [];
  for (const item of legs) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.plays)) flat.push(...item.plays);
    else if (Array.isArray(item.candidates)) flat.push(...item.candidates);
    else flat.push(item);
  }

  let snapshot = options.snapshot;
  if (!snapshot) {
    const loaded = loadSnapshot();
    snapshot = loaded && loaded.snapshot;
  }
  const stats = { attempted: 0, attached: 0, skipped: {} };
  const bump = (k) => {
    stats.skipped[k] = (stats.skipped[k] || 0) + 1;
  };
  const maxAgeDays =
    Number.isFinite(options.maxAgeDays) && options.maxAgeDays >= 0 ? options.maxAgeDays : ATTACH_MAX_AGE_DAYS;
  const lookup = options.lookupMatchImpl || lookupMatch;
  const findMatch = options.lookupMatchTimeImpl || lookupMatchTime;
  const surfaceOf = options.surfaceOfImpl || guessSurfaceFromFlashscoreMatch;
  const surfaceMap = options.surfaceMap || loadSurfaceMap(options.surfaceMapPath);

  for (const row of flat) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (String(row.league || '').toLowerCase() !== 'tennis') continue;
    stats.attempted++;
    // Moneyline is the only market this model can price; the adapter would refuse
    // anything else without reading the snapshot, so do not spend the call.
    if (!/moneyline/i.test(String(row.market || ''))) {
      bump('unsupported_market');
      continue;
    }
    const pair = participantsOf(row);
    if (!pair) {
      bump('no_participants');
      continue;
    }
    const date = eventDateOf(row);
    if (!date) {
      bump('no_event_date');
      continue;
    }
    const match = findMatch(pair[0], pair[1]);
    const tour = match ? tourOfCategory(match.category) : null;
    if (!tour) {
      bump('unknown_tour');
      continue;
    }
    // The Flashscore schedule cache ships an empty surface for most events, so the
    // tournament -> surface map is usually the working source; the cache wins when
    // it actually carries a surface. The map is consulted month-first, because one
    // place can host two events on different surfaces in a season.
    const tKey = surfaceKey(match && match.tournament);
    const surface =
      (match && surfaceOf(match)) || surfaceMap[`${tKey}|${date.slice(0, 7)}`] || surfaceMap[tKey] || null;
    if (!surface) {
      bump('unknown_surface');
      continue;
    }
    const out = lookup({
      snapshot,
      tour,
      playerA: pair[0],
      playerB: pair[1],
      surface,
      market: 'Moneyline',
      asOf: date,
      snapshotNotBefore: shiftDays(date, -maxAgeDays)
    });
    const records = (out && Array.isArray(out.records) && out.records) || [];
    if (records.length === 0) {
      bump((out && out.reasonKind) || 'unavailable');
      continue;
    }
    row.ratings = Object.assign({}, row.ratings || {});
    row.ratings.tennis_elo = {
      game: row.game || null,
      asOf: (out && out.asOf) || null,
      records: records.map((r) => ({ ...r }))
    };
    stats.attached++;
  }

  return stats;
}

module.exports = { attachTennisElo, tourOfCategory, participantsOf, eventDateOf, surfaceKey, loadSurfaceMap };
