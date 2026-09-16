'use strict';

const { resolveMatchTime } = require('./ssb-time-resolver');
const flashscore = require('./flashscore-times');
const { nameSimilarity } = require('./ssb-shared-utils');

/**
 * Tennis helpers (merged module, v1.7.0).
 *
 * Combines the previous two split files:
 *   - ssb-tennis-names.js — player name resolution + lookup table
 *   - ssb-tennis-times.js — ESPN scoreboard start-time correction
 *
 * ESPN-backed time correction is wired into the quick_screen, validate_play,
 * and recommended_bets pipelines via correctTennisTimes() (called from
 * handlers.js L1306/L1406). The tennis context provider (getTennisContext)
 * also self-corrects start times via ESPN data. Placeholder detection
 * prevents ESPN's 04:00Z placeholder from overwriting real times.
 */

// ─── From ssb-tennis-names ────────────────────────────────────

/**
 * Tennis player name lookup table.
 * Maps last names (as they appear in pp-mcp data) to full names.
 * Covers ATP top 150 + WTA top 100 + common names at Grand Slams.
 *
 * This is the bridge between pp-mcp's last-name-only tennis data and
 * SportScore's full-name API slugs.
 *
 * @type {Object<string, string>}
 * @constant
 */

/**
 * Tennis player name lookup table.
 * Maps last names (as they appear in pp-mcp data) to full names.
 * Covers ATP top 150 + WTA top 100 + common names at Grand Slams.
 *
 * This is the bridge between pp-mcp's last-name-only tennis data and
 * SportScore's full-name API slugs.
 *
 * @type {Object<string, string>}
 * @constant
 */

const PLAYER_NAMES = {
  // ATP - top players
  djokovic: 'Novak Djokovic',
  alcaraz: 'Carlos Alcaraz',
  sinner: 'Jannik Sinner',
  medvedev: 'Daniil Medvedev',
  zverev: 'Alexander Zverev',
  tsitsipas: 'Stefanos Tsitsipas',
  rune: 'Holger Rune',
  rublev: 'Andrey Rublev',
  hurkacz: 'Hubert Hurkacz',
  'auger-aliassime': 'Felix Auger-Aliassime',
  aliassime: 'Felix Auger-Aliassime',
  fritz: 'Taylor Fritz',
  fonseca: 'Joao Fonseca',
  ruud: 'Casper Ruud',
  'de-minaur': 'Alex De Minaur',
  deminaur: 'Alex De Minaur',
  dimitrov: 'Grigor Dimitrov',
  paul: 'Tommy Paul',
  khachanov: 'Karen Khachanov',
  bublik: 'Alexander Bublik',
  tiafoe: 'Frances Tiafoe',
  shelton: 'Ben Shelton',
  musetti: 'Lorenzo Musetti',
  jarry: 'Nicolas Jarry',
  tabilo: 'Alejandro Tabilo',
  navone: 'Mariano Navone',
  etcheverry: 'Tomas Martin Etcheverry',
  cerundolo: 'Francisco Cerundolo',
  'diaz-acosta': 'Facundo Diaz Acosta',
  struff: 'Jan-Lennard Struff',
  korda: 'Sebastian Korda',
  mannarino: 'Adrian Mannarino',
  banez: 'Roberto Bautista Agut',
  'bautista-agut': 'Roberto Bautista Agut',
  monfils: 'Gael Monfils',
  gasquet: 'Richard Gasquet',
  wawrinka: 'Stan Wawrinka',
  nadal: 'Rafael Nadal',
  murray: 'Andy Murray',
  thiem: 'Dominic Thiem',
  berrettini: 'Matteo Berrettini',
  shapovalov: 'Denis Shapovalov',
  kyrgios: 'Nick Kyrgios',
  nishikori: 'Kei Nishikori',
  raonic: 'Milos Raonic',
  cilic: 'Marin Cilic',
  delbonis: 'Federico Delbonis',
  fognini: 'Fabio Fognini',
  basilashvili: 'Nikoloz Basilashvili',
  mcenroe: 'John McEnroe',
  moutet: 'Corentin Moutet',
  humbert: 'Ugo Humbert',
  fils: 'Arthur Fils',
  'van-de-zandschulp': 'Botic Van De Zandschulp',
  vandeschulp: 'Botic Van De Zandschulp',
  griekspoor: 'Tallon Griekspoor',
  sonego: 'Lorenzo Sonego',
  'davidovich-fokina': 'Alejandro Davidovich Fokina',
  arnaldi: 'Matteo Arnaldi',
  safiullin: 'Roman Safiullin',
  zvonareva: 'Vera Zvonareva',
  kecmanovic: 'Miomir Kecmanovic',
  lavrinenko: 'unknown',
  nguyen: 'unknown',

  // ATP - other common names
  mcdonald: 'Mackenzie McDonald',
  wolf: 'J.J. Wolf',
  nakashima: 'Brandon Nakashima',
  koepfer: 'Dominik Koepfer',
  hanfmann: 'Yannick Hanfmann',
  ophoff: 'unknown',
  pepper: 'unknown',
  sock: 'Jack Sock',
  isner: 'John Isner',
  anderson: 'Kevin Anderson',
  opelka: 'Reilly Opelka',
  brooksby: 'Jenson Brooksby',
  kozlova: 'Kateryna Kozlova',
  mensik: 'Jakub Mensik',
  michalski: 'Daniel Michalski',
  muller: 'Alexandre Muller',
  cachin: 'Pedro Cachin',
  coria: 'Federico Coria',
  'carballes-baena': 'Roberto Carballes Baena',
  cazaux: 'Arthur Cazaux',
  halys: 'Quentin Halys',
  lorenzi: 'Paolo Lorenzi',
  mager: 'Gianluca Mager',
  passaro: 'Francesco Passaro',
  piros: 'Zsombor Piros',
  rodionov: 'Jurij Rodionov',
  sweeting: 'unknown',
  vavassori: 'Andrea Vavassori',
  zeppieri: 'Giulio Zeppieri',
  ddokic: 'unknown',
  ngounoue: 'unknown',
  spizzichino: 'unknown',
  pigato: 'unknown',
  serafini: 'unknown',
  maestrelli: 'unknown',

  // WTA - top players
  swiatek: 'Iga Swiatek',
  sabalenka: 'Aryna Sabalenka',
  gauff: 'Coco Gauff',
  rybakina: 'Elena Rybakina',
  pegula: 'Jessica Pegula',
  jabeur: 'Ons Jabeur',
  sakkari: 'Maria Sakkari',
  kvitova: 'Petra Kvitova',
  osaka: 'Naomi Osaka',
  kenin: 'Sofia Kenin',
  andreescu: 'Bianca Andreescu',
  konta: 'Johanna Konta',
  muguruza: 'Garbine Muguruza',
  halep: 'Simona Halep',
  kerber: 'Angelique Kerber',
  williams: 'Serena Williams',
  'williams-v': 'Venus Williams',
  azarenka: 'Victoria Azarenka',
  svitolina: 'Elina Svitolina',
  bencic: 'Belinda Bencic',
  kostyuk: 'Marta Kostyuk',
  cirstea: 'Sorana Cirstea',
  xiyu: 'Wang Xiyu',
  kalinina: 'Anhelina Kalinina',
  potapova: 'Anastasia Potapova',
  kalinskaya: 'Anna Kalinskaya',
  samsonova: 'Liudmila Samsonova',
  kudermetova: 'Veronika Kudermetova',
  kasatkina: 'Daria Kasatkina',
  ostapenko: 'Jelena Ostapenko',
  pliskova: 'Karolina Pliskova',
  muchova: 'Karolina Muchova',
  'haddad-maia': 'Beatriz Haddad Maia',
  keys: 'Madison Keys',
  stephens: 'Sloane Stephens',
  collins: 'Danielle Collins',
  aniesimova: 'Amanda Anisimova',
  fernandez: 'Leylah Fernandez',
  raducanu: 'Emma Raducanu',
  xia: 'Wang Xiyu',
  shnaider: 'Diana Shnaider',
  chwalinska: 'unknown',
  parry: 'Diane Parry',
  mmoh: 'unknown',
  smith: 'unknown',
  teunissen: 'unknown',
  smit: 'unknown',

  // WTA - other common
  // These two carry different surnames in each source, and the two surnames
  // share no string at all, so the PP surname must expand to the full name for
  // the Flashscore pairing to match (Flashscore uses the first surname, PP the
  // last). Without this the time correction can never pair the row and it keeps
  // its uncorroborated PP start.
  reales: 'Guiomar Maristany Zuleta de Reales', // Flashscore: Maristany G.
  ribera: 'Marina Bassols Ribera', // Flashscore: Bassols M.
  linette: 'Magda Linette',
  boulter: 'Katie Boulter',
  burrage: 'Jodie Burrage',
  dart: 'Harriet Dart',
  watson: 'Heather Watson',
  vondrousova: 'Marketa Vondrousova',
  kontaveit: 'Anett Kontaveit',
  badosa: 'Paula Badosa',
  tauson: 'Clara Tauson',
  tomljanovic: 'Ajla Tomljanovic',
  riske: 'Alison Riske',
  roland: 'unknown',
  townsend: 'Taylor Townsend',
  dolehide: 'Caroline Dolehide',
  navarro: 'Emma Navarro',
  stevens: 'unknown',
  uchiijima: 'unknown',
  hontama: 'unknown',
  bektas: 'Emina Bektas',
  brengle: 'Madison Brengle',
  marino: 'Rebecca Marino',
  stakusic: 'unknown',
  zhao: 'unknown',
  sun: 'unknown',
  wei: 'unknown',
  gao: 'unknown',
  wushuang: 'unknown',
  schmiedlova: 'Anna Karolina Schmiedlova',
  sramkova: 'Rebecca Sramkova',
  martincova: 'Tereza Martincova',
  niemeier: 'Jule Niemeier',
  friedsam: 'Anna-Lena Friedsam',
  lis: 'unknown',
  korpatsch: 'Tamara Korpatsch',
  kolodziejova: 'unknown',
  birrell: 'Kimberly Birrell',
  saville: 'Daria Saville',
  sharma: 'unknown',
  aiava: 'Destanee Aiava',
  gadecki: 'unknown',
  hon: 'unknown',
  bucsa: 'Cristina Bucsa',
  'sorribes-tormo': 'Sara Sorribes Tormo',
  podoroska: 'Nadia Podoroska',
  errani: 'Sara Errani',
  paolini: 'Jasmine Paolini',
  cocciaretto: 'Elisabetta Cocciaretto',
  trevisan: 'Martina Trevisan',
  bronzetti: 'Lucia Bronzetti',
  stefanini: 'unknown',
  pigossi: 'Laura Pigossi',
  alves: 'unknown',
  ce: 'unknown',
  selcinkaya: 'unknown',
  cengiz: 'unknown',
  okamura: 'unknown',
  shinikova: 'unknown',
  karatancheva: 'unknown',
  yankova: 'unknown',
  tomanova: 'unknown',
  naydenova: 'unknown',
  ivanova: 'unknown',
  kovaleva: 'unknown',
  andreeva: 'Mirra Andreeva',
  timofeeva: 'unknown',
  avanesyan: 'Elina Avanesyan',
  mertens: 'Elise Mertens'
};

/**
 * Resolve a player name (last name or partial) to a full name.
 * Returns the full name if found, or the input if not.
 *
 * @param {string} name - Player last name or partial name to resolve
 * @returns {string|null} Full player name if found in lookup table, null if input is empty
 */
function resolvePlayerName(name) {
  if (!name) return null;
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
  return PLAYER_NAMES[key] || PLAYER_NAMES[name.trim().toLowerCase()] || null;
}

/**
 * Get the SportScore slug for a player name.
 *
 * @param {string} name - Player name to convert into a URL-safe slug
 * @returns {string|null} URL-safe slug for SportScore API, or null if input is empty
 */
function getNameSlug(name) {
  const full = resolvePlayerName(name);
  if (full && full !== 'unknown') {
    return full
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
  }
  // Try direct slug from last name
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\w-]/g, '')
    .replace(/\s+/g, '-');
  return slug || null;
}

('use strict');

/**
 * Tennis time correction module.
 * Uses ESPN's free public API to get reliable match start times.
 *
 * ESPN API: https://site.api.espn.com/apis/site/v2/sports/tennis/{atp,wta}/scoreboard
 * No API key required. Returns individual match times for every tournament.
 *
 * Strategy:
 * 1. Fetch ATP + WTA scoreboards (2 HTTP calls total)
 * 2. Detect and filter out ESPN placeholder times (e.g. 04:00Z for future rounds)
 * 3. Build a lookup map: normalized full name -> { start, opponent, venue }
 * 4. For each pp-mcp tennis row, find the match by player name
 * 5. Correct if ESPN time differs by >30 min
 *
 * PLACEHOLDER DETECTION:
 * ESPN uses placeholder times (commonly 04:00Z) for matches where the exact time
 * hasn't been set yet (future rounds, TBD matchups). These placeholders are
 * identical across many matches in the same tournament. We detect them by
 * clustering: if 3+ matches share the exact same time AND the match is still
 * "Scheduled" (not In Progress/Final), we treat that time as a placeholder
 * and skip correction for those matches.
 */

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/tennis';

// Cache for ESPN scoreboard data
let _espnCache = null;
let _espnCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Detect if an ESPN time is a placeholder.
 * Placeholder pattern: ESPN uses 04:00Z (4:00 AM UTC) as a default time for
 * matches where the exact schedule hasn't been set yet (future rounds, TBD matchups).
 * These show up as clusters of 10+ Scheduled matches all at the exact same time.
 *
 * Detection: if 10+ Scheduled matches share the exact same time, it's a placeholder.
 * Real match schedules have natural variation (5-30 min gaps between matches).
 *
 * @param {Array} allMatches - All ESPN matches (to detect clustering)
 * @param {string} timeToCheck - ISO time string to test
 * @param {string} status - Match status (e.g. "Scheduled", "Final")
 * @returns {boolean} True if the time is likely a placeholder
 */
function isPlaceholderTime(allMatches, timeToCheck, status) {
  if (!timeToCheck || !status) return false;
  // Only check Scheduled matches — In Progress/Final have real times
  if (status !== 'Scheduled') return false;

  // Count how many Scheduled matches share this exact time
  const sameTimeCount = allMatches.filter((m) => m.start === timeToCheck && m.status === 'Scheduled').length;

  // If 10+ Scheduled matches share the exact same time, it's a placeholder.
  // Real tennis schedules have natural variation — you won't see 10+ matches
  // all starting at the exact same minute. ESPN's 04:00Z placeholder produces
  // clusters of 15-45+ matches at the identical time.
  return sameTimeCount >= 10;
}

/**
 * Central Time display string for a given date value.
 * @param {string|number|null|undefined} value - An ISO date string, Unix timestamp, or falsy value
 * @returns {string|null} Formatted Central Time string (e.g. "Jun 7, 2026, 2:00 PM CDT"), or null if input is falsy
 */
function formatCentralTime(value) {
  if (!value) return null;
  const raw = String(value);
  const hasExplicitZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(raw);
  const date = new Date(hasExplicitZone ? raw : `${raw}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);
}

/**
 * Fetch tennis scoreboard from ESPN for both ATP and WTA.
 * Results are cached for 5 minutes.
 * Returns a flat array of ESPN match objects:
 *   { player1, player2, start, status, venue, event, tournament, league }
 * @returns {Promise<Array<{player1: string, player2: string, start: string, status: string, venue: string}>>} Flat array of ESPN match objects
 */
async function fetchEspnMatches() {
  const now = Date.now();
  if (_espnCache && now - _espnCacheTime < CACHE_TTL_MS) {
    return _espnCache;
  }

  const circuits = ['atp', 'wta'];
  const allMatches = [];

  for (const circuit of circuits) {
    try {
      const url = `${ESPN_BASE}/${circuit}/scoreboard`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ssb-for-agents/1.0.7 (tennis-time-correction)',
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) continue;

      const data = await response.json();
      const events = Array.isArray(data?.events) ? data.events : [];

      for (const event of events) {
        const groupings = Array.isArray(event?.groupings) ? event.groupings : [];
        for (const group of groupings) {
          const competitions = Array.isArray(group?.competitions) ? group.competitions : [];
          for (const comp of competitions) {
            const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
            if (competitors.length < 2) continue;

            const player1 = competitors[0]?.athlete?.displayName || '';
            const player2 = competitors[1]?.athlete?.displayName || '';
            if (!player1 || !player2) continue;

            const matchDate = comp.date || '';
            const status = comp?.status?.type?.description || '';
            const venue = comp?.venue?.fullName || '';
            const eventName = comp?.name || event?.name || '';
            const tournament = comp?.tournament?.name || group?.name || '';
            const league = comp?.league?.name || event?.league?.name || '';

            allMatches.push({
              player1: player1.trim(),
              player2: player2.trim(),
              start: matchDate,
              status,
              venue,
              event: eventName,
              tournament,
              league
            });
          }
        }
      }
    } catch {
      // Circuit failed, continue with whatever we have
      continue;
    }
  }

  _espnCache = allMatches;
  _espnCacheTime = Date.now();
  return allMatches;
}

/**
 * Find the best ESPN match for a given pp-mcp row.
 * Matches by player name similarity to either side of the ESPN match.
 */
function findEspnMatch(espnMatches, ppHomeTeam, ppAwayTeam) {
  if (!espnMatches || !espnMatches.length) return null;

  let best = null;
  let bestScore = 0;

  for (const m of espnMatches) {
    // Check if either player matches home or away
    const homeToP1 = nameSimilarity(ppHomeTeam, m.player1);
    const homeToP2 = nameSimilarity(ppHomeTeam, m.player2);
    const awayToP1 = nameSimilarity(ppAwayTeam, m.player1);
    const awayToP2 = nameSimilarity(ppAwayTeam, m.player2);

    // Score: we need both players to match (one on each side)
    const matchScore1 = Math.min(Math.max(homeToP1, awayToP1), Math.max(homeToP2, awayToP2));
    const matchScore2 = Math.min(Math.max(homeToP2, awayToP2), Math.max(homeToP1, awayToP1));
    // Higher of the two crossing patterns
    const combined = Math.max(matchScore1, matchScore2);

    if (combined > bestScore) {
      bestScore = combined;
      best = {
        time: m.start,
        match: `${m.player1} vs ${m.player2}`,
        confidence: combined,
        status: m.status,
        venue: m.venue,
        event: m.event,
        tournament: m.tournament,
        league: m.league
      };
    }
  }

  return bestScore >= 0.5 ? best : null;
}

/**
 * Correct tennis match times for an array of ranked rows using ESPN data.
 * Mutates and returns the same array with corrected `start` fields.
 * @param {Array<Object>} rows - Array of tennis match rows; each row expected to have homeTeam, awayTeam, start/startTimestamp fields
 * @returns {Promise<Array<Object>>} The same rows array with corrected start fields and added metadata (startDisplay, startCorrected, startSource, startMatchName, etc.)
 */

/**
 * Convert a Flashscore "HH:MM" time (CDT) + date string to ISO 8601.
 * @param {string} timeStr - Time like "22:05"
 * @param {string} dateStr - Date like "2026-07-30"
 * @returns {string|null} ISO 8601 timestamp or null if invalid
 */
function flashscoreTimeToISO(timeStr, dateStr) {
  if (!timeStr || !dateStr) return null;
  // Strip any non-time suffixes (e.g. "23:00FRO")
  const clean = timeStr.replace(/[^0-9:]/g, '');
  const match = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const [, hours, minutes] = match;
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, Number(hours), Number(minutes)));
  const offsetPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'longOffset'
  })
    .formatToParts(utcGuess)
    .find((part) => part.type === 'timeZoneName')?.value;
  const offsetMatch = offsetPart?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!offsetMatch) return null;
  const offsetMinutes = (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3] || 0)) * (offsetMatch[1] === '+' ? 1 : -1);
  const dt = new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

async function correctUnmatchedTennisTimes(uncorrectedRows) {
  if (uncorrectedRows.length > 0) {
    const webCorrected = [];
    const concurrency = 3;
    for (let i = 0; i < uncorrectedRows.length; i += concurrency) {
      const batch = uncorrectedRows.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (row) => {
          let homeTeam = String(row.homeTeam || '').trim();
          let awayTeam = String(row.awayTeam || '').trim();

          // Same game-field fallback as the ESPN path above
          if ((!homeTeam || !awayTeam) && row.game && row.game.includes(' vs ')) {
            const parts = row.game.split(' vs ').map((s) => s.trim());
            if (parts.length === 2) {
              homeTeam = homeTeam || parts[0];
              awayTeam = awayTeam || parts[1];
            }
          }
          if (!homeTeam || !awayTeam) return null;

          const startTime = row.start || row.startTimestamp || '';
          const result = await resolveMatchTime(homeTeam, awayTeam);
          if (result && result.time) {
            const newTime = new Date(result.time);
            if (!isNaN(newTime.getTime())) {
              const oldTime = startTime ? new Date(startTime) : null;
              const diffMs = oldTime ? Math.abs(newTime.getTime() - oldTime.getTime()) : Infinity;
              if (diffMs > 30 * 60 * 1000 || !oldTime) {
                row.start = newTime.toISOString();
                row.startCorrected = true;
                row.startSource = result.source || 'web_search';
                row.startConfidence = result.confidence || 0.6;
                return homeTeam + ' vs ' + awayTeam;
              }
            }
          }
          return null;
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          webCorrected.push(r.value);
        }
      }
    }

    if (webCorrected.length > 0 && typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(
        `[tennis-times] Web-search corrected ${webCorrected.length} additional matches: ${webCorrected.join(', ')}\n`
      );
    }
  }
}

function correctTennisRow(row, { fsCacheFresh, espnMatches, espnAvailable }) {
  let correctedFlag = false;
  let flashscoreCorrectedFlag = false;
  let espnCorrectedFlag = false;
  let uncorrectedFlag = false;
  let homeTeam = String(row.homeTeam || '').trim();
  let awayTeam = String(row.awayTeam || '').trim();

  // Tennis plays often have null homeTeam/awayTeam — parse from game field
  // Format: "Player1 vs Player2"
  if ((!homeTeam || !awayTeam) && row.game && row.game.includes(' vs ')) {
    const parts = row.game.split(' vs ').map((s) => s.trim());
    if (parts.length === 2) {
      homeTeam = homeTeam || parts[0];
      awayTeam = awayTeam || parts[1];
    }
  }
  const startTime = row.start || row.startTimestamp || '';

  // ── Primary: Flashscore time lookup ──────────────────────────────
  // PP carries one surname (usually the last) and Flashscore another (usually the
  // first), so for some players the two share no string at all - "Reales" vs
  // "Maristany". The name table bridges that; without expanding first, the
  // pairing never matches and the row silently keeps its uncorroborated PP time.
  const fsMatch = flashscore.lookupFromPPRow({
    ...row,
    homeTeam: resolvePlayerName(homeTeam) || homeTeam,
    awayTeam: resolvePlayerName(awayTeam) || awayTeam
  });
  if (fsMatch && fsMatch.time) {
    // Flashscore returns "HH:MM" in CDT. Convert to ISO 8601.
    const isoTime = flashscoreTimeToISO(fsMatch.time, fsMatch.date);
    if (isoTime) {
      const oldTime = startTime ? new Date(startTime) : new Date(0);
      const newTime = new Date(isoTime);
      const diffMs = Math.abs(newTime.getTime() - oldTime.getTime());

      if (diffMs > 30 * 60 * 1000 || !startTime) {
        row.start = isoTime;
        row.startCorrected = true;
        row.startSource = 'flashscore';
        row.startMatchName = `${fsMatch.home || homeTeam} vs ${fsMatch.away || awayTeam}`;
        row.startConfidence = 0.95;
        row.startTournament = fsMatch.tournament;
        row.startCategory = fsMatch.category;
        correctedFlag = true;
        flashscoreCorrectedFlag = true;
      } else {
        row.startSource = 'flashscore-verified';
        row.startMatchName = `${fsMatch.home || homeTeam} vs ${fsMatch.away || awayTeam}`;
        row.startConfidence = 0.95;
      }
      // Always set CT display
      if (row.start) row.startDisplay = formatCentralTime(row.start);
      if (!row.startSource) {
        row.startSource = 'pp-mcp (unverified)';
        row.startConfidence = 0.3;
      }
      return {
        corrected: correctedFlag,
        flashscoreCorrected: flashscoreCorrectedFlag,
        espnCorrected: espnCorrectedFlag,
        uncorrected: uncorrectedFlag
      }; // Flashscore handled this row, skip ESPN/web
    }

    // Flashscore has this match scheduled but its time string is
    // unparsable. The Flashscore schedule is authoritative — keep the row
    // unresolved rather than letting ESPN mark it verified/trusted.
    row.startSource = 'flashscore (time unparsed)';
    row.startConfidence = 0.3;
    row.startMatchName = `${fsMatch.home || homeTeam} vs ${fsMatch.away || awayTeam}`;
    if (row.start) row.startDisplay = formatCentralTime(row.start);
    return {
      corrected: correctedFlag,
      flashscoreCorrected: flashscoreCorrectedFlag,
      espnCorrected: espnCorrectedFlag,
      uncorrected: uncorrectedFlag
    };
  }

  // Fresh, valid Flashscore cache present but this row's match is not in
  // it (omission). The Flashscore schedule is authoritative — leave the
  // row unresolved instead of upgrading it to a trusted ESPN time.
  if (fsCacheFresh) {
    if (!row.startSource) {
      row.startSource = 'pp-mcp (unverified)';
      row.startConfidence = 0.3;
    }
    const timeForDisplay = row.start || row.startTimestamp;
    if (timeForDisplay) row.startDisplay = formatCentralTime(timeForDisplay);
    return {
      corrected: correctedFlag,
      flashscoreCorrected: flashscoreCorrectedFlag,
      espnCorrected: espnCorrectedFlag,
      uncorrected: uncorrectedFlag
    };
  }

  // ── Fallback: ESPN time lookup ───────────────────────────────────
  let match = null;
  if (espnAvailable) {
    match = findEspnMatch(espnMatches, homeTeam, awayTeam);
  }

  // Apply ESPN correction if found and meaningful
  if (match && match.time) {
    if (isPlaceholderTime(espnMatches, match.time, match.status)) {
      row.startSource = 'pp-mcp (espn-placeholder-skipped)';
    } else {
      const oldTime = startTime ? new Date(startTime) : new Date(0);
      const newTime = new Date(match.time);
      const diffMs = Math.abs(newTime.getTime() - oldTime.getTime());

      if (diffMs > 30 * 60 * 1000 || !startTime) {
        row.start = match.time;
        row.startCorrected = true;
        row.startSource = 'espn (fallback, unverified)';
        row.startMatchName = match.match;
        row.startConfidence = Math.round(match.confidence * 100) / 100;
        if (match.venue) row.startVenue = match.venue;
        if (match.status) row.startStatus = match.status;
        correctedFlag = true;
        espnCorrectedFlag = true;
      } else {
        // Time already matches — still an ESPN fallback, never a
        // Flashscore verification.
        row.startSource = 'espn-verified (fallback, unverified)';
        row.startMatchName = match.match;
        row.startConfidence = Math.round(match.confidence * 100) / 100;
        if (match.venue) row.startVenue = match.venue;
        if (match.status) row.startStatus = match.status;
      }
    }
  } else {
    // ESPN didn't have this match — try web search fallback
    uncorrectedFlag = true;
  }

  // Always set a CT display string
  const timeForDisplay = row.start || row.startTimestamp;
  if (timeForDisplay) {
    row.startDisplay = formatCentralTime(timeForDisplay);
  }

  // Tag the time quality so users know what to trust
  if (!row.startSource) {
    row.startSource = 'pp-mcp (unverified)';
    row.startConfidence = 0.3;
  }
  return {
    corrected: correctedFlag,
    flashscoreCorrected: flashscoreCorrectedFlag,
    espnCorrected: espnCorrectedFlag,
    uncorrected: uncorrectedFlag
  };
}

async function correctTennisTimes(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;

  // Determine the Flashscore cache state once per pass. A fresh, valid
  // Flashscore cache is the authoritative schedule source: when it omits a
  // match, no fallback may present that row as verified/trusted. ESPN is
  // only an acceptable fallback when the Flashscore cache is missing,
  // malformed, or stale — and it must be labeled as such.
  const fsCacheInfo = flashscore.getCacheInfo();
  const fsCacheFresh = fsCacheInfo !== null && fsCacheInfo.fresh === true;

  // Fetch all ESPN matches (ATP + WTA, cached for 5 min)
  let espnMatches;
  let espnAvailable = false;
  try {
    espnMatches = await fetchEspnMatches();
    espnAvailable = espnMatches.length > 0;
  } catch {
    espnMatches = [];
  }

  let corrected = 0;
  let flashscoreCorrected = 0;
  let espnCorrected = 0;
  const uncorrectedRows = [];

  for (const row of rows) {
    const r = correctTennisRow(row, { fsCacheFresh, espnMatches, espnAvailable });
    if (r.corrected) corrected++;
    if (r.flashscoreCorrected) flashscoreCorrected++;
    if (r.espnCorrected) espnCorrected++;
    if (r.uncorrected) uncorrectedRows.push(row);
  }

  if (corrected > 0 && typeof process !== 'undefined' && process.stderr) {
    process.stderr.write(
      `[tennis-times] Corrected ${corrected}/${rows.length} tennis match times ` +
        `(Flashscore ${flashscoreCorrected}, ESPN fallback ${espnCorrected})\n`
    );
  }

  await correctUnmatchedTennisTimes(uncorrectedRows);

  return rows;
}

module.exports = {
  // From ssb-tennis-names
  PLAYER_NAMES,
  resolvePlayerName,
  getNameSlug,
  // From ssb-tennis-times
  correctTennisTimes,
  fetchEspnMatches,
  findEspnMatch,
  nameSimilarity,
  formatCentralTime,
  isPlaceholderTime,
  // Flashscore integration
  flashscoreTimeToISO
};
