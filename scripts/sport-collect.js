'use strict';
/**
 * Collect game data for any ESPN sport: results and OPEN + CLOSE moneylines.
 *
 * Generic over sport/league so MLB and college football share one verified path. Written
 * after `mlb-collect.js`, which it supersedes -- and it reproduces that file's output
 * exactly, which is the regression check that the generalisation did not break anything.
 *
 * Sources (public, no key):
 *   - site.api.espn.com  /sports/<sport>/<league>/scoreboard  -> teams, scores, starters
 *   - sports.core.api.espn.com /v2/sports/<sport>/leagues/<league>/events/<id>/competitions/<id>/odds
 *
 * NOTE the `leagues/` segment in the odds path. Dropping it returns 404 for EVERY league,
 * including ones that work -- which looks like "this sport has no odds data" and is not.
 *
 * DELIBERATELY NOT COLLECTED: a probable starter's ERA. ESPN serves the pitcher's
 * SEASON-FINAL ERA on every game he started, all season long (verified across 705
 * pitcher-seasons: 705 identical, 0 varying). Feeding that to a model hands it the rest of
 * the season. Only the starter ID is kept; models derive their own walk-forward signal.
 *
 * Usage:
 *   node scripts/sport-collect.js --sport baseball --league mlb --start 2025-03-27 --end 2025-09-28
 *   node scripts/sport-collect.js --sport football --league college-football \
 *     --start 2024-08-24 --end 2025-01-20
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SPORT = arg('sport', 'baseball');
const LEAGUE = arg('league', 'mlb');
const START = arg('start');
const END = arg('end');
const OUT_DIR = arg('out', path.join(os.homedir(), '.ssb-for-agents', 'data'));
const CONCURRENCY = Number(arg('concurrency', '6'));
// ESPN's placeholder for "no line posted". Real lines sit far inside this.
const MAX_PLAUSIBLE_ML = Number(arg('max-plausible-ml', '5000'));

if (!START || !END) {
  console.error('need --start YYYY-MM-DD --end YYYY-MM-DD');
  process.exit(1);
}

const CACHE = path.join(OUT_DIR, 'cache', `${SPORT}-${LEAGUE}`);
fs.mkdirSync(CACHE, { recursive: true });

const dates = [];
for (let d = new Date(`${START}T12:00:00Z`); d <= new Date(`${END}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
  dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
}

const moneyLine = (x) => {
  if (x == null) return null;
  if (typeof x === 'object') return x.alternateDisplayValue ?? x.american ?? null;
  return x;
};
/** ESPN uses absurd placeholders (e.g. -50000) for games with no real line. Reject them. */
const usableMl = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.abs(n) <= MAX_PLAUSIBLE_ML ? n : null;
};

async function fetchDay(date) {
  const file = path.join(CACHE, `sb-${date}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${SPORT}/${LEAGUE}/scoreboard?dates=${date}`);
  if (!res.ok) return []; // never cache a failure
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
        neutralSite: comp.neutralSite === true,
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
  const url = `https://sports.core.api.espn.com/v2/sports/${SPORT}/leagues/${LEAGUE}/events/${game.eventId}/competitions/${game.eventId}/odds`;
  let out = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      // ESPN returns several items, including a "Live Odds" placeholder priced 0.
      const items = (json.items || []).filter((i) => i.homeTeamOdds && i.awayTeamOdds);
      const it = items[0];
      if (it) {
        out = {
          provider: it.provider?.name ?? null,
          homeOpen: usableMl(moneyLine(it.homeTeamOdds?.open?.moneyLine)),
          homeClose: usableMl(moneyLine(it.homeTeamOdds?.close?.moneyLine) ?? moneyLine(it.homeTeamOdds?.moneyLine)),
          awayOpen: usableMl(moneyLine(it.awayTeamOdds?.open?.moneyLine)),
          awayClose: usableMl(moneyLine(it.awayTeamOdds?.close?.moneyLine) ?? moneyLine(it.awayTeamOdds?.moneyLine)),
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
  console.log(`${SPORT}/${LEAGUE}: ${dates.length} days ${START}..${END} -> ${OUT_DIR}`);
  // Each worker stores its own result and the accumulation happens ONCE, after the pool
  // drains. `games = games.concat(await fetchDay(d))` inside the worker is a lost-update
  // race: JS evaluates the `games` reference BEFORE the await, so concurrent workers each
  // concat onto a stale array. It silently dropped 2,463 games to 403.
  const byDate = new Map();
  let done = 0;
  await pool(dates, CONCURRENCY, async (d) => {
    byDate.set(d, await fetchDay(d));
    done += 1;
    if (done % 60 === 0) console.log(`  ${done}/${dates.length} days fetched`);
  });
  const games = dates.flatMap((d) => byDate.get(d) || []);

  const completed = games.filter((g) => g.completed && g.home.score != null && g.away.score != null);
  console.log(`scoreboards: ${games.length} games, ${completed.length} completed`);

  let odds = 0;
  let seen = 0;
  await pool(completed, CONCURRENCY, async (g) => {
    const o = await fetchOdds(g);
    if (o && o.homeClose && o.awayClose) {
      g.odds = o;
      odds += 1;
    }
    seen += 1;
    if (seen % 500 === 0) console.log(`  odds ${seen}/${completed.length} (${odds} usable)`);
  });

  const usable = completed.filter((g) => g.odds && g.odds.homeClose && g.odds.awayClose);
  const outFile = path.join(OUT_DIR, `${LEAGUE}-${START.slice(0, 4)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(usable));
  console.log(`FINAL: ${usable.length} games with usable open+close moneylines`);
  console.log(`wrote ${outFile}`);
})();
