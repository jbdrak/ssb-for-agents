'use strict';
/**
 * Collect MLB game data for a season: results, starting pitchers, and OPEN + CLOSE moneylines.
 *
 * Sources (both public, no key):
 *   - site.api.espn.com scoreboard  -> teams, final scores, probable starters
 *   - sports.core.api.espn.com odds -> open and close moneylines per event
 *
 * Cached to disk so the model can be re-run without refetching. The cache is keyed by date
 * and event id, so re-running is cheap and idempotent.
 *
 * DELIBERATELY NOT COLLECTED: the probable starter's ERA. ESPN serves the pitcher's
 * SEASON-FINAL ERA on every game he started, all season long -- verified across 705
 * pitcher-seasons, 705 identical, 0 varying (Miles Mikolas: 36 starts, all 4.78). Feeding
 * that to a model hands it the rest of the season and manufactures a fake edge. Only the
 * starter's ID is kept; the model derives a walk-forward signal from the games themselves.
 *
 * Usage: node scripts/mlb-collect.js [--start 2025-03-27] [--end 2025-09-28] [--out <dir>]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const START = arg('start', '2025-03-27');
const END = arg('end', '2025-09-28');
const OUT_DIR = arg('out', path.join(os.homedir(), '.ssb-for-agents', 'mlb'));
const CONCURRENCY = Number(arg('concurrency', '6'));

const CACHE = path.join(OUT_DIR, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const dates = [];
for (let d = new Date(`${START}T12:00:00Z`); d <= new Date(`${END}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
  dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
}

/** ESPN returns `moneyLine` either as a number/string or as an object with `alternateDisplayValue`. */
const moneyLine = (ml) => {
  if (ml == null) return null;
  if (typeof ml === 'object') return ml.alternateDisplayValue ?? ml.american ?? null;
  return ml;
};

async function fetchDay(date) {
  const file = path.join(CACHE, `sb-${date}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${date}`);
  if (!res.ok) return [];
  const json = await res.json();
  const games = (json.events || [])
    .map((ev) => {
      const comp = ev.competitions[0];
      const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
      const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
      if (!home || !away) return null;
      const side = (c) => ({
        id: c.team?.id,
        name: c.team?.displayName,
        abbr: c.team?.abbreviation,
        score: c.score != null ? Number(c.score) : null,
        winner: c.winner === true,
        starterId: c.probables?.[0]?.athlete?.id ?? null,
        starterName: c.probables?.[0]?.athlete?.fullName ?? null
      });
      return {
        eventId: ev.id,
        date,
        startDate: comp.startDate,
        completed: comp.status?.type?.completed === true,
        home: side(home),
        away: side(away)
      };
    })
    .filter(Boolean);
  fs.writeFileSync(file, JSON.stringify(games));
  return games;
}

async function fetchOdds(game) {
  const file = path.join(CACHE, `od-${game.eventId}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/${game.eventId}/competitions/${game.eventId}/odds`;
  let out = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      // ESPN returns several items, including a "Live Odds" placeholder whose moneyline is
      // literally 0. Keep only items with both sides priced, and take the first.
      const items = (json.items || []).filter((i) => i.homeTeamOdds && i.awayTeamOdds);
      const it = items[0];
      if (it) {
        out = {
          provider: it.provider?.name ?? null,
          homeOpen: moneyLine(it.homeTeamOdds?.open?.moneyLine),
          homeClose: moneyLine(it.homeTeamOdds?.close?.moneyLine) ?? moneyLine(it.homeTeamOdds?.moneyLine),
          awayOpen: moneyLine(it.awayTeamOdds?.open?.moneyLine),
          awayClose: moneyLine(it.awayTeamOdds?.close?.moneyLine) ?? moneyLine(it.awayTeamOdds?.moneyLine),
          details: it.details ?? null
        };
      }
    }
  } catch {
    out = null;
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    })
  );
}

(async () => {
  console.log(`collecting ${dates.length} days ${START}..${END} -> ${OUT_DIR}`);
  // Each worker stores its own result and the accumulation happens ONCE, after the pool
  // drains. The obvious `games = games.concat(await fetchDay(d))` inside the worker is a
  // lost-update race: JS evaluates the `games` reference BEFORE the await (member expression
  // first, then arguments), so every concurrent worker concats onto a stale array and the
  // last write wins. With a warm cache the reads resolve instantly and the loss is severe --
  // it silently dropped 2,463 games down to 403.
  const byDate = new Map();
  let done = 0;
  await pool(dates, CONCURRENCY, async (d) => {
    byDate.set(d, await fetchDay(d));
    done += 1;
    if (done % 40 === 0) console.log(`  ${done}/${dates.length} days fetched`);
  });
  const games = dates.flatMap((d) => byDate.get(d) || []);

  const completed = games.filter((g) => g.completed && g.home.score != null && g.away.score != null);
  console.log(`scoreboards: ${games.length} games, ${completed.length} completed`);

  let odds = 0;
  let d2 = 0;
  await pool(completed, CONCURRENCY, async (g) => {
    const o = await fetchOdds(g);
    if (o && o.homeClose && o.awayClose) {
      g.odds = o;
      odds += 1;
    }
    d2 += 1;
    if (d2 % 500 === 0) console.log(`  odds ${d2}/${completed.length} (${odds} usable)`);
  });

  const usable = completed.filter((g) => g.odds && g.odds.homeClose && g.odds.awayClose);
  const outFile = path.join(OUT_DIR, `season-${START.slice(0, 4)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(usable));
  console.log(`FINAL: ${usable.length} games with usable open+close moneylines`);
  console.log(`wrote ${outFile}`);
})();
