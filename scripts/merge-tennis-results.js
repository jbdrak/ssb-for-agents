#!/usr/bin/env node
/**
 * merge-tennis-results.js — turn a Flashscore results capture into the importer's
 * recent-results schema, resolving every player through the SHARED resolver.
 *
 *   python3 scripts/flashscore-results.py --days 8 --out /tmp/fs.json
 *   node scripts/merge-tennis-results.js \
 *     --results /tmp/fs.json \
 *     --archive ~/data/tennis-elo/combined_archives.csv \
 *     --out ~/data/tennis-elo/recent_results.csv \
 *     --surface-map ~/.ssb-for-agents/tennis-surface-map.json
 *
 * Identity rules (this is the whole point of the file):
 *   - A player is emitted only when the shared resolver pins them to exactly one
 *     archive name. Unresolved sides drop the whole row. Emitting a guess would
 *     create a phantom second player and silently corrupt the ratings.
 *   - The Flashscore slug is the only place a forename appears, so it is tried
 *     first; the displayed surname is the fallback.
 *   - Sides are assigned by matching the displayed surname against the resolved
 *     display name, because Flashscore's slot order and its href slug order do not
 *     agree.
 *
 * Dates come from the capture's own day label, never from the day offset: when the
 * day-arrow walk stalls it repeats one label across several offsets, and trusting
 * the offset would fabricate whole days of duplicate matches at wrong dates.
 */

const fs = require('node:fs');
const { normalizeName, parseMatchCsv } = require('../lib/tennis-elo-data');
const { buildNameMap, buildSurnameIndex, resolveName, resolveSlug } = require('../lib/tennis-name-resolve');
const { surfaceKey } = require('../lib/ssb-tennis-elo-overlay');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const expand = (p) => String(p).replace(/^~/, process.env.HOME);

/** Tokens of a displayed surname, dropping a trailing initial ("Samson L." -> SAMSON). */
function surnameTokens(raw) {
  const tokens = String(raw || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.'’]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.toUpperCase());
  while (tokens.length > 1 && tokens[tokens.length - 1].length === 1) tokens.pop();
  return tokens;
}

/** Does `name` end with the token run `tail`? */
function endsWithTokens(name, tail) {
  if (!tail.length || tail.length > name.length) return false;
  const start = name.length - tail.length;
  return tail.every((t, i) => name[start + i] === t);
}

/**
 * Which capture side does this resolved display name belong to?
 * @returns {'home'|'away'|null} null when both or neither side matches.
 */
function sideFor(resolvedDisplay, home, away) {
  const resolved = surnameTokens(resolvedDisplay);
  const h = endsWithTokens(resolved, surnameTokens(home));
  const a = endsWithTokens(resolved, surnameTokens(away));
  if (h === a) return null;
  return h ? 'home' : 'away';
}

/** Flashscore categories that carry a tour, and their doubles flag. */
function categoryInfo(category) {
  const c = String(category || '').toUpperCase();
  if (!c) return null;
  const doubles = c.includes('DOUBLES');
  if (c.includes('WTA') || c.includes('WOMEN')) return { tour: 'WTA', doubles };
  if (c.includes('ATP') || c.includes('MEN')) return { tour: 'ATP', doubles };
  return null;
}

const STATUS_OF_STAGE = (stage) => {
  const s = String(stage || '').toUpperCase();
  if (s.includes('WALKOVER')) return 'walkover';
  if (s.includes('RETIRED')) return 'retired';
  if (s.includes('CANCEL')) return 'cancelled';
  if (s.includes('AWARDED')) return 'completed';
  if (s.includes('FINISHED')) return 'completed';
  return 'unknown';
};

/** "10/09" or "17/09 Th" -> "2026-09-10", inferring the year from the capture date. */
function stripToIso(strip, capturedAt) {
  const m = /^(\d{2})\/(\d{2})(?:\s+\S+)?$/.exec(String(strip || '').trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (!day || !month || month > 12) return null;
  const cap = new Date(capturedAt);
  let year = cap.getUTCFullYear();
  // A December capture walking back into November must not read as next year.
  if (month > cap.getUTCMonth() + 1) year -= 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.results || !args.archive || !args.out) {
    console.error(
      'usage: node scripts/merge-tennis-results.js --results <capture.json> --archive <combined_archives.csv> --out <recent_results.csv> [--existing <csv>]... [--surface-map <map.json>] [--as-of YYYY-MM-DD]'
    );
    process.exit(2);
  }

  const capture = JSON.parse(fs.readFileSync(expand(args.results), 'utf8'));
  const archiveRows = parseMatchCsv(fs.readFileSync(expand(args.archive), 'utf8'));

  // Anything already known, so a re-scraped overlap never double-counts. `--existing`
  // takes the season ingest's own recent rows: Flashscore and TennisData disagree
  // about the DATE of about 5% of matches (day-boundary convention, measured), while
  // agreeing on the pair, so a duplicate is the same pair within +-1 day. Matching on
  // the exact date would let those 5% in twice and skew the ratings.
  const existingRows = [];
  for (const p of [].concat(args.existing || [])) {
    try {
      existingRows.push(...parseMatchCsv(fs.readFileSync(expand(p), 'utf8')));
    } catch {
      // A missing optional source is not an error; the archive is the floor.
    }
  }
  const knownRows = archiveRows.concat(existingRows);
  const nameMap = buildNameMap(knownRows);
  const surnameIdx = {
    ATP: buildSurnameIndex(nameMap.ATP),
    WTA: buildSurnameIndex(nameMap.WTA)
  };

  /** key -> Set(dates already recorded for that pair) */
  const seenPairs = new Map();
  const DAY_MS = 86400000;
  for (const row of knownRows) {
    const w = normalizeName(row.winner);
    const l = normalizeName(row.loser);
    const date = String(row.date || '').trim();
    if (!w || !l || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const key = `${w}|${l}`;
    if (!seenPairs.has(key)) seenPairs.set(key, new Set());
    seenPairs.get(key).add(date);
  }

  const alreadyKnown = (date, w, l) => {
    const dates = seenPairs.get(`${normalizeName(w)}|${normalizeName(l)}`);
    if (!dates) return false;
    const t = Date.parse(`${date}T00:00:00Z`);
    for (const d of dates) {
      if (Math.abs(Date.parse(`${d}T00:00:00Z`) - t) <= DAY_MS) return true;
    }
    return false;
  };

  const asOf = args['as-of'] ? String(args['as-of']) : null;
  const capturedAt = capture.scrapedAt || new Date().toISOString();

  // Read-only surface fallback. The season ingest is the single writer of this map
  // (its surfaces come from TennisData's own column); the capture's header surface
  // is usually blank, so look the tournament up here instead.
  let surfaceMap = {};
  if (args['surface-map']) {
    try {
      surfaceMap = JSON.parse(fs.readFileSync(expand(args['surface-map']), 'utf8'));
    } catch {
      surfaceMap = {};
    }
  }

  const stats = {
    days: 0,
    stalledDaysSkipped: 0,
    matchesSeen: 0,
    doublesSkipped: 0,
    unknownCategory: 0,
    unresolved: 0,
    ambiguousSide: 0,
    afterAsOf: 0,
    duplicate: 0,
    surfaceFromMap: 0,
    surfaceUnknown: 0,
    rowsOut: 0
  };
  const out = [];
  const seenStrips = new Set();
  const seenRows = new Set();

  for (const day of capture.days || []) {
    if (!day || !day.strip || !day.result || !Array.isArray(day.result.matches)) continue;
    const date = stripToIso(day.strip, capturedAt);
    if (!date) continue;
    // A repeated label means the day-arrow walk stalled; those matches are already
    // captured under this date.
    if (seenStrips.has(day.strip)) {
      stats.stalledDaysSkipped++;
      continue;
    }
    seenStrips.add(day.strip);
    stats.days++;

    for (const m of day.result.matches) {
      stats.matchesSeen++;
      const info = categoryInfo(m.category);
      if (!info) {
        stats.unknownCategory++;
        continue;
      }
      if (info.doubles) {
        stats.doublesSkipped++;
        continue;
      }
      const slugs = Array.isArray(m.slugs) ? m.slugs.filter(Boolean) : [];
      if (slugs.length !== 2) {
        stats.unresolved++;
        continue;
      }

      // Resolve identity from the slugs first (they carry the forename), then the
      // displayed names as a fallback.
      const resolvedBySide = { home: null, away: null };
      const slugHits = slugs.map((s) => resolveSlug(s, nameMap[info.tour])).filter(Boolean);
      const displayHits = [
        resolveName(m.home, nameMap[info.tour], surnameIdx[info.tour]),
        resolveName(m.away, nameMap[info.tour], surnameIdx[info.tour])
      ].filter(Boolean);

      for (const display of [...slugHits, ...displayHits]) {
        const side = sideFor(display, m.home, m.away);
        if (!side) continue;
        if (resolvedBySide[side] && resolvedBySide[side] !== display) {
          // Two different players claimed one slot: leave it unresolved.
          resolvedBySide[side] = null;
          stats.ambiguousSide++;
          continue;
        }
        resolvedBySide[side] = display;
      }

      if (!resolvedBySide.home || !resolvedBySide.away) {
        stats.unresolved++;
        continue;
      }

      const homeWon = Boolean(m.homeWinner);
      const awayWon = Boolean(m.awayWinner);
      if (homeWon === awayWon) {
        stats.unresolved++;
        continue;
      }
      const winner = homeWon ? resolvedBySide.home : resolvedBySide.away;
      const loser = homeWon ? resolvedBySide.away : resolvedBySide.home;
      if (winner === loser) {
        stats.unresolved++;
        continue;
      }

      if (asOf && date > asOf) {
        stats.afterAsOf++;
        continue;
      }
      const key = `${normalizeName(winner)}|${normalizeName(loser)}`;
      if (alreadyKnown(date, winner, loser) || seenRows.has(key)) {
        stats.duplicate++;
        continue;
      }
      seenRows.add(key);

      const status = STATUS_OF_STAGE(m.stage);
      const tKey = surfaceKey(m.tournament);
      let surface = String(m.surface || '')
        .trim()
        .toLowerCase();
      if (!surface) {
        surface = surfaceMap[`${tKey}|${date.slice(0, 7)}`] || surfaceMap[tKey] || '';
        if (surface) stats.surfaceFromMap++;
      }
      if (!surface) stats.surfaceUnknown++;
      out.push(`${date},${info.tour},${surface},${winner},${loser},${status}`);
      stats.rowsOut++;
    }
  }

  out.sort();
  fs.writeFileSync(
    expand(args.out),
    'date,tour,surface,winner,loser,status\n' + out.join('\n') + (out.length ? '\n' : '')
  );

  console.log(JSON.stringify({ ok: true, out: expand(args.out), asOf, ...stats }, null, 1));
}

if (require.main === module) main();

module.exports = { surnameTokens, endsWithTokens, sideFor, categoryInfo, stripToIso, STATUS_OF_STAGE };
