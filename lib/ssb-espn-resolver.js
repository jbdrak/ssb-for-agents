'use strict';

/**
 * ESPN settled-result resolver for the backtest pipeline.
 *
 * Fetches scoreboard data from ESPN's public API for NBA, MLB, Tennis, and
 * UFC, finds the matching game by team/player name, and returns the settled
 * outcome (win | loss | push) for a given snapshot play.
 *
 * ESPN endpoints (no API key required):
 *   NBA:    site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard
 *   MLB:    site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard
 *   Tennis: site.api.espn.com/apis/site/v2/sports/tennis/{atp,wta}/scoreboard
 *   UFC:    site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard
 *
 * Usage:
 *   const { getPlayResult } = require('./ssb-espn-resolver');
 *   const result = await getPlayResult(play);
 *   // => 'win' | 'loss' | 'push' | null
 *
 * Wire into resolve-outcomes.js:
 *   node scripts/resolve-outcomes.js --espn
 */

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
// Akamai edge-blocks site.api.espn.com intermittently (403 Access Denied). The
// site.web. host serves the same scoreboard JSON; try it before giving up.
const ESPN_BASE_FALLBACK = 'https://site.web.api.espn.com/apis/site/v2/sports';

const { nameSimilarity } = require('./ssb-shared-utils');

const ESPN_LEAGUE_PATH = {
  NBA: 'basketball/nba',
  WNBA: 'basketball/wnba',
  NCAAB: 'basketball/mens-college-basketball',
  MLB: 'baseball/mlb',
  NFL: 'football/nfl',
  NCAAF: 'football/college-football',
  NHL: 'hockey/nhl',
  TENNIS: 'tennis',
  UFC: 'mma/ufc'
};

// Cache per-league scoreboard fetches
const _scoreboardCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch ESPN scoreboard for one league.
 * Returns parsed competitions: [{homeTeam, awayTeam, homeScore, awayScore, status, winner, date}]
 *
 * @param {string} league - upper-case key from ESPN_LEAGUE_PATH
 * @param {Object} [options]
 * @param {string} [options.dates] - YYYYMMDD board date; omit for ESPN's current board
 */
async function fetchEspnScoreboard(league, { dates } = {}) {
  const cacheKey = `${league}:${dates || 'current'}`;
  const now = Date.now();
  const cached = _scoreboardCache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.data;

  const path = ESPN_LEAGUE_PATH[league];
  if (!path) return [];

  // Tennis has no single combined board.
  const subPaths = path === 'tennis' ? ['tennis/atp', 'tennis/wta'] : [path];
  const query = dates ? `?dates=${dates}` : '';

  const allCompetitions = [];
  const seen = new Set();

  for (const base of [ESPN_BASE, ESPN_BASE_FALLBACK]) {
    for (const sub of subPaths) {
      try {
        const response = await fetch(`${base}/${sub}/scoreboard${query}`, {
          headers: { 'User-Agent': 'ssb-for-agents/2.10.0 (venue-order)', Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) continue;
        const data = await response.json();

        const events = Array.isArray(data?.events) ? data.events : [];
        for (const event of events) {
          const competitions = Array.isArray(event?.competitions) ? event.competitions : [];
          for (const comp of competitions) {
            const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
            if (competitors.length < 2) continue;

            const home = competitors.find((c) => c.homeAway === 'home') || competitors[0];
            const away = competitors.find((c) => c.homeAway === 'away') || competitors[1];

            const homeName = (home?.team?.displayName || home?.athlete?.displayName || '').trim();
            const awayName = (away?.team?.displayName || away?.athlete?.displayName || '').trim();
            if (!homeName || !awayName) continue;

            const homeScore = home?.score != null ? String(home.score) : '';
            const awayScore = away?.score != null ? String(away.score) : '';
            const statusState = comp?.status?.type?.state || '';
            const statusDesc = comp?.status?.type?.description || statusState;
            const statusDetail = comp?.status?.type?.detail || '';
            const isFinal = statusState === 'post' || statusDesc === 'Final' || statusDetail === 'Final';
            const compDate = comp?.date || '';

            const key = `${homeName}|${awayName}|${compDate}`;
            if (seen.has(key)) continue;
            seen.add(key);

            let winner = null;
            if (isFinal && homeScore && awayScore) {
              const hs = parseFloat(homeScore);
              const as = parseFloat(awayScore);
              if (!Number.isNaN(hs) && !Number.isNaN(as)) {
                if (hs > as) winner = homeName;
                else if (as > hs) winner = awayName;
              }
            }

            allCompetitions.push({
              homeTeam: homeName,
              awayTeam: awayName,
              homeScore,
              awayScore,
              status: statusDesc || statusState,
              isFinal,
              winner,
              date: compDate
            });
          }
        }
      } catch {
        continue;
      }
    }
    // Primary host served the board — no need to hit the fallback host.
    if (allCompetitions.length > 0) break;
  }

  _scoreboardCache.set(cacheKey, { data: allCompetitions, ts: Date.now() });
  return allCompetitions;
}

/**
 * Find the best matching competition for a play in the scoreboard data.
 * Returns the matched competition or null.
 */
function findMatch(competitions, selection, threshold = 0.7) {
  let best = null;
  let bestScore = 0;

  for (const comp of competitions) {
    const homeSim = nameSimilarity(selection, comp.homeTeam);
    const awaySim = nameSimilarity(selection, comp.awayTeam);
    const score = Math.max(homeSim, awaySim);
    if (score > bestScore) {
      bestScore = score;
      best = comp;
    }
  }

  return bestScore >= threshold ? best : null;
}

/**
 * Determine the settled outcome for a single play.
 *
 * @param {Object} play - snapshot play record with {gameId, selection, market, league, ...}
 * @returns {Promise<'win'|'loss'|'push'|null>} settled outcome, or null if unresolved
 */
async function getPlayResult(play) {
  if (!play || !play.league || !play.selection) return null;

  const league = String(play.league).toUpperCase();
  if (!ESPN_LEAGUE_PATH[league]) return null;

  const competitions = await fetchEspnScoreboard(league);
  if (!competitions.length) return null;

  const selection = String(play.selection).trim();
  const market = String(play.market || 'Moneyline').toLowerCase();

  const match = findMatch(competitions, selection);
  if (!match) return null;
  if (!match.isFinal) return null;

  // Moneyline: pick wins if winner matches selection
  if (market === 'moneyline') {
    if (!match.winner) return null;
    const winnerSim = nameSimilarity(selection, match.winner);
    return winnerSim >= 0.7 ? 'win' : 'loss';
  }

  // For spread/totals, we'd need the line value from the play record.
  // Those aren't captured in the current snapshot schema, so we fall
  // back to null for non-Moneyline markets.
  return null;
}

/**
 * Flush the scoreboard cache (useful for tests).
 */
function clearCache() {
  _scoreboardCache.clear();
}

module.exports = { getPlayResult, fetchEspnScoreboard, findMatch, nameSimilarity, clearCache, ESPN_LEAGUE_PATH };
