'use strict';

// Massey source adapter for the external-ratings benchmark layer.
//
// Massey publishes a *team*-ratings table per sport (`Rat`, `Pwr`, `Off`,
// `Def`, `HFA`, `SoS`, ...), exported as CSV from the ratings page's
// More -> Export action. There is no documented free API, so the transfer is
// injected through `fetchMassey` and the parsing half (`normalizeMassey`) is
// pure and network-free.
//
// Verified against the live pages (2026-09-15): the ratings table header is
// `Team | Rec | Δ | Rat | Pwr | Off | Def | HFA | SoS | SSF | EW | EL`, the
// title line reads `... Using games thru Sun, Sep 13, 2026`, every team also
// carries a `Correlation` footer row, and `Rat`/`Pwr`/`Off`/`Def`/`SoS` cells
// print a leading rank (`6 8.94`) while `HFA` prints bare (`2.29`). The page
// paths in `COVERAGE_BY_LEAGUE` are the verified routes, not guessed ones.
//
// Two things this adapter is deliberately strict about:
//
//   1. `asOf` comes from the export's "Using games thru <date>" title line and
//      is kept separate from our own `fetchedAt`. Massey's heading can lag the
//      rows it sits above, so neither date is derived from the other.
//   2. A header with no team rows is `coverage: 'unavailable'` with a reason.
//      An empty ratings table and a quiet slate look identical otherwise.
//
// The shared contract (`lib/ssb-ratings-contract.js`) is matchup-shaped, but
// Massey publishes one rating per team with no opponent on the row. A Massey
// record therefore carries the rated team in `teamA` with its `Rat` in
// `ratingA`; `teamB`/`ratingB` mirror it because the contract has no
// single-team slot. Consumers key Massey by `teamA` (canonical) and must treat
// `teamB` as a structural placeholder, never as an opponent.
//
// Only `Rat` and `HFA` have contract fields (`ratingA/ratingB` and
// `homeAdvantage`). `Pwr`/`Off`/`Def`/`SoS` are read so a reordered export
// still maps correctly, but are not carried until a consumer needs them.
//
// No third-party payload is bundled here: `normalizeMassey` returns derived
// records and callers persist them via `lib/ssb-ratings-snapshot.js`.

const crypto = require('node:crypto');

const { supportedLeagues: contractSupportedLeagues, validateRatingRecord } = require('../ssb-ratings-contract');
const { canonicalTeam } = require('../ssb-ratings-team-aliases');
const { getSupportedLeagues } = require('../league-presets');

const SOURCE = 'massey';
const METHOD = 'overall';

// The repo's canonical league registry (lib/league-presets.js): every league
// code the ranker knows. A code in here that this adapter does not publish is a
// scope/coverage gap and must be reported as one; only a code *outside* this set
// is a caller typo. Sourcing it from the ranking registry keeps a newly added
// league from drifting into the "unrecognized" bucket.
const RECOGNIZED_LEAGUES = new Set(getSupportedLeagues());

// Per-sport coverage map: the single source of truth for what this adapter can
// and cannot serve, so a request for an uncovered sport fails with a stated
// reason instead of an empty table that reads like a quiet day.
//
// `supported: true` carries the verified ratings-page route the CSV export is
// triggered from; no undocumented export endpoint is invented, so `fetchMassey`
// accepts an explicit `exportUrl`. `supported: false` is a real canonical league
// this adapter deliberately does not cover, carrying the reason it will not.
//
// Massey does publish a college-basketball ratings page
// (`masseyratings.com/cb/ncaa-d1/ratings`), but the benchmark seeds no NCAAB
// adapter or aliases, so NCAAB stays explicitly unsupported rather than
// half-wired: the reason states the scope gap and never claims the source lacks
// CBB. The page paths are the verified routes, not guessed ones.
const COVERAGE_BY_LEAGUE = Object.freeze({
  NCAAF: { supported: true, page: 'https://masseyratings.com/cf/fbs/ratings' },
  NFL: { supported: true, page: 'https://masseyratings.com/nfl/ratings' },
  NBA: { supported: true, page: 'https://masseyratings.com/nba/ratings' },
  NHL: { supported: true, page: 'https://masseyratings.com/nhl/ratings' },
  MLB: { supported: true, page: 'https://masseyratings.com/mlb/mlb/ratings' },
  MLS: { supported: true, page: 'https://masseyratings.com/dls/mls/ratings' },
  WNBA: { supported: true, page: 'https://masseyratings.com/wnba/ratings' },
  NCAAB: { supported: false, reason: 'NCAAB is not covered by the massey benchmark adapter' }
});

// The plan/CLI vocabulary says CFB; the contract's canonical code is NCAAF.
const LEAGUE_ALIASES = Object.freeze({ CFB: 'NCAAF' });

const HEADERS = Object.freeze({
  team: ['team', 'school', 'name'],
  rat: ['rat', 'rating'],
  hfa: ['hfa', 'homefield', 'home field', 'home field advantage']
});

// The table's own correlation footer is printed as a row with `Correlation` in
// the team column; it is not a program.
const CORRELATION_RE = /^correlation$/i;

const ASOF_PATTERN = /using games (?:thru|through)\s+(?:[A-Za-z]{3},\s*)?([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/i;

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

/** Massey's canonical league codes (the only source with MLB team ratings). */
function supportedLeagues() {
  return contractSupportedLeagues(SOURCE);
}

/** The coverage-map entry for a league, or `null` when the code is unknown. */
function coverageEntry(league) {
  const code = canonicalLeague(league);
  return Object.prototype.hasOwnProperty.call(COVERAGE_BY_LEAGUE, code) ? COVERAGE_BY_LEAGUE[code] : null;
}

/**
 * Why a league has no Massey team ratings, or `null` when it does.
 *
 * Two gaps are kept distinct: a real canonical league this adapter does not
 * cover (a scope gap) versus a code that is not a canonical league at all (a
 * caller error). Collapsing them into one string hides a typo behind a
 * plausible-looking coverage excuse, and - worse - calls a real league like UFC
 * or Tennis "not a canonical league code" when Massey simply publishes no team
 * ratings for it.
 *
 * @param {unknown} league
 * @returns {string | null}
 */
function unsupportedReason(league) {
  if (typeof league !== 'string' || league.trim() === '') {
    return 'massey requires a canonical league code';
  }
  const code = canonicalLeague(league);
  const entry = coverageEntry(code);
  if (!entry) {
    return RECOGNIZED_LEAGUES.has(code)
      ? `${code} is not published by ${SOURCE}`
      : `${code} is not a recognized league code`;
  }
  return entry.supported ? null : entry.reason;
}

function canonicalLeague(league) {
  const code = String(league).trim().toUpperCase();
  return LEAGUE_ALIASES[code] || code;
}

/** The human-facing ratings page for a league, or `null` when unsupported. */
function pageUrlFor(league) {
  const entry = coverageEntry(league);
  return entry && entry.supported ? entry.page : null;
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
 * Fetch one Massey ratings export. The HTTP transport is injected so tests stay
 * network-free and the caller owns timeout/retry policy.
 *
 * `exportUrl` is the link resolved from the page's More -> Export action; when
 * omitted the league's ratings page itself is requested.
 *
 * @param {{ league: string, fetchImpl: Function, exportUrl?: string, now?: Date | string }} options
 * @returns {Promise<{ raw: string, sourceUrl: string, exportUrl: string, fetchedAt: string }>}
 */
async function fetchMassey(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { fetchImpl, league, now, exportUrl } = opts;
  if (typeof fetchImpl !== 'function') {
    throw new Error('massey: fetchMassey requires an injected fetchImpl (dependency-injected fetch)');
  }

  const reason = unsupportedReason(league);
  if (reason) {
    const err = /** @type {any} */ (new Error(`massey: ${reason}`));
    err.code = 'unsupported_league';
    throw err;
  }

  const sourceUrl = /** @type {string} */ (pageUrlFor(league));
  const target = typeof exportUrl === 'string' && exportUrl.trim() !== '' ? exportUrl.trim() : sourceUrl;
  const res = await fetchImpl(target, { headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8' } });
  if (!res || res.ok === false) {
    const status = res && res.status ? res.status : 'unknown';
    throw new Error(`massey: HTTP ${status} from ${target}`);
  }
  if (typeof res.text !== 'function') {
    throw new Error('massey: fetchImpl response has no text() body');
  }
  const raw = await res.text();
  return { raw: String(raw), sourceUrl, exportUrl: target, fetchedAt: resolveFetchedAt(now) };
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Split RFC4180-ish CSV into rows of cells: quoted fields may contain commas,
 * newlines and escaped quotes. A lone `\r` is dropped so `\r\n` ends one row.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '');

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') endField();
    else if (char === '\n') endRow();
    else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** First line of a cell, trimmed; quoted multi-line cells collapse to line 1. */
function cleanCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).split(/\r?\n/)[0].trim();
}

/**
 * Last numeric token in a cell, so both `8.94` and Massey's rank-prefixed
 * `6 8.94` read as the value. `null` when the cell carries no number.
 */
function numericCell(value) {
  const text = cleanCell(value);
  if (text === '') return null;
  const matches = text.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const parsed = Number(matches[matches.length - 1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function headerIndex(cells, names) {
  for (let i = 0; i < cells.length; i++) {
    if (names.includes(cells[i])) return i;
  }
  return -1;
}

/**
 * Locate the ratings header row and map the columns this adapter consumes by
 * header name, so column order does not matter.
 *
 * @param {string[][]} rows
 * @returns {{ index: number, columns: Record<string, number> } | null}
 */
function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((cell) => cleanCell(cell).toLowerCase());
    if (!cells.includes('team') || !cells.includes('rat')) continue;
    return {
      index: i,
      columns: {
        team: headerIndex(cells, HEADERS.team),
        rat: headerIndex(cells, HEADERS.rat),
        hfa: headerIndex(cells, HEADERS.hfa)
      }
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

function monthNumber(name) {
  const key = String(name).toLowerCase();
  if (MONTHS[key]) return MONTHS[key];
  const full = Object.keys(MONTHS).find((month) => month.startsWith(key.slice(0, 3)));
  return full ? MONTHS[full] : null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Parse the export's "Using games thru <day>, <Month> <d>, <year>" title into
 * `{ asOf, season }`, kept separate from `fetchedAt` on purpose.
 */
function parseAsOf(raw) {
  const match = ASOF_PATTERN.exec(String(raw || ''));
  if (!match) return null;
  const month = monthNumber(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31 || !year) return null;
  return { asOf: `${year}-${pad2(month)}-${pad2(day)}`, season: year };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function buildRecord(context) {
  const { cells, columns, league, season, asOf, fetchedAt, sourceUrl, sourceHash } = context;
  const printed = cleanCell(cells[columns.team]);
  const rating = numericCell(cells[columns.rat]);
  const homeAdvantage = columns.hfa === -1 ? null : numericCell(cells[columns.hfa]);
  const canonical = canonicalTeam(printed, league);
  const team = canonical || printed;

  return {
    source: SOURCE,
    method: METHOD,
    league,
    season,
    asOf,
    fetchedAt,
    sourceUrl,
    sourceHash,
    eventId: null,
    teamA: team,
    // No opponent exists on a team-ratings row; see the module header.
    teamB: team,
    neutral: null,
    ratingA: rating,
    ratingB: rating,
    predictedScoreA: null,
    predictedScoreB: null,
    predictedTotal: null,
    predictedMargin: null,
    homeAdvantage,
    marketOpen: null,
    marketCurrent: null,
    coverage: canonical && rating !== null ? 'full' : 'partial',
    matchStatus: canonical ? 'unmatched' : 'unresolved',
    unresolvedReason: canonical ? null : `${SOURCE} team "${printed}" has no canonical match in ${league}`
  };
}

/** Is this a team row, or a blank/footer row to skip entirely? */
function teamCellOf(cells, columns) {
  if (!Array.isArray(cells) || cells.every((cell) => cleanCell(cell) === '')) return null;
  const team = cleanCell(cells[columns.team]);
  if (team === '' || CORRELATION_RE.test(team)) return null;
  return team;
}

function scanRows(rows, header, context) {
  const records = [];
  const skipped = [];
  for (let i = header.index + 1; i < rows.length; i++) {
    const team = teamCellOf(rows[i], header.columns);
    if (team === null) continue;
    const validation = validateRatingRecord(buildRecord({ ...context, cells: rows[i], columns: header.columns }));
    if (!validation.ok) {
      skipped.push({ line: i + 1, text: team.slice(0, 120), reason: 'invalid_record', errors: validation.errors });
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
 * Normalize a Massey ratings export into contract records.
 *
 * @param {{ raw: string, league: string, fetchedAt: string }} options
 * @returns {Record<string, any>}
 */
function normalizeMassey(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const league = canonicalLeague(opts.league);
  const fetchedAt = typeof opts.fetchedAt === 'string' ? opts.fetchedAt : null;
  const raw = typeof opts.raw === 'string' ? opts.raw : '';
  const sourceUrl = pageUrlFor(league);
  const sourceHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

  const reason = unsupportedReason(league);
  if (reason) return unavailable({ league, reason, sourceUrl, sourceHash, fetchedAt });

  const rows = parseCsv(raw);
  const header = findHeader(rows);
  if (!header) {
    return unavailable({
      league,
      reason: 'massey ratings header row (Team + Rat) not found in export',
      sourceUrl,
      sourceHash,
      fetchedAt
    });
  }

  const heading = parseAsOf(raw);
  const { records, skipped } = scanRows(rows, header, {
    league,
    season: heading ? heading.season : null,
    asOf: heading ? heading.asOf : null,
    fetchedAt,
    sourceUrl,
    sourceHash
  });

  return {
    source: SOURCE,
    league,
    method: METHOD,
    season: heading ? heading.season : null,
    asOf: heading ? heading.asOf : null,
    fetchedAt,
    sourceUrl,
    sourceHash,
    coverage: records.length === 0 ? 'unavailable' : 'full',
    records,
    skipped,
    unresolvedReason: records.length === 0 ? `no readable ${SOURCE} team rows in export` : null
  };
}

module.exports = { SOURCE, fetchMassey, normalizeMassey, supportedLeagues, unsupportedReason, pageUrlFor };
