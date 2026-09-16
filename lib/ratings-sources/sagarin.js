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
// ratings rather than a team-ratings table, so there is no team rating to
// normalize there. It is the one league where the source has no team table at
// all, rather than a league this adapter chose not to read (see the page-shape
// decision below). That surfaces as `coverage: 'unavailable'` with a reason,
// never as empty success.
//
// No third-party payload is bundled here: `normalizeSagarin` returns derived
// records, and callers persist them in the local state dir via
// `lib/ssb-ratings-snapshot.js`.
//
// ---------------------------------------------------------------------------
// Page shape (verified against live captures, `test/fixtures/ratings/`)
// ---------------------------------------------------------------------------
//
// A Sagarin page carries MORE numbered rows than this adapter emits records, in
// three separate sections:
//
//   1. the whole-season RATINGS table - one row per team, `RATING W L
//      SCHEDL(RANK) VS top N ... PREDICTOR GOLDEN_MEAN RECENT STRONG RECENT
//      <division>`. Football rows insert a division letter (`A`) between the
//      team and `=`; basketball/hockey/soccer rows have no division column.
//      It has no opponent and no predicted score, and the page repeats each
//      team again in per-division sub-tables.
//   2. the game-prediction block - `FAVORITE ... five margin columns ...
//      UNDERDOG ... MONEY WIN% home away TOTAL`. This is the only section that
//      can produce a game-scoped contract record. Its `WIN%` column is the
//      source's OWN published win probability for the printed favorite and is
//      carried as `modelWinProbability` (`kind: 'published'`);
//      `resolveWinProbability` documents the verified column semantics and why
//      the trailing `WIN%` of the home-margin tail is not the number.
//   3. an `EIGENVECTOR` table, and on some pages a conference summary table.
//      Both stay out of scope.
//
// BOTH sections 1 and 2 are normalized (decision 2026-09-16; rationale and
// constraints in `docs/research/external-ratings-sources-2026-09.md`,
// "Sagarin per-team RATINGS table: decision"). Reading section 1 costs no extra
// fetch - the page is already in hand - and it is what lets
// `SUPPORTED_LEAGUES.sagarin` mean something for NCAAB/MLS, whose captures are
// frozen final-ratings pages carrying no prediction rows at all. The scope
// boundary, all verified against the committed captures: the per-division
// repeats are de-duplicated (the first, i.e. ranked, occurrence wins), the
// conference-summary table and the `***UNRATED***` sentinel are skipped, team
// records take the Massey shape (the rated team in `teamA`, mirrored into
// `teamB`, with its value in `ratingA`), and NCAAB's inline `<font>` tags are
// stripped for the team-table scan only.
//
// So `pageCandidateRows` (every numbered line on the page) is a DIAGNOSTIC of
// how much page the adapter deliberately did not read, never a target record
// count: the same team appears in the main table and again in each division
// sub-table, so NBA's page shows 84 numbered rows for a 30-team league. The
// coverage gate below is therefore scoped to the candidate rows of the two
// parsed sections - the rows this adapter claims to read - and
// `pageCandidateRows` is exposed alongside it so a consumer can see the
// difference instead of reading a bare `coverage: 'full'`.
//
// Verified 2026-09-16 (fixtures `sagarin-<league>-2026-09-16.html`): every
// candidate row in both parsed sections parses, for every method, with zero
// skipped. NBA/NHL show only their finals matchup in the prediction block
// because the season is over, and NCAAB/MLS have no prediction rows at all, so
// those four leagues' records come from the ratings table alone.

const crypto = require('node:crypto');

const { supportedLeagues: contractSupportedLeagues, validateRatingRecord } = require('../ssb-ratings-contract');
const { canonicalTeam } = require('../ssb-ratings-team-aliases');

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

// Coverage gate. `coverage: 'full'` requires that EVERY candidate row in BOTH
// parsed sections - the prediction block and the per-team ratings table, after
// the table's per-division repeats are de-duplicated - produced a record, so a
// column change that breaks either row layout surfaces as `partial` with a
// reason naming the shortfall instead of a quiet success. Scoped to those two
// sections on purpose - see "Page shape" in the module header for why the
// page-level numbered-row count is not a record-count target. Captured real
// pages (2026-09-16) produced zero unreadable candidate rows for every league
// and every method, so this gate is silent today and fires the moment the
// layout drifts.
//
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

// The printed tail is `MONEY WIN% home away TOTAL` followed, on CFB/NFL, by an
// optional `HMARG WIN% MONEY` for the home-margin line. Only the LEADING `WIN%`
// is read (see `resolveWinProbability`); the trailing pair belongs to the other
// line and reading the wrong one would attribute a probability to the wrong
// number.
const WIN_PERCENT_INDEX = 10;

// ---------------------------------------------------------------------------
// Per-team RATINGS table
// ---------------------------------------------------------------------------
//
// One printed row per team:
//
//   1  Oklahoma City Thunder   = 100.98   75  22   90.88(   4)   24  13  |  35  17  |  101.05    2 |  102.10    1 |  100.05    3 |  100.49    3  northwest
//   1  Notre Dame           A  =  95.24    2   0   67.85(  45)    0   0  |   0   0  |   94.36    2 |   96.51    2 |   93.33    5 |   99.65    4  I-A IND.            (A)
//
// i.e. `index  name  [division letter]  =  RATING  W  L  [T]  SCHEDL(RANK)
// VS-top-A pair  |  VS-top-B pair  |  PREDICTOR  |  GOLDEN_MEAN  |  RECENT
// [|  STRONG RECENT]  division/conference`, where the four rating columns print
// `value rank` and the page's own header line confirms the order
// (`RATING W L SCHEDL(RANK) VS top 10 | VS top 16 | PREDICTOR | GOLDEN_MEAN |
// RECENT | STRONG RECENT`).
//
// The discriminator below is what separates a team row from every other
// numbered row on the page: it requires the `=` separator plus a `W L` pair, a
// decimal `SCHEDL(...)` and a bracketed rank. Verified against all six
// committed captures - it matches only team rows. It does NOT match the
// division-averages table (`1 ATLANTIC = 92.34 91.79 ( 2) ...`), the NCAAB
// conference-summary table (`1 BIG 12 = 85.53 85.69 ( 1) ...`), the EIGENVECTOR
// rows, the division-level `UNRATED___ (__)= -91.00 ...` row, or any
// prediction-block row.
//
// It DOES match Sagarin's `267  ***UNRATED***        __ = -91.00 ...` sentinel,
// which carries a real numeric index (the page's own rank column prints it) and
// is not a program. That row is rejected by label - see `isTeamRow` - and the
// pinned test asserts it, because "the leading index excludes it" is false.
const TEAM_ROW_PATTERN =
  /^\s*(\d{1,3})\s+(.+?)\s*=\s*(-?\d+\.\d+)\s+(\d{1,3})\s+(\d{1,3})(?:\s+(\d{1,3}))?\s+(\d+\.\d+)\(\s*(\d+)\)/;

// Pipe-group offset of each score-based ratings column. `overall` is the
// `RATING` column, which is the value immediately after `=`, so it has no group
// offset. The number of `VS top N` groups ahead of them varies by page (two in
// every committed capture), but PREDICTOR/GOLDEN_MEAN/RECENT always start at the
// third group, and the trailing STRONG RECENT group is optional (NCAAB's header
// stops at RECENT), which is why the group count is validated rather than
// assumed.
const TEAM_GROUP_INDEX = Object.freeze({ predictor: 2, goldenMean: 3, recent: 4 });
const TEAM_GROUP_COUNTS = Object.freeze([5, 6]);
const TEAM_VALUE_PATTERN = /^\s*(-?\d+\.\d+)\s+\d+/;

// A printed label containing an asterisk is Sagarin's non-team sentinel, not a
// program; every real row's label is asterisk-free.
const TEAM_LABEL_REJECT_PATTERN = /\*/;

// College football prints the division letter (`A` = I-A) between the team and
// `=`; no other league has a division column.
const CFB_DIVISION_SUFFIX_PATTERN = /\s+[A-Z]{1,2}$/;

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
 * The page's own win probability for the FAVORITE (which this adapter carries as
 * `teamA`), as a probability in [0, 1] - or `null` when the row prints none.
 *
 * Verified against the six captured pages (2026-09-16,
 * `test/fixtures/ratings/sagarin-*-2026-09-16.html`), 276 prediction rows:
 *
 *   - The leading `WIN%` is the FAVORITE's win probability, not the home team's.
 *     CFB row 4 (`Miami-Florida ... @ Wake Forest`) prints the favorite as the
 *     AWAY side and still reads `82%`, so the column follows the printed
 *     favorite; NBA's `@ New York Knicks` / `San Antonio Spurs` pair reads 55
 *     then 51 for the same two teams, i.e. it follows the favorite, not home.
 *   - It is the same number as the adjacent `MONEY` column (the underdog's
 *     price "to 100"): `round(100 * M / (100 + M))` reproduces the printed
 *     whole percent on 274 of 276 rows and is 1 point off on the other two
 *     (Sagarin prints the percent independently of the rounded price). That
 *     cross-check is what pins the column order, and it is asserted by the
 *     adapter's tests rather than trusted from this comment.
 *   - It is rounded to a whole percent (observed 50..98), so the carried
 *     probability carries +/-0.005 of display granularity. That is the source's
 *     own precision and is never inflated into more digits.
 *
 * The trailing `WIN%` is NOT this number: it is the home team's probability on
 * the page's separate home-margin line and is signed negative when the home team
 * is the underdog. Reading it instead would attach the wrong line's probability,
 * so it is deliberately never parsed.
 *
 * An out-of-range print (a column change, or a 0-100 / 0-1 scale slip) is passed
 * through as-is so the shared contract rejects it loudly instead of turning it
 * into a silent "no probability".
 *
 * @param {RegExpExecArray} match
 * @returns {number | null}
 */
function resolveWinProbability(match) {
  const percent = numberAt(match, WIN_PERCENT_INDEX);
  return percent === null ? null : percent / 100;
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

  // `winProbability` is read here (not part of `complete`): the row pattern
  // requires the `WIN%` column, so a page that stops printing it makes every row
  // unparseable and the envelope's coverage gate already fails loudly. Adding a
  // second, unreachable guard for the same drift would be dead code.
  const winProbability = resolveWinProbability(match);

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
    // The page's own number for the favorite (this record's `teamA`), carried
    // verbatim. Attribution is 'published': Sagarin printed it, we did not
    // compute it.
    modelWinProbability: winProbability,
    modelWinProbabilityKind: winProbability === null ? null : 'published',
    coverage: complete ? 'full' : 'partial',
    matchStatus: 'unmatched',
    unresolvedReason: null
  };
}

// ---------------------------------------------------------------------------
// Team-table rows
// ---------------------------------------------------------------------------

/** The label the page printed for a team row, with the CFB division letter removed. */
function printedTeamLabel(raw, league) {
  const label = String(raw || '').trim();
  // Strip the college-football division letter for NCAAF only: no other league
  // prints a division column, and a real name can end in a single capital.
  return league === 'NCAAF' ? label.replace(CFB_DIVISION_SUFFIX_PATTERN, '').trim() : label;
}

/** Is this printed label a program, or the page's non-team sentinel? */
function isTeamRow(label) {
  return label !== '' && !TEAM_LABEL_REJECT_PATTERN.test(label);
}

/**
 * The requested method's value from one team row, or `null` when the row's
 * column layout is not the one this adapter was written against.
 *
 * `overall` is the `RATING` column (the value right after `=`); the three
 * score-based methods read the `value` of their `value rank` pipe group. A
 * group count outside the two verified layouts, or a group that does not start
 * with a decimal value, returns `null`, which makes the row a skipped candidate
 * so a layout drift fails the coverage gate instead of quietly returning a
 * number from the wrong column.
 */
function teamColumnValue(match, line, column) {
  if (column === 'rating') {
    const rating = Number(match[3]);
    return Number.isFinite(rating) ? rating : null;
  }
  const groups = line
    .slice(match[0].length)
    .split('|')
    .map((group) => group.trim());
  if (!TEAM_GROUP_COUNTS.includes(groups.length)) return null;
  const value = TEAM_VALUE_PATTERN.exec(groups[TEAM_GROUP_INDEX[column]]);
  if (!value) return null;
  const parsed = Number(value[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turn one printed team row into a team-scoped contract record for the requested
 * method.
 *
 * Team rows take the Massey shape: the contract is matchup-shaped but a ratings
 * table prints one rating per team with no opponent, so the team lands in
 * `teamA` and is mirrored into `teamB`, which a consumer must read as a
 * structural placeholder and never as an opponent.
 *
 * An unresolved team is a CORRECT fail-closed outcome, not a parse failure: the
 * name registry is seeded per league, and a program it does not know stays
 * `unresolved` with a reason rather than being guessed into a key. Unresolved
 * records are excluded from the envelope's incomplete-record shortfall (see
 * `resolveCoverage`), because a registry gap is not a parse drift.
 */
function buildTeamRecord(context) {
  const { printed, value, method, league, season, asOf, fetchedAt, sourceUrl, sourceHash, homeAdvantage } = context;
  const canonical = canonicalTeam(printed, league);
  const team = canonical || printed;

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
    teamA: team,
    teamB: team,
    neutral: null,
    ratingA: value,
    ratingB: value,
    predictedScoreA: null,
    predictedScoreB: null,
    predictedTotal: null,
    predictedMargin: null,
    // The page's single listed home edge, the same value the envelope carries,
    // so a consumer can turn a rating pair into a margin.
    homeAdvantage,
    marketOpen: null,
    marketCurrent: null,
    modelWinProbability: null,
    modelWinProbabilityKind: null,
    coverage: canonical && value !== null ? 'full' : 'partial',
    matchStatus: canonical ? 'unmatched' : 'unresolved',
    unresolvedReason: canonical ? null : `${SOURCE} team "${printed}" has no canonical match in ${league}`
  };
}

/**
 * Scan the page's per-team RATINGS table into team-scoped records.
 *
 * The ranked table is reprinted per division/conference, so each team appears
 * two or more times (NBA 60 printed rows for 30 teams, NCAAF 534 for 266) and
 * only its FIRST (ranked) occurrence is kept - the ranked table is printed above
 * the sub-tables.
 *
 * Inline markup is stripped PER LINE HERE and nowhere else: NCAAB wraps every
 * team row in `<font>` runs, but stripping the whole page would turn previously
 * tag-led lines into numbered rows and would silently move the pinned
 * `pageCandidateRows` diagnostic.
 *
 * The `experimental_*` methods are prediction-block-only - the page prints no
 * experimental ratings column - so they emit no team rows and contribute no
 * candidates.
 */
function scanTeamRows(lines, context) {
  const { method, league } = context;
  const column = METHOD_COLUMNS[method].block === 'regular' ? METHOD_COLUMNS[method].column : null;
  const records = [];
  const skipped = [];
  let candidates = 0;
  if (column === null) return { records, skipped, candidates };

  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/<[^>]*>/g, '');
    const match = TEAM_ROW_PATTERN.exec(line);
    if (!match) continue;
    const printed = printedTeamLabel(match[2], league);
    // The sentinel is not a candidate at all (it is not a team row), while a
    // repeat is the same team printed again.
    if (!isTeamRow(printed) || seen.has(printed)) continue;
    seen.add(printed);
    candidates++;
    const value = teamColumnValue(match, line, column);
    if (value === null) {
      skipped.push({ line: i + 1, text: printed.slice(0, 120), reason: 'unreadable_team_row' });
      continue;
    }
    const record = buildTeamRecord({ ...context, printed, value });
    const validation = validateRatingRecord(record);
    if (!validation.ok) {
      skipped.push({ line: i + 1, text: printed.slice(0, 120), reason: 'invalid_record', errors: validation.errors });
      continue;
    }
    records.push(record);
  }
  return { records, skipped, candidates };
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
  // Candidate rows the adapter ATTEMPTED inside this block: the row count the
  // coverage gate is measured against. Rows in the page's other sections (the
  // division/conference summary tables and the EIGENVECTOR table) are not
  // candidates here; the per-team RATINGS table is counted separately by
  // `scanTeamRows`, and `pageNumberedRows` counts the whole page.
  let candidates = 0;
  for (let i = bounds.start; i < bounds.end; i++) {
    const line = lines[i];
    const index = candidateIndex(line);
    if (index === null) continue;
    // A page can print a second numbered section after the block (Sagarin's
    // EIGENVECTOR table). It restarts at row 1; stop there rather than
    // reporting every one of its rows as skipped.
    if (records.length > 0 && index === 1) break;
    candidates++;
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
  return { records, skipped, candidates };
}

/**
 * Every numbered line on the page, across every section. Diagnostic only: a
 * Sagarin page prints the same team in its main ratings table and again in
 * each division sub-table, so this is far larger than any record count and
 * must never be used as a parsing target (see the module header).
 */
function pageNumberedRows(lines) {
  let count = 0;
  for (const line of lines) {
    if (candidateIndex(line) !== null) count++;
  }
  return count;
}

/**
 * Derive the envelope coverage from what was actually read across BOTH parsed
 * sections, so neither an unreadable candidate row nor a row that parsed into
 * an incomplete record can leave `coverage: 'full'` standing. Every real
 * captured page produces zero of both across all six leagues and all eight
 * methods, so this gate is silent today and fires the moment either row layout
 * drifts.
 *
 * The denominator is the MERGED candidate count - the prediction block plus the
 * de-duplicated per-team ratings table - because a team row that stops parsing
 * is as much of an under-read as a prediction row that does.
 *
 * An `unresolved` record is deliberately NOT counted as incomplete: it carries
 * its rating and is only missing a registry entry, which is the correct
 * fail-closed outcome rather than a parse drift. Counting it would leave every
 * league with an unseeded program permanently `partial` and hide the signal this
 * gate exists for.
 */
function resolveCoverage({ records, block, blockCandidateRows, teamCandidateRows, skipped }) {
  const parsed = records.length;
  const candidates = blockCandidateRows + teamCandidateRows;
  const sections = `${blockCandidateRows} ${block}-block + ${teamCandidateRows} team-table candidate row(s)`;
  if (parsed === 0) {
    return {
      coverage: 'unavailable',
      unresolvedReason: `no readable ${SOURCE} rows in the ${block} prediction block or the per-team ratings table`,
      coverageReason: `${sections}, none readable`
    };
  }
  const shortfall = [];
  if (skipped.length > 0) shortfall.push(`${skipped.length} unreadable`);
  const incomplete = records.filter(
    (record) => record.coverage !== 'full' && record.matchStatus !== 'unresolved'
  ).length;
  if (incomplete > 0) shortfall.push(`${incomplete} incomplete`);
  const parsedReason = `${parsed} of ${candidates} candidate rows parsed (${sections})`;
  if (shortfall.length > 0) {
    return { coverage: 'partial', unresolvedReason: null, coverageReason: `${parsedReason} (${shortfall.join(', ')})` };
  }
  return { coverage: 'full', unresolvedReason: null, coverageReason: parsedReason };
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function unavailable({ method, resolved, reason, sourceUrl, sourceHash, pageCandidateRows = 0 }) {
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
    coverageReason: reason,
    records: [],
    skipped: [],
    pageCandidateRows,
    blockCandidateRows: 0,
    teamCandidateRows: 0,
    candidateRows: 0,
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
  const pageCandidateRows = pageNumberedRows(lines);
  const block = METHOD_COLUMNS[method].block;
  const bounds = blockBounds(lines, block);

  // The heading and the page's single home edge are anchored on the prediction
  // block when the page has one; a frozen final-ratings page has no block but
  // still prints both, so they fall back to the whole page.
  const heading = findNearest(lines, (line) => parseHeading(line), bounds ? bounds.start - 1 : lines.length - 1);
  const homeAdvantage = findNearest(
    lines,
    (line) => parseHomeAdvantage(line),
    bounds ? bounds.start + 5 : lines.length - 1
  );
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

  // Both sections are optional on their own and neither is required for the
  // other: NCAAB/MLS carry a ratings table and no prediction rows, while a
  // finals page can carry the reverse. Availability is decided once, below,
  // from what the two sections together actually produced.
  const prediction = bounds ? scanRows(lines, bounds, context) : { records: [], skipped: [], candidates: 0 };
  const teams = scanTeamRows(lines, context);
  const records = [...prediction.records, ...teams.records];
  const skipped = [...prediction.skipped, ...teams.skipped];
  const blockCandidateRows = prediction.candidates;
  const teamCandidateRows = teams.candidates;
  const { coverage, unresolvedReason, coverageReason } = resolveCoverage({
    records,
    block,
    blockCandidateRows,
    teamCandidateRows,
    skipped
  });

  return {
    source: SOURCE,
    league: resolved,
    method,
    block,
    season: context.season,
    asOf: context.asOf,
    fetchedAt: context.fetchedAt,
    sourceUrl,
    sourceHash,
    homeAdvantage,
    coverage,
    coverageReason,
    records,
    skipped,
    // `pageCandidateRows` counts every numbered line on the page, including the
    // division and EIGENVECTOR sections this adapter does not read. Diagnostic,
    // never a record-count target - see the module header.
    pageCandidateRows,
    blockCandidateRows,
    teamCandidateRows,
    candidateRows: blockCandidateRows + teamCandidateRows,
    unresolvedReason
  };
}

module.exports = { SOURCE, SAGARIN_METHODS, fetchSagarin, normalizeSagarin, supportedLeagues, unsupportedReason };
