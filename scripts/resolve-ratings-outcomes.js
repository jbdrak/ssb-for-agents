#!/usr/bin/env node
'use strict';

/**
 * resolve-ratings-outcomes.js — settle ratings fixtures from ESPN's public
 * college-football scoreboard, so `pp ratings --evaluate` has outcomes to score
 * Sagarin's published WIN% against.
 *
 * Read-only against the ratings snapshot store; writes only the outcomes file.
 * No PropProfessor traffic anywhere on this path, so it is in the same
 * schedulable category as `scripts/refresh-ratings.js`.
 *
 * The window is EXPLICIT on purpose. A ratings snapshot carries an `asOf` (the
 * source's own "through games of" date) but no per-fixture kickoff date, so the
 * script never guesses one: `--from`/`--to` say which dates to look at, and the
 * default is the week following the snapshot's `asOf`. Every fixture that does
 * not resolve inside that window is reported as unmatched.
 *
 * Usage:
 *   node scripts/resolve-ratings-outcomes.js --source sagarin --league NCAAF
 *   node scripts/resolve-ratings-outcomes.js --source sagarin --league NCAAF \
 *     --from 2026-09-13 --to 2026-09-19 --out /tmp/outcomes.json
 *
 * @module scripts/resolve-ratings-outcomes
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listSnapshots, loadSnapshot } = require('../lib/ssb-ratings-snapshot');
const { buildCfbOutcomeIndex, matchCfbOutcomes } = require('../lib/cfb-outcomes');

const ESPN_CFB_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';

/** Add `days` to a YYYY-MM-DD date string. */
function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Every YYYY-MM-DD from `from` to `to` inclusive, or null when the range is invalid. */
function dateRange(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return null;
  const days = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
    if (days.length > 60) return null; // a 60-day window is a caller error, not a season
  }
  return days;
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/** The snapshot records for one source+league, or an error describing why not. */
function loadRecords(source, league) {
  const listed = listSnapshots();
  if (!listed.ok) return { ok: false, error: (listed.errors || []).join('; ') };
  const match = listed.snapshots.find(
    (snapshot) => snapshot.valid && snapshot.source === source && snapshot.league === league
  );
  if (!match) return { ok: false, error: `no valid ${source}/${league} snapshot in the ratings store` };
  const loaded = loadSnapshot(source, league, match.season);
  if (!loaded.ok || !loaded.snapshot) return { ok: false, error: `unable to load ${source}/${league}` };
  return { ok: true, records: loaded.snapshot.records, asOf: loaded.snapshot.asOf, season: loaded.snapshot.season };
}

async function fetchScoreboard(date, fetchImpl = globalThis.fetch) {
  const url = `${ESPN_CFB_SCOREBOARD}?dates=${date.replace(/-/g, '')}&limit=400`;
  const response = await fetchImpl(url);
  if (!response || !response.ok) throw new Error(`ESPN scoreboard ${date} returned ${response && response.status}`);
  const payload = await response.json();
  return Array.isArray(payload && payload.events) ? payload.events : [];
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const source = String(flags.source || 'sagarin');
  const league = String(flags.league || 'NCAAF').toUpperCase();
  if (league !== 'NCAAF') {
    // ESPN's college-football scoreboard is the only feed this script speaks.
    console.error(`resolve-ratings-outcomes: only NCAAF is supported (got ${league})`);
    process.exit(1);
  }

  const loaded = loadRecords(source, league);
  if (!loaded.ok) {
    console.error(`resolve-ratings-outcomes: ${loaded.error}`);
    process.exit(1);
  }

  const from = String(flags.from || addDays(loaded.asOf, 1) || '');
  const to = String(flags.to || addDays(loaded.asOf, 10) || '');
  const days = dateRange(from, to);
  if (!days) {
    console.error(`resolve-ratings-outcomes: invalid window ${from}..${to} (need YYYY-MM-DD, from <= to)`);
    process.exit(1);
  }

  const events = [];
  const failedDates = [];
  for (const day of days) {
    try {
      events.push(...(await fetchScoreboard(day)));
    } catch (error) {
      failedDates.push({ date: day, error: error && error.message });
    }
  }

  const index = buildCfbOutcomeIndex(events, league);
  const result = matchCfbOutcomes(loaded.records, index);

  const outPath =
    typeof flags.out === 'string' && flags.out.trim() !== ''
      ? flags.out
      : path.join(
          process.env.SSB_RATINGS_DIR || path.join(os.homedir(), '.ssb-for-agents', 'ratings'),
          `cfb-outcomes-${league}-${loaded.season}.json`
        );

  const document = {
    schemaVersion: 1,
    source: 'espn',
    feed: ESPN_CFB_SCOREBOARD,
    league,
    season: loaded.season,
    ratingsSource: source,
    ratingsAsOf: loaded.asOf,
    window: { from, to, days: days.length },
    fetchedAt: new Date().toISOString(),
    counts: {
      fixtures: loaded.records.length,
      events: events.length,
      matched: result.matched,
      unmatched: result.unmatched
    },
    reasons: result.reasons,
    outcomes: result.outcomes
  };

  if (flags['dry-run'] !== true) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  }

  // Nothing here is a secret: counts and reasons only.
  console.log(
    `${source}/${league} ratingsAsOf=${loaded.asOf} window=${from}..${to} days=${days.length}` +
      (failedDates.length ? ` failedDates=${failedDates.length}` : '')
  );
  console.log(
    `  fixtures=${loaded.records.length} events=${events.length} matched=${result.matched} unmatched=${result.unmatched}`
  );
  for (const [reason, count] of Object.entries(result.reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  }
  if (index.skipped.length) {
    const byReason = {};
    for (const entry of index.skipped) byReason[entry.reason] = (byReason[entry.reason] || 0) + 1;
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  event:${reason}`);
    }
  }
  console.log(flags['dry-run'] === true ? '  (dry run: nothing written)' : `  wrote ${outPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`resolve-ratings-outcomes: ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = { addDays, dateRange, fetchScoreboard, loadRecords };
