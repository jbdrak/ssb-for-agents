'use strict';

/**
 * Venue-order verification.
 *
 * The PP feed's homeTeam/awayTeam are unreliable: null for some games and
 * inverted for others. Verified 2026-09-13 — gameId
 * `MLB:GAME:Colorado_Rockies:Detroit_Tigers` rendered as "Detroit Tigers @
 * Colorado Rockies" for a game played at Comerica Park, and
 * `MLB:GAME:Los_Angeles_Dodgers:Miami_Marlins` was inverted the same way.
 *
 * Printing a wrong `away @ home` corrupts handicap interpretation, but
 * permanently refusing to print one costs the reader real context. So confirm
 * the venue against an independent source (ESPN) and only mark the row verified
 * when that source matches the matchup. Anything unmatched or unreachable stays
 * unverified, which fails closed to a neutral label.
 *
 * Never throws.
 */

const { nameSimilarity } = require('./ssb-shared-utils');

// Average of both participants' name similarity. 0.6 tolerates "Athletics" vs
// "Athletics Athletics" and nickname/abbreviation drift without matching two
// different games in the same league.
const MATCH_THRESHOLD = 0.6;

function splitGameField(value) {
  return String(value || '')
    .split(/\s+(?:vs\.?|@|at)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Participants named on a row, preferring explicit fields over the game string.
 * @param {Object} row
 * @returns {{home: string, away: string}}
 */
function rowTeams(row = {}) {
  const parts = splitGameField(row.game || row.matchup);
  const home = String(row.homeTeam || '').trim() || parts[0] || '';
  const away = String(row.awayTeam || '').trim() || parts[1] || '';
  return { home, away };
}

/**
 * YYYYMMDD board date for the row's start time, or undefined for ESPN's current
 * board. A wrong/missing date only costs us the verification, never correctness.
 * @param {Object} row
 * @returns {string|undefined}
 */
function espnDate(row = {}) {
  const iso = row.start || row.scheduledStart || row.date || '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : undefined;
}

/**
 * Previous calendar day for a YYYYMMDD key.
 *
 * ESPN groups its scoreboard by US-local date, but a row's `start` is UTC. A
 * 20:20Z (4:20pm ET) game derives tomorrow's UTC date while ESPN files it under
 * today, so the derived board comes back empty. Verified 2026-09-13: a
 * `dates=20260914` NFL board held 1 game and no DAL/NYG, while `dates=20260913`
 * held the whole Sunday slate.
 *
 * @param {string} yyyymmdd
 * @returns {string|undefined}
 */
function previousDay(yyyymmdd) {
  const m = String(yyyymmdd || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Pick the ESPN competition matching this row's two participants. Tries both
 * orientations so an inverted feed row still matches.
 *
 * @param {Object[]} competitions - from fetchEspnScoreboard
 * @param {string} home
 * @param {string} away
 * @returns {Object|null}
 */
function matchCompetition(competitions, home, away) {
  let best = null;
  let bestScore = 0;
  for (const comp of competitions || []) {
    const direct = (nameSimilarity(home, comp.homeTeam) + nameSimilarity(away, comp.awayTeam)) / 2;
    const flipped = (nameSimilarity(home, comp.awayTeam) + nameSimilarity(away, comp.homeTeam)) / 2;
    const score = Math.max(direct, flipped);
    if (score > bestScore) {
      bestScore = score;
      best = comp;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

/**
 * Confirm home/away for a play-detail row against ESPN.
 *
 * @param {Object} row - PP row with league, start, and homeTeam/awayTeam or game
 * @param {Object} [deps]
 * @param {Function} [deps.fetchScoreboard] - injectable (league, options) => competitions
 * @returns {Promise<{venueOrderVerified: boolean, homeTeam: string|null, awayTeam: string|null, source: string|null}>}
 */
async function verifyVenueOrder(row = {}, deps = {}) {
  const unresolved = { venueOrderVerified: false, homeTeam: null, awayTeam: null, source: null };

  if (row.venueOrderVerified === true) {
    return {
      venueOrderVerified: true,
      homeTeam: row.homeTeam || null,
      awayTeam: row.awayTeam || null,
      source: 'row'
    };
  }

  const league = String(row.league || '')
    .trim()
    .toUpperCase();
  if (!league) return unresolved;

  const { home, away } = rowTeams(row);
  if (!home || !away) return unresolved;

  const fetchScoreboard = deps.fetchScoreboard || require('./ssb-espn-resolver').fetchEspnScoreboard;

  // Try the derived board date first, then the previous day — ESPN files a late
  // UTC start under the earlier US-local date (see previousDay).
  const derived = espnDate(row);
  const candidateDates = derived ? [derived, previousDay(derived)] : [undefined];

  for (const dates of candidateDates) {
    let competitions;
    try {
      competitions = await fetchScoreboard(league, { dates });
    } catch {
      continue;
    }
    if (!Array.isArray(competitions) || competitions.length === 0) continue;

    const match = matchCompetition(competitions, home, away);
    if (match) {
      return {
        venueOrderVerified: true,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        source: 'espn'
      };
    }
  }

  return unresolved;
}

module.exports = {
  verifyVenueOrder,
  matchCompetition,
  rowTeams,
  espnDate,
  previousDay,
  MATCH_THRESHOLD
};
