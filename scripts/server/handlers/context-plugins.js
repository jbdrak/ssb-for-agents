'use strict';

/**
 * Context plugins handlers: player_context, mlb_game_context, fantasy_optimizer,
 * league_presets.
 *
 * Extracted from createMcpHandlers() in handlers.js (v2.x.x).
 *
 * Note: ufc_card was skipped — it calls the closure function `runUfcCard`
 * which depends on resolveMarkets, runLeagueScreen, buildUfcShortlist, getLimit
 * and other closure-scoped helpers.
 */

const { ok } = require('../../../lib/response-envelope');
const { getPlayerContext } = require('../../../lib/ssb-player-context');
const { getMlbGameContext } = require('../../../lib/ssb-mlb-game-context');
const { getLeagueRankingPreset } = require('../../../lib/ssb-mcp-ranked-screen');
const { getSharpBookComparisonSet, getSharpBookContext } = require('../../../lib/ssb-sharp-books');

// ─── league preset inspector (extracted closure) ──────────────────────────

function buildLeaguePresetSummary() {
  const leagues = ['NBA', 'WNBA', 'MLB', 'NFL', 'NHL', 'UFC', 'SOCCER', 'TENNIS', 'NCAAB', 'NCAAF'];
  return leagues.map((league) => {
    const preset = getLeagueRankingPreset(league);
    const isSharpLeague = ['NBA', 'NFL', 'MLB'].includes(league);
    const sharpMainMarkets = isSharpLeague ? getSharpBookComparisonSet({ league, market: 'Moneyline' }) : undefined;
    const sharpProps = isSharpLeague
      ? getSharpBookComparisonSet({ league, market: league === 'MLB' ? 'Player Strikeouts' : 'Player Points' })
      : undefined;

    return {
      ...preset,
      sharpMainMarkets,
      sharpProps,
      sharpBookVariants: isSharpLeague
        ? {
            mainMarkets: sharpMainMarkets,
            playerProps: sharpProps
          }
        : undefined,
      sharpBookResearch: getSharpBookContext({ league, market: league === 'MLB' ? 'Moneyline' : undefined })
    };
  });
}

// ─── factory ──────────────────────────────────────────────────────────────

/**
 * @param {import('../../../lib/ssb-api').SSBClient} client
 * @param {import('./handler-context').HandlerContext} ctx
 */
function createContextPluginsHandlers(client, _ctx) {
  return {
    async player_context(args = {}) {
      const player = typeof args.player === 'string' ? args.player.trim() : '';
      if (!player) {
        return { ok: false, error: 'player argument is required' };
      }
      return ok(
        await getPlayerContext({
          player,
          sport: typeof args.sport === 'string' && args.sport.length > 0 ? args.sport : null,
          gameTime: typeof args.gameTime === 'string' && args.gameTime.length > 0 ? args.gameTime : null,
          maxAgeMinutes: Number.isFinite(Number(args.maxAgeMinutes)) ? Number(args.maxAgeMinutes) : 60,
          useXurl: args.useXurl === true
        })
      );
    },

    async mlb_game_context(args = {}) {
      const gamePk = String(args.gamePk || '').trim();
      if (!gamePk) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'gamePk is required' } };
      }
      if (!/^\d{4,}$/.test(gamePk)) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'gamePk must be a numeric MLB game ID' } };
      }
      try {
        const result = await getMlbGameContext({ gamePk });
        return result;
      } catch (err) {
        return { ok: false, gamePk, error: { code: 'API_ERROR', message: err?.message || String(err) } };
      }
    },

    async fantasy_optimizer(args = {}) {
      const filters = {
        fantasyApps: Array.isArray(args.fantasyApps) && args.fantasyApps.length ? args.fantasyApps : ['PrizePicks'],
        leagues:
          Array.isArray(args.leagues) && args.leagues.length
            ? args.leagues
            : ['NBA', 'MLB', 'WNBA', 'Tennis', 'NHL', 'NFL', 'UFC', 'Soccer']
      };
      if (args.market) filters.market = args.market;
      if (args.isLive === true) filters.isLive = true;
      const result = await client.queryBackendFantasyPicks(filters);
      // The live backend returns an envelope: { freeTier, threshold, omitted, bets: [...] }.
      // Legacy callers/tests return a bare array. Normalize both, otherwise the envelope is
      // discarded and the whole fantasy board is silently reported as empty.
      const picks = Array.isArray(result) ? result : Array.isArray(result?.bets) ? result.bets : [];
      return {
        ok: true,
        count: picks.length,
        result: picks
      };
    },

    async league_presets() {
      return { ok: true, result: buildLeaguePresetSummary() };
    }
  };
}

module.exports = { createContextPluginsHandlers };
