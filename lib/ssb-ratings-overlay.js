'use strict';

// Additive shadow overlay for the external-ratings benchmark layer (Task 10).
//
// Attaches normalized Massey / Sagarin / Sasser records to candidate rows as
// `row.ratings = { massey, sagarin, sasser }` WITHOUT touching the ranking
// path. This is a pure enrichment: it only ADDS one property, it never
// clobbers a pre-existing `row.ratings`, and it never reads or writes
// kaiCall, tier, verdict, edge, or any score.
//
// The join key is the COMPOSITE `(league, canonical game identity, market)`,
// case-normalized on every segment. That is not cosmetic: the removed
// tennis-Elo overlay shipped a name-only join and bled one game's context onto
// another game that merely shared a team name (`Ohio State` plays a dozen
// games). Canonicalizing BOTH sides of the matchup into one order-independent
// pair key is what keeps the wrong game's prediction out of a row.
//
// Two record scopes are supported, distinguished by the contract itself:
//
//   - game-scoped (Sagarin / Sasser predictions): `teamA !== teamB`, so the
//     identity is the canonical pair. One prediction row cannot land on a
//     different fixture.
//   - team-scoped (Massey team ratings): `teamA === teamB` because a
//     team-list row publishes no opponent. Its identity is the single
//     canonical team, so it applies to every game that team plays - which is
//     correct for a rating and is not the same thing as a game bleed.
//
// A record may optionally carry `market` to scope it (e.g. a spread model to
// `Point Spread`). The contract does not define a market field, so adapter
// records are market-wildcard and attach to every market of their fixture.
//
// Fail closed: an unresolvable team, league, or matchup yields no key, so the
// source entry is `null` - never a guessed team or a fuzzy match.

const { SOURCES } = require('./ssb-ratings-contract');
const { canonicalTeam } = require('./ssb-ratings-team-aliases');

/** Sentinel for "this record applies to every market of its fixture". */
const WILDCARD = '*';

/**
 * Case-normalize one join segment: trim, collapse internal whitespace, upper-case.
 *
 * @param {unknown} value
 * @returns {string} normalized segment, or "" when there is nothing to key on
 */
function segment(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Split a matchup label into its two sides.
 *
 * @param {unknown} game - e.g. "Michigan vs Ohio State" or "Athletics @ Angels"
 * @returns {[string, string] | null}
 */
function splitMatchup(game) {
  if (typeof game !== 'string') return null;
  const parts = game
    .split(/\s+(?:vs\.?|@|at)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

/**
 * Order-independent canonical identity for a matchup, or null when either side
 * cannot be resolved (fail closed - a guessed key is exactly the bleed bug).
 *
 * @param {unknown} game
 * @param {unknown} league
 * @returns {string|null} sorted "TEAM|TEAM" key, or null
 */
function canonicalGameKey(game, league) {
  const sides = splitMatchup(game);
  if (!sides) return null;
  const canonical = sides.map((name) => canonicalTeam(name, league));
  if (canonical.some((team) => !team)) return null;
  return canonical
    .map((team) => segment(team))
    .sort()
    .join('|');
}

/**
 * Index key for one contract record: `LEAGUE|GAME|MARKET`. The game segment is
 * the canonical pair for a game-scoped row, or the single canonical team for a
 * team-scoped row (`teamA === teamB`, a team-list rating with no opponent).
 *
 * @param {Record<string, any>} record
 * @returns {string|null}
 */
function recordKey(record) {
  const league = segment(record.league);
  if (!league) return null;
  const teamA = canonicalTeam(record.teamA, record.league);
  if (!teamA) return null;
  const market = segment(record.market) || WILDCARD;
  if (teamA === canonicalTeam(record.teamB, record.league)) {
    return `${league}|${segment(teamA)}|${market}`;
  }
  const teamB = canonicalTeam(record.teamB, record.league);
  if (!teamB) return null;
  return `${league}|${[segment(teamA), segment(teamB)].sort().join('|')}|${market}`;
}

/**
 * Every index key a candidate row can match, market-specific first then the
 * market wildcard. A row's own market never blocks a game-level rating: the
 * composite key is (league, game identity, market) with a wildcard fallback.
 *
 * @param {Record<string, any>} row
 * @returns {string|null}
 */
function rowKeys(row) {
  const league = segment(row.league);
  if (!league) return null;
  const market = segment(row.market);
  const markets = market === '' || market === WILDCARD ? [WILDCARD] : [market, WILDCARD];

  const keys = [];
  const sides = splitMatchup(row.game);
  const canonical = sides ? sides.map((name) => canonicalTeam(name, row.league)) : [];
  if (canonical.length === 2 && canonical.every((team) => team)) {
    const pair = canonical
      .map((team) => segment(team))
      .sort()
      .join('|');
    for (const m of markets) keys.push(`${league}|${pair}|${m}`);
    for (const team of canonical) {
      for (const m of markets) keys.push(`${league}|${segment(team)}|${m}`);
    }
  }
  return keys.length > 0 ? keys.join('\u0000') : null;
}

/**
 * Normalize the accepted ratings inputs (flat record list, adapter envelopes,
 * or a source-keyed map) into one record array per source.
 *
 * @param {unknown} input
 * @returns {Record<string, Array<Record<string, any>>>}
 */
function recordsBySource(input) {
  /** @type {Record<string, Array<Record<string, any>>>} */
  const bySource = {};
  for (const source of SOURCES) bySource[source] = [];

  const push = (source, record) => {
    if (!SOURCES.includes(source)) return;
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    bySource[source].push(/** @type {Record<string, any>} */ (record));
  };

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.records)) {
        for (const record of item.records) push(item.source, record);
      } else {
        push(item.source, item);
      }
    }
  } else if (input && typeof input === 'object') {
    for (const source of SOURCES) {
      const list = /** @type {Record<string, any>} */ (input)[source];
      if (!Array.isArray(list)) continue;
      for (const record of list) push(source, record);
    }
  }
  return bySource;
}

/**
 * Build the per-source lookup index.
 *
 * @param {Record<string, Array<Record<string, any>>>} bySource
 * @returns {Record<string, Map<string, Array<Record<string, any>>>>}
 */
function buildIndex(bySource) {
  /** @type {Record<string, Map<string, Array<Record<string, any>>>>} */
  const index = {};
  for (const source of SOURCES) {
    const map = new Map();
    for (const record of bySource[source]) {
      const key = recordKey(record);
      if (!key) continue;
      const bucket = map.get(key);
      if (bucket) bucket.push(record);
      else map.set(key, [record]);
    }
    index[source] = map;
  }
  return index;
}

/**
 * Collect the records under a packed key string, de-duplicating shared objects.
 *
 * @param {Map<string, Array<Record<string, any>>>} map
 * @param {string} packed
 * @returns {Array<Record<string, any>>}
 */
function collect(map, packed) {
  const seen = new Set();
  const out = [];
  for (const key of packed.split('\u0000')) {
    const bucket = map.get(key);
    if (!bucket) continue;
    for (const record of bucket) {
      if (seen.has(record)) continue;
      seen.add(record);
      out.push(record);
    }
  }
  return out;
}

/**
 * Build one source entry, or null when nothing matched.
 *
 * @param {unknown} game - the candidate row's own game label (provenance stamp)
 * @param {Array<Record<string, any>>} records
 * @returns {{ game: string|null, asOf: string|null, records: Array<Record<string, any>> } | null}
 */
function buildEntry(game, records) {
  if (records.length === 0) return null;
  let asOf = null;
  for (const record of records) {
    if (typeof record.asOf === 'string' && (asOf === null || record.asOf > asOf)) asOf = record.asOf;
  }
  return {
    game: typeof game === 'string' ? game : null,
    asOf,
    records: records.map((record) => ({ ...record }))
  };
}

/**
 * Every candidate row reachable from the input: a flat row list, or scan result
 * buckets ({"league","market","plays"} / {"candidates"}).
 *
 * @param {unknown} rows
 * @returns {Array<Record<string, any>>}
 */
function iterRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.plays)) out.push(...item.plays);
    else if (Array.isArray(item.candidates)) out.push(...item.candidates);
    else out.push(item);
  }
  return out;
}

/**
 * Attach external ratings to candidate rows in place. Additive only.
 *
 * @param {unknown} rows - flat candidate rows, or result buckets of them
 * @param {{ ratings?: unknown }} [options] - `ratings` is a flat record list,
 *   a list of adapter envelopes (`{ source, records }`), or a source-keyed map
 * @returns {unknown} the same rows input, mutated with `row.ratings` added
 */
function applyRatingsOverlay(rows, options = {}) {
  const bySource = recordsBySource(options.ratings);
  const index = buildIndex(bySource);

  for (const row of iterRows(rows)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    // Only add. A pre-attached row.ratings (another overlay, a hand-built
    // fixture) is authoritative and must never be clobbered.
    if (Object.prototype.hasOwnProperty.call(row, 'ratings')) continue;

    const packed = rowKeys(row);
    /** @type {Record<string, any>} */
    const ratings = {};
    for (const source of SOURCES) {
      ratings[source] = packed === null ? null : buildEntry(row.game, collect(index[source], packed));
    }
    row.ratings = ratings;
  }

  return rows;
}

module.exports = { applyRatingsOverlay, canonicalGameKey };
