'use strict';

const cp = require('child_process');

// Fresh promise on each call so tests mocking cp.execFile are honored.
const pExecFile = (...args) =>
  new Promise((resolve, reject) => {
    const execFile = /** @type {*} */ (cp.execFile);
    execFile(...args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });

const CURL_TIMEOUT_MS = 10000;

// A parseable date string must carry an explicit 4-digit year. V8 happily
// invents year 2001 for a year-less display string, so `parseGameStartMs`
// refuses anything without one rather than returning a plausible wrong instant.
const YEAR_PATTERN = /\d{4}/;

/**
 * Fetch a URL via curl with the given header list, then JSON.parse the body.
 * @param {string} url
 * @param {string[]} curlHeaders - Array of curl args (e.g. ['-H', 'User-Agent: x']).
 * @returns {Promise<*>} Parsed JSON
 */
async function fetchJson(url, curlHeaders) {
  const args = ['-fsS', '--max-time', String(CURL_TIMEOUT_MS / 1000), ...curlHeaders, url];
  const { stdout } = await pExecFile('curl', args, {
    timeout: CURL_TIMEOUT_MS
  });
  return JSON.parse(stdout);
}

/**
 * Parse a date string (YYYY-MM-DD) into a Date object at midnight UTC.
 * @param {string} dateStr
 * @returns {Date}
 */
function parseDateUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Compute rest days between two date strings (YYYY-MM-DD).
 * Returns null if either date is missing or invalid.
 * @param {string} gameDate - Date of the current game
 * @param {string} lastPlayed - Date of the team's last game
 * @returns {number|null} Number of days of rest (>= 0), or null
 */
function computeRestDays(gameDate, lastPlayed) {
  if (!gameDate || !lastPlayed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !/^\d{4}-\d{2}-\d{2}$/.test(lastPlayed)) return null;
  const d1 = parseDateUtc(gameDate);
  const d2 = parseDateUtc(lastPlayed);
  const diffMs = d1.getTime() - d2.getTime();
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return days >= 0 ? days : null; // null if lastPlayed is after gameDate (data issue)
}

/**
 * Determine if a team is on a back-to-back (≤1 day rest).
 * @param {number|null} restDays
 * @returns {boolean}
 */
function isBackToBack(restDays) {
  return restDays !== null && restDays <= 1;
}

/**
 * Normalize a player/team name for fuzzy comparison.
 * Strips punctuation, lowercases, collapses whitespace, trims.
 */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score how well two names match (0-1).
 * @param {string} a - First name
 * @param {string} b - Second name
 * @returns {number} Similarity score: 1.0 = exact, 0.9 = substring, 0.85 = same last name, 0.7 = partial last name, 0 = no match
 */
function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const aLast = na.split(' ').pop();
  const bLast = nb.split(' ').pop();
  if (aLast === bLast && aLast.length > 2) return 0.85;
  if (aLast.length > 2 && bLast.length > 2 && (aLast.includes(bLast) || bLast.includes(aLast))) return 0.7;
  return 0;
}

/**
 * Convert American odds to implied probability.
 * @param {number|string} odds - American odds value (e.g. -110, +150). Must be a finite non-zero number.
 * @returns {number|null} Implied probability as a decimal between 0 and 1, or null if input is invalid.
 */
function americanOddsToImpliedProbability(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n > 0) return 100 / (n + 100);
  return -n / (-n + 100);
}

/**
 * Parse a time value into milliseconds since Unix epoch.
 * Accepts Date objects, numeric timestamps (seconds or milliseconds), and date strings.
 * @param {Date|number|string} value - The value to parse.
 * @returns {number|null} Milliseconds timestamp, or null if the value cannot be parsed.
 */
function parseHistoryTimeMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse a game start time from the upstream API into epoch milliseconds.
 *
 * The SSB /screen endpoint returns `start` in mixed formats:
 * - Epoch seconds (integer, ~10 digits) — MLB, WNBA, NBA, NFL, NHL
 * - ISO date strings — Soccer, Tennis
 *
 * This function normalizes both into epoch milliseconds so downstream
 * callers don't need per-call format detection.
 *
 * @param {Date|number|string|null|undefined} value - Raw start time from API.
 * @returns {number|null} Epoch milliseconds, or null if unparseable.
 */
function parseGameStartMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // > 1e12 = epoch milliseconds (year 2001+)
    if (value > 1e12) return value;
    // >= 1e9 = epoch seconds (Sep 2001+)
    if (value >= 1e9) return value * 1000;
    // Small numbers (< 1e9) are treated as-is — relative offsets from
    // test fixtures or already in milliseconds. These never come from
    // the real API (which uses epoch seconds ≥ 1.7B).
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Try numeric first — V8's Date.parse('42') returns year 2042, not NaN
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      if (num > 1e12) return num;
      if (num >= 1e9) return num * 1000;
      return num;
    }
    // Try a date string. A YEAR-LESS display string is refused before V8 sees
    // it: `Date.parse('Wed, Sep 16, 1:30 PM CDT')` returns 1000665000000
    // (2001-09-16), a FINITE but wrong instant. A finite wrong value is worse
    // than a null, because a caller that gates on it - the external-ratings
    // recency gate reads row starts through here - would treat the wrong event
    // date as verified. The CLI's own `startCST` display field is exactly that
    // shape (`Wed, Sep 16, 8:40 PM CT`), and it must never resolve to an epoch
    // without an explicit year; callers that need one must pass the
    // machine-readable `start` the backend sends.
    if (!YEAR_PATTERN.test(trimmed)) return null;
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Calculate the average of an array of finite numbers.
 * @param {Array<number>} values - Array of numbers (non-finite values are filtered).
 * @returns {number|null} Average value, or null if no finite values.
 */
function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

/**
 * Score a row against a query for relevance matching.
 * Combines weighted matches on player name, market, direction/side, and line value.
 * @param {Object} query - Query object with optional search fields.
 * @param {string} [query.player] - Player name to match.
 * @param {string} [query.market] - Market name to match (normalized).
 * @param {string} [query.side] - Direction/side to match (normalized).
 * @param {number|string} [query.line] - Line value to match.
 * @param {Object} row - Row data to score against the query.
 * @param {string} [row.market] - Market name on the row.
 * @param {string} [row.selection] - Selection name on the row.
 * @returns {number} A positive relevance score; higher = more relevant.
 */
function scoreRow(query, row) {
  const text = JSON.stringify(row).toLowerCase();
  const marketText = normalizeMarketName(row.market || row.selection || '');
  let score = 0;
  if (query.player && text.includes(String(query.player).toLowerCase())) score += 4;
  if (query.market && marketText.includes(query.market)) score += 2;
  if (query.side && text.includes(normalizeDirection(query.side))) score += 1;
  if (query.line !== undefined && query.line !== null && text.includes(String(query.line))) score += 1;
  return score;
}

/**
 * Normalize a market name to its canonical short form.
 * Maps common variations (e.g. "pts", "player points") to a consistent string.
 * @param {string} value - Raw market name.
 * @returns {string} Normalized market name, or empty string if input is empty.
 */
function normalizeMarketName(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (['pts', 'point', 'points', 'player points', 'player point'].includes(raw)) return 'points';
  if (['ast', 'assists', 'player assists'].includes(raw)) return 'assists';
  if (['reb', 'rebound', 'rebounds', 'player rebounds'].includes(raw)) return 'rebounds';
  if (['pra', 'points + rebounds + assists', 'points rebounds assists'].includes(raw)) return 'points+rebounds+assists';
  return raw.replace(/\s+/g, ' ');
}

/**
 * Alias map for main-line markets. Each generic alias (e.g. "Total", "Spread") maps
 * to the per-league canonical market name used by the upstream API.
 *
 * Each alias entry is either:
 *   - An object keyed by league (e.g. { NHL: 'Total Goals', MLB: 'Total Runs' })
 *   - A plain string (used as-is regardless of league)
 *
 * Sources verified 2026-06-12 against the live SSB `/screen` endpoint.
 * Note: NBA/WNBA/NCAAB/NCAAF/NFL spread canonical name is "Point Spread",
 * not "Spread" — verified via live screen_raw call. Prior verification
 * (2026-06-09) missed this. Tennis resolves generic spread/handicap aliases
 * to the single canonical "Game Handicap" market; "Set Handicap" stays distinct.
 */
const MARKET_ALIASES = {
  // Generic main-line aliases → per-league canonical name
  total: {
    NHL: 'Total Goals',
    MLB: 'Total Runs',
    NBA: 'Total Points',
    WNBA: 'Total Points',
    NBASL: 'Total Points',
    NCAAB: 'Total Points',
    NCAAF: 'Total Points',
    NFL: 'Total Points',
    TENNIS: 'Total Games',
    UFC: 'Total Rounds',
    SOCCER: 'Total Goals',
    MLS: 'Total Goals'
  },
  spread: {
    NHL: 'Puck Line',
    MLB: 'Run Line',
    NBA: 'Point Spread',
    WNBA: 'Point Spread',
    NBASL: 'Point Spread',
    NCAAB: 'Point Spread',
    NCAAF: 'Point Spread',
    NFL: 'Point Spread',
    TENNIS: 'Game Handicap',
    SOCCER: 'Match Handicap',
    MLS: 'Match Handicap'
  },
  puck_line: { NHL: 'Puck Line' },
  run_line: { MLB: 'Run Line' },
  total_goals: { NHL: 'Total Goals', SOCCER: 'Total Goals', MLS: 'Total Goals' },
  total_runs: { MLB: 'Total Runs' },
  total_points: {
    NBA: 'Total Points',
    WNBA: 'Total Points',
    NBASL: 'Total Points',
    NCAAB: 'Total Points',
    NCAAF: 'Total Points',
    NFL: 'Total Points'
  },
  total_games: {
    NHL: 'Total Goals',
    MLB: 'Total Runs',
    NBA: 'Total Points',
    WNBA: 'Total Points',
    NBASL: 'Total Points',
    NCAAB: 'Total Points',
    NCAAF: 'Total Points',
    NFL: 'Total Points',
    TENNIS: 'Total Games',
    UFC: 'Total Rounds',
    SOCCER: 'Total Goals',
    MLS: 'Total Goals'
  },
  total_rounds: { UFC: 'Total Rounds' },
  // Common shorthand for run/puck line
  'run line': { MLB: 'Run Line' },
  rl: { MLB: 'Run Line' },
  pl: { NHL: 'Puck Line' },
  // Handicap aliases (common in tennis, soccer, NBA)
  handicap: {
    NHL: 'Puck Line',
    MLB: 'Run Line',
    NBA: 'Point Spread',
    WNBA: 'Point Spread',
    NBASL: 'Point Spread',
    NCAAB: 'Point Spread',
    NCAAF: 'Point Spread',
    NFL: 'Point Spread',
    TENNIS: 'Game Handicap',
    SOCCER: 'Match Handicap',
    MLS: 'Match Handicap'
  },
  game_handicap: {
    NHL: 'Puck Line',
    MLB: 'Run Line',
    NBA: 'Point Spread',
    WNBA: 'Point Spread',
    NBASL: 'Point Spread',
    NCAAB: 'Point Spread',
    NCAAF: 'Point Spread',
    NFL: 'Point Spread',
    TENNIS: 'Game Handicap',
    SOCCER: 'Match Handicap',
    MLS: 'Match Handicap'
  },
  set_handicap: { TENNIS: 'Set Handicap' },
  moneyline: { SOCCER: 'Draw No Bet', MLS: 'Draw No Bet' },
  match_handicap: { SOCCER: 'Match Handicap', MLS: 'Match Handicap' },
  draw_no_bet: { SOCCER: 'Draw No Bet', MLS: 'Draw No Bet' },
  // Over/Under aliases
  'over/under': {
    NHL: 'Total Goals',
    MLB: 'Total Runs',
    NBA: 'Total Points',
    WNBA: 'Total Points',
    NBASL: 'Total Points',
    NCAAB: 'Total Points',
    NCAAF: 'Total Points',
    NFL: 'Total Points',
    TENNIS: 'Total Games',
    UFC: 'Total Rounds',
    SOCCER: 'Total Goals',
    MLS: 'Total Goals'
  },
  ou: {
    NHL: 'Total Goals',
    MLB: 'Total Runs',
    NBA: 'Total Points',
    WNBA: 'Total Points',
    NBASL: 'Total Points',
    NCAAB: 'Total Points',
    NCAAF: 'Total Points',
    NFL: 'Total Points',
    TENNIS: 'Total Games',
    UFC: 'Total Rounds',
    SOCCER: 'Total Goals',
    MLS: 'Total Goals'
  },
  total_sets: { TENNIS: 'Total Sets' },
  // Player prop aliases
  points: { NBA: 'Player Points', NBASL: 'Player Points', WNBA: 'Player Points', NCAAB: 'Player Points' },
  rebounds: {
    NBA: 'Player Rebounds',
    NBASL: 'Player Rebounds',
    WNBA: 'Player Rebounds',
    NCAAB: 'Player Rebounds'
  },
  assists: {
    NBA: 'Player Assists',
    NBASL: 'Player Assists',
    WNBA: 'Player Assists',
    NCAAB: 'Player Assists',
    NHL: 'Player Assists'
  },
  pra: { NBA: 'Player PRA', NBASL: 'Player PRA', WNBA: 'Player PRA' },
  strikeouts: { MLB: 'Player Strikeouts' },
  passing_yards: { NFL: 'Player Passing Yards', NCAAF: 'Player Passing Yards' },
  rushing_yards: { NFL: 'Player Rushing Yards', NCAAF: 'Player Rushing Yards' },
  receiving_yards: { NFL: 'Player Receiving Yards', NCAAF: 'Player Receiving Yards' },
  receptions: { NFL: 'Player Receptions' },
  hits: { MLB: 'Player Hits' },
  home_runs: { MLB: 'Player Home Runs' },
  runs: { MLB: 'Player Runs' },
  rbis: { MLB: 'Player RBIs' },
  triples: { MLB: 'Player Triples' },
  walks: { MLB: 'Player Walks' },
  earned_runs: { MLB: 'Pitcher Earned Runs Allowed' },
  walks_allowed: { MLB: 'Pitcher Walks Allowed' },
  outs_recorded: { MLB: 'Pitcher Outs Recorded' },
  hits_runs_rbis: { MLB: 'Player Hits + Runs + RBIs' },
  outs: { MLB: 'Pitcher Outs Recorded' },
  hits_allowed: { MLB: 'Pitcher Hits Allowed' },
  goals: { NHL: 'Player Goals', SOCCER: 'Player Goals', MLS: 'Player Goals' },
  shots: { NHL: 'Player Shots' },
  saves: { NHL: 'Player Saves' }
};

/**
 * Normalize a league name the same way `normalizeLeagueName` does, returning an
 * uppercase canonical key suitable for MARKET_ALIASES lookups.
 * @param {string} value - Raw league name.
 * @returns {string} Uppercase canonical league name.
 */
function _aliasLeagueKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

/**
 * Resolve a market name input (which may be a generic alias like "Total" or
 * "Spread") into the canonical per-league market name used by the upstream API.
 *
 * Examples:
 *   resolveMarketName('Total', 'NHL')    => 'Total Goals'
 *   resolveMarketName('Spread', 'MLB')   => 'Run Line'
 *   resolveMarketName('Moneyline', 'NBA') => 'Moneyline'   (no alias, passthrough)
 *   resolveMarketName(undefined, 'NBA')  => 'Moneyline'   (default)
 *
 * The return value is `{ resolved, wasAliased, original, aliasKey }`:
 *   - resolved:    the canonical market name to use in the upstream query
 *   - wasAliased:  true if an alias was applied (i.e. the input was a generic
 *                  name like "Total" that mapped to a league-specific name)
 *   - original:    the original input string (post-trim, pre-normalization)
 *   - aliasKey:    the alias key that was matched (e.g. "total"), or null
 *
 * @param {string|undefined} input - The market name from the caller.
 * @param {string} league - League name (will be uppercased for lookup).
 * @returns {{ resolved: string, wasAliased: boolean, original: string, aliasKey: string|null }}
 */
function resolveMarketName(input, league) {
  const original = String(input == null ? '' : input).trim();
  const leagueKey = _aliasLeagueKey(league);

  // Empty input → default to Moneyline, no alias
  if (!original) {
    return { resolved: 'Moneyline', wasAliased: false, original, aliasKey: null };
  }

  // Normalize: lowercase, collapse spaces to underscores
  const aliasKey = original.toLowerCase().replace(/\s+/g, '_');
  const aliasEntry = Object.prototype.hasOwnProperty.call(MARKET_ALIASES, aliasKey)
    ? MARKET_ALIASES[aliasKey]
    : undefined;

  if (aliasEntry) {
    // Object form: { NHL: 'Total Goals', ... }
    if (typeof aliasEntry === 'object' && aliasEntry !== null) {
      // Try league-specific first
      if (leagueKey && Object.prototype.hasOwnProperty.call(aliasEntry, leagueKey)) {
        return { resolved: aliasEntry[leagueKey], wasAliased: true, original, aliasKey };
      }
      // No league-specific entry — pass through unchanged (don't fall back to another league's entry)
    }
    // String form: use as-is
    if (typeof aliasEntry === 'string') {
      return { resolved: aliasEntry, wasAliased: true, original, aliasKey };
    }
  }

  // No alias matched — passthrough unchanged
  return { resolved: original, wasAliased: false, original, aliasKey: null };
}

/**
 * Normalize a direction string to 'over', 'under', or empty.
 * @param {string} value - Raw direction (e.g. 'o', 'over', '+', 'u', 'under', '-').
 * @returns {string} 'over', 'under', or empty string if input is empty.
 */
function normalizeDirection(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (['o', 'over', '+'].includes(raw)) return 'over';
  if (['u', 'under', '-'].includes(raw)) return 'under';
  return raw;
}

/**
 * Normalize a league name to its canonical abbreviation.
 * @param {string} value - Raw league name (e.g. 'nba', 'baseball', 'college basketball').
 * @returns {string} Canonical league abbreviation or uppercase original.
 */
function normalizeLeagueName(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase();
  if (!raw) return '';
  if (raw === 'NCAAB' || raw === 'COLLEGE BASKETBALL') return 'NCAAB';
  if (raw === 'NCAAF' || raw === 'COLLEGE FOOTBALL') return 'NCAAF';
  if (raw === 'MLB' || raw === 'BASEBALL') return 'MLB';
  if (raw === 'NBA' || raw === 'BASKETBALL') return 'NBA';
  if (raw === 'WNBA' || raw === "WOMEN'S BASKETBALL") return 'WNBA';
  if (raw === 'NFL' || raw === 'FOOTBALL') return 'NFL';
  if (raw === 'NHL' || raw === 'HOCKEY') return 'NHL';
  if (raw === 'SOCCER' || raw === 'FUTBOL' || raw === 'FOOTBALL/SOCCER') return 'SOCCER';
  if (raw === 'MLS' || raw === 'MAJOR LEAGUE SOCCER') return 'MLS';
  if (raw === 'TENNIS') return 'TENNIS';
  if (raw === 'UFC' || raw === 'MMA') return 'UFC';
  if (raw === 'NBASL' || raw === 'NBA SUMMER LEAGUE' || raw === 'NBA SUMMER' || raw === 'SUMMER LEAGUE') return 'NBASL';
  return raw;
}

/**
 * Check if a book name matches the preferred book (case-insensitive).
 * @param {string} bookName - Book name to check.
 * @param {string} preferredBook - Preferred book name.
 * @returns {boolean} True if the book matches the preferred book.
 */
function matchesPreferredBook(bookName, preferredBook) {
  const normalizedBook = String(bookName || '')
    .trim()
    .toLowerCase();
  const normalizedPreferred = String(preferredBook || '')
    .trim()
    .toLowerCase();
  return Boolean(normalizedBook && normalizedPreferred && normalizedBook === normalizedPreferred);
}

/**
 * Strip null, empty-string, empty-array, and empty-object fields from a row.
 * If `keepFields` is provided, only those fields are retained (with their original
 * values, even if null/empty); all other fields are dropped. Without `keepFields`,
 * the row is returned with all empty-valued fields removed.
 * The input object is not mutated.
 * @param {Object} row - The response row to compact.
 * @param {string[]} [keepFields] - Optional allow-list of field names to keep verbatim.
 * @returns {Object} A new object with the compacted fields.
 */
function compactRow(row, keepFields) {
  if (row === null || typeof row !== 'object') return {};
  const isEmptyValue = (v) =>
    v === null ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
  if (Array.isArray(keepFields)) {
    const allow = new Set(keepFields);
    const out = {};
    for (const k of allow) {
      if (k in row) out[k] = row[k];
    }
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!isEmptyValue(v)) out[k] = v;
  }
  return out;
}

/**
 * Normalize text by collapsing whitespace, trimming, and lowercasing.
 * @param {string} value - Raw text to normalize.
 * @returns {string} Normalized text, or empty string if input is empty/undefined.
 */
function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const { getOddsHistoryLookbackHours, DEFAULT_ODDS_HISTORY_CACHE_TTL_MS } = require('./mcp-runtime-config');
const { runScope, createScopedInflight, throwIfScopeAborted } = require('./async-scope');

/**
 * Run an async worker over an array with a bounded concurrency cap. Unlike
 * Promise.all (which fires every task at once), this processes at most
 * `concurrency` items in flight at any time — the right shape for fanning
 * out HTTP calls without hammering the backend. The worker receives
 * `(item, index)` and results preserve the input order.
 *
 * Behavior matches the original implementation in scripts/server/handlers.js;
 * it was extracted here so lib/ modules (sharp-plays-service, screen-tennis,
 * research-runner) can use the same primitive without depending on the
 * handlers module.
 *
 * @template T, R
 * @param {Array<T>} items - Items to process. Non-arrays are treated as empty.
 * @param {(item: T, index: number) => Promise<R>} worker - Async worker fn.
 * @param {Object} [options]
 * @param {number} [options.concurrency=6] - Max in-flight workers.
 * @returns {Promise<R[]>} Results in input order.
 */
function mapWithConcurrency(items, worker, { concurrency = 6 } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return Promise.resolve([]);

  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < list.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(list[currentIndex], currentIndex);
    }
  }

  return Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => runWorker())).then(() => results);
}

/**
 * Bound a single league×market fan-out task so one slow/never-resolving pair
 * cannot hang the whole mixed scan and erase every other league's results.
 *
 * Wraps `worker(item)` in a Promise.race against a timer. Each pair runs
 * inside its own cooperative cancellation scope (see lib/async-scope.js):
 * on timeout the scope's signal is aborted, so the underlying provider work
 * (screen/odds-history network calls, queue waits, retries) sees the abort
 * via the current-scope signal and stops starting NEW requests. The fan-out
 * resolves with a structured timeout error instead of leaving the pair's slot
 * forever empty — the caller records the failure and continues, so sibling
 * leagues keep their rows. Sibling pairs use independent scopes, so aborting
 * one never touches another.
 *
 * @param {(item:any, index?:number)=>Promise<any>} worker
 * @param {number} timeoutMs - Per-pair budget. Bounded default so a mixed
 *   scan with N pairs can't take N×unbounded; siblings still get their slice.
 * @param {Object} [opts]
 * @param {string|((item:any, index?:number)=>string)} [opts.label] - Static
 *   league/market string, or a function resolved per item for a precise label.
 * @returns {(item:any, index?:number)=>Promise<any>}
 */
function withPairTimeout(worker, timeoutMs, { label = '' } = {}) {
  const ms = Math.max(1, Math.floor(Number(timeoutMs) || 1));
  const resolveLabel = typeof label === 'function' ? label : () => String(label || '');
  return async (item, index) => {
    const labelText = resolveLabel(item, index);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Deadline reached: fire the pair's cancellation scope so the
        // underlying provider work (in-flight request gets the composed
        // abort signal; queued/retry waits bail; no NEW requests start).
        if (!scope.controller.signal.aborted) scope.controller.abort();
        reject(
          Object.assign(new Error(`pair timed out after ${ms}ms${labelText ? ` (${labelText})` : ''}`), {
            code: 'PAIR_TIMEOUT',
            timeoutMs: ms
          })
        );
      }, ms);
    });
    // Run each pair inside its own cancellation scope so provider work started
    // by the worker (and its descendants) can observe the deadline.
    const scope = runScope(async () => Promise.race([worker(item, index), timeout]));
    try {
      return await scope.promise;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Normalize params for use as a cache key.
 * Sorts arrays and object keys alphabetically before JSON serialization
 * to ensure that params with identical values but different ordering
 * produce the same cache key. This enables concurrent deduplication
 * of screen requests with logically equivalent but differently-ordered params.
 *
 * @param {*} value - The value to normalize.
 * @returns {*} The normalized value, suitable for JSON.stringify.
 */
function normalizeParamsForKey(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    // Sort arrays after normalizing each element
    return value.map(normalizeParamsForKey).sort();
  }
  if (typeof value === 'object') {
    // Sort object keys alphabetically after normalizing each value
    const sortedKeys = Object.keys(value).sort();
    const result = {};
    for (const key of sortedKeys) {
      result[key] = normalizeParamsForKey(value[key]);
    }
    return result;
  }
  // Primitives (string, number, boolean) pass through unchanged
  return value;
}

/**
 * Wrap an async function with a long-lived, in-process LRU cache plus an
 * in-flight mutex. The cache is shared across all callers (and across tool
 * invocations within the same process) so a "screen_ranked then validate_play"
 * workflow reuses the same /odds_history_new response instead of refetching
 * it on the second call. The mutex prevents N concurrent calls for the same
 * key from firing N independent network requests — exactly one wins the
 * race, the rest await its promise.
 *
 * The cache is per-key, per-process. It does NOT survive a process restart;
 * that's intentional (we never want to serve stale data across the auth
 * refresh boundary, and a 5-minute TTL is short enough to make this a
 * non-issue in practice).
 *
 * @template T
 * @param {Function} fn - The async function to memoize. Receives a single
 *   `params` object; must be JSON-serializable for the cache key to work.
 * @param {Object} options
 * @param {import('./ssb-lru-cache').LruCache} options.cache - The LRU
 *   cache to use. Caller controls TTL + max-entries.
 * @param {(params: object) => string} [options.keyFn] - Optional cache-key
 *   function. Defaults to normalizeParamsForKey for stable key generation.
 * @returns {Function} A memoized version of `fn` with the same signature.
 */
function createCrossCallMemoizedQuery(
  fn,
  opts = /** @type {{ cache: import('./ssb-lru-cache').LruCache, keyFn?: (params: any) => string }} */ ({})
) {
  const { cache, keyFn = normalizeParamsForKey } = opts;
  if (typeof fn !== 'function') {
    throw new TypeError('createCrossCallMemoizedQuery: fn must be a function');
  }
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    throw new TypeError('createCrossCallMemoizedQuery: cache must be an LRU-like object');
  }
  // In-flight mutex — separate from the cache so a pending request doesn't
  // have to wait for a TTL expiry. Map<key, Promise>.
  const getInflight = createScopedInflight();

  return async function memoized(params) {
    throwIfScopeAborted();
    const inflight = getInflight();
    const key = keyFn(params || {});
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      try {
        const result = await fn(params);
        // Only cache successful results. Failures shouldn't poison the cache
        // for the full TTL — the next caller retries from scratch.
        throwIfScopeAborted();
        cache.set(key, result, DEFAULT_ODDS_HISTORY_CACHE_TTL_MS);
        return result;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  };
}

/**
 * Every league the SSB backend supports. Used as the default
 * `leagues` argument for tool calls and CLI scans when the caller doesn't
 * supply one. Order matches the API request shape (main US sports first,
 * then college, then international / niche).
 *
 * Case matches the `leagues` payload field on the upstream `/screen` POST
 * (see lib/ssb-api.js → queryScreenOddsBestComps). Internal
 * canonicalization (UPPERCASE keys for getLeagueRankingPreset) is handled
 * by normalizeLeagueName().
 *
 * Source of truth — update here when the backend adds or removes a league,
 * then update the matching test in test/ssb-shared-utils.test.js.
 */
const DEFAULT_LEAGUES = Object.freeze([
  'NBA',
  'NBASL',
  'MLB',
  'NFL',
  'NHL',
  'WNBA',
  'NCAAB',
  'NCAAF',
  'Soccer',
  'MLS',
  'Tennis',
  'UFC'
]);

/**
 * Compute a Unix timestamp (seconds) representing the start of the odds-history lookback window.
 * @param {Object} [options] - Options object.
 * @param {number} [options.lookbackHours] - Number of hours to look back. Falls back to runtime config if omitted.
 * @param {number} [options.nowMs] - Current time in milliseconds. Defaults to Date.now().
 * @returns {number} Unix timestamp in seconds (always >= 0).
 */
function getOddsHistoryStartTimestamp({ lookbackHours = getOddsHistoryLookbackHours(), nowMs = Date.now() } = {}) {
  const safeHours = getOddsHistoryLookbackHours(lookbackHours);
  const now = Number(nowMs);
  const safeNowMs = Number.isFinite(now) ? now : Date.now();
  return Math.max(0, Math.floor(safeNowMs / 1000) - Math.floor(safeHours * 60 * 60));
}

/**
 * Normalize a row by lifting selections.null contents to top level.
 *
 * SSB API returns `selections: { "null": {...} }` and `defaultKey: "null"`
 * for non-prop markets (moneyline, spread, total). The literal string "null" is the
 * API's convention for "no sub-market key", but it leaks through to consumers as a
 * real string.
 *
 * This function:
 * - Lifts contents of `selections.null` to the top level of the row
 * - Removes `defaultKey` when it equals the string "null"
 * - Preserves player props (selections with real player names as keys)
 * - Returns a new object without mutating the input
 *
 * @param {Object} row - Row data from the API.
 * @returns {Object} Normalized row with selections.null lifted and defaultKey removed if "null".
 */
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;

  // Check if we have selections.null (the string "null" as a key)
  const hasNullSelections =
    row.selections &&
    typeof row.selections === 'object' &&
    Object.prototype.hasOwnProperty.call(row.selections, 'null');

  if (!hasNullSelections) {
    // No selections.null to lift - return row as-is (but still check defaultKey)
    if (row.defaultKey === 'null') {
      const out = { ...row };
      delete out.defaultKey;
      return out;
    }
    return { ...row };
  }

  // Lifting selections.null contents to top level
  const { null: nullSelections, ...restOfSelections } = row.selections;
  const liftedRow = {
    ...row,
    ...nullSelections,
    selections: Object.keys(restOfSelections).length > 0 ? restOfSelections : undefined
  };

  // Remove defaultKey if it's the string "null"
  if (liftedRow.defaultKey === 'null') {
    const out = { ...liftedRow };
    delete out.defaultKey;
    return out;
  }

  return liftedRow;
}

/**
 * Normalize screen args to a canonical key tuple for stable (gameId, market, book) caching.
 * Returns null when gameId is absent (full-league scan) since those queries
 * have dynamic fields (different book, different league) and shouldn't be cached.
 *
 * The key is order-independent for array fields (leagues, markets, books).
 *
 * @param {Object} args - The args object from a screen query.
 * @param {string|string[]} [args.gameId] - Single game ID or array of IDs.
 * @param {string|string[]} [args.league] - Singular league name (used by get_play_details / screen_ranked).
 * @param {string|string[]} [args.leagues] - Array of league names.
 * @param {string|string[]} [args.market] - Singular market name (used by get_play_details / screen_ranked).
 * @param {string|string[]} [args.markets] - Array of market names.
 * @param {string[]} [args.books] - Array of book names.
 * @param {string} [args.selection] - Optional exact selection filter.
 * @returns {string|null} Canonical key string, or null if gameId is absent.
 */
function canonicalizeScreenArgs(args) {
  const a = /** @type {any} */ (args);
  if (!a || typeof a !== 'object') return null;

  // Extract gameId - support both gameId (string) and gameIds (array)
  let gameId = null;
  if (a.gameId && typeof a.gameId === 'string') {
    gameId = a.gameId.trim();
  } else if (Array.isArray(a.gameIds) && a.gameIds.length > 0) {
    const firstId = a.gameIds[0];
    if (firstId && typeof firstId === 'string') {
      gameId = firstId.trim();
    }
  }

  // Return null for full-league scans (no gameId filter)
  if (!gameId) return null;

  // Normalize arrays to sorted, unique values for order-independence.
  // Singular league/market (used by get_play_details / screen_ranked) are
  // folded into the same buckets as the plural forms so the canonical key is
  // identical regardless of which shape the caller used — and so an NBA
  // Moneyline cannot collapse onto an MLB Total Runs for the same gameId/books.
  const normalizeArray = (arr) => {
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.map((v) => String(v || '').trim()).filter(Boolean))].sort();
  };

  const leagues = normalizeArray([...(args.leagues || []), ...(args.league ? [args.league] : [])]);
  const markets = normalizeArray([...(args.markets || []), ...(args.market ? [args.market] : [])]);
  const books = normalizeArray(args.books);
  const selection =
    typeof args.selection === 'string'
      ? args.selection
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, ' ')
      : '';

  // Build canonical tuple: gameId, league, market, book, selection.
  // Selection must be part of the key because exact-line rechecks and broad
  // game lookups can share the same game/market/book tuple but return
  // different post-filtered results.
  return JSON.stringify({
    gameId,
    leagues,
    markets,
    books,
    selection
  });
}

/**
 * Create a canonical screen cache for stable (gameId, market, book) tuples.
 * This cache is keyed on the canonical tuple rather than the full request signature,
 * making it suitable for the drill-down flow where the same row gets re-fetched
 * with different metadata.
 *
 * @param {Object} options
 * @param {number} options.ttlMs - Time-to-live in milliseconds.
 * @param {number} options.maxEntries - Maximum cache entries (must be positive integer).
 * @returns {Object} Cache object with get, set, stats, and memoize methods.
 */
function createCanonicalScreenCache({ ttlMs, maxEntries }) {
  // Validate inputs
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('createCanonicalScreenCache: maxEntries must be a positive integer');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('createCanonicalScreenCache: ttlMs must be a positive number');
  }

  const { LruCache } = require('./ssb-lru-cache');
  const cache = new LruCache(maxEntries);

  // In-flight mutex for deduplication
  const inflight = new Map();

  /**
   * Get a value from the cache.
   * @param {string} key
   * @returns {*} The cached value or undefined.
   */
  function get(key) {
    return cache.get(key);
  }

  /**
   * Set a value in the cache.
   * @param {string} key
   * @param {*} value
   */
  function set(key, value) {
    cache.set(key, value, ttlMs);
  }

  /**
   * Get cache statistics.
   * @returns {Object} Stats object.
   */
  function stats() {
    return cache.stats();
  }

  /**
   * Memoize an async function with in-flight deduplication.
   * Only caches when the key is non-null (gameId present).
   * Returns a callable function that invokes the memoized operation.
   * @param {Function} fn - Async function to memoize.
   * @param {string|null} key - Cache key (null means skip caching).
   * @returns {Function} A callable that returns a promise.
   */
  function memoize(fn, key) {
    // If key is null (full-league scan), skip caching entirely
    if (key === null) {
      return () => fn();
    }

    return async () => {
      // Check cache first
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      // Check in-flight mutex
      if (inflight.has(key)) {
        return inflight.get(key);
      }

      // Start the async operation
      const promise = fn()
        .then((result) => {
          inflight.delete(key);
          cache.set(key, result, ttlMs);
          return result;
        })
        .catch((err) => {
          inflight.delete(key);
          throw err;
        });

      inflight.set(key, promise);
      return promise;
    };
  }

  return {
    get,
    set,
    stats,
    memoize,
    // Expose the underlying LruCache for direct access if needed
    _cache: cache
  };
}

module.exports = {
  DEFAULT_LEAGUES,
  MARKET_ALIASES,
  americanOddsToImpliedProbability,
  average,
  canonicalizeScreenArgs,
  compactRow,
  computeRestDays,
  createCanonicalScreenCache,
  createCrossCallMemoizedQuery,
  fetchJson,
  getOddsHistoryStartTimestamp,
  isBackToBack,
  mapWithConcurrency,
  matchesPreferredBook,
  withPairTimeout,
  nameSimilarity,
  normalizeDirection,
  normalizeLeagueName,
  normalizeMarketName,
  normalizeName,
  normalizeRow,
  normalizeText,
  parseDateUtc,
  parseGameStartMs,
  parseHistoryTimeMs,
  resolveMarketName,
  scoreRow
};
