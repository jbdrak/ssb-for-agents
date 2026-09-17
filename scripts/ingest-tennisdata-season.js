#!/usr/bin/env node
'use strict';

/**
 * ingest-tennisdata-season.js — turn a TennisData (tennisdata.app) season CSV into
 * importer-schema rows the tennis-elo build can consume.
 *
 * Why this source: it is the only free feed found that is CURRENT (its 2026 season
 * file runs to today), covers BOTH tours at Tour + Challenger level, and carries
 * surface and a per-match completion status. The Sackmann archives are 404
 * upstream and the surviving mirror stops in June, so this file is what keeps the
 * Elo snapshot's `asOf` honest.
 *
 * Two things make the join trustworthy rather than guessy:
 *
 *  1. IDENTITY. The CSV names players short ("Masarova R.", "De Stefano S."), so a
 *     name is resolved to the archive's own spelling only when it is UNIQUE on
 *     (surname, first initial) within that tour. Anything ambiguous or unknown is
 *     skipped and counted, never emitted under a new spelling. A player's stable
 *     TennisData id is cached the first time it resolves, so later rows for that
 *     player reuse the decision instead of re-deriving it.
 *  2. OVERLAP. The archive already contains part of the same season, and the two
 *     sources date matches differently (the archive stamps a whole tournament with
 *     its start date; this file stamps each match with its own day). A row is
 *     therefore dropped when the same winner/loser pair already appears in the
 *     archive within a +/- window, not merely when it shares a date.
 *
 * Usage:
 *   node scripts/ingest-tennisdata-season.js \
 *     --input ~/data/tennis-elo/td-wta-2026.csv --input ~/data/tennis-elo/td-atp-2026.csv \
 *     --archive ~/data/tennis-elo/combined_all.csv \
 *     --out ~/data/tennis-elo/recent_results.csv
 */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeName, parseMatchCsv } = require('../lib/tennis-elo-data');
const { buildNameMap, buildSurnameIndex, resolveName } = require('../lib/tennis-name-resolve');

const OVERLAP_DAYS = 10;

function parseArgs(argv) {
  const out = { input: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      if (key === 'input') out.input.push(next);
      else out[key] = next;
      i++;
    }
  }
  return out;
}

const expand = (p) => String(p).replace(/^~/, process.env.HOME);

// --- tiny RFC4180-ish CSV parser (quoted fields, "" escapes, CRLF/LF) --------
function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && src[i + 1] === '\n') i++;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "01 Apr 2026" / "2026-04-01" -> "2026-04-01" */
function toIsoDate(raw) {
  const s = String(raw || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function daysBetween(a, b) {
  return Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}

// --- archive index ----------------------------------------------------------
// Archive side of the resolution: normalized full names keyed to the archive's own
// spelling (via the shared resolver), plus winner|loser -> dates for time pairing.
function buildArchive(archivePath) {
  const rows = parseMatchCsv(fs.readFileSync(archivePath, 'utf8'));
  const byTour = buildNameMap(rows);
  const pairs = { ATP: new Map(), WTA: new Map() };
  for (const row of rows) {
    const tour = String(row.tour || '').toUpperCase();
    if (!byTour[tour]) continue;
    const date = String(row.date || '').trim();
    const wk = normalizeName(row.winner);
    const lk = normalizeName(row.loser);
    if (wk && lk && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const key = `${wk}|${lk}`;
      if (!pairs[tour].has(key)) pairs[tour].set(key, []);
      pairs[tour].get(key).push(date);
    }
  }
  return { byTour, pairs };
}

// Identity resolution lives in lib/tennis-name-resolve.js so this source and the
// Flashscore capture cannot drift into two different resolvers.

const TOUR_OF = (human, code) => {
  const h = String(human || '').toUpperCase();
  const c = String(code || '').toUpperCase();
  if (h.includes('WTA') || c.startsWith('W')) return 'WTA';
  if (h.includes('ATP') || c.startsWith('M')) return 'ATP';
  return null;
};

// Reduce a tournament name to a comparable place key via the shared helper in
// lib/ssb-tennis-elo-overlay.js, so this file's "Ljubljana Chall. Women" and the
// Flashscore cache's "Ljubljana (Slovenia)" land on the same key. Used only for
// the surface map, which is tournament-scoped metadata - never a player identity.
const { surfaceKey } = require('../lib/ssb-tennis-elo-overlay');

const STATUS_OF = (extra) => {
  const e = String(extra || '').toUpperCase();
  if (e.includes('WALKOVER')) return 'walkover';
  if (e.includes('RETIRED')) return 'retired';
  if (e.includes('CANCEL')) return 'cancelled';
  if (e.includes('INTERRUPT')) return 'suspended';
  if (e.includes('SCHEDULED')) return 'scheduled';
  return e.includes('FINISHED') ? 'completed' : 'unknown';
};

function main() {
  const args = parseArgs(process.argv);
  if (!args.input.length || !args.archive || !args.out) {
    console.error(
      'usage: node scripts/ingest-tennisdata-season.js --input <season.csv> [--input <more.csv>] --archive <combined_all.csv> --out <recent_results.csv>'
    );
    process.exit(1);
  }
  const archivePath = expand(args.archive);
  const outPath = expand(args.out);
  const { byTour, pairs } = buildArchive(archivePath);
  const surnameIdx = {
    ATP: buildSurnameIndex(byTour.ATP),
    WTA: buildSurnameIndex(byTour.WTA)
  };
  const idCache = new Map(); // `${tour}|${id}` -> canonical name or null

  const stats = { files: 0, rowsSeen: 0, skippedReason: {}, rowsOut: 0, dates: { from: null, to: null } };
  const surfaceTally = {};
  const bump = (k) => {
    stats.skippedReason[k] = (stats.skippedReason[k] || 0) + 1;
  };
  const outRows = [];

  for (const inputPath of args.input) {
    const fp = expand(inputPath);
    stats.files++;
    const all = parseCsv(fs.readFileSync(fp, 'utf8'));
    if (all.length < 2) continue;
    const header = all[0].map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase());
    const col = (name) => header.indexOf(name);
    const C = {
      date: col('date_human'),
      tour: col('tour_type_human'),
      surface: col('surface'),
      tournament: col('tournament'),
      home: col('home_name'),
      away: col('away_name'),
      homeId: col('home_id'),
      awayId: col('away_id'),
      winner: col('winner_code'),
      extra: col('status_extra')
    };
    if (Object.values(C).some((v) => v < 0)) {
      console.error(
        `skip ${fp}: missing one of date_human/tour_type_human/surface/tournament/home_name/away_name/home_id/away_id/winner_code/status_extra`
      );
      continue;
    }
    for (let r = 1; r < all.length; r++) {
      const cells = all[r];
      stats.rowsSeen++;
      const tour = TOUR_OF(cells[C.tour]);
      if (!tour) {
        bump('unknown_tour');
        continue;
      }
      const date = toIsoDate(cells[C.date]);
      if (!date) {
        bump('unparsable_date');
        continue;
      }
      // Tournament -> surface tally, collected for every row regardless of whether
      // the row itself survives, because the map is slate metadata. Keyed by place
      // AND by month: one place can host two events on different surfaces in one
      // season (Sao Paulo is clay in February and hard in September), so a season
      // majority would answer for the wrong event.
      const tSurface = String(cells[C.surface] || '')
        .trim()
        .toLowerCase();
      const tKey = surfaceKey(cells[C.tournament]);
      if (tKey && tSurface && tSurface !== 'no surface') {
        for (const k of [tKey, `${tKey}|${date.slice(0, 7)}`]) {
          const tally = (surfaceTally[k] = surfaceTally[k] || {});
          tally[tSurface] = (tally[tSurface] || 0) + 1;
        }
      }
      // Point-in-time: a snapshot may never contain a match on or after the day it
      // is used to price, so anything after `--as-of` is dropped here rather than
      // left for the importer to reject wholesale.
      if (args['as-of'] && date > String(args['as-of'])) {
        bump('after_as_of');
        continue;
      }
      const status = STATUS_OF(cells[C.extra]);
      if (status !== 'completed') {
        bump(`status_${status}`);
        continue;
      }
      const winnerCode = String(cells[C.winner] || '').trim();
      if (winnerCode !== '1' && winnerCode !== '2') {
        bump('no_winner_code');
        continue;
      }
      const resolveSide = (name, id) => {
        const cacheKey = `${tour}|${id}`;
        if (idCache.has(cacheKey)) return idCache.get(cacheKey);
        const resolved = resolveName(name, byTour[tour], surnameIdx[tour]);
        idCache.set(cacheKey, resolved);
        return resolved;
      };
      const home = resolveSide(cells[C.home], cells[C.homeId]);
      const away = resolveSide(cells[C.away], cells[C.awayId]);
      if (!home || !away || normalizeName(home) === normalizeName(away)) {
        bump('identity_unresolved');
        continue;
      }
      const winner = winnerCode === '1' ? home : away;
      const loser = winnerCode === '1' ? away : home;
      // Overlap guard: the archive dates a match by its tournament, this file by
      // the day played, so a shared date is not a reliable duplicate test.
      const seen = pairs[tour].get(`${normalizeName(winner)}|${normalizeName(loser)}`) || [];
      if (seen.some((d) => daysBetween(d, date) <= OVERLAP_DAYS)) {
        bump('already_in_archive');
        continue;
      }
      const surface = String(cells[C.surface] || '')
        .trim()
        .toLowerCase();
      outRows.push([date, tour, surface && surface !== 'no surface' ? surface : 'unknown', winner, loser, 'completed']);
      stats.rowsOut++;
    }
  }

  outRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (outRows.length) {
    stats.dates.from = outRows[0][0];
    stats.dates.to = outRows[outRows.length - 1][0];
  }
  if (args['dry-run']) {
    console.log(
      JSON.stringify(
        { dryRun: true, out: outPath, surfaceMapKeys: Object.keys(surfaceTally).length, ...stats },
        null,
        1
      )
    );
    return;
  }
  fs.writeFileSync(
    outPath,
    'date,tour,surface,winner,loser,status\n' + outRows.map((r) => r.join(',')).join('\n') + '\n'
  );

  // Optional tournament -> surface map. The Flashscore schedule cache ships an
  // empty surface for most events, so the Elo overlay would fail closed on
  // `unknown_surface` without this. Majority vote per place key; ties go to the
  // first seen rather than a coin flip.
  let surfaceMapOut = null;
  if (args['surface-map']) {
    surfaceMapOut = expand(String(args['surface-map']));
    const map = {};
    for (const [key, tally] of Object.entries(surfaceTally)) {
      const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (best) map[key] = best[0];
    }
    fs.mkdirSync(path.dirname(surfaceMapOut), { recursive: true });
    fs.writeFileSync(surfaceMapOut, JSON.stringify(map, null, 1) + '\n');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        out: path.resolve(outPath),
        surfaceMap: surfaceMapOut ? path.resolve(surfaceMapOut) : null,
        surfaceMapKeys: Object.keys(surfaceTally).length,
        ...stats
      },
      null,
      1
    )
  );
}

if (require.main === module) main();

module.exports = { resolveName, toIsoDate, STATUS_OF, TOUR_OF, surfaceKey };
