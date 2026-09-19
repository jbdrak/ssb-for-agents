'use strict';
/**
 * LEAK TEST, done properly.
 *
 * The edge comes ENTIRELY from the starter-ERA term ("ERA only" -> +6.62pts, +10.46% ROI;
 * "strength only" -> +0.16pts, no edge). No model built on starting-pitcher ERA beats an
 * MLB closing line by 6.6 points. So either the ERA is leaking, or this is the greatest
 * baseball model ever built. Test which.
 *
 * The specific question: for a given pitcher in a given SEASON, is the ERA attached to his
 * starts the as-of-that-date value (fine), or the season-FINAL value served retroactively
 * (a leak that hands the model the rest of the season)?
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const DATA_DIR = process.env.SSB_MLB_DATA || path.join(os.homedir(), '.ssb-for-agents', 'mlb');

const { buildWalkForwardRows } = require('../lib/team-model');

const SEASONS = ['2023', '2024', '2025'];
const rows = [];
for (const s of SEASONS) {
  for (const r of buildWalkForwardRows(JSON.parse(fs.readFileSync(`${DATA_DIR}/season-${s}.json`, 'utf8')))) {
    rows.push({ season: s, r });
  }
}

console.log("=== LEAK TEST: ESPN's retroactive season-final ERA ===");
console.log('');
console.log("HISTORICAL FINDING (2026-09-18): ESPN's scoreboard attached the starting pitcher's");
console.log('SEASON-FINAL ERA to every game he started, all season long. Across 705 pitcher-seasons,');
console.log('705 showed an identical ERA on every start and 0 varied (Miles Mikolas: 36 starts,');
console.log('2023-03-30 to 2023-10-01, every one 4.78; Gerrit Cole 2023: every start 2.63).');
console.log('A model using it reads the rest of the season, and it produced a fake +6.62pt edge and');
console.log('+10.46% ROI from that term alone.');
console.log('');
console.log('The field is no longer collected at all. This check now ASSERTS that.');
console.log('');

let leaked = 0;
let checked = 0;
for (const s of SEASONS) {
  for (const g of JSON.parse(fs.readFileSync(`${DATA_DIR}/season-${s}.json`, 'utf8'))) {
    for (const side of ['home', 'away']) {
      checked += 1;
      if ('starterEra' in g[side]) leaked += 1;
    }
  }
}
console.log(`  team-sides checked in the collected data : ${checked}`);
console.log(`  carrying a 'starterEra' field (a LEAK)  : ${leaked}`);
console.log('');
if (leaked === 0) {
  console.log('  PASS: the leaking field is not collected. The model builds its starter signal');
  console.log('        from this dataset instead (runs allowed by his team in prior starts),');
  console.log('        which is knowable at first pitch.');
} else {
  console.log('  FAIL: the leaking field is present again. Remove it from the collector.');
  process.exitCode = 1;
}
