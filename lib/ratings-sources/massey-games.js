'use strict';

// Massey games-board adapter: the per-game prediction table.
//
// `lib/ratings-sources/massey.js` reads Massey's per-sport RATINGS table, which
// carries one row per team and therefore no matchup and no probability - the
// shared contract is matchup-shaped, so every row it emits is team-scoped and
// the evaluation bridge drops it as `team_scoped_record`. That makes Massey
// (the only source in the layer with MLB ratings) permanently unscoreable, in
// every league.
//
// Massey also publishes a per-sport GAMES board, and that table is what this
// adapter reads. Each row is one fixture and carries Massey's own predicted
// score for both sides plus a printed `Pwin` - the win probability Massey's own
// site documents ("Probabilities are computed from the ratings by considering
// the predicted margin of victory and assuming a normal distribution of
// possible game results", masseyratings.com/theory/predict.htm). So the
// probability is the source's PUBLISHED number, not one this layer derived -
// which is the distinction `lib/ssb-ratings-contract.js` exists to police.
//
// The two tables share one transport: both pages issue a `stamp.obfu` /
// `stamp.jsonURL` pair and are served from the same obfuscated JSON endpoint,
// so `./massey-web` performs the transfer for both and only the column plan
// differs. Verified live 2026-09-17: the games board decodes to the exact
// numbers the page renders (MLB Brewers @ Pirates -> Pred 5/4, Pwin 61/39).
//
// Column layout (verified for MLB, NFL, NBA, NHL, WNBA, NCAAF, NCAAB and MLS -
// all eight share it):
//
//   Date | time | Team | opponent | - | Stand | opp Stand | Scr | opp Scr |
//   Pred | opp Pred | Pwin | opp Pwin | MOV | Spread | Total | O/U
//
// The FIRST team listed is the AWAY side and the second is printed `@ Home`,
// which is the opposite of the contract's convention (see below), so sides are
// swapped on read. `Pred`/`Pwin` are the away side's; the untitled cell after
// each carries the home side's. A titled column's companion is the immediately
// following untitled cell, and the plan requires that companion to be a numeric
// (`gfac` 1|2) column for `Scr`/`Pred`/`Pwin` - so a vendor reorder fails
// loudly instead of reading a string column as a number.
//
// Contract-field conventions used here, matching Sasser's fixture records:
//
//   - `teamA` is the HOME team and `teamB` the away team, so `predictedScoreA`,
//     `modelWinProbability` and `predictedMargin` are all home-relative.
//   - `modelWinProbability` is the HOME side's printed `Pwin` over 100, carried
//     with `kind: 'published'`.
//   - `predictedTotal` is the sum of Massey's two predicted scores. Massey also
//     prints its own `O/U` column, which is NOT that sum on every row (NFL
//     Buffalo/Detroit: 24 + 27 = 51 against an O/U of 55), so the predicted
//     scores stay the source of truth and `O/U` is not carried.
//   - `marketCurrent` is the printed `Spread`, re-signed to the home side
//     (verified: Buffalo -3.5 at home, Pittsburgh +1.5 at home). The `MOV`
//     column is deliberately not carried - it does not mirror `Spread` on every
//     row, so its meaning is unverified.
//   - `asOf` is the payload's own publish timestamp, kept separate from our
//     `fetchedAt`, and doubles as `season`'s year.
//
// Only `Scheduled` rows are emitted. A `Final` row's result is already known at
// fetch time, so carrying its prediction as evidence would score the model
// against information it could not have had - the games board marks status per
// row (`RI[i].style`), and settled rows are dropped by that mark rather than
// silently included.
//
// No third-party payload is bundled here: `normalizeMasseyGames` returns derived
// records and callers persist them via `lib/ssb-ratings-snapshot.js`.

const crypto = require('node:crypto');

const { supportedLeagues: contractSupportedLeagues, validateRatingRecord } = require('../ssb-ratings-contract');
const { canonicalTeam } = require('../ssb-ratings-team-aliases');
const { getSupportedLeagues } = require('../league-presets');
const { fetchMasseyPayload, decodeMasseyRows } = require('./massey-web');

const SOURCE = 'massey_games';
const METHOD = 'games';

// The repo's canonical league registry (lib/league-presets.js), so a real league
// this adapter does not cover is reported as a scope gap and only a code outside
// the registry is reported as a caller typo.
const RECOGNIZED_LEAGUES = new Set(getSupportedLeagues());

// The verified games-board route per league. These are the sibling routes of
// `massey.js`'s `COVERAGE_BY_LEAGUE` ratings pages (same sport path, `games` for
// `ratings`) and each was fetched live on 2026-09-17.
const GAMES_BY_LEAGUE = Object.freeze({
  NCAAF: 'https://masseyratings.com/cf/fbs/games',
  NFL: 'https://masseyratings.com/nfl/games',
  NBA: 'https://masseyratings.com/nba/games',
  NHL: 'https://masseyratings.com/nhl/games',
  MLB: 'https://masseyratings.com/mlb/mlb/games',
  MLS: 'https://masseyratings.com/dls/mls/games',
  WNBA: 'https://masseyratings.com/wnba/games',
  NCAAB: 'https://masseyratings.com/cb/ncaa-d1/games'
});

// The plan/CLI vocabulary says CFB; the contract's canonical code is NCAAF.
const LEAGUE_ALIASES = Object.freeze({ CFB: 'NCAAF' });

// Titles the plan cannot work without. `Scr` is optional (a board with no live
// games prints only zeros, and it is not a value this adapter carries).
const REQUIRED_TITLES = Object.freeze(['Date', 'Team', 'Pred', 'Pwin']);

// Column titles whose untitled companion must be numeric; see the header.
const NUMERIC_COMPANIONS = Object.freeze(['Scr', 'Pred', 'Pwin']);

const STATUS_SCHEDULED = 'Scheduled';

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Massey's canonical league codes (the only source with MLB team ratings). */
function supportedLeagues() {
  return contractSupportedLeagues(SOURCE);
}

function canonicalLeague(league) {
  const code = String(league).trim().toUpperCase();
  return LEAGUE_ALIASES[code] || code;
}

/**
 * Why a league has no Massey games board, or `null` when it does. A real league
 * this adapter does not cover is kept distinct from a code that is not a league
 * code at all, the same split `massey.js` makes.
 *
 * @param {unknown} league
 * @returns {string | null}
 */
function unsupportedReason(league) {
  if (typeof league !== 'string' || league.trim() === '') {
    return 'massey requires a canonical league code';
  }
  const code = canonicalLeague(league);
  if (Object.prototype.hasOwnProperty.call(GAMES_BY_LEAGUE, code)) return null;
  return RECOGNIZED_LEAGUES.has(code)
    ? `${code} is not published by ${SOURCE}`
    : `${code} is not a recognized league code`;
}

/** The games board for a league, or `null` when unsupported. */
function pageUrlFor(league) {
  const code = canonicalLeague(league);
  return Object.prototype.hasOwnProperty.call(GAMES_BY_LEAGUE, code) ? GAMES_BY_LEAGUE[code] : null;
}

// ---------------------------------------------------------------------------
// Column plan
// ---------------------------------------------------------------------------

function titleOf(column) {
  return column && typeof column.title === 'string' && column.title.trim() !== '' ? column.title.trim() : '';
}

/**
 * Map the games board's columns by TITLE onto the cells this adapter reads.
 * Each titled column's companion is the immediately following untitled cell.
 *
 * @param {Array<Record<string, any>>} columns
 * @returns {Record<string, { value: number, other: number | null }>}
 */
function buildColumnPlan(columns) {
  /** @type {Record<string, { value: number, other: number | null }>} */
  const plan = {};
  const list = Array.isArray(columns) ? columns : [];
  for (let i = 0; i < list.length; i++) {
    const title = titleOf(list[i]);
    if (title === '') continue;
    if (!Object.prototype.hasOwnProperty.call(plan, title)) {
      const next = list[i + 1];
      plan[title] = { value: i, other: next && titleOf(next) === '' ? i + 1 : null };
    }
  }

  for (const title of REQUIRED_TITLES) {
    if (!plan[title]) {
      throw new Error(`massey: games board has no ${title} column (the vendor layout changed)`);
    }
  }
  for (const title of ['Team', 'Pred', 'Pwin']) {
    if (plan[title].other === null) {
      throw new Error(`massey: games board ${title} column has no companion cell (the vendor layout changed)`);
    }
  }
  for (const title of NUMERIC_COMPANIONS) {
    const entry = plan[title];
    if (!entry || entry.other === null) continue;
    const type = list[entry.value] && list[entry.value].gfac;
    const otherType = list[entry.other] && list[entry.other].gfac;
    if (!type || !otherType) {
      throw new Error(`massey: games board ${title} column is not numeric (the vendor layout changed)`);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** The scalar a cell displays: an array cell shows its first element. */
function cellScalar(value) {
  if (Array.isArray(value)) return value.length > 0 ? cellScalar(value[0]) : null;
  return value === undefined || value === '' ? null : value;
}

function numberCell(value) {
  const scalar = cellScalar(value);
  return typeof scalar === 'number' && Number.isFinite(scalar) ? scalar : null;
}

function textCell(value) {
  const scalar = cellScalar(value);
  if (typeof scalar === 'number') return String(scalar);
  return typeof scalar === 'string' && scalar.trim() !== '' ? scalar.trim() : null;
}

/** A leading country/section prefix the soccer boards print: `USA/NYC FC`. */
const COUNTRY_PREFIX_RE = /^[A-Z]{2,5}\//;

/** `Brewers | K Harrison` -> `Brewers`; `@ USA/NYC FC` -> `NYC FC`. */
function teamNameOf(cell) {
  const text = textCell(cell);
  if (text === null) return null;
  const [listed] = text.split('|');
  const name = listed.replace(/^@\s*/, '').replace(COUNTRY_PREFIX_RE, '').trim();
  return name || null;
}

/** The per-row status token out of `RI[i].style` (`rcMLB rcScheduled`). */
function statusOf(rowsInfo, index) {
  const entry = Array.isArray(rowsInfo) ? rowsInfo[index] : null;
  const style = entry && typeof entry.style === 'string' ? entry.style : '';
  for (const status of ['In-Progress', 'Scheduled', 'Final']) {
    if (style.includes(`rc${status}`)) return status;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** The payload's publish timestamp as `YYYY-MM-DD`, or `null` when unusable. */
function asOfFromPayload(payload, fetchedAt) {
  const stamp = payload && typeof payload.timestamp === 'number' ? payload.timestamp : null;
  const date = stamp === null ? new Date(fetchedAt) : new Date(stamp);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * Decode one games-board payload into the documented plain-object table the
 * normalizer reads. Pure: the obfuscation seed and the fetch time are passed in.
 *
 * `settledSkipped` counts the rows dropped for being Final, so a board that is
 * all Final reads as "nothing left to predict" rather than an empty table.
 *
 * @param {{ payload: Record<string, any>, obfu: unknown, league: string, fetchedAt?: string }} options
 * @returns {{ league: string, asOf: string | null, games: Array<Object>, settledSkipped: number, rowCount: number }}
 */
function masseyGamesTable(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : {};
  const league = canonicalLeague(opts.league);
  const rows = decodeMasseyRows(payload, opts.obfu);
  if (!rows) {
    throw new Error('massey: games payload carried no CI/DI table');
  }

  const plan = buildColumnPlan(payload.CI);
  const chain = payload.RI;
  const games = [];
  let settledSkipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const status = statusOf(chain, i);
    if (status !== STATUS_SCHEDULED) {
      if (status !== null) settledSkipped += 1;
      continue;
    }

    const listed = teamNameOf(row[plan.Team.value]);
    const opponent = teamNameOf(row[plan.Team.other]);
    if (!listed || !opponent) continue;
    // The second side is printed `@ Home`; without that marker there is no
    // verified venue, and a guessed home side would sign the probability wrong.
    const marker = textCell(row[plan.Team.other]) || '';
    if (!marker.startsWith('@')) continue;

    games.push({
      status,
      away: listed,
      home: opponent,
      awayPred: numberCell(row[plan.Pred.value]),
      homePred: numberCell(row[plan.Pred.other]),
      awayPwin: numberCell(row[plan.Pwin.value]),
      homePwin: numberCell(row[plan.Pwin.other]),
      spread: plan.Spread ? numberCell(row[plan.Spread.value]) : null,
      total: plan.Total ? numberCell(row[plan.Total.value]) : null
    });
  }

  return { league, asOf: asOfFromPayload(payload, opts.fetchedAt), games, settledSkipped, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Fetch (injected transport only)
// ---------------------------------------------------------------------------

/**
 * Fetch one Massey games board and return it as the JSON text `normalizeMasseyGames`
 * reads. The transfer and the per-cell de-obfuscation both happen here, matching
 * `fetchMasseyExport`: the parsing half stays network-free.
 *
 * @param {{ league: string, fetchImpl: Function, now?: Date | string, exportUrl?: string, obfu?: string }} options
 * @returns {Promise<{ raw: string, sourceUrl: string, exportUrl: string, fetchedAt: string }>}
 */
async function fetchMasseyGames(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const { league, fetchImpl, now, exportUrl, obfu } = opts;

  const reason = unsupportedReason(league);
  if (reason) {
    const err = /** @type {any} */ (new Error(`massey: ${reason}`));
    err.code = 'unsupported_league';
    throw err;
  }

  const fetched = await fetchMasseyPayload({
    pageUrl: /** @type {string} */ (pageUrlFor(league)),
    fetchImpl,
    exportUrl,
    obfu,
    now
  });
  const table = masseyGamesTable({
    payload: fetched.payload,
    obfu: fetched.obfu,
    league,
    fetchedAt: fetched.fetchedAt
  });
  return {
    raw: JSON.stringify({ ...table, sourceUrl: fetched.sourceUrl }),
    sourceUrl: fetched.sourceUrl,
    exportUrl: fetched.exportUrl,
    fetchedAt: fetched.fetchedAt
  };
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

function buildRecord(context) {
  const { game, league, season, asOf, fetchedAt, sourceUrl, sourceHash } = context;
  const homeKey = canonicalTeam(game.home, league);
  const awayKey = canonicalTeam(game.away, league);
  const unresolvedName = !homeKey ? game.home : !awayKey ? game.away : null;

  // The contract's probability is the record's `teamA` side, and `teamA` is the
  // home side here, so this is the HOME team's printed Pwin.
  const probability = typeof game.homePwin === 'number' ? game.homePwin / 100 : null;
  const carried = probability !== null && probability >= 0 && probability <= 1 ? probability : null;

  const scored = typeof game.homePred === 'number' && typeof game.awayPred === 'number';
  const resolved = unresolvedName === null;

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
    teamA: homeKey || game.home,
    teamB: awayKey || game.away,
    neutral: false,
    ratingA: null,
    ratingB: null,
    predictedScoreA: game.homePred,
    predictedScoreB: game.awayPred,
    predictedTotal: scored ? game.homePred + game.awayPred : null,
    predictedMargin: scored ? game.homePred - game.awayPred : null,
    homeAdvantage: null,
    marketOpen: null,
    marketCurrent: game.spread === null ? null : game.spread,
    modelWinProbability: carried,
    modelWinProbabilityKind: carried === null ? null : 'published',
    coverage: resolved && scored && carried !== null ? 'full' : 'partial',
    matchStatus: resolved ? 'unmatched' : 'unresolved',
    unresolvedReason: resolved ? null : `${SOURCE} team "${unresolvedName}" has no canonical match in ${league}`
  };
}

function scanGames(games, context) {
  const records = [];
  const skipped = [];
  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    const record = buildRecord({ ...context, game });
    const validation = validateRatingRecord(record);
    if (!validation.ok) {
      skipped.push({
        line: i + 1,
        text: `${game.away} @ ${game.home}`.slice(0, 120),
        reason: 'invalid_record',
        errors: validation.errors
      });
      continue;
    }
    records.push(validation.record);
  }
  return { records, skipped };
}

/**
 * Normalize a Massey games board (the JSON text `fetchMasseyGames` returns) into
 * contract records.
 *
 * @param {{ raw: string, league: string, fetchedAt: string }} options
 * @returns {Record<string, any>}
 */
function normalizeMasseyGames(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const league = canonicalLeague(opts.league);
  const fetchedAt = typeof opts.fetchedAt === 'string' ? opts.fetchedAt : null;
  const raw = typeof opts.raw === 'string' ? opts.raw : '';
  const sourceHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

  const reason = unsupportedReason(league);
  if (reason) return unavailable({ league, reason, sourceUrl: null, sourceHash, fetchedAt });

  let table;
  try {
    table = JSON.parse(raw);
  } catch {
    return unavailable({
      league,
      reason: 'massey games board was not the expected JSON table',
      sourceUrl: null,
      sourceHash,
      fetchedAt
    });
  }
  const games = table && Array.isArray(table.games) ? table.games : null;
  if (!games) {
    return unavailable({
      league,
      reason: 'massey games board carried no games array',
      sourceUrl: null,
      sourceHash,
      fetchedAt
    });
  }

  const sourceUrl = typeof table.sourceUrl === 'string' ? table.sourceUrl : null;
  const asOf = typeof table.asOf === 'string' ? table.asOf : null;
  if (asOf === null) {
    // Undated games are unpersistable and must never read as current; see
    // `massey.js` for the same rule applied to the ratings table.
    return unavailable({
      league,
      reason: 'massey games board carries no usable publish date',
      sourceUrl,
      sourceHash,
      fetchedAt
    });
  }

  const season = Number(asOf.slice(0, 4));
  const { records, skipped } = scanGames(games, { league, season, asOf, fetchedAt, sourceUrl, sourceHash });
  const settledSkipped = typeof table.settledSkipped === 'number' ? table.settledSkipped : 0;

  return {
    source: SOURCE,
    league,
    method: METHOD,
    season,
    asOf,
    fetchedAt,
    sourceUrl,
    sourceHash,
    // Fail closed: zero records is never `full`.
    coverage: records.length === 0 ? 'unavailable' : 'full',
    records,
    skipped,
    unresolvedReason:
      records.length === 0
        ? settledSkipped > 0
          ? `massey games board carried only settled fixtures (${settledSkipped} final rows)`
          : 'no readable massey game rows in board'
        : null
  };
}

module.exports = {
  SOURCE,
  METHOD,
  fetchMasseyGames,
  normalizeMasseyGames,
  masseyGamesTable,
  supportedLeagues,
  unsupportedReason,
  pageUrlFor
};
