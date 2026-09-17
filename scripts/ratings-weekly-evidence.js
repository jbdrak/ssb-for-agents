#!/usr/bin/env node
'use strict';

/**
 * ratings-weekly-evidence.js — the weekly turn of the evidence loop.
 *
 * A ratings snapshot records what a source predicted BEFORE its games were
 * played, and it is the retained copy (not the overwritten latest file) that
 * survives to be scored. This script does the whole turn in one place:
 *
 *   1. refresh the snapshots, which is also what RETAINS this week's copy;
 *   2. for every retained week whose games have since been played, settle its
 *      fixtures from ESPN and score it through `pp ratings --evaluate`;
 *   3. print a compact report.
 *
 * Without a cadence the loop does not turn at all: retention only accumulates on
 * a refresh, and a week is only scoreable after its games finish.
 *
 * Stateless on purpose. Re-running re-derives the same numbers from the same
 * retained snapshots and the same ESPN results, so there is no cursor to corrupt
 * and a missed week is picked up on the next run.
 *
 * Usage:
 *   node scripts/ratings-weekly-evidence.js
 *   node scripts/ratings-weekly-evidence.js --no-refresh   # score only
 *   node scripts/ratings-weekly-evidence.js --verbose
 *
 * @module scripts/ratings-weekly-evidence
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

const { listSnapshotHistory, loadSnapshotAt } = require('../lib/ssb-ratings-snapshot');
const { buildCfbOutcomeIndex, matchCfbOutcomes } = require('../lib/cfb-outcomes');
const { addDays, dateRange, fetchScoreboard } = require('./resolve-ratings-outcomes');

const LEAGUE = 'NCAAF';
const SOURCES = ['massey', 'sagarin', 'sasser'];
// A game must be finished before its result is used, and a week stops being
// re-scored once it is old enough that nothing new can settle.
const MIN_AGE_DAYS = 2;
const MAX_AGE_DAYS = 35;
// How far past a snapshot's `asOf` its fixtures can be. A source publishes its
// prediction block for the coming week, so this is the following slate.
const WINDOW_DAYS = 10;
// Below this, a calibration number is reported as a small sample rather than
// presented as if it settled anything.
const MIN_SAMPLE = 30;

const today = () => new Date().toISOString().slice(0, 10);

function stampOf(snapshot) {
  return snapshot.asOf ? String(snapshot.asOf).slice(0, 10) : snapshot.stamp;
}

function parseArgs(argv) {
  const flags = {};
  for (const token of argv) {
    if (token.startsWith('--')) flags[token.slice(2)] = true;
  }
  return flags;
}

/** Refresh the snapshots. Failure is reported, never fatal: scoring is the point. */
function refresh() {
  try {
    const out = execFileSync(
      'node',
      ['scripts/refresh-ratings.js', '--source', SOURCES.join(','), '--league', LEAGUE],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }
    );
    const totals = /totals:.*/.exec(out);
    return { ok: true, summary: totals ? totals[0].trim() : 'refresh completed' };
  } catch (error) {
    const first = String((error && error.message) || 'unknown error').split('\n')[0];
    return { ok: false, summary: `refresh failed: ${first}` };
  }
}

/** Retained weeks old enough to have been played, newest first. */
function eligibleWeeks(history) {
  const floor = addDays(today(), -MAX_AGE_DAYS);
  const ceiling = addDays(today(), -MIN_AGE_DAYS);
  return history
    .filter((snapshot) => snapshot.valid && snapshot.league === LEAGUE && SOURCES.includes(snapshot.source))
    .filter((snapshot) => {
      const stamp = stampOf(snapshot);
      return stamp >= floor && stamp <= ceiling;
    })
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || a.source.localeCompare(b.source));
}

/** Fetch every board day ONCE, then build a per-week index from the cached events. */
async function fetchByDate(dates, verbose) {
  const byDate = new Map();
  for (const date of dates) {
    try {
      byDate.set(date, await fetchScoreboard(date));
    } catch {
      byDate.set(date, []);
      if (verbose) console.error(`  ! ESPN scoreboard ${date} unavailable`);
    }
  }
  return byDate;
}

/** Score one retained week. Returns null when nothing has settled yet. */
function scoreWeek(snapshot, index) {
  const stamp = stampOf(snapshot);
  const loaded = loadSnapshotAt(snapshot.source, snapshot.league, snapshot.season, stamp);
  if (!loaded.ok || !loaded.snapshot) return { stamp, error: 'retained snapshot unreadable' };

  const result = matchCfbOutcomes(loaded.snapshot.records, index);
  if (result.matched === 0) {
    return { stamp, fixtures: loaded.snapshot.records.length, matched: 0, pending: true, reasons: result.reasons };
  }

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-week-')), 'outcomes.json');
  fs.writeFileSync(tmp, JSON.stringify({ outcomes: result.outcomes }));
  try {
    const raw = execFileSync(
      'node',
      [
        'bin/pp-cli.js',
        'ratings',
        '--evaluate',
        '--source',
        snapshot.source,
        '--league',
        LEAGUE,
        '--as-of',
        stamp,
        '--outcomes',
        tmp,
        '-j'
      ],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }
    );
    const report = JSON.parse(raw);
    const scored = report.scores[snapshot.source] || null;
    return {
      stamp,
      fixtures: loaded.snapshot.records.length,
      matched: result.matched,
      coverage: scored ? scored.coverage : null,
      scores: scored ? scored.scores : null,
      probability: (report.sources[snapshot.source] || {}).probability || null,
      reasons: result.reasons
    };
  } catch (error) {
    const first = String((error && error.message) || 'unknown error').split('\n')[0];
    return { stamp, error: `evaluate failed: ${first}` };
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

function formatMetric(value) {
  return typeof value === 'number' ? value.toFixed(4) : 'n/a';
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const verbose = flags.verbose === true;

  const lines = [];
  if (flags['no-refresh'] !== true) {
    const refreshed = refresh();
    lines.push(`refresh: ${refreshed.summary}`);
  }

  const history = listSnapshotHistory();
  if (!history.ok) {
    console.log(`SSB ratings evidence — ${today()}\nretained snapshot store unreadable`);
    return;
  }

  const weeks = eligibleWeeks(history.snapshots);
  if (weeks.length === 0) {
    console.log(
      [
        `SSB ratings evidence — ${today()}`,
        ...lines,
        'no retained week is old enough to score yet (a week is scoreable from',
        `${MIN_AGE_DAYS} days after its games; retention begins at the first refresh).`
      ].join('\n')
    );
    return;
  }

  // One ESPN fetch per board day across every week's window, then a separate
  // index per week: a wide shared span would list a pairing twice and be refused
  // as ambiguous, which is correct behavior but would blind the whole report.
  const windowOf = (week) => {
    const stamp = stampOf(week);
    return dateRange(addDays(stamp, 1), addDays(stamp, WINDOW_DAYS)) || [];
  };
  const allDates = [...new Set(weeks.flatMap(windowOf))].sort();
  const byDate = await fetchByDate(allDates, verbose);

  const results = [];
  for (const week of weeks) {
    const events = windowOf(week).flatMap((date) => byDate.get(date) || []);
    results.push({ source: week.source, ...scoreWeek(week, buildCfbOutcomeIndex(events, LEAGUE)) });
  }

  const scored = results.filter((row) => !row.error && !row.pending);
  const pending = results.filter((row) => row.pending);
  const failed = results.filter((row) => row.error);

  const out = [`SSB ratings evidence — ${today()}`];
  if (lines.length) out.push(...lines);
  out.push(`retained weeks scored: ${scored.length}  awaiting results: ${pending.length}  failed: ${failed.length}`);

  if (scored.length) {
    out.push('', 'scored');
    for (const row of scored) {
      const sample = row.coverage ? row.coverage.sampleSize : 0;
      const small = sample > 0 && sample < MIN_SAMPLE ? ' (small sample)' : '';
      out.push(
        `  ${row.source} asOf=${row.stamp} fixtures=${row.fixtures} settled=${row.matched} sample=${sample}${small}`
      );
      if (row.scores && row.scores.modelWinProbability) {
        const m = row.scores.modelWinProbability;
        out.push(
          `      brier=${formatMetric(m.brier && m.brier.value)} logLoss=${formatMetric(m.logLoss && m.logLoss.value)}`
        );
      } else if (row.probability && !row.probability.available) {
        out.push(`      no probability: ${row.probability.reason}`);
      } else if (sample > 0) {
        out.push('      no probability-carrying record to score');
      }
    }
  }

  if (pending.length) {
    out.push('', 'awaiting results');
    for (const row of pending) {
      const reasons = Object.entries(row.reasons || {})
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}=${count}`)
        .join(' ');
      out.push(`  ${row.source} asOf=${row.stamp} fixtures=${row.fixtures} ${reasons}`);
    }
  }

  if (failed.length) {
    out.push('', 'failed');
    for (const row of failed) out.push(`  ${row.source} asOf=${row.stamp} ${row.error}`);
  }

  console.log(out.join('\n'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ratings-weekly-evidence: ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = { eligibleWeeks, stampOf, MIN_SAMPLE };
