'use strict';
/**
 * FADE THE MOVE — testing a documented, peer-reviewed finding.
 *
 * Simon (2024), Management Science 70(12): "Inefficient Forecasts at the Sportsbook". Over 3,681
 * MLB games and four sportsbooks he finds that "betting lines tend to OVERREACT, exhibiting
 * significant NEGATIVELY AUTOCORRELATED changes", and documents a strategy returning 10-13%:
 * bet the team whose price has DECREASED when the line moved more than a threshold late in the
 * day. That is FADING the move -- the opposite of steam-following, which I tested and which
 * failed.
 *
 * WHAT I CAN AND CANNOT REPRODUCE. The paper's effect is specific to movement in the LAST 90
 * MINUTES before weekend day games. I do not have intraday ticks -- only OPEN and CLOSE. So I
 * test the BROADER claim (negatively autocorrelated line changes) on the open->close move, and
 * separately restrict to weekend day games, which is the paper's condition. The broad version
 * is expected to be weaker than the paper's; if it works at all, that is informative.
 *
 * Directions are tested BOTH ways and reported, because testing one and calling it a result
 * would be dishonest. Note the multiple-testing cost: the paper itself ran 120 strategies.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { americanToProb, devigPrices, payout } = require('../lib/team-model');

const DATA_DIR = process.env.SSB_DATA_DIR || path.join(os.homedir(), '.ssb-for-agents', 'data');
const THRESHOLDS = [0.005, 0.01, 0.015, 0.02, 0.03];

function load(league, seasons) {
  const out = [];
  for (const s of seasons) {
    const f = path.join(DATA_DIR, `${league}-${s}.json`);
    if (!fs.existsSync(f)) continue;
    for (const g of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const o = g.odds || {};
      const open = devigPrices(o.homeOpen, o.awayOpen);
      const close = devigPrices(o.homeClose, o.awayClose);
      if (!open || !close) continue;
      if (o.homeClose == null || o.awayClose == null) continue;
      const start = new Date(g.startDate);
      const day = start.getUTCDay(); // 0 Sun .. 6 Sat
      const hourUTC = start.getUTCHours();
      out.push({
        league,
        season: s,
        eventId: g.eventId,
        // Movement in home win probability from open to close.
        move: close.home - open.home,
        openHome: open.home,
        closeHome: close.home,
        homeCloseMl: o.homeClose,
        awayCloseMl: o.awayClose,
        homeWon: g.home.score > g.away.score,
        // The paper's condition: weekend DAY games (Sat/Sun, daytime US start).
        weekendDay: (day === 0 || day === 6) && hourUTC >= 15 && hourUTC <= 21
      });
    }
  }
  return out;
}

/** Fade: bet the side the line moved AGAINST (whose win probability fell). */
function fadeSide(r) {
  if (Math.abs(r.move) < 1e-9) return null;
  return r.move < 0 ? 'home' : 'away'; // home prob fell => bet home
}
/** Follow: bet the side the line moved TOWARD. */
function followSide(r) {
  if (Math.abs(r.move) < 1e-9) return null;
  return r.move > 0 ? 'home' : 'away';
}

function run(rows, sideFn, threshold, label) {
  let n = 0;
  let wins = 0;
  let pnl = 0;
  let impliedSum = 0;
  const returns = [];
  for (const r of rows) {
    if (Math.abs(r.move) < threshold) continue;
    const side = sideFn(r);
    if (!side) continue;
    const ml = Number(side === 'home' ? r.homeCloseMl : r.awayCloseMl);
    const raw = americanToProb(ml);
    if (raw == null) continue;
    const won = side === 'home' ? r.homeWon : !r.homeWon;
    n += 1;
    impliedSum += raw;
    if (won) {
      wins += 1;
      pnl += payout(ml);
    } else pnl -= 1;
    returns.push(won ? payout(ml) : -1);
  }
  if (!n) return null;
  const hit = wins / n;
  const implied = impliedSum / n;
  const se = Math.sqrt((implied * (1 - implied)) / n);
  const roi = pnl / n;
  const mean = roi;
  const v = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1);
  const roiSe = Math.sqrt(v / n);
  return { label, n, hit, implied, z: (hit - implied) / se, roi, roiSe };
}

function report(rows, sideFn, name) {
  console.log('');
  console.log(`--- ${name} ---`);
  console.log('  thresh   bets    hit      implied   z       ROI      +/-1se');
  for (const t of THRESHOLDS) {
    const s = run(rows, sideFn, t, name);
    if (!s) continue;
    console.log(
      `  ${t.toFixed(3)}   ${String(s.n).padStart(5)}   ${(s.hit * 100).toFixed(1)}%   ${(s.implied * 100).toFixed(1)}%   ` +
        `${s.z >= 0 ? '+' : ''}${s.z.toFixed(2)}   ${s.roi >= 0 ? '+' : ''}${(s.roi * 100).toFixed(2)}%   ${(s.roiSe * 100).toFixed(2)}%`
    );
  }
}

const MLB = load('mlb', ['2023', '2024', '2025']);
const CFB = load('college-football', ['2021', '2022', '2023', '2024', '2025']);
console.log(`loaded ${MLB.length} MLB games, ${CFB.length} CFB games with open+close moneylines`);
console.log(
  `weekend day games: MLB ${MLB.filter((r) => r.weekendDay).length}, CFB ${CFB.filter((r) => r.weekendDay).length}`
);

// Sanity: how big are the moves, and is movement actually autocorrelated?
const meanAbs = (a) => a.reduce((s, r) => s + Math.abs(r.move), 0) / a.length;
console.log(
  `mean |open->close move|: MLB ${(meanAbs(MLB) * 100).toFixed(2)}pts, CFB ${(meanAbs(CFB) * 100).toFixed(2)}pts`
);

console.log('');
console.log('=== FADE THE MOVE (Simon 2024) — bet the side the line moved AGAINST ===');
report(MLB, fadeSide, 'MLB fade, all games');
report(
  MLB.filter((r) => r.weekendDay),
  fadeSide,
  'MLB fade, weekend day games (paper condition)'
);
report(CFB, fadeSide, 'CFB fade, all games');

console.log('');
console.log('=== FOLLOW THE MOVE — the opposite, for comparison ===');
report(MLB, followSide, 'MLB follow, all games');
report(CFB, followSide, 'CFB follow, all games');

// Cross-season stability for the best-looking configuration, which is the real test.
console.log('');
console.log('=== CROSS-SEASON STABILITY (fade, MLB, threshold 0.01) ===');
for (const s of ['2023', '2024', '2025']) {
  const sub = MLB.filter((r) => r.season === s);
  const r = run(sub, fadeSide, 0.01, s);
  if (r) {
    console.log(
      `  ${s}  n=${String(r.n).padStart(4)}  hit ${(r.hit * 100).toFixed(1)}%  implied ${(r.implied * 100).toFixed(1)}%  z ${r.z.toFixed(2)}  ROI ${r.roi >= 0 ? '+' : ''}${(r.roi * 100).toFixed(2)}%`
    );
  }
}

console.log('');
console.log('Reading this: a real edge needs positive ROI that survives cross-season and a z well');
console.log('clear of 2. With 5 thresholds x 2 directions x 2 leagues = 20 tests, ONE nominal hit is');
console.log('expected by chance. The paper itself ran 120 strategies and noted this.');
