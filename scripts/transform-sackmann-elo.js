#!/usr/bin/env node
'use strict';
// Transform Sackmann atp_matches_*.csv (main + qual_chall) into the
// tennis-elo importer CSV schema: date,tour,surface,winner,loser,status
// Recovered verbatim from the pre-refactor helper (7f4780b^). Local filesystem
// only — no network, no downloads, no bundled data.
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.ELO_DATA_DIR || path.join(process.env.HOME, 'data/tennis-elo');
const OUT = process.env.ELO_OUT || path.join(DIR, 'combined_atp.csv');

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
  .filter((f) => /^atp_(main|qual)_\d{4}\.csv$/.test(f))
  .sort();
let totalRows = 0,
  skipped = 0;
const nameCounts = new Map(); // raw name -> count (for collision canonicalization)
const nameRows = []; // { date, surface, winner, loser, status }

function normKey(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

for (const f of files) {
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
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (k) => (idx[k] >= 0 ? (cells[idx[k]] || '').trim() : '');
    const d = get('tourney_date');
    const date = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skipped++;
      continue;
    }
    const winner = get('winner_name');
    const loser = get('loser_name');
    if (!winner || !loser || winner === loser) {
      skipped++;
      continue;
    }
    nameRows.push({ date, surface: normSurface(get('surface')), winner, loser, status: statusFromScore(get('score')) });
    nameCounts.set(winner, (nameCounts.get(winner) || 0) + 1);
    nameCounts.set(loser, (nameCounts.get(loser) || 0) + 1);
    totalRows++;
  }
}

// Canonicalize case-variant collisions: keep the most frequent spelling.
const byNorm = new Map();
for (const [raw, count] of nameCounts) {
  const k = normKey(raw);
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push([raw, count]);
}
const canonical = new Map(); // raw -> canonical raw
for (const variants of byNorm.values()) {
  if (variants.length === 1) {
    canonical.set(variants[0][0], variants[0][0]);
    continue;
  }
  variants.sort((a, b) => b[1] - a[1]); // most frequent first
  const winner = variants[0][0];
  for (const [v] of variants) canonical.set(v, winner);
}

const outLines = nameRows.map((row) =>
  [row.date, 'ATP', row.surface, canonical.get(row.winner), canonical.get(row.loser), row.status].join(',')
);

fs.writeFileSync(OUT, 'date,tour,surface,winner,loser,status\n' + outLines.join('\n') + '\n');
console.log(JSON.stringify({ inputFiles: files.length, totalRows, skipped, output: OUT }));
