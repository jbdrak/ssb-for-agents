'use strict';
/**
 * Join historical weather to games, for testing whether an input the model doesn't have
 * adds information the closing line doesn't already contain.
 *
 * Two free sources, no API key:
 *   - Open-Meteo geocoding: city/state -> lat/lon
 *   - Open-Meteo archive:   hourly temperature, wind speed/direction, precipitation
 *
 * Design notes that matter:
 *   - INDOOR venues are marked and given NO weather. A dome is weather-immune, so feeding it
 *     outdoor conditions would inject noise into exactly the games where weather is irrelevant.
 *   - Weather is averaged over the game window (kickoff + 3 hours), not sampled at one instant.
 *     A game is 3+ hours long; a single kickoff reading misrepresents it.
 *   - Cached per (rounded lat/lon, date), because dozens of games share a city and a date.
 *
 * Usage: node scripts/weather-join.js --league college-football --seasons 2021,2022,2023,2024,2025
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LEAGUE = arg('league', 'college-football');
const SEASONS = arg('seasons', '2025')
  .split(',')
  .map((s) => s.trim());
const DATA_DIR = process.env.SSB_DATA_DIR || path.join(os.homedir(), '.ssb-for-agents', 'data');
const CACHE = path.join(DATA_DIR, 'cache', 'weather');
fs.mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function geocode(city, state) {
  const key = `${city}|${state}`.replace(/[^a-zA-Z0-9|]/g, '_');
  const file = path.join(CACHE, `geo-${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let out = null;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json`;
    const r = await fetch(url);
    if (r.ok) {
      const j = await r.json();
      const hit = (j.results || []).find((x) => (x.country_code || '').toUpperCase() === 'US') || (j.results || [])[0];
      if (hit) out = { lat: hit.latitude, lon: hit.longitude, name: hit.name, admin: hit.admin1 };
    }
  } catch {
    out = null;
  }
  // Never cache a FAILURE. Caching nulls turned a transient rate-limit into a permanent gap:
  // whole seasons ended up with 0-11% weather coverage because one burst got throttled.
  if (out) fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Hourly weather averaged over the game window (kickoff through kickoff + 3h). */
async function weatherAt(lat, lon, isoStart) {
  const d = new Date(isoStart);
  const day = d.toISOString().slice(0, 10);
  const key = `${lat.toFixed(2)}_${lon.toFixed(2)}_${day}`;
  const file = path.join(CACHE, `wx-${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let out = null;
  try {
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=${day}&end_date=${day}` +
      `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=UTC`;
    const r = await fetch(url);
    if (r.ok) {
      const j = await r.json();
      const h = j.hourly;
      if (h && h.time) {
        const startIdx = h.time.findIndex((t) => new Date(t + 'Z') >= d);
        if (startIdx >= 0) {
          const idxs = [startIdx, startIdx + 1, startIdx + 2, startIdx + 3].filter((i) => i < h.time.length);
          const avg = (arr) => {
            const vals = idxs.map((i) => arr[i]).filter((x) => Number.isFinite(x));
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          };
          out = {
            tempF: avg(h.temperature_2m),
            windMph: avg(h.wind_speed_10m),
            windDir: avg(h.wind_direction_10m),
            precipIn: avg(h.precipitation)
          };
        }
      }
    }
  } catch {
    out = null;
  }
  // Never cache a FAILURE. Caching nulls turned a transient rate-limit into a permanent gap:
  // whole seasons ended up with 0-11% weather coverage because one burst got throttled.
  if (out) fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

(async () => {
  // Gather every distinct venue city across the requested seasons.
  const gamesBySeason = {};
  const cityKeys = new Map();
  for (const s of SEASONS) {
    const f = path.join(DATA_DIR, `${LEAGUE}-${s}.json`);
    if (!fs.existsSync(f)) {
      console.error(`missing ${f}`);
      process.exit(1);
    }
    gamesBySeason[s] = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const g of gamesBySeason[s]) {
      const v = g.venue;
      if (!v || !v.city || v.indoor) continue;
      cityKeys.set(`${v.city}|${v.state}`, { city: v.city, state: v.state });
    }
  }
  console.log(`${cityKeys.size} distinct outdoor venue cities to geocode`);

  const geo = new Map();
  let done = 0;
  await pool([...cityKeys.keys()], 4, async (k) => {
    const { city, state } = cityKeys.get(k);
    geo.set(k, await geocode(city, state));
    done += 1;
    if (done % 40 === 0) console.log(`  geocoded ${done}/${cityKeys.size}`);
    await sleep(60);
  });
  const geoOk = [...geo.values()].filter(Boolean).length;
  console.log(`geocoded ${geoOk}/${cityKeys.size}`);

  // Attach weather.
  let attached = 0;
  let indoor = 0;
  let failed = 0;
  const tasks = [];
  for (const s of SEASONS) {
    for (const g of gamesBySeason[s]) {
      const v = g.venue;
      if (!v || !v.city) {
        failed += 1;
        continue;
      }
      if (v.indoor) {
        g.weather = { indoor: true };
        indoor += 1;
        continue;
      }
      const coords = geo.get(`${v.city}|${v.state}`);
      if (!coords) {
        failed += 1;
        continue;
      }
      tasks.push({ g, coords });
    }
  }
  console.log(`${tasks.length} outdoor games to fetch weather for`);

  let n = 0;
  // Gentler concurrency: the free tier throttles bursts, and a throttled request that is
  // never cached just means another attempt later.
  await pool(tasks, 3, async ({ g, coords }) => {
    let w = await weatherAt(coords.lat, coords.lon, g.startDate);
    if (!w) {
      await sleep(400);
      w = await weatherAt(coords.lat, coords.lon, g.startDate);
    }
    if (w) {
      g.weather = { ...w, indoor: false, lat: coords.lat, lon: coords.lon };
      attached += 1;
    } else {
      failed += 1;
    }
    n += 1;
    if (n % 400 === 0) console.log(`  weather ${n}/${tasks.length} (${attached} attached)`);
    await sleep(150);
  });

  for (const s of SEASONS) {
    fs.writeFileSync(path.join(DATA_DIR, `${LEAGUE}-${s}.json`), JSON.stringify(gamesBySeason[s]));
  }
  console.log(`weather attached: ${attached} | indoor (no weather): ${indoor} | failed: ${failed}`);
  console.log('season files rewritten');
})();
