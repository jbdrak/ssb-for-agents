#!/usr/bin/env node
'use strict';

/**
 * Produce a settlement results file from real result sources.
 *
 * `scripts/settle-record.js` never calls the network by design — it grades a
 * SUPPLIED results file. Nothing produced one, which is why the ledger holds
 * 0 settlements. This is that producer:
 *
 *   node scripts/fetch-results.js --date 2026-09-17 --out /tmp/results.json
 *   node scripts/settle-record.js --results /tmp/results.json --dry-run
 *
 * Sources:
 *   - **ESPN** (lib/ssb-espn-resolver's `fetchEspnScoreboard`) for MLB, NFL, NBA,
 *     WNBA, NCAAF, NCAAB, NHL. Free, no key. It already carries the Akamai 403
 *     fallback host and a 5-minute cache, so this reuses it instead of adding a
 *     second fetcher.
 *   - **Flashscore** (`scripts/flashscore-results.py`) for tennis, passed in with
 *     `--flashscore <file>`. Same-day tennis is not on any ESPN board — its
 *     125K/Challenger coverage does not exist — and this scraper is the only
 *     working same-day source; it is verified against the live DOM.
 *
 * `--espn`/`--no-espn` and `--flashscore <file>` are independent, so either
 * source can run alone. Top-level provenance is derived from the events that
 * actually made it into the document, never asserted ahead of them.
 *
 * Usage:
 *   node scripts/fetch-results.js --date 2026-09-17 --leagues MLB,WNBA --out r.json
 *   node scripts/fetch-results.js --date 2026-09-17 --flashscore /tmp/fs.json --out r.json
 *   node scripts/fetch-results.js --date 2026-09-17 --json          # stdout
 */

const fs = require('node:fs');
const { ESPN_LEAGUE_PATH, fetchEspnScoreboard } = require('../lib/ssb-espn-resolver');
const { eventsFromEspnBoards, eventsFromFlashscorePayload, buildResultsDocument } = require('../lib/results-provider');

/** Leagues ESPN serves that a bet can actually be settled against. */
const DEFAULT_LEAGUES = Object.freeze(['MLB', 'WNBA', 'NBA', 'NFL', 'NCAAF', 'NCAAB', 'NHL']);

/** ESPN's scoreboard date parameter is a compact calendar date. */
function espnDate(isoDate) {
  const day = String(isoDate || '').slice(0, 10);
  const compact = day.replace(/-/g, '');
  return /^\d{8}$/.test(compact) ? compact : undefined;
}

/**
 * Fetch and assemble a results document.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.leagues]
 * @param {string}   [opts.date] - YYYY-MM-DD
 * @param {boolean}  [opts.espn=true]
 * @param {Object}   [opts.flashscorePayload] - parsed flashscore-results.py output
 * @param {Function} [opts.getBoard] - async (league, { dates }) => competitions[]
 * @returns {Promise<Object>}
 */
async function fetchResults(opts = {}) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const { getBoard = fetchEspnScoreboard } = opts;

  const events = [];
  const skipped = { leagues: [], sources: [] };

  if (opts.espn !== false) {
    const leagues = Array.isArray(opts.leagues) && opts.leagues.length ? opts.leagues : DEFAULT_LEAGUES;
    const boards = {};
    for (const league of leagues) {
      if (!ESPN_LEAGUE_PATH[league]) {
        skipped.leagues.push({ league, reason: 'unsupported_league' });
        continue;
      }
      try {
        const competitions = await getBoard(league, { dates: espnDate(date) });
        if (Array.isArray(competitions) && competitions.length) boards[league] = competitions;
        else skipped.leagues.push({ league, reason: 'empty_board' });
      } catch (error) {
        skipped.leagues.push({ league, reason: 'fetch_failed', detail: error && error.message });
      }
    }
    events.push(...eventsFromEspnBoards(boards, { date }));
  }

  if (opts.flashscorePayload) {
    const tennis = eventsFromFlashscorePayload(opts.flashscorePayload, { date });
    if (tennis.length) events.push(...tennis);
    else skipped.sources.push({ source: 'flashscore', reason: 'no_matches' });
  }

  const document = buildResultsDocument(events);
  if (!document.ok) {
    return {
      ok: false,
      error: document.error,
      date,
      events: 0,
      skipped
    };
  }

  return {
    ok: true,
    date,
    provider: document.provider,
    sourceUrl: document.sourceUrl,
    events: document.events.length,
    counts: document.counts,
    skipped,
    document: { provider: document.provider, sourceUrl: document.sourceUrl, events: document.events }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.split(/=(.+)/);
    const key = k.replace(/^--/, '');
    if (v !== undefined) {
      flags[key] = v;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function readJson(file, label) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error: `unable to read ${label} file ${file}: ${error && error.message}` };
  }
}

async function main() {
  const flags = parseArgs(process.argv);
  let flashscorePayload;
  if (typeof flags.flashscore === 'string') {
    const read = readJson(flags.flashscore, 'flashscore');
    if (!read.ok) {
      console.error(read.error);
      process.exit(2);
    }
    flashscorePayload = read.value;
  }

  const result = await fetchResults({
    date: typeof flags.date === 'string' ? flags.date : undefined,
    leagues:
      typeof flags.leagues === 'string' ? flags.leagues.split(',').map((s) => s.trim().toUpperCase()) : undefined,
    espn: flags['no-espn'] === undefined,
    flashscorePayload
  });

  if (!result.ok) {
    console.error(`fetch-results: ${result.error}`);
    process.exit(1);
  }

  if (typeof flags.out === 'string') {
    fs.writeFileSync(flags.out, JSON.stringify(result.document, null, 2));
  }
  if (flags.json) {
    console.log(JSON.stringify(result.document, null, 2));
  } else {
    console.log(
      `fetch-results: ${result.events} event(s) for ${result.date} from ${result.provider} ` +
        `[${Object.entries(result.counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}]`
    );
    for (const skip of result.skipped.leagues) console.log(`  skipped ${skip.league}: ${skip.reason}`);
    for (const skip of result.skipped.sources) console.log(`  skipped ${skip.source}: ${skip.reason}`);
    if (typeof flags.out === 'string') console.log(`  -> ${flags.out}`);
  }
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`fetch-results failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { fetchResults, parseArgs, espnDate, DEFAULT_LEAGUES };
