#!/usr/bin/env node
'use strict';

/**
 * refresh-ratings.js — fetch and snapshot the external ratings benchmark
 * sources (Massey / Sagarin / Sasser) with ZERO PropProfessor traffic.
 *
 * Ratings are a dated benchmark layer, never a live ranking input: this script
 * only reads the free third-party pages and writes normalized snapshots to the
 * local state dir (`SSB_RATINGS_DIR`, default `~/.ssb-for-agents/ratings/`) via
 * `lib/ssb-ratings-snapshot.js`. No PropProfessor client (lib/ssb-api.js), no
 * auth, no SSB endpoint is imported or called anywhere on this path, which is
 * what makes a refresh schedulable — same category as
 * `scripts/resolve-outcomes.js --espn` and `scripts/refresh-tennis-circuit.js`.
 *
 * Usage:
 *   node scripts/refresh-ratings.js --source massey,sagarin,sasser --league NCAAF
 *   node scripts/refresh-ratings.js --source sagarin                # every league sagarin publishes
 *   node scripts/refresh-ratings.js --source sagarin --league CFB --json
 *   node scripts/refresh-ratings.js --source sagarin --league NFL --export-url <csv-url>
 *
 * Scheduling this script is a deliberate human decision, not part of the
 * script: nothing here installs a cron entry, watcher, or startup hook.
 *
 * Failure policy (fail closed, never abort the batch):
 *   - one source/league pair that throws is recorded as `status: 'error'` and
 *     the remaining pairs still run;
 *   - a league the source does not publish is `status: 'unsupported'` and is
 *     not fetched at all;
 *   - a page that fetches but yields no readable rows is
 *     `status: 'unavailable'` and stores nothing — an empty table and a quiet
 *     slate must not look alike;
 *   - the process exits non-zero only when NO pair succeeded.
 */

const store = require('../lib/ssb-ratings-snapshot');
const massey = require('../lib/ratings-sources/massey');
const masseyWeb = require('../lib/ratings-sources/massey-web');
const masseyGames = require('../lib/ratings-sources/massey-games');
const sagarin = require('../lib/ratings-sources/sagarin');
const sasser = require('../lib/ratings-sources/sasser');
// The layer's one recency rule and age arithmetic. The refresh summary asks a
// different question from the attach gate ("has this source gone quiet?" against
// our fetch time, not "does this record describe this event?"), so it uses the
// looser display window - but the same implementation, never a second copy.
const { REFRESH_STALE_AFTER_DAYS: STALE_AFTER_DAYS, ageInDays } = require('../lib/ssb-ratings-recency');

const ADAPTERS = Object.freeze({
  massey: {
    source: massey.SOURCE,
    fetch: massey.fetchMassey,
    normalize: massey.normalizeMassey,
    unsupportedReason: massey.unsupportedReason,
    supportedLeagues: massey.supportedLeagues,
    // Massey's ratings host 403s plain HTTP, so it needs the got-scraping
    // client rather than the ambient fetch. Other sources keep the default.
    createFetch: masseyWeb.createMasseyFetch
  },
  massey_games: {
    source: masseyGames.SOURCE,
    fetch: masseyGames.fetchMasseyGames,
    normalize: masseyGames.normalizeMasseyGames,
    unsupportedReason: masseyGames.unsupportedReason,
    supportedLeagues: masseyGames.supportedLeagues,
    // Same vendor and same bot wall as `massey`, so the same client.
    createFetch: masseyWeb.createMasseyFetch
  },
  sagarin: {
    source: sagarin.SOURCE,
    fetch: sagarin.fetchSagarin,
    normalize: sagarin.normalizeSagarin,
    unsupportedReason: sagarin.unsupportedReason,
    supportedLeagues: sagarin.supportedLeagues
  },
  sasser: {
    source: sasser.SOURCE,
    fetch: sasser.fetchSasser,
    normalize: sasser.normalizeSasser,
    unsupportedReason: sasser.unsupportedReason,
    supportedLeagues: sasser.supportedLeagues
  }
});

const SOURCES = Object.freeze(Object.keys(ADAPTERS));

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function displayLeague(league) {
  return String(league).trim().toUpperCase();
}

function reasonOf(error) {
  if (error && typeof error.message === 'string' && error.message.trim() !== '') return error.message;
  return String(error);
}

/** A skipped/failed pair, always shaped like a successful one. */
function rowFor(source, league, status, extra = {}) {
  return {
    source,
    league,
    status,
    asOf: null,
    fetchedAt: null,
    ageDays: null,
    stale: null,
    recordCount: 0,
    coverage: null,
    coverageReason: null,
    reason: null,
    ...extra
  };
}

// A source's own "through games of" heading can sit far behind the page we just
// fetched: in the 2026-09-16 capture sagarin's college-basketball and MLS pages
// are frozen final-ratings pages (asOf 2023-04-03 and 2024-12-07). Age is
// therefore printed per pair so a stale source can never read as live. This
// mirrors the snapshot store's cutoff-based `stale` on read; the threshold is a
// display default, not a data rule - defined, with the age arithmetic, alongside
// the attach-time window in lib/ssb-ratings-recency.js.
function resolveNowMs(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.getTime();
  const parsed = typeof now === 'string' ? Date.parse(now) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * The transport for one adapter: an explicitly injected fetch wins (tests and
 * callers), then the adapter's own client when it needs one (massey's host 403s
 * plain HTTP, so it uses got-scraping), then the ambient fetch.
 */
async function resolveFetch(adapter, context) {
  if (typeof context.injectedFetch === 'function') return context.injectedFetch;
  if (typeof adapter.createFetch === 'function') return adapter.createFetch();
  return context.fetchImpl;
}

/**
 * Fetch, normalize and (unless `save` is false) snapshot ONE source/league
 * pair. Never throws: every failure — an unsupported league, a throwing
 * transport, unreadable content, a refused snapshot write — comes back as a
 * result row, so one bad pair can never abort the batch.
 */
async function refreshPair(adapter, requestedLeague, context) {
  const { now, method, exportUrl, save } = context;
  try {
    const fetchImpl = await resolveFetch(adapter, context);
    const unsupported = adapter.unsupportedReason(requestedLeague);
    if (unsupported) {
      // A league the source does not publish is never fetched: an empty
      // response from it would read like a quiet slate instead of a gap.
      return rowFor(adapter.source, displayLeague(requestedLeague), 'unsupported', {
        coverage: 'unavailable',
        reason: unsupported
      });
    }

    const fetched = await adapter.fetch({ league: requestedLeague, fetchImpl, now, exportUrl });
    const normalized = adapter.normalize({
      raw: fetched.raw,
      league: requestedLeague,
      fetchedAt: fetched.fetchedAt,
      method
    });
    const recordCount = Array.isArray(normalized.records) ? normalized.records.length : 0;
    const ageDays = ageInDays(normalized.asOf, resolveNowMs(now));

    if (normalized.coverage === 'unavailable' || recordCount === 0) {
      return rowFor(adapter.source, normalized.league || displayLeague(requestedLeague), 'unavailable', {
        asOf: normalized.asOf || null,
        fetchedAt: normalized.fetchedAt || null,
        ageDays,
        coverage: normalized.coverage || 'unavailable',
        coverageReason: normalized.coverageReason || null,
        reason: normalized.unresolvedReason || `${adapter.source} published no readable rows`
      });
    }

    const row = rowFor(adapter.source, normalized.league, 'ok', {
      asOf: normalized.asOf || null,
      fetchedAt: normalized.fetchedAt || null,
      ageDays,
      stale: ageDays === null ? null : ageDays > STALE_AFTER_DAYS,
      recordCount,
      coverage: normalized.coverage,
      coverageReason: normalized.coverageReason || null,
      sourceUrl: normalized.sourceUrl || fetched.sourceUrl || null,
      path: null
    });

    if (save) {
      const saved = store.saveSnapshot({
        source: adapter.source,
        league: normalized.league,
        season: normalized.season,
        method: normalized.method,
        asOf: normalized.asOf,
        fetchedAt: normalized.fetchedAt,
        sourceUrl: normalized.sourceUrl || fetched.sourceUrl,
        sourceHash: normalized.sourceHash,
        records: normalized.records
      });
      if (!saved.ok) {
        row.status = 'error';
        row.recordCount = 0;
        // Fail closed: `coverage: 'full'` must never sit beside zero records, and
        // a refused write means nothing is available for this pair. Without this
        // the row read `records=0 coverage=full`, which is the contradiction a
        // reader noticed - and it is what made a benign seasonal page look like
        // an adapter error.
        row.coverage = 'unavailable';
        row.reason = `snapshot not written: ${(saved.errors || []).join('; ')}`;
      } else {
        row.path = saved.path;
      }
    }

    return row;
  } catch (error) {
    return rowFor(adapter.source, displayLeague(requestedLeague), 'error', { reason: reasonOf(error) });
  }
}

/**
 * Fetch, normalize and snapshot every requested source/league pair.
 *
 * @param {{
 *   sources?: string[] | string,
 *   leagues?: string[] | string,
 *   fetchImpl?: Function,
 *   now?: Date | string,
 *   method?: string,
 *   exportUrl?: string,
 *   save?: boolean
 * }} [options]
 * @returns {Promise<{ ok: boolean, results: Array<Record<string, any>>, totals: Record<string, number> }>}
 */
async function refreshRatings(options = {}) {
  const requestedSources = splitList(options.sources);
  const requestedLeagues = splitList(options.leagues);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('refresh-ratings: no fetch implementation available (pass fetchImpl or run on Node >= 20)');
  }
  const context = {
    fetchImpl,
    injectedFetch: options.fetchImpl,
    now: options.now,
    method: options.method,
    exportUrl: options.exportUrl,
    save: options.save !== false
  };
  const sources = requestedSources.length > 0 ? requestedSources : SOURCES;

  const results = [];
  for (const requested of sources) {
    const key = String(requested).trim().toLowerCase();
    const adapter = ADAPTERS[key];
    if (!adapter) {
      results.push(
        rowFor(key, null, 'error', {
          reason: `unknown ratings source: ${requested} (known: ${SOURCES.join(', ')})`
        })
      );
      continue;
    }

    const leagues = requestedLeagues.length > 0 ? requestedLeagues : adapter.supportedLeagues();
    for (const league of leagues) {
      results.push(await refreshPair(adapter, league, context));
    }
  }

  const totals = {
    attempted: results.length,
    ok: results.filter((row) => row.status === 'ok').length,
    unavailable: results.filter((row) => row.status === 'unavailable').length,
    unsupported: results.filter((row) => row.status === 'unsupported').length,
    error: results.filter((row) => row.status === 'error').length
  };

  return { ok: totals.ok > 0, results, totals };
}

/**
 * One human-readable line per source/league plus a totals line. Never prints a
 * payload, only provenance and counts.
 */
function formatSummary(result) {
  const lines = (result.results || []).map((row) => {
    const parts = [
      `${row.source} ${row.league || '-'} ${row.status}`,
      `asOf=${row.asOf || '-'}`,
      `fetchedAt=${row.fetchedAt || '-'}`,
      `records=${row.recordCount}`,
      `coverage=${row.coverage || '-'}`
    ];
    if (typeof row.ageDays === 'number') parts.push(`age=${row.ageDays}d`);
    if (row.stale === true) parts.push('stale=true');
    if (row.path) parts.push(`path=${row.path}`);
    if (row.coverageReason) parts.push(`coverageReason=${row.coverageReason}`);
    if (row.reason) parts.push(`reason=${row.reason}`);
    return parts.join(' ');
  });
  const totals = result.totals || { attempted: 0, ok: 0, unavailable: 0, unsupported: 0, error: 0 };
  lines.push(
    `totals: ${totals.ok}/${totals.attempted} ok (${totals.unavailable} unavailable, ` +
      `${totals.unsupported} unsupported, ${totals.error} error)`
  );
  return lines;
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

// A downstream consumer (e.g. `... | head -5`, or a pager the user quits) can
// close stdout before this script finishes writing its summary. That is not a
// script failure: behave like a native tool stopped by SIGPIPE and exit quietly
// with 0. Any other stdout error is a real I/O failure and must still surface,
// so only EPIPE is special-cased. Same guard as scripts/refresh-tennis-elo.js.
// The MEASURED effect differs by write path, though: that script uses
// `process.stdout.write`, which crashes unhandled, while this one writes via
// `console.log`, which Node's Console swallows when no 'error' listener exists.
// So here the guard turns a spurious exit 1 (e.g. `... | head`) into a clean 0
// rather than suppressing a stack trace. `bin/pp-cli.js` has no equivalent, so
// this is the only guard shape in the repo.
function installStdoutEpipeGuard() {
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  });
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const result = await refreshRatings({
    sources: splitList(flags.source),
    leagues: splitList(flags.league),
    method: typeof flags.method === 'string' ? flags.method : undefined,
    exportUrl: typeof flags['export-url'] === 'string' ? flags['export-url'] : undefined,
    now: new Date()
  });

  if (flags.json === true) {
    console.log(JSON.stringify({ results: result.results, totals: result.totals }, null, 2));
  } else {
    for (const line of formatSummary(result)) console.log(line);
  }

  return result.ok ? 0 : 1;
}

if (require.main === module) {
  // Installed only when this file IS the entry point, unlike
  // refresh-tennis-elo.js which arms it at module load: this module is
  // `require`d by test/refresh-ratings.test.js, and arming a process-wide
  // stdout handler (one that calls process.exit) inside the test runner would
  // be a side effect on unrelated output. The guard still protects every real
  // invocation, which is where a closed stdout can happen.
  installStdoutEpipeGuard();
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error && error.stack ? error.stack : String(error));
      process.exitCode = 1;
    });
}

module.exports = { SOURCES, ADAPTERS, refreshRatings, formatSummary, parseArgs, main };
