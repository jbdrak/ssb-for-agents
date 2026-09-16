'use strict';

function isSoccer(row = {}) {
  return /^(soccer|mls)$/i.test(String(row.league || row.sport || row.gameType || '').trim());
}

/**
 * Build a safe soccer matchup label. Soccer screen rows don't consistently
 * encode home-first ordering, so only an explicit venue marker may produce an
 * away-at-home label.
 * @param {Object} row
 * @returns {{teamA: string, teamB: string, venueOrderVerified: boolean, label: string}}
 */
function getSoccerEventIdentity(row = {}) {
  const home = String(row.homeTeam || '').trim();
  const away = String(row.awayTeam || '').trim();
  const parts = String(row.game || row.matchup || '')
    .split(/\s+vs\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const teamA = home || parts[0] || '';
  const teamB = away || parts[1] || '';
  const venueOrderVerified = row.venueOrderVerified === true || row.homeAwayVerified === true;
  const label = venueOrderVerified ? `${teamB} @ ${teamA}` : `${teamA} vs ${teamB} (home/away unverified)`;
  return { teamA, teamB, venueOrderVerified, label };
}

function buildMatchupLabel(row = {}) {
  if (isSoccer(row)) return getSoccerEventIdentity(row).label;
  const home = String(row.homeTeam || '').trim();
  const away = String(row.awayTeam || '').trim();
  return row.game || row.matchup || (home && away ? `${home} vs ${away}` : '');
}

/**
 * Event label that never asserts venue order without a verified marker.
 *
 * Rule (repo doctrine): do not infer home/away from participant order, the
 * gameId token order, or a generic feed field. Only an explicit venue marker
 * may produce an `away @ home` label. Verified 2026-09-13: the MLB/NFL feed
 * returns homeTeam/awayTeam that are null for some games and inverted for
 * others (Colorado_Rockies:Detroit_Tigers rendered as "Detroit Tigers @
 * Colorado Rockies" for a game at Comerica Park). Absence of the marker fails
 * closed to a neutral "A vs B" label rather than a wrong matchup.
 *
 * @param {Object} row
 * @returns {string}
 */
function formatEventLabel(row = {}) {
  if (row.venueOrderVerified === true) {
    const home = String(row.homeTeam || '').trim();
    const away = String(row.awayTeam || '').trim();
    if (home || away) return `${away || 'Away'} @ ${home || 'Home'}`;
  }
  return buildMatchupLabel(row) || '(home/away unverified)';
}

module.exports = { buildMatchupLabel, formatEventLabel, getSoccerEventIdentity, isSoccer };
