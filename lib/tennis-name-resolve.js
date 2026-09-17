/**
 * tennis-name-resolve.js — the ONE identity resolver for tennis results.
 *
 * Every source that feeds recent results (the TennisData season CSV and the
 * Flashscore capture) resolves player names through this module. Keeping a single
 * implementation is a correctness requirement, not tidiness: this layer's contract
 * is fail-closed identity, and two resolvers means a bug in either one can invent a
 * phantom second player for a real person, which silently corrupts ratings.
 *
 * Matching is exact after normalization. There is no fuzzy matching and no
 * substring matching anywhere in this file. When a name cannot be pinned to
 * exactly one archive player, the answer is null and the caller drops the row.
 */

const { normalizeName } = require('./tennis-elo-data');

/**
 * Build `{ NORMALIZED_FULL_NAME: 'Firstname Lastname' }` from archive CSV rows.
 * The display value is what downstream writes into recent_results.csv, so it must
 * be the archive's own spelling rather than the source's.
 *
 * @param {Array<object>} rows - parseMatchCsv rows ({tour, winner, loser, ...})
 * @returns {{ATP: object, WTA: object}}
 */
function buildNameMap(rows) {
  const byTour = { ATP: {}, WTA: {} };
  for (const row of rows) {
    const tour = String(row.tour || '').toUpperCase();
    const idx = byTour[tour];
    if (!idx) continue;
    for (const raw of [row.winner, row.loser]) {
      const name = String(raw || '').trim();
      if (!name) continue;
      idx[normalizeName(name)] = name;
    }
  }
  return byTour;
}

/**
 * `"SURNAME|I"` -> Set(display names), so a surname-plus-initial source name can be
 * resolved when exactly one player matches. Built lazily per tour.
 *
 * @param {Record<string,string>} nameMap - normalized name -> display name
 * @returns {Map<string, Set<string>>}
 */
function buildSurnameIndex(nameMap) {
  const idx = new Map();
  for (const display of Object.values(nameMap)) {
    const tokens = String(display).trim().split(/\s+/);
    if (tokens.length < 2) continue;
    const initial = normalizeName(tokens[0]).slice(0, 1);
    const surname = tokens
      .slice(1)
      .map((t) => normalizeName(t))
      .join(' ');
    const key = `${surname}|${initial}`;
    if (!idx.has(key)) idx.set(key, new Set());
    idx.get(key).add(display);
  }
  return idx;
}

/**
 * Resolve one source player name against the archive.
 *
 * Handles a full name ("Laura Samson") exactly, and a surname-plus-initial
 * ("Samson L.") when exactly one archive player carries that surname and initial.
 *
 * @param {string} raw
 * @param {Record<string,string>} nameMap
 * @param {Map<string, Set<string>>} surnameIndex
 * @returns {string|null} the archive's display name, or null
 */
function resolveName(raw, nameMap, surnameIndex) {
  const name = String(raw || '').trim();
  if (!name) return null;
  const exact = nameMap[normalizeName(name)];
  if (exact) return exact;
  const m = /^(.*?)\s*([A-Za-z])\.?$/.exec(name);
  if (!m) return null;
  const surname = m[1]
    .trim()
    .split(/\s+/)
    .map((t) => normalizeName(t))
    .join(' ');
  if (!surname) return null;
  const hits = surnameIndex.get(`${surname}|${normalizeName(m[2]).slice(0, 1)}`);
  return hits && hits.size === 1 ? [...hits][0] : null;
}

/**
 * Every rotation of a slug's tokens, as candidate full names.
 * `blinkova-anna` is surname-first and `samira-de-stefano` is forename-first, and
 * Flashscore is not consistent, so the rotation set is the honest way to cover both
 * without guessing which convention a given slug uses.
 *
 * @param {string} slug
 * @returns {string[]}
 */
function slugRotations(slug) {
  const tokens = String(slug || '')
    .toLowerCase()
    .split('-')
    .filter(Boolean);
  if (tokens.length < 2) return [];
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    out.push(tokens.slice(i).concat(tokens.slice(0, i)).join(' '));
  }
  return out;
}

/**
 * Resolve a Flashscore slug (the only place a forename appears) against the
 * archive. The slug carries more information than the displayed surname, so this
 * runs before any display-name fallback.
 *
 * Fail-closed: rotations that land on two different players resolve to null.
 *
 * @param {string} slug
 * @param {Record<string,string>} nameMap
 * @returns {string|null}
 */
function resolveSlug(slug, nameMap) {
  const survivors = new Set();
  for (const candidate of slugRotations(slug)) {
    const hit = nameMap[normalizeName(candidate)];
    if (hit) survivors.add(hit);
  }
  return survivors.size === 1 ? [...survivors][0] : null;
}

module.exports = {
  buildNameMap,
  buildSurnameIndex,
  resolveName,
  resolveSlug,
  slugRotations
};
