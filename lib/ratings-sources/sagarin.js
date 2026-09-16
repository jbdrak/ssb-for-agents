'use strict';

// Sagarin source adapter for the external-ratings benchmark layer.
//
// Sagarin publishes free legacy fixed-width HTML at `sagarin.com/sports/`. This
// adapter normalizes one of his team-ratings pages into the shared record
// contract (`lib/ssb-ratings-contract.js`). It is pure and network-free: the
// HTTP call is dependency-injected through `fetchSagarin`.
//
// Two things the page does that the adapter must not flatten:
//
//   1. The "through games of ..." heading date can lag the rows it sits above
//      (the Sep-3-6 benchmark snapshot carried an Aug-29 heading). The heading
//      is therefore parsed into `asOf` and stored separately from our own
//      `fetchedAt`; neither is derived from the other.
//   2. The regular predictions block and the separate EXPERIMENTAL home-away
//      block are different methods. They are parsed as different method values
//      (`overall`/... versus `experimental_overall`/...), so a caller can never
//      merge one block's margins into the other's.
//
// MLB is deliberately unsupported: Sagarin's baseball page publishes *player*
// ratings, so there is no team rating to normalize. That surfaces as
// `coverage: 'unavailable'` with a reason, never as empty success.
//
// No third-party payload is bundled here: `normalizeSagarin` returns derived
// records, and callers persist them in the local state dir via
// `lib/ssb-ratings-snapshot.js`.

const crypto = require('node:crypto');

const { supportedLeagues: contractSupportedLeagues, validateRatingRecord } = require('../ssb-ratings-contract');

const SOURCE = 'sagarin';
const BASE_URL = 'http://sagarin.com/sports/';

// Verified team-ratings pages. MLB is intentionally absent (see header).
const PAGE_BY_LEAGUE = Object.freeze({
  NCAAF: 'cfsend.htm',
  NFL: 'nflsend.htm',
  NBA: 'nbasend.htm',
  NCAAB: 'cbsend.htm',
  NHL: 'nhlsend.htm',
  MLS: 'soccer.htm'
});

// The frontend/plan vocabulary says CFB/CBB; the contract's canonical codes are
// NCAAF/NCAAB. Accept both, emit canonical.
const LEAGUE_ALIASES = Object.freeze({ CFB: 'NCAAF', CBB: 'NCAAB' });

const MLB_REASON = 'sagarin publishes player ratings for MLB, not team ratings';

// The label is `Predictions_with_Totals_and_Moneylines` on most pages but plain
// `Predictions_with_Totals` on the college-basketball page, so match the common
// prefix and take its last occurrence (the label, not the "click here" prose).
const REGULAR_MARKER = 'Predictions_with_Totals';
const EXPERIMENTAL_MARKER = 'EXPERIMENTAL NUMBERS INVOLVING HOME-AWAY ADJUSTMENTS';

// Method -> which block it comes from and which margin column supplies the
// prediction. `strong_recent` is another printed margin column but is not part
// of the plan's method vocabulary, so it is deliberately not exposed.
const METHOD_COLUMNS = Object.freeze({
  overall: { block: 'regular', column: 'rating' },
  predictor: { block: 'regular', column: 'predictor' },
  golden_mean: { block: 'regular', column: 'goldenMean' },
  recent: { block: 'regular', column: 'recent' },
  experimental_overall: { block: 'experimental', column: 'rating' },
  experimental_predictor: { block: 'experimental', column: 'predictor' },
  experimental_golden_mean: { block: 'experimental', column: 'goldenMean' },
  experimental_recent: { block: 'experimental', column: 'recent' }
});

const SAGARIN_METHODS = Object.freeze(Object.keys(METHOD_COLUMNS));
const DEFAULT_METHOD = 'overall';

// Row = index, favorite field, five margin columns, underdog field, then the
// money / win% / predicted-score tail. The trailing `HMARG WIN% MONEY` triple is
// printed on the CFB/NFL pages but omitted on the NBA/NHL pages, so it is
// optional. Anchored on numbers so team names may contain spaces and digits.
const ROW_PATTERN =
  /^\s*(\d{1,3})\s+(.+?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(.+?)\s+(-?\d+)\s+(-?\d+)%\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)(?:\s+(-?\d+\.\d+)\s+(-?\d+)%\s+(-?\d+))?\s*$/;

const COLUMN_INDEX = Object.freeze({ rating: 3, predictor: 4, goldenMean: 5, recent: 6 });
const FAVORITE_FIELD_INDEX = 2;
const UNDERDOG_FIELD_INDEX = 8;
const HOME_SCORE_INDEX = 11;
const AWAY_SCORE_INDEX = 12;
const TOTAL_INDEX = 13;

// `N` = neutral venue, `@` = home-or-closer team. The marker may repeat and may
// touch the name (`N @ Virginia`, `N@ Virginia`), and it must be followed by
// whitespace so that a team called "Nevada" is not mistaken for one.
const MARKER_PATTERN = /^([N@]{1,2})(?:\s+|$)(.*)$/;

const HOME_ADVANTAGE_PATTERN = /HOME ADVANTAGE=\s*\[?\s*(-?\d+(?:\.\d+)?)/i;
// `2026 June 13` (NBA/CBB spell the season 2025-2026) or just `September 14`
// (CFB/NFL/NHL). A year adjacent to the month wins; otherwise the last year
// printed before "through", never the first (season labels carry two).
const HEADING_PATTERN = /through (?:games|results) of\s+(?:(20\d{2})\s+)?([A-Za-z]+)\s+(\d{1,2})/i;

const MONTHS = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Sagarin's canonical league codes (MLB excluded). */
function supportedLeagues() {
  return contractSupportedLeagues(SOURCE);
}

/**
 * Why a league has no Sagarin team ratings, or `null` when it does.
 *
 * @param {unknown} league
 * @returns {string | null}
 */
function unsupportedReason(league) {
  if (typeof league !== 'string' || league.trim() === '') {
    return 'sagarin requires a canonical league code';
  }
  const code = canonicalLeague(league);
  if (code === 'MLB') return MLB_REASON;
  if (Object.prototype.hasOwnProperty.call(PAGE_BY_LEAGUE, code)) return null;
  return `${code} is not published by ${SOURCE}`;
}

function canonicalLeague(league) {
  const code = String(league).trim().toUpperCase();
  return LEAGUE_ALIASES[code] || code;
}

function sourceUrlFor(league) {
  const page = PAGE_BY_LEAGUE[canonicalLeague(league)];
  return page ? `${BASE_URL}${page}` : null;
}

// ---------------------------------------------------------------------------
// Fetch (injected transport only)
// ---------------------------------------------------------------------------

/**
 * Fetch one Sagarin ratings page. The HTTP transport is injected so tests stay
 * network-free and the caller owns timeout/retry policy.
 *
 * @param {{ league: string, fetchImpl: Function, now?: Date | string }} options
 * @returns {Promise<{ raw: string, sourceUrl: string, fetchedAt: string }>}
 */
async function fetchSagarin(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { fetchImpl, league, now } = opts;
  if (typeof fetchImpl !== 'function') {
    throw new Error('sagarin: fetchSagarin requires an injected fetchImpl (dependency-injected fetch)');
  }

  const reason = unsupportedReason(league);
  if (reason) {
    const err = /** @type {any} */ (new Error(`sagarin: ${reason}`));
    err.code = 'unsupported_league';
    throw err;
  }

  const sourceUrl = /** @type {string} */ (sourceUrlFor(league));
  const res = await fetchImpl(sourceUrl, { headers: { Accept: 'text/html' } });
  if (!res || res.ok === false) {
    const status = res && res.status ? res.status : 'unknown';
    throw new Error(`sagarin: HTTP ${status} from ${sourceUrl}`);
  }
  if (typeof res.text !== 'function') {
    throw new Error('sagarin: fetchImpl response has no text() body');
  }
  const raw = await res.text();
  return { raw: String(raw), sourceUrl, fetchedAt: resolveFetchedAt(now) };
}

function resolveFetchedAt(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString();
  if (typeof now === 'string' && Number.isFinite(Date.parse(now))) return new Date(Date.parse(now)).toISOString();
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

function monthNumber(name) {
  const key = String(name).toLowerCase();
  if (MONTHS[key]) return MONTHS[key];
  const prefix = Object.keys(MONTHS).find((month) => month.startsWith(key.slice(0, 3)));
  return prefix ? MONTHS[prefix] : null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Parse the page's "through games of <Month> <day>, <year>" heading into
 * `{ asOf, season }`. Split out from `fetchedAt` on purpose: the heading can be
 * stale relative to the rows it sits above.
 */
function parseHeading(line) {
  const match = HEADING_PATTERN.exec(line || '');
  if (!match) return null;
  const month = monthNumber(match[2]);
  const day = Number(match[3]);
  const year = match[1] ? Number(match[1]) : lastYearBefore(line, match.index);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31 || !year) return null;
  return { asOf: `${year}-${pad2(month)}-${pad2(day)}`, season: year };
}

/** Last 4-digit year printed before `index` (season labels carry two). */
function lastYearBefore(text, index) {
  const years = [
    ...String(text)
      .slice(0, index)
      .matchAll(/\b(20\d{2})\b/g)
  ].map((hit) => Number(hit[1]));
  return years.length > 0 ? years[years.length - 1] : null;
}

function parseHomeAdvantage(line) {
  const match = HOME_ADVANTAGE_PATTERN.exec(line || '');
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Nearest matching line at or before `before`, else the first in the page. */
function findNearest(lines, pattern, before) {
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    const hit = pattern(lines[i]);
    if (!hit) continue;
    if (i <= before) found = hit;
    else if (found === null) found = hit;
    else break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function splitMarkers(field) {
  let rest = String(field || '').trim();
  let markers = '';
  for (let guard = 0; guard < 4; guard++) {
    const match = MARKER_PATTERN.exec(rest);
    if (!match) break;
    markers += match[1];
    rest = match[2];
  }
  return { markers: markers.toUpperCase(), name: rest.trim() };
}

function numberAt(match, index) {
  const value = Number(match[index]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Turn one fixed-width game row into a contract record for the requested
 * method, or `null` when the row cannot be read confidently.
 */
function buildRecord(context) {
  const { match, method, league, asOf, season, fetchedAt, sourceUrl, sourceHash, homeAdvantage } = context;
  const favorite = splitMarkers(match[FAVORITE_FIELD_INDEX]);
  const underdog = splitMarkers(match[UNDERDOG_FIELD_INDEX]);
  if (!favorite.name || !underdog.name) return null;

  const neutral = favorite.markers.includes('N') || underdog.markers.includes('N');
  const homeScore = numberAt(match, HOME_SCORE_INDEX);
  const awayScore = numberAt(match, AWAY_SCORE_INDEX);
  const favoriteIsHome = favorite.markers.includes('@');
  const underdogIsHome = underdog.markers.includes('@');

  let scoreA = null;
  let scoreB = null;
  if (favoriteIsHome) {
    scoreA = homeScore;
    scoreB = awayScore;
  } else if (underdogIsHome) {
    scoreA = awayScore;
    scoreB = homeScore;
  }

  const column = METHOD_COLUMNS[method].column;
  const predictedMargin = numberAt(match, COLUMN_INDEX[column]);

  const complete =
    predictedMargin !== null &&
    scoreA !== null &&
    scoreB !== null &&
    Boolean(asOf) &&
    homeScore !== null &&
    awayScore !== null;

  return {
    source: SOURCE,
    method,
    league,
    season,
    asOf,
    fetchedAt,
    sourceUrl,
    sourceHash,
    eventId: null,
    teamA: favorite.name,
    teamB: underdog.name,
    neutral,
    ratingA: null,
    ratingB: null,
    predictedScoreA: scoreA,
    predictedScoreB: scoreB,
    predictedTotal: numberAt(match, TOTAL_INDEX),
    predictedMargin,
    homeAdvantage,
    marketOpen: null,
    marketCurrent: null,
    coverage: complete ? 'full' : 'partial',
    matchStatus: 'unmatched',
    unresolvedReason: null
  };
}

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

function markerIndex(lines, marker, after) {
  for (let i = lines.length - 1; i > after; i--) {
    if (lines[i].includes(marker)) return i;
  }
  return -1;
}

function blockBounds(lines, block) {
  const experimentalAt = markerIndex(lines, EXPERIMENTAL_MARKER, -1);
  if (block === 'experimental') {
    if (experimentalAt === -1) return null;
    return { start: experimentalAt + 1, end: lines.length };
  }
  const regularAt = markerIndex(lines, REGULAR_MARKER, -1);
  if (regularAt === -1) return null;
  const end = experimentalAt > regularAt ? experimentalAt : lines.length;
  return { start: regularAt + 1, end };
}

function candidateIndex(line) {
  const match = /^\s*(\d{1,3})\s/.exec(line);
  return match ? Number(match[1]) : null;
}

function scanRows(lines, bounds, context) {
  const records = [];
  const skipped = [];
  for (let i = bounds.start; i < bounds.end; i++) {
    const line = lines[i];
    const index = candidateIndex(line);
    if (index === null) continue;
    // A page can print a second numbered section after the block (Sagarin's
    // EIGENVECTOR table). It restarts at row 1; stop there rather than
    // reporting every one of its rows as skipped.
    if (records.length > 0 && index === 1) break;
    const match = ROW_PATTERN.exec(line);
    if (!match) {
      skipped.push({ line: i + 1, text: line.trim().slice(0, 120), reason: 'unparseable_row' });
      continue;
    }
    const record = buildRecord({ ...context, match });
    if (!record) {
      skipped.push({ line: i + 1, text: line.trim().slice(0, 120), reason: 'unreadable_row' });
      continue;
    }
    const validation = validateRatingRecord(record);
    if (!validation.ok) {
      skipped.push({
        line: i + 1,
        text: line.trim().slice(0, 120),
        reason: 'invalid_record',
        errors: validation.errors
      });
      continue;
    }
    records.push(record);
  }
  return { records, skipped };
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function unavailable({ method, resolved, reason, sourceUrl, sourceHash }) {
  return {
    source: SOURCE,
    league: resolved,
    method,
    block: METHOD_COLUMNS[method].block,
    season: null,
    asOf: null,
    fetchedAt: null,
    sourceUrl,
    sourceHash,
    homeAdvantage: null,
    coverage: 'unavailable',
    records: [],
    skipped: [],
    unresolvedReason: reason
  };
}

/**
 * Normalize a Sagarin page into contract records.
 *
 * @param {{ raw: string, league: string, fetchedAt: string, method?: string }} options
 * @returns {Record<string, any>}
 */
function normalizeSagarin(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { league, fetchedAt } = opts;
  const method = METHOD_COLUMNS[opts.method] ? opts.method : DEFAULT_METHOD;
  const resolved = canonicalLeague(league);
  const sourceUrl = sourceUrlFor(resolved);
  const raw = typeof opts.raw === 'string' ? opts.raw : '';
  const sourceHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

  const reason = unsupportedReason(resolved);
  if (reason) return unavailable({ method, resolved, reason, sourceUrl, sourceHash });

  const lines = raw.split(/\r?\n/);
  const bounds = blockBounds(lines, METHOD_COLUMNS[method].block);
  if (!bounds) {
    return unavailable({
      method,
      resolved,
      reason: `sagarin ${METHOD_COLUMNS[method].block} prediction block not found in page`,
      sourceUrl,
      sourceHash
    });
  }

  const heading = findNearest(lines, (line) => parseHeading(line), bounds.start - 1);
  const homeAdvantage = findNearest(lines, (line) => parseHomeAdvantage(line), bounds.start + 5);
  const context = {
    method,
    league: resolved,
    asOf: heading ? heading.asOf : null,
    season: heading ? heading.season : null,
    fetchedAt: typeof fetchedAt === 'string' ? fetchedAt : null,
    sourceUrl,
    sourceHash,
    homeAdvantage
  };
  const { records, skipped } = scanRows(lines, bounds, context);

  return {
    source: SOURCE,
    league: resolved,
    method,
    block: METHOD_COLUMNS[method].block,
    season: context.season,
    asOf: context.asOf,
    fetchedAt: context.fetchedAt,
    sourceUrl,
    sourceHash,
    homeAdvantage,
    coverage: records.length === 0 ? 'unavailable' : 'full',
    records,
    skipped,
    unresolvedReason:
      records.length === 0 ? `no readable ${SOURCE} rows in the ${METHOD_COLUMNS[method].block} block` : null
  };
}

module.exports = { SOURCE, SAGARIN_METHODS, fetchSagarin, normalizeSagarin, supportedLeagues, unsupportedReason };
