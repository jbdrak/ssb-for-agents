'use strict';

// Wrap a fixture's settled result so the ratings evidence gate can score a source
// that publishes a win probability.
//
// WHY THIS EXISTS: the layer can score Sagarin (the only adapter that carries a
// published win probability) but had no outcome feed for the leagues Sagarin
// covers. The repo's automatic resolver (`scripts/resolve-outcomes.js --espn`)
// covers NBA/MLB/Tennis/UFC and resolves OUR recorded plays; it does not cover
// college football and does not answer "who won this ratings fixture". This
// module answers exactly that, from ESPN's public scoreboard.
//
// FAIL CLOSED, THREE WAYS, because a wrong winner is worse than no sample: it
// would be scored as evidence and quietly move a source's calibration.
//
//   1. Identity is the layer's own. A side must canonicalize through the same
//      `identity` the overlay and the evaluation bridge use, and the fixture key
//      is the same order-independent `canonicalGameKey` pair. A name this module
//      resolves differently from the bridge would never join, so it is dropped
//      rather than approximated.
//   2. ESPN's `location` field is the name that canonicalizes. Measured against a
//      live 80-game CFB slate: `team.location` canonicalized on 160/160 teams,
//      while `displayName` ("Pittsburgh Panthers") canonicalized on 0/160 and
//      `shortDisplayName` ("Western KY") on 151/160. Only `location` is used.
//   3. A pairing ESPN lists twice in the window (or a non-completed game, or a
//      tie) is refused, never collapsed onto one game. An unknown name is skipped.
//
// The winner is emitted as the RECORD'S OWN side label, not ESPN's, so the
// bridge's side attribution cannot disagree with the label it is given.

const { canonicalGameKey, identity } = require('./ssb-ratings-overlay');

/**
 * The layer's order-independent identity for a matchup. Order does not matter:
 * `canonicalGameKey` sorts the two canonical sides.
 *
 * @param {unknown} sideA
 * @param {unknown} sideB
 * @param {unknown} league
 * @returns {string|null}
 */
function fixtureKey(sideA, sideB, league) {
  if (!sideA || !sideB) return null;
  return canonicalGameKey(`${sideA} vs ${sideB}`, league);
}

/**
 * Index ESPN college-football scoreboard events by canonical fixture.
 *
 * @param {Array<Object>} events - ESPN scoreboard events
 * @param {string} [league] - canonical league code the events belong to
 * @returns {{byPair: Map<string, {winnerCanonical: string}>, ambiguous: Set<string>, skipped: Array<{reason: string, sample: string}>}}
 */
function buildCfbOutcomeIndex(events, league = 'NCAAF') {
  const byPair = new Map();
  const ambiguous = new Set();
  const skipped = [];
  const note = (reason, sample) => skipped.push({ reason, sample });

  for (const event of Array.isArray(events) ? events : []) {
    const competition = (event && event.competitions && event.competitions[0]) || null;
    const competitors = (competition && competition.competitors) || [];
    if (competitors.length !== 2) {
      note('not_two_competitors', event && event.name ? event.name : '(event)');
      continue;
    }
    const status = competition.status && competition.status.type ? competition.status.type : {};
    if (status.completed !== true) {
      note('not_completed', event.name || '(event)');
      continue;
    }
    const sides = competitors.map((competitor) => {
      const location = competitor && competitor.team ? competitor.team.location : null;
      return {
        canonical: identity(location, league),
        winner: competitor && competitor.winner === true,
        label: String(location || '')
      };
    });
    if (sides.some((side) => !side.canonical)) {
      note('team_unresolved', competitors.map((c) => (c && c.team ? c.team.location : '?')).join(' vs '));
      continue;
    }
    const winners = sides.filter((side) => side.winner);
    if (winners.length !== 1) {
      // A tie, or a scoreboard row with no winner flag: the game has no single
      // winner to attribute, so it is not evidence.
      note('no_single_winner', sides.map((side) => side.label).join(' vs '));
      continue;
    }
    const key = fixtureKey(sides[0].canonical, sides[1].canonical, league);
    if (!key) {
      note('fixture_key_unresolved', sides.map((side) => side.label).join(' vs '));
      continue;
    }
    if (byPair.has(key)) {
      // The same pairing twice in one window is two games, not one. Refusing it
      // is the only answer that cannot silently score a fixture with the wrong
      // night's result.
      ambiguous.add(key);
      note('duplicate_fixture', sides.map((side) => side.label).join(' vs '));
      continue;
    }
    byPair.set(key, { winnerCanonical: winners[0].canonical });
  }

  return { byPair, ambiguous, skipped };
}

/**
 * Whether a record names the same team on both sides.
 *
 * Sagarin's payload carries its team RATINGS table alongside its game
 * predictions, and a rating row reads `teamA === teamB`. That is not a fixture:
 * it has no opponent, so it can never match a result, and counting it as one
 * both inflates the denominator and reports a permanent failure that is not a
 * failure. Compared canonically when both sides resolve and literally otherwise,
 * so a team the alias registry does not know (an FCS program, say) is still
 * recognised as its own non-fixture rather than reported as a fixture whose name
 * could not be resolved.
 *
 * @param {unknown} teamA
 * @param {unknown} teamB
 * @param {unknown} league
 * @returns {boolean}
 */
function isSameSide(teamA, teamB, league) {
  if (typeof teamA !== 'string' || typeof teamB !== 'string') return false;
  const a = identity(teamA, league);
  const b = identity(teamB, league);
  if (a && b) return a === b;
  return teamA.trim().toLowerCase() === teamB.trim().toLowerCase();
}

/**
 * Attach settled results to ratings records.
 *
 * @param {Array<Object>} records - contract records (`teamA`, `teamB`, `league`)
 * @param {Object} index - from `buildCfbOutcomeIndex`
 * @returns {{outcomes: Array<{league: string, game: string, winner: string}>, matched: number, unmatched: number, fixtures: number, notFixtures: number, refused: number, reasons: Object}}
 */
function matchCfbOutcomes(records, index) {
  const outcomes = [];
  const reasons = {};
  const bump = (reason) => {
    reasons[reason] = (reasons[reason] || 0) + 1;
  };
  let unmatched = 0;
  let notFixtures = 0;

  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue;
    const league = record.league;
    if (isSameSide(record.teamA, record.teamB, league)) {
      // Counted apart from `unmatched`: nothing failed to settle, there was
      // nothing to settle.
      notFixtures += 1;
      bump('not_a_fixture');
      continue;
    }
    const sideA = identity(record.teamA, league);
    const sideB = identity(record.teamB, league);
    const key = sideA && sideB ? fixtureKey(record.teamA, record.teamB, league) : null;
    if (!key) {
      bump('record_identity_unresolved');
      unmatched += 1;
      continue;
    }
    if (index.ambiguous.has(key)) {
      bump('ambiguous_fixture');
      unmatched += 1;
      continue;
    }
    const hit = index.byPair.get(key);
    if (!hit) {
      bump('no_settled_result');
      unmatched += 1;
      continue;
    }
    // Report the winner using the record's OWN label so the bridge's side
    // attribution can never disagree with the label it is handed.
    let winner = null;
    if (sideA === hit.winnerCanonical) winner = record.teamA;
    else if (sideB === hit.winnerCanonical) winner = record.teamB;
    if (!winner) {
      bump('winner_not_in_record');
      unmatched += 1;
      continue;
    }
    outcomes.push({ league, game: `${record.teamA} vs ${record.teamB}`, winner });
  }

  return {
    outcomes,
    matched: outcomes.length,
    unmatched,
    // The honest denominator: records that actually name a matchup.
    fixtures: outcomes.length + unmatched,
    notFixtures,
    refused: unmatched,
    reasons
  };
}

module.exports = { buildCfbOutcomeIndex, matchCfbOutcomes, fixtureKey, isSameSide };
