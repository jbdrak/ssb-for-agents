#!/usr/bin/env node
'use strict';

/**
 * build-tennis-elo-alias-map.js — derive an explicit unique-surname alias file
 * for the tennis Elo snapshot.
 *
 * Why: PP names tennis participants by SURNAME ONLY ("Barthel vs Ristic",
 * `participant1: "Kasintseva"`), while the Elo resolver is exact-full-name or
 * explicit-unique-alias only and refuses fuzzy or guessed surnames. A surname is
 * therefore declared as an alias only when it is UNIQUE inside its tour; an
 * ambiguous surname (two Wilsons) is omitted entirely, so the resolver keeps
 * failing closed on it instead of picking one at random.
 *
 * The file is generated from the snapshot itself, so the alias targets always
 * exist in the ratings the importer validates against. It is written outside the
 * repo (derived from CC BY-NC-SA licensed source data).
 *
 * Usage:
 *   node scripts/build-tennis-elo-alias-map.js \
 *     --snapshot ~/.ssb-for-agents/tennis-elo-snapshot.json \
 *     --out ~/.ssb-for-agents/tennis-elo-aliases.json
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadSnapshot, normalizeName } = require('../lib/tennis-elo-data');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const expand = (p) => String(p).replace(/^~/, process.env.HOME);

/** Last whitespace-separated token of a display name; PP uses exactly this. */
function surnameOf(displayName) {
  const parts = String(displayName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function main() {
  const args = parseArgs(process.argv);
  const outPath = expand(args.out || '~/.ssb-for-agents/tennis-elo-aliases.json');
  const loaded = args.snapshot ? loadSnapshot(expand(args.snapshot)) : loadSnapshot();
  const snapshot = loaded.snapshot;
  if (!snapshot || !snapshot.players) {
    console.error('could not load a tennis-elo snapshot; build one first (scripts/refresh-tennis-elo.js)');
    process.exit(1);
  }

  const aliases = {};
  const report = { snapshotAsOf: (snapshot.manifest || {}).asOf || null, tours: {} };
  for (const [rawTour, pool] of Object.entries(snapshot.players)) {
    const tour = rawTour.toUpperCase();
    const bySurname = new Map();
    for (const player of Object.values(pool)) {
      const surname = surnameOf(player && player.name);
      if (!surname) continue;
      const key = normalizeName(surname);
      if (!bySurname.has(key)) bySurname.set(key, new Set());
      bySurname.get(key).add(player.name);
    }
    const tourAliases = {};
    let ambiguous = 0;
    for (const [key, names] of bySurname.entries()) {
      if (names.size !== 1) {
        ambiguous++;
        continue;
      }
      tourAliases[key] = [...names][0];
    }
    aliases[tour] = tourAliases;
    report.tours[tour] = {
      players: Object.keys(pool).length,
      distinctSurnames: bySurname.size,
      uniqueSurnames: Object.keys(tourAliases).length,
      ambiguousSurnames: ambiguous
    };
  }

  if (args['dry-run']) {
    console.log(JSON.stringify({ dryRun: true, out: outPath, ...report }, null, 1));
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(aliases, null, 1) + '\n');
  console.log(JSON.stringify({ ok: true, out: path.resolve(outPath), ...report }, null, 1));
}

if (require.main === module) main();

module.exports = { surnameOf };
