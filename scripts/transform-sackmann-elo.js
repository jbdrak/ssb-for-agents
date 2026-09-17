#!/usr/bin/env node
'use strict';
// Transform Sackmann match archives ({atp,wta}_{main,qual}_YYYY.csv) into the
// tennis-elo importer CSV schema: date,tour,surface,winner,loser,status
// Recovered from the pre-refactor helper (7f4780b^), then generalized to both
// tours so one snapshot can carry ATP and WTA ratings side by side. Local
// filesystem only — no network, no downloads, no bundled data.
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.ELO_DATA_DIR || path.join(process.env.HOME, 'data/tennis-elo');
const OUT = process.env.ELO_OUT || path.join(DIR, 'combined_all.csv');

// RFC4180-ish parse: quoted fields with "" escapes, embedded commas/newlines.
function parseCsv(text) {
  const rows = [];
  let field = '',
    row = [],
    inQuotes = false,
    i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      if (row.length > 0 || rows.length > 0) rows.push(row);
      row = [];
      if (ch === '\r' && text[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 0);
}

function statusFromScore(score) {
  const s = String(score || '').toUpperCase();
  if (s.includes('RET')) return 'retired';
  if (s.includes('W/O') || s.includes('WO ')) return 'walkover';
  if (s.includes('DEF')) return 'default';
  if (s.includes('ABN')) return 'abandoned';
  return 'completed';
}

function normSurface(s) {
  const v = String(s || '').trim();
  const low = v.toLowerCase();
  if (low.includes('hard') || low.includes('indoor')) return 'hard';
  if (low.includes('clay')) return 'clay';
  if (low.includes('grass')) return 'grass';
  return v || 'unknown';
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => /^(atp|wta)_(main|qual)_\d{4}\.csv$/.test(f))
  .sort();
let totalRows = 0,
  skipped = 0;
const nameCounts = new Map(); // `${tour}|${raw name}` -> count (for collision canonicalization)
const nameRows = []; // { tour, date, surface, winner, loser, status }
const perTour = {};

function normKey(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

for (const f of files) {
  const tour = f.slice(0, 3).toUpperCase(); // 'ATP' | 'WTA'
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) continue;
  const cols = rows[0].map((c) => c.trim().toLowerCase());
  const idx = {};
  ['tourney_date', 'surface', 'winner_name', 'loser_name', 'score'].forEach((c) => {
    idx[c] = cols.indexOf(c);
  });
  if (Object.values(idx).some((v) => v < 0)) {
    console.error(`skip ${f}: missing cols (${cols.join(',')})`);
    continue;
  }
  const stats = (perTour[tour] = perTour[tour] || { files: 0, rows: 0, skipped: 0 });
  stats.files += 1;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (k) => (idx[k] >= 0 ? (cells[idx[k]] || '').trim() : '');
    const d = get('tourney_date');
    const date = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skipped++;
      stats.skipped++;
      continue;
    }
    const winner = get('winner_name');
    const loser = get('loser_name');
    if (!winner || !loser || winner === loser) {
      skipped++;
      stats.skipped++;
      continue;
    }
    nameRows.push({
      tour,
      date,
      surface: normSurface(get('surface')),
      winner,
      loser,
      status: statusFromScore(get('score'))
    });
    // Collisions are only meaningful WITHIN a tour: a men's and a women's
    // player who normalize to the same key are different people and must keep
    // their own spelling rather than being merged into one rating.
    nameCounts.set(`${tour}|${winner}`, (nameCounts.get(`${tour}|${winner}`) || 0) + 1);
    nameCounts.set(`${tour}|${loser}`, (nameCounts.get(`${tour}|${loser}`) || 0) + 1);
    totalRows++;
    stats.rows++;
  }
}

// Canonicalize case-variant collisions: keep the most frequent spelling.
const byNorm = new Map();
for (const [raw, count] of nameCounts) {
  const sep = raw.indexOf('|');
  const tour = raw.slice(0, sep);
  const name = raw.slice(sep + 1);
  const k = `${tour}|${normKey(name)}`;
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push([name, count]);
}
const canonical = new Map(); // `${tour}|${raw}` -> canonical raw
for (const [groupKey, variants] of byNorm.entries()) {
  const tour = groupKey.slice(0, groupKey.indexOf('|'));
  if (variants.length === 1) {
    canonical.set(`${tour}|${variants[0][0]}`, variants[0][0]);
    continue;
  }
  variants.sort((a, b) => b[1] - a[1]); // most frequent first
  const winner = variants[0][0];
  for (const [v] of variants) canonical.set(`${tour}|${v}`, winner);
}

// Optional recent-results overlays (importer schema). Two producers:
//   ELO_RECENT    - scripts/ingest-tennisdata-season.js (the season baseline)
//   ELO_RECENT_FS - scripts/merge-tennis-results.js (the headless incremental)
// Names in both are already resolved onto the archive's own spelling, so they are
// appended verbatim and never re-canonicalized (that would let a recent file rename
// a player). The incremental file is expected to be deduped against the baseline by
// its own producer, so this merge stays a plain concatenation.
const recentPaths = [process.env.ELO_RECENT || path.join(DIR, 'recent_results.csv')];
if (process.env.ELO_RECENT_FS) recentPaths.push(process.env.ELO_RECENT_FS);
const recentRows = [];
for (const recentPath of recentPaths) {
  if (!fs.existsSync(recentPath)) continue;
  const rrows = parseCsv(fs.readFileSync(recentPath, 'utf8'));
  if (rrows.length <= 1) continue;
  const rcols = rrows[0].map((c) => c.trim().toLowerCase());
  const ri = {};
  ['date', 'tour', 'surface', 'winner', 'loser', 'status'].forEach((c) => {
    ri[c] = rcols.indexOf(c);
  });
  if (!Object.values(ri).every((v) => v >= 0)) {
    console.error(`skip ${recentPath}: missing cols (${rcols.join(',')})`);
    continue;
  }
  for (let r = 1; r < rrows.length; r++) {
    const c = rrows[r];
    const get = (k) => (c[ri[k]] || '').trim();
    const d = get('date');
    const winner = get('winner');
    const loser = get('loser');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !winner || !loser || winner === loser) continue;
    recentRows.push({
      tour: get('tour').toUpperCase(),
      date: d,
      surface: get('surface') || 'unknown',
      winner,
      loser,
      status: get('status') || 'completed'
    });
  }
}

const archiveRows = nameRows.map((row) => ({
  date: row.date,
  tour: row.tour,
  surface: row.surface,
  winner: canonical.get(`${row.tour}|${row.winner}`),
  loser: canonical.get(`${row.tour}|${row.loser}`),
  status: row.status
}));

const toLines = (list) =>
  list
    // The engine consumes matches chronologically, so the merged file is sorted by
    // date. Array.prototype.sort is stable in Node, which preserves same-day order
    // (round robin order) exactly as it was read.
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((row) => [row.date, row.tour, row.surface, row.winner, row.loser, row.status].join(','));

// Archives-only file, written ALWAYS. Downstream identity work (the season ingest)
// must dedupe against this one: deduping against the merged file makes every
// previously-ingested recent row look like an archive duplicate, which would
// silently drop it on the next rebuild.
const ARCHIVES_OUT = process.env.ELO_ARCHIVES_OUT || path.join(DIR, 'combined_archives.csv');
fs.writeFileSync(ARCHIVES_OUT, 'date,tour,surface,winner,loser,status\n' + toLines(archiveRows).join('\n') + '\n');
fs.writeFileSync(
  OUT,
  'date,tour,surface,winner,loser,status\n' + toLines(archiveRows.concat(recentRows)).join('\n') + '\n'
);
console.log(
  JSON.stringify({
    inputFiles: files.length,
    totalRows,
    skipped,
    perTour,
    recentRows: recentRows.length,
    recentPaths: recentRows.length ? recentPaths : null,
    output: OUT,
    archivesOutput: ARCHIVES_OUT
  })
);
