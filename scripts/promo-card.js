'use strict';

/**
 * Build the best qualifying card for a stake-capped profit boost.
 *
 * Usage:
 *   node scripts/promo-card.js --from <scan.json> --boost 40 --stake 10 --min-odds 300 --legs 4
 *   node scripts/promo-card.js --boost 40 --stake 10 --min-odds 300        # runs a fresh scan
 *
 * Input is a `pp scan -j` capture (or a fresh scan when --from is omitted). Only legs with
 * a DEVIGGED fair probability are used: ranking on implied probability would just re-rank
 * by price, and the whole point is that a stake-capped boost's EV is nearly flat in price,
 * so the card should be chosen on how likely it is to WIN.
 *
 * A card here is a CANDIDATE. Verify every leg is live, same-line and accepted at the
 * venue before placing; nothing in this path submits anything.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { enumerateCards, boostFactor } = require('../lib/promo-eval');

const SCAN_TIMEOUT_MS = 300000;

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
  console.log(`promo-card — best qualifying card for a stake-capped profit boost

Flags:
  --boost <pct>      Profit boost percent (40 means profit x1.40). REQUIRED.
  --stake <n>        Stake cap. Default: 10
  --min-odds <n>     Promo's minimum parlay price, American. Default: 300
  --legs <n>         Minimum legs. Default: 4
  --from <file>      Read a saved \\\`pp scan -j\\\` capture instead of scanning live
  --book <name>      Book for a live scan. Default: DraftKings
  --json             Machine-readable output
  --help             This message

Example:
  pp scan -b DraftKings --card-window today -n 150 -j > /tmp/scan.json
  node scripts/promo-card.js --from /tmp/scan.json --boost 40 --stake 10 --min-odds 300 --legs 4`);
}

/** Odds -> decimal, matching promo-eval. Kept local so this file has no hidden coupling. */
const dec = (o) => (Number(o) > 0 ? 1 + Number(o) / 100 : 1 + 100 / Math.abs(Number(o)));

/** Fair probability for a scan play: sharp-anchored first, then all-books. */
function fairOf(play) {
  const snapshot = play.featureSnapshot || {};
  for (const value of [
    snapshot.sharpMarketFairProbability,
    play.sharpMarketFairProbability,
    snapshot.marketFairProbability,
    play.marketFairProbability
  ]) {
    const p = Number(value);
    if (value != null && Number.isFinite(p) && p > 0 && p < 1) return { p, source: 'sharp' };
  }
  return null;
}

/** Pull usable legs out of a `pp scan -j` payload (results[].plays[]). */
function legsFromScanPayload(payload) {
  const legs = [];
  for (const group of (payload && payload.results) || []) {
    for (const play of group.plays || []) {
      const odds = Number(play.odds);
      if (!Number.isFinite(odds) || odds === 0) continue;
      const fair = fairOf(play);
      if (!fair) continue;
      legs.push({
        gameId: play.gameId || play.game || play.playId || null,
        game: play.game || `${play.awayTeam || '?'} vs ${play.homeTeam || '?'}`,
        league: group.league || play.league || null,
        market: group.market || play.market || null,
        selection: play.selection || play.participant || null,
        odds,
        fairProbability: fair.p
      });
    }
  }
  return legs;
}

function loadScan(flags) {
  if (flags.from) {
    const raw = fs.readFileSync(String(flags.from), 'utf8');
    // `pp ... -j` stdout carries progress lines before the payload.
    return JSON.parse(raw.slice(raw.indexOf('{')));
  }
  const cli = path.join(__dirname, '..', 'bin', 'pp-cli.js');
  const book = flags.book || 'DraftKings';
  const stdout = execFileSync(
    process.execPath,
    [cli, 'scan', '-b', book, '--card-window', 'today', '-n', '150', '-j'],
    {
      encoding: 'utf8',
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

function formatReport(result, { boostPct, stake, minOdds, minLegs }) {
  const out = [];
  out.push(`promo: ${boostPct}% profit boost | stake cap ${stake} | min price +${minOdds} | min ${minLegs} legs`);
  out.push('');
  out.push(`CEILING at fair prices: ${result.ceiling == null ? 'n/a' : result.ceiling.toFixed(2)}`);
  out.push(
    `  (this is arithmetic, not an estimate — a stake-capped boost is worth S*(k-1)*(1-1/d),` +
      ` so the longest card is NOT the best card. Ranked on win probability instead.)`
  );
  out.push('');
  out.push(`legs available: ${result.distinctGames} distinct game(s) | qualifying cards: ${result.qualifying}`);
  if (result.truncated)
    out.push('  [!] combination search truncated — raise --min-legs specificity or narrow the slate');
  out.push('');

  if (!result.best) {
    out.push('NO QUALIFYING CARD.');
    out.push(`  No combination of ${minLegs} legs from distinct games reaches +${minOdds}.`);
    out.push('  Do not pad with a leg from a game already on the card — those legs are');
    out.push('  correlated and the probability product would overstate the win chance.');
    return out.join('\n');
  }

  for (const [i, card] of result.top.entries()) {
    out.push(
      `${i === 0 ? 'RECOMMENDED' : `Alternative ${i}`} — parlay +${card.american}   P(win) = ${(card.pWin * 100).toFixed(1)}%`
    );
    for (const leg of card.legs) {
      out.push(
        `   ${String(leg.odds).padStart(6)}  ${String(leg.league || '').padEnd(7)} ${String(leg.market || '').padEnd(14)} ${String(leg.selection).slice(0, 26).padEnd(27)} p=${(leg.fairProbability * 100).toFixed(1)}%`
      );
      out.push(`            ${leg.game}`);
    }
    out.push(
      `   stake ${card.stake.toFixed(2)} -> win ${card.profit.toFixed(2)} profit | lose ${card.stake.toFixed(2)} (${((1 - card.pWin) * 100).toFixed(1)}% of the time)`
    );
    out.push(`   EV ${card.ev >= 0 ? '+' : ''}${card.ev.toFixed(2)}  (${card.evPctOfStake.toFixed(0)}% of stake)`);
    out.push('');
  }
  out.push('A card is a CANDIDATE, and the ranking is model-only — the matchup pass is NOT included.');
  out.push("Before placing, check every leg's starters/lineups/venue against the price. Tonight a total");
  out.push('ranked 2nd-best here sat behind two starters carrying 5.40+ ERAs, which the price alone');
  out.push("does not tell you. If a leg's matchup contradicts it, drop it or re-price the card and");
  out.push('say what EV that costs. Then verify every leg is live, same-line and accepted.');
  return out.join('\n');
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return 0;
  }
  const boostPct = Number(flags.boost);
  if (boostFactor(boostPct) == null) {
    console.error('--boost is required (e.g. --boost 40). Use --help for usage.');
    return 2;
  }
  const stake = Number.isFinite(Number(flags.stake)) ? Number(flags.stake) : 10;
  const minOdds = Number.isFinite(Number(flags['min-odds'])) ? Number(flags['min-odds']) : 300;
  const minLegs = Number.isFinite(Number(flags.legs)) ? Number(flags.legs) : 4;
  const minDecimal = dec(minOdds);

  const payload = loadScan(flags);
  const legs = legsFromScanPayload(payload);
  const result = enumerateCards(legs, { minLegs, minDecimal, stake, boostPct });

  if (flags.json) {
    console.log(JSON.stringify({ boostPct, stake, minOdds, minLegs, legs: legs.length, ...result }, null, 2));
  } else {
    console.log(formatReport(result, { boostPct, stake, minOdds, minLegs }));
  }
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main, parseArgs, legsFromScanPayload, fairOf, dec, formatReport };
