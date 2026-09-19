/** @typedef {Object} CfbSummary
 * @property {number} [plays]
 * @property {number} [epaSum]
 * @property {number} [successSum]
 * @property {number} [explosivePlays]
 * @property {number} [earlyDownPasses]
 * @property {number} [earlyDownPlays]
 * @property {number} [earlyDownEpaSum]
 * @property {number} [passingDownEpaSum]
 * @property {number} [passingDownPlays]
 * @property {number} [sacksAllowed]
 * @property {number} [dropbacks]
 * @property {number} [turnovers]
 * @property {number} [havocEvents]
 * @property {number} [possessionSeconds]
 * @property {number} [scoringOpportunityPoints]
 * @property {number} [scoringOpportunities]
 */

/** @typedef {Object} CfbGame
 * @property {string} gameId
 * @property {number} season
 * @property {string} startDate
 * @property {string} homeTeamId
 * @property {string} awayTeamId
 * @property {CfbSummary} home
 * @property {CfbSummary} away
 */

/** @typedef {Object} CfbFeatureOutput
 * @property {number} season
 * @property {string} gameId
 * @property {string} startDate
 * @property {string} homeTeamId
 * @property {string} awayTeamId
 * @property {Object<string, number|null>} features
 */

const MATCHUP_KEYS = ['epa', 'success', 'explosive', 'havoc'];
const OWN_KEYS = [
  'earlyDownPassRate',
  'earlyDownEpa',
  'passingDownEpa',
  'sackRateAllowed',
  'turnoverRate',
  'finishingDrives',
  'pace'
];

function validRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

function observations(summary) {
  const plays = summary.plays;
  return {
    epa: validRatio(summary.epaSum, plays),
    success: validRatio(summary.successSum, plays),
    explosive: validRatio(summary.explosivePlays, plays),
    earlyDownPassRate: validRatio(summary.earlyDownPasses, summary.earlyDownPlays),
    earlyDownEpa: validRatio(summary.earlyDownEpaSum, summary.earlyDownPlays),
    passingDownEpa: validRatio(summary.passingDownEpaSum, summary.passingDownPlays),
    sackRateAllowed: validRatio(summary.sacksAllowed, summary.dropbacks),
    turnoverRate: validRatio(summary.turnovers, plays),
    finishingDrives: validRatio(summary.scoringOpportunityPoints, summary.scoringOpportunities),
    havoc: validRatio(summary.havocEvents, plays),
    pace:
      Number.isFinite(summary.possessionSeconds) && summary.possessionSeconds > 0
        ? validRatio(plays, summary.possessionSeconds / 60)
        : null
  };
}

function validateGames(games) {
  if (!Array.isArray(games)) throw new Error('games must be an array');

  for (const [index, game] of games.entries()) {
    const label = `game at index ${index}`;
    if (!game || typeof game !== 'object' || Array.isArray(game)) {
      throw new Error(`${label} must be an object`);
    }
    const gameLabel = game.gameId ? `${label} (${game.gameId})` : label;
    if (typeof game.gameId !== 'string' || game.gameId.trim() === '') {
      throw new Error(`${gameLabel} must have a nonempty gameId`);
    }
    if (!Number.isFinite(game.season) || !Number.isInteger(game.season)) {
      throw new Error(`${gameLabel} must have a finite integer season`);
    }
    if (
      typeof game.startDate !== 'string' ||
      game.startDate.trim() === '' ||
      !Number.isFinite(Date.parse(game.startDate))
    ) {
      throw new Error(`${gameLabel} has an invalid startDate`);
    }
    if (typeof game.homeTeamId !== 'string' || game.homeTeamId.trim() === '') {
      throw new Error(`${gameLabel} must have a nonempty homeTeamId`);
    }
    if (typeof game.awayTeamId !== 'string' || game.awayTeamId.trim() === '') {
      throw new Error(`${gameLabel} must have a nonempty awayTeamId`);
    }
    if (game.homeTeamId === game.awayTeamId) {
      throw new Error(`${gameLabel} must have distinct homeTeamId and awayTeamId`);
    }
    for (const side of ['home', 'away']) {
      const summary = game[side];
      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        throw new Error(`${gameLabel} must have a ${side} summary object`);
      }
    }
  }
}

function makeState() {
  const makeMetricGroup = (keys) => ({
    values: Object.fromEntries(keys.map((key) => [key, null])),
    counts: Object.fromEntries(keys.map((key) => [key, 0]))
  });
  return {
    gamesObserved: 0,
    off: makeMetricGroup(MATCHUP_KEYS),
    def: makeMetricGroup(MATCHUP_KEYS),
    own: makeMetricGroup(OWN_KEYS)
  };
}

function updateMetric(target, key, value, alpha) {
  if (!Number.isFinite(value)) return false;
  const prior = target.values[key];
  const next = prior === null ? value : alpha * value + (1 - alpha) * prior;
  if (!Number.isFinite(next)) return false;
  target.values[key] = next;
  target.counts[key] += 1;
  return true;
}

function updateState(state, offenseSummary, defenseSummary, alpha) {
  const offense = observations(offenseSummary);
  const defense = observations(defenseSummary);
  let hasValidOffenseObservation = false;
  for (const key of MATCHUP_KEYS) {
    if (updateMetric(state.off, key, offense[key], alpha)) hasValidOffenseObservation = true;
    updateMetric(state.def, key, defense[key], alpha);
  }
  for (const key of OWN_KEYS) {
    if (updateMetric(state.own, key, offense[key], alpha)) hasValidOffenseObservation = true;
  }
  if (hasValidOffenseObservation) state.gamesObserved += 1;
}

function visible(metrics, key, minGames) {
  return metrics.counts[key] >= minGames ? metrics.values[key] : null;
}

function snapshot(game, homeState, awayState, minGames) {
  const show = (metrics, key) => visible(metrics, key, minGames);
  const homeOff = homeState.off;
  const awayOff = awayState.off;
  const homeDef = homeState.def;
  const awayDef = awayState.def;
  const homeOwn = homeState.own;
  const awayOwn = awayState.own;
  return {
    season: game.season,
    gameId: game.gameId,
    startDate: game.startDate,
    homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId,
    features: {
      homeOffEpa: show(homeOff, 'epa'),
      awayOffEpa: show(awayOff, 'epa'),
      homeDefEpaAllowed: show(homeDef, 'epa'),
      awayDefEpaAllowed: show(awayDef, 'epa'),
      homeOffSuccess: show(homeOff, 'success'),
      awayOffSuccess: show(awayOff, 'success'),
      homeDefSuccessAllowed: show(homeDef, 'success'),
      awayDefSuccessAllowed: show(awayDef, 'success'),
      homeOffExplosive: show(homeOff, 'explosive'),
      awayOffExplosive: show(awayOff, 'explosive'),
      homeDefExplosiveAllowed: show(homeDef, 'explosive'),
      awayDefExplosiveAllowed: show(awayDef, 'explosive'),
      homeOffHavocAllowed: show(homeOff, 'havoc'),
      awayOffHavocAllowed: show(awayOff, 'havoc'),
      homeDefHavoc: show(homeDef, 'havoc'),
      awayDefHavoc: show(awayDef, 'havoc'),
      homeEarlyDownPassRate: show(homeOwn, 'earlyDownPassRate'),
      awayEarlyDownPassRate: show(awayOwn, 'earlyDownPassRate'),
      homeEarlyDownEpa: show(homeOwn, 'earlyDownEpa'),
      awayEarlyDownEpa: show(awayOwn, 'earlyDownEpa'),
      homePassingDownEpa: show(homeOwn, 'passingDownEpa'),
      awayPassingDownEpa: show(awayOwn, 'passingDownEpa'),
      homeSackRateAllowed: show(homeOwn, 'sackRateAllowed'),
      awaySackRateAllowed: show(awayOwn, 'sackRateAllowed'),
      homeTurnoverRate: show(homeOwn, 'turnoverRate'),
      awayTurnoverRate: show(awayOwn, 'turnoverRate'),
      homeFinishingDrives: show(homeOwn, 'finishingDrives'),
      awayFinishingDrives: show(awayOwn, 'finishingDrives'),
      homePace: show(homeOwn, 'pace'),
      awayPace: show(awayOwn, 'pace'),
      homeGamesObserved: homeState.gamesObserved,
      awayGamesObserved: awayState.gamesObserved
    }
  };
}

/**
 * @param {CfbGame[]} games
 * @param {{alpha?: number, minGames?: number}} [options]
 * @returns {CfbFeatureOutput[]}
 */
function buildWalkForwardCfbFeatures(games, { alpha = 0.35, minGames = 2 } = {}) {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error('alpha must be in (0, 1]');
  }
  if (!Number.isInteger(minGames) || minGames <= 0) {
    throw new Error('minGames must be a positive integer');
  }
  validateGames(games);

  const statesBySeason = new Map();
  const sortedGames = games
    .map((game, index) => ({ game, index, timestamp: Date.parse(game.startDate) }))
    .sort((a, b) => {
      if (Number.isNaN(a.timestamp) || Number.isNaN(b.timestamp)) {
        return a.index - b.index;
      }
      return a.timestamp - b.timestamp || String(a.game.gameId).localeCompare(String(b.game.gameId));
    });
  const output = [];

  for (let index = 0; index < sortedGames.length;) {
    const timestamp = sortedGames[index].timestamp;
    let end = index + 1;
    while (end < sortedGames.length && sortedGames[end].timestamp === timestamp) end += 1;

    const bucket = sortedGames.slice(index, end);
    for (const { game } of bucket) {
      if (!statesBySeason.has(game.season)) statesBySeason.set(game.season, new Map());
      const states = statesBySeason.get(game.season);
      if (!states.has(game.homeTeamId)) states.set(game.homeTeamId, makeState());
      if (!states.has(game.awayTeamId)) states.set(game.awayTeamId, makeState());
    }
    const snapshots = bucket.map(({ game }) => {
      const states = statesBySeason.get(game.season);
      const homeState = states.get(game.homeTeamId);
      const awayState = states.get(game.awayTeamId);
      return { game, homeState, awayState, row: snapshot(game, homeState, awayState, minGames) };
    });
    output.push(...snapshots.map(({ row }) => row));

    for (const { game, homeState, awayState } of snapshots) {
      updateState(homeState, game.home, game.away, alpha);
      updateState(awayState, game.away, game.home, alpha);
      const states = statesBySeason.get(game.season);
      states.set(game.homeTeamId, homeState);
      states.set(game.awayTeamId, awayState);
    }
    index = end;
  }

  return output;
}

module.exports = { buildWalkForwardCfbFeatures };
