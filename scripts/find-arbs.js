'use strict';

/**
 * Find cross-venue arbitrage across the full ranked market.
 *
 * WHY A SCRIPT AND NOT PART OF `pp scan`
 *
 * `arbMarginPct` is recorded on every candidate, but candidates are a BIASED subset: the
 * scan ranks on movement and EV, not on price disagreement, so an arbitrage is filtered
 * out long before it is recorded (measured live: 138/138 candidates carried the field, 0
 * were arbitrageable). Finding arbs for real needs the FULL ranked market, before the
 * card filter.
 *
 * `pp rank <league> -j` already returns that: its rows carry `allBookOdds` (the per-book
 * two-sided price map) which `pp scan`'s output strips. So this tool reuses the existing
 * CLI rather than reimplementing auth, retries, rate limiting, or the screen parser, and
 * needs no change to `bin/pp-cli.js` — which sits at its `max-lines` cap.
 *
 * WHAT THIS IS NOT
 *
 * Detection is arithmetic; execution is not. A reported opportunity is a CANDIDATE that
 * must be verified as live, same-line and actually accepted at BOTH venues before any
 * money moves — stake limits, rejection, line movement between legs, differing settlement
 * rules, palpable-error voids and account limiting all eat the margin. Nothing here places
 * a bet.
 *
 * Usage:
 *   node scripts/find-arbs.js [--leagues MLB,NBA,...] [--book NoVigApp] [--limit 100]
 *                             [--min-margin 0.25] [--json] [--from <rank.json>] [--help]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findArbs, rowsFromRankOutput, DEFAULT_MIN_ARB_MARGIN_PCT } = require('../lib/arb-scan');

const DEFAULT_BOOK = 'NoVigApp';
const DEFAULT_LIMIT = 100;
const DEFAULT_LEAGUES = ['MLB', 'WNBA', 'NCAAF', 'NFL', 'NHL', 'NBA', 'Tennis', 'Soccer', 'MLS', 'UFC'];
/** Per-league wall clock for the underlying `pp rank` call. */
const RANK_TIMEOUT_MS = 240000;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'help' || key === 'json') {
      flags[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function printHelp() {
  console.log(`pp find-arbs — cross-venue arbitrage across the full ranked market

Usage:
  node scripts/find-arbs.js [flags]

Flags:
  --leagues <A,B,...>   Leagues to check. Default: ${DEFAULT_LEAGUES.join(',')}
  --book <name>         Focus book for the underlying rank call. Default: ${DEFAULT_BOOK}
  --limit <N>           Max ranked rows per league. Default: ${DEFAULT_LIMIT}
  --min-margin <pct>    Ignore margins below this, in percentage points. Default: ${DEFAULT_MIN_ARB_MARGIN_PCT}
  --from <file>         Analyse a saved \`pp rank -j\` capture instead of calling live
  --json                Machine-readable output
  --help                This message

An opportunity is a CANDIDATE: verify both legs are live and accepted before betting.`);
}

/** Run `pp rank` for one league and return its parsed rows (never throws). */
function fetchRows(league, book, limit) {
  const cli = path.join(__dirname, '..', 'bin', 'pp-cli.js');
  try {
    const stdout = execFileSync(
      process.execPath,
      [cli, 'rank', league, '-b', book, '--all-markets', '-n', String(limit), '-j'],
      { encoding: 'utf8', timeout: RANK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { league, rows: rowsFromRankOutput(stdout), error: null };
  } catch (error) {
    // A league with no slate, or a transient API failure, must not abort the sweep:
    // the remaining leagues are independent and still worth checking.
    return { league, rows: [], error: error && error.message ? error.message : String(error) };
  }
}

function formatReport({ opportunities, examined, minMarginPct, perLeague, skipped }) {
  const out = [];
  out.push(`examined ${examined} ranked row(s) across ${perLeague.length} league(s)`);
  out.push(`min margin ${minMarginPct}%`);
  out.push('');
  if (!opportunities.length) {
    out.push('NO ARBITRAGE FOUND.');
    out.push('  This is the expected result: sportsbooks track the same market, so an arb');
    out.push('  between two of them is rare. The documented pattern is bookmaker vs');
    out.push('  EXCHANGE, so a missing exchange in the book set limits what can be found.');
    out.push('  Sharp alone is not the same as an exchange: a book whose prices simply');
    out.push('  follow the market will almost never disagree enough to arb.');
  } else {
    out.push(`${opportunities.length} CANDIDATE(S) — verify both legs are live and accepted:`);
    for (const arb of opportunities) {
      const flags = [
        arb.suspicious ? ' [SUSPICIOUS — likely a data error, not an edge]' : '',
        arb.sameBook ? ' [same-book]' : ''
      ].join('');
      out.push('');
      out.push(`  ${arb.marginPct.toFixed(2)}%  ${arb.league} ${arb.market}${flags}`);
      out.push(`    ${arb.game || ''}`);
      out.push(`    back ${arb.selection1} @ ${arb.side1.odds} (${arb.side1.book})`);
      out.push(`    back ${arb.selection2} @ ${arb.side2.odds} (${arb.side2.book})`);
      out.push(
        `    split stakes ${(arb.stakeSplit.side1 * 100).toFixed(1)}% / ${(arb.stakeSplit.side2 * 100).toFixed(1)}%`
      );
    }
    out.push('');
    out.push('  margin is measured against the PAYOUT; return on stake is stake/(1-margin).');
  }
  if (skipped.length) {
    out.push('');
    out.push(`skipped league(s) (no slate or API error): ${skipped.map((s) => s.league).join(', ')}`);
  }
  return out.join('\n');
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return 0;
  }

  const book = flags.book || DEFAULT_BOOK;
  const limit = Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : DEFAULT_LIMIT;
  const minMarginPct = Number.isFinite(Number(flags['min-margin']))
    ? Number(flags['min-margin'])
    : DEFAULT_MIN_ARB_MARGIN_PCT;
  const leagues = flags.leagues
    ? String(flags.leagues)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_LEAGUES;

  let rows = [];
  const perLeague = [];
  const skipped = [];

  if (flags.from) {
    // Offline path: analyse an already-captured rank payload. Deterministic, no network.
    const text = fs.readFileSync(flags.from, 'utf8');
    rows = rowsFromRankOutput(text);
    perLeague.push({ league: path.basename(String(flags.from)), rows: rows.length });
  } else {
    for (const league of leagues) {
      const result = fetchRows(league, book, limit);
      if (result.error) skipped.push(result);
      else perLeague.push({ league, rows: result.rows.length });
      rows = rows.concat(result.rows);
    }
  }

  const report = findArbs(rows, { minMarginPct });
  const document = {
    book,
    limit,
    leagues: perLeague,
    skipped: skipped.map((s) => ({ league: s.league, error: s.error })),
    ...report
  };

  if (flags.json) console.log(JSON.stringify(document, null, 2));
  else console.log(formatReport(report && { ...report, perLeague, skipped }));
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main, parseArgs, fetchRows, formatReport, DEFAULT_LEAGUES };
