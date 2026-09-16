'use strict';

// Sasser source adapter for the external-ratings benchmark layer.
//
// `davidsasser.com/cfb` publishes a per-game projection overlay for one college
// football week: both projected scores, the opening and current market lines, a
// projected line, and a model pick, under a page-level "Updated" line and a
// header model record. The root of `davidsasser.com` is a personal portfolio, so
// only the verified `/cfb` route is ever fetched; this adapter never guesses a
// sibling path such as `/massey`.
//
// The page is a Next.js app whose model data is server-rendered inside the RSC
// flight stream as `self.__next_f.push([1,"<escaped stream>"])`; there is no HTML
// table to scrape. `normalizeSasser` decodes those flight chunks and reads the
// `week` object out of the reconstructed stream. The HTTP call is injected via
// `fetchSasser`, so parsing stays pure and network-free.
//
// Three deliberate decisions:
//
//   1. CFB only. Sasser publishes no other sport, so every other league is
//      `coverage: 'unavailable'` with a reason, never an empty success.
//   2. `asOf` is the page's own "Updated" line, stored separately from our own
//      `fetchedAt`. The line names a weekday and a date but no year, so the year
//      comes from the page's `season`.
//   3. This is a projection overlay, not a rating: `ratingA`/`ratingB` are null
//      and `coverage: 'partial'` by design. It also publishes no win
//      probability, so none is derived from the projected scores.
//
// Contract-field conventions used here:
//
//   - `teamA` is the feed's **home** team and `teamB` the away team, so
//     `predictedScoreA/B`, `predictedTotal` and `predictedMargin`
//     (`predictedScoreA - predictedScoreB`) are home-then-away. The page's own
//     `market.projected` line is away-minus-home, so it equals
//     `-predictedMargin`; the score projection is the source of truth.
//   - `marketOpen`/`marketCurrent` are the printed spread lines re-oriented to
//     `teamA`: the page prints the favorite with a negative number, so a line
//     naming the away team is negated to stay teamA-relative (matching the
//     contract's own `marketOpen: -7.5` / `predictedMargin: 6.5` example).
//
// The page-level header model record (straight-up and ATS) and the per-game
// model pick have no contract field, so they are deliberately not carried
// (YAGNI), the same call the Massey adapter makes for `Pwr`/`Off`/`Def`/`SoS`.
//
// No third-party payload is bundled here: `normalizeSasser` returns derived
// records, and callers persist them in the local state dir via
// `lib/ssb-ratings-snapshot.js`.

const crypto = require('node:crypto');

const { supportedLeagues: contractSupportedLeagues, validateRatingRecord } = require('../ssb-ratings-contract');
const { canonicalTeam } = require('../ssb-ratings-team-aliases');
const { getSupportedLeagues } = require('../league-presets');

const SOURCE = 'sasser';
const METHOD = 'model_v1';

// The only verified model route; see the module header.
const SOURCE_URL = 'https://davidsasser.com/cfb';

// The repo's canonical league registry (lib/league-presets.js): every league
// code the ranker knows, so a real league Sasser does not cover (UFC, Tennis,
// NFL) is reported as a scope gap and only a code outside the repo's league
// universe (a caller typo) is reported as unrecognized. Sourced from the
// ranking registry rather than a local copy so a new league cannot drift into
// the "unrecognized" bucket.
const RECOGNIZED_LEAGUES = new Set(getSupportedLeagues());

// The plan/CLI vocabulary says CFB; the contract's canonical code is NCAAF.
const LEAGUE_ALIASES = Object.freeze({ CFB: 'NCAAF' });

const MONTHS = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
});

// The week object's first key is `season`; the flight stream is minified.
const WEEK_START_PATTERN = /\{\s*"season"\s*:/g;
// `Monday, September 14 · 11:30 AM CT` (year is absent and comes from `season`).
const UPDATED_PATTERN = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i;
// A printed spread line: `<team> <sign><number>`. The minus is U+2212 upstream.
const SPREAD_PATTERN = /^(.*?)\s*([+\u2212\u2013-])\s*(\d+(?:\.\d+)?)$/;
// Each Next.js flight chunk pushes a JSON string literal onto `self.__next_f`.
const PUSH_PATTERN = /self\.__next_f\.push\(\[\d+,("(?:[^"\\]|\\.)*")\]\)/g;

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Sasser's canonical league codes (CFB only). */
function supportedLeagues() {
  return contractSupportedLeagues(SOURCE);
}

function canonicalLeague(league) {
  const code = String(league).trim().toUpperCase();
  return LEAGUE_ALIASES[code] || code;
}

/**
 * Why a league has no Sasser model page, or `null` when it does.
 *
 * A real canonical league this adapter does not cover (a scope gap) is kept
 * distinct from a code that is not a canonical league at all (a caller typo),
 * so a mistyped league is not hidden behind a plausible coverage excuse - and a
 * real league like UFC or Tennis is never called "not a canonical league code".
 *
 * @param {unknown} league
 * @returns {string | null}
 */
function unsupportedReason(league) {
  if (typeof league !== 'string' || league.trim() === '') {
    return 'sasser requires a canonical league code';
  }
  const code = canonicalLeague(league);
  if (code === 'NCAAF') return null;
  if (RECOGNIZED_LEAGUES.has(code)) return `${code} is not covered by the ${SOURCE} benchmark adapter`;
  return `${code} is not a recognized league code`;
}

/** The model page, or `null` when the league is unsupported. */
function pageUrlFor(league) {
  return unsupportedReason(league) === null ? SOURCE_URL : null;
}

// ---------------------------------------------------------------------------
// Fetch (injected transport only)
// ---------------------------------------------------------------------------

function resolveFetchedAt(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString();
  if (typeof now === 'string' && Number.isFinite(Date.parse(now))) return new Date(Date.parse(now)).toISOString();
  return new Date().toISOString();
}

/**
 * Fetch the Sasser model page. The HTTP transport is injected so tests stay
 * network-free and the caller owns timeout/retry policy.
 *
 * @param {{ league: string, fetchImpl: Function, now?: Date | string }} options
 * @returns {Promise<{ raw: string, sourceUrl: string, fetchedAt: string }>}
 */
async function fetchSasser(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { fetchImpl, league, now } = opts;
  if (typeof fetchImpl !== 'function') {
    throw new Error('sasser: fetchSasser requires an injected fetchImpl (dependency-injected fetch)');
  }

  const reason = unsupportedReason(league);
  if (reason) {
    const err = /** @type {any} */ (new Error(`sasser: ${reason}`));
    err.code = 'unsupported_league';
    throw err;
  }

  const res = await fetchImpl(SOURCE_URL, { headers: { Accept: 'text/html' } });
  if (!res || res.ok === false) {
    const status = res && res.status ? res.status : 'unknown';
    throw new Error(`sasser: HTTP ${status} from ${SOURCE_URL}`);
  }
  if (typeof res.text !== 'function') {
    throw new Error('sasser: fetchImpl response has no text() body');
  }
  const raw = await res.text();
  return { raw: String(raw), sourceUrl: SOURCE_URL, fetchedAt: resolveFetchedAt(now) };
}

// ---------------------------------------------------------------------------
// Flight-stream extraction
// ---------------------------------------------------------------------------

/**
 * Concatenate the Next.js RSC flight chunks into the reconstructed stream. A
 * malformed chunk is skipped; the payload search fails closed if none survive.
 *
 * @param {unknown} html
 * @returns {string}
 */
function readFlightStream(html) {
  const text = String(html || '');
  const chunks = [];
  PUSH_PATTERN.lastIndex = 0;
  let match;
  while ((match = PUSH_PATTERN.exec(text)) !== null) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {
      // Ignore: a non-JSON chunk carries no model data.
    }
  }
  return chunks.join('');
}

/**
 * Slice the balanced `{...}` object starting at `start`, string-aware.
 *
 * @param {string} text
 * @param {number} start - index of the opening `{`
 * @returns {string | null}
 */
function sliceBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Recover the `week` object (which carries `games`) from the flight stream, or
 * `null` when the page does not contain one.
 *
 * @param {string} stream
 * @returns {Record<string, any> | null}
 */
function extractWeekObject(stream) {
  const text = String(stream || '');
  WEEK_START_PATTERN.lastIndex = 0;
  let match;
  while ((match = WEEK_START_PATTERN.exec(text)) !== null) {
    const candidate = sliceBalancedObject(text, match.index);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.games)) return parsed;
    } catch {
      // Not the week object; keep scanning.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Parse the page's "Updated <weekday>, <Month> <day> · <time>" line into an
 * ISO date, taking the year from the page's `season` when the line omits it.
 * Kept separate from `fetchedAt` on purpose.
 *
 * @param {unknown} value
 * @param {number | null} fallbackYear
 * @returns {string | null}
 */
function parseUpdatedAt(value, fallbackYear) {
  const match = UPDATED_PATTERN.exec(String(value || ''));
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = match[3] ? Number(match[3]) : fallbackYear;
  if (!month || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function foldName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Re-orient a printed spread line ("Pittsburgh −10.5", "Miami −21.0") to be
 * teamA-relative: the page prints the favorite with a negative number, so a
 * line naming the away team is negated. `null` when the line is unreadable or
 * names neither team (fail closed rather than mis-signing a value).
 *
 * @param {unknown} text
 * @param {string} homeName
 * @param {string} awayName
 * @returns {number | null}
 */
function orientSpread(text, homeName, awayName) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const match = SPREAD_PATTERN.exec(text.trim());
  if (!match) return null;
  const named = foldName(match[1]);
  const magnitude = Number(match[3]);
  if (named === '' || !Number.isFinite(magnitude)) return null;
  const value = match[2] === '+' ? magnitude : -magnitude;
  if (named === foldName(homeName)) return value;
  if (named === foldName(awayName)) return -value;
  return null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nameOf(side) {
  if (!side || typeof side !== 'object') return null;
  return typeof side.name === 'string' && side.name.trim() !== '' ? side.name.trim() : null;
}

function describeGame(game) {
  if (!game || typeof game !== 'object') return String(game).slice(0, 120);
  return `${nameOf(game.away) || '?'} @ ${nameOf(game.home) || '?'}`;
}

/**
 * Turn one game from the week payload into a contract record, or `null` when it
 * carries no usable matchup.
 *
 * @param {Record<string, any>} context
 * @returns {Record<string, any> | null}
 */
function buildRecord(context) {
  const { game, league, season, asOf, fetchedAt, sourceUrl, sourceHash } = context;
  const homeName = nameOf(game.home);
  const awayName = nameOf(game.away);
  if (!homeName || !awayName) return null;

  const projection = game.projection && typeof game.projection === 'object' ? game.projection : {};
  const market = game.market && typeof game.market === 'object' ? game.market : {};
  const homeScore = finiteOrNull(projection.homeScore);
  const awayScore = finiteOrNull(projection.awayScore);
  const scored = homeScore !== null && awayScore !== null;

  const homeKey = canonicalTeam(homeName, league);
  const awayKey = canonicalTeam(awayName, league);
  const unresolvedName = !homeKey ? homeName : !awayKey ? awayName : null;

  return {
    source: SOURCE,
    method: METHOD,
    league,
    season,
    asOf,
    fetchedAt,
    sourceUrl,
    sourceHash,
    eventId: typeof game.id === 'string' && game.id.trim() !== '' ? game.id.trim() : null,
    teamA: homeKey || homeName,
    teamB: awayKey || awayName,
    neutral: typeof game.neutralSite === 'boolean' ? game.neutralSite : null,
    ratingA: null,
    ratingB: null,
    predictedScoreA: homeScore,
    predictedScoreB: awayScore,
    predictedTotal: scored ? homeScore + awayScore : null,
    predictedMargin: scored ? homeScore - awayScore : null,
    homeAdvantage: null,
    marketOpen: orientSpread(market.openingSpread, homeName, awayName),
    marketCurrent: orientSpread(market.currentSpread, homeName, awayName),
    // A per-game projection overlay is partial by design; see the module header.
    coverage: 'partial',
    matchStatus: unresolvedName === null ? 'unmatched' : 'unresolved',
    unresolvedReason:
      unresolvedName === null ? null : `${SOURCE} team "${unresolvedName}" has no canonical match in ${league}`
  };
}

function scanGames(games, context) {
  const records = [];
  const skipped = [];
  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    const record = game && typeof game === 'object' ? buildRecord({ ...context, game }) : null;
    if (!record) {
      skipped.push({ line: i + 1, text: describeGame(game), reason: 'unreadable_game' });
      continue;
    }
    const validation = validateRatingRecord(record);
    if (!validation.ok) {
      skipped.push({ line: i + 1, text: describeGame(game), reason: 'invalid_record', errors: validation.errors });
      continue;
    }
    records.push(validation.record);
  }
  return { records, skipped };
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function unavailable({ league, reason, sourceUrl, sourceHash, fetchedAt }) {
  return {
    source: SOURCE,
    league,
    method: METHOD,
    season: null,
    asOf: null,
    fetchedAt: fetchedAt || null,
    sourceUrl,
    sourceHash,
    coverage: 'unavailable',
    records: [],
    skipped: [],
    unresolvedReason: reason
  };
}

/**
 * Normalize the Sasser model page into contract records.
 *
 * @param {{ raw: string, league: string, fetchedAt: string }} options
 * @returns {Record<string, any>}
 */
function normalizeSasser(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const league = canonicalLeague(opts.league);
  const fetchedAt = typeof opts.fetchedAt === 'string' ? opts.fetchedAt : null;
  const raw = typeof opts.raw === 'string' ? opts.raw : '';
  const sourceUrl = pageUrlFor(league);
  const sourceHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

  const reason = unsupportedReason(league);
  if (reason) return unavailable({ league, reason, sourceUrl, sourceHash, fetchedAt });

  const week = extractWeekObject(readFlightStream(raw));
  if (!week) {
    return unavailable({
      league,
      reason: `${SOURCE} week payload not found in page`,
      sourceUrl,
      sourceHash,
      fetchedAt
    });
  }

  const season = Number.isInteger(week.season) ? week.season : null;
  const asOf = parseUpdatedAt(week.updatedAt, season);
  const { records, skipped } = scanGames(Array.isArray(week.games) ? week.games : [], {
    league,
    season,
    asOf,
    fetchedAt,
    sourceUrl,
    sourceHash
  });

  return {
    source: SOURCE,
    league,
    method: METHOD,
    season,
    asOf,
    fetchedAt,
    sourceUrl,
    sourceHash,
    coverage: records.length === 0 ? 'unavailable' : 'partial',
    records,
    skipped,
    unresolvedReason: records.length === 0 ? `no readable ${SOURCE} game rows in week payload` : null
  };
}

module.exports = {
  SOURCE,
  SOURCE_URL,
  fetchSasser,
  normalizeSasser,
  supportedLeagues,
  unsupportedReason,
  pageUrlFor
};
