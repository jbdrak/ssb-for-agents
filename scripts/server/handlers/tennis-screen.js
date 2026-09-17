'use strict';

/**
 * Tennis screen handler — extracted from createMcpHandlers() in handlers.js.
 */

const { correctTennisTimes, normalizeTennisMarketQuery, rankTennisScreenRows } = require('../../../lib/screen-tennis');
const {
  buildRankedScreenResponse: buildRankedScreenResponseShared,
  getIncludeAll,
  getLimit,
  getMaxAgeMs,
  normalizeBookList
} = require('../../../lib/ssb-mcp-ranked-screen');
const { resolveMarkets, filterPayloadByLeagueName } = require('./handler-utils');
const { extractScreenRows } = require('../../../lib/screen-parser');
const { ALL_SCREEN_BOOKS } = require('../../../lib/ssb-sharp-books');
const { createSharpOddsClient } = require('../../../lib/sharpodds-client');
const { createSharpOddsHistoryProvider } = require('../../../lib/sharpodds-history-provider');
const { getLocalTimezone } = require('../../../lib/mcp-runtime-config');
const { filterTennisRowsByCardWindow } = require('../../../lib/tennis-fallback');

function buildCacheKey(prefix, args, league) {
  return JSON.stringify({
    prefix,
    league,
    market: args.market || 'Moneyline',
    books: normalizeBookList(args.books),
    is_live: false,
    cardWindow: String(args.cardWindow || 'all')
      .trim()
      .toLowerCase(),
    lookbackHours: Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : null,
    games: args.games || [],
    participants: args.participants || [],
    leagueName: args.leagueName || null,
    enableSharpOddsHistory: args.enableSharpOddsHistory === true,
    sharpOddsBooks: normalizeBookList(args.sharpOddsBooks)
  });
}

function getSharedSharpOddsProvider(ctx) {
  if (!ctx) return null;
  if (!ctx.sharpOddsProvider) {
    ctx.sharpOddsProvider = createSharpOddsHistoryProvider({
      client: createSharpOddsClient({ fetchImpl: globalThis.fetch, timeoutMs: 12_000 }),
      timezone: getLocalTimezone()
    });
  }
  return ctx.sharpOddsProvider;
}

/**
 * @param {import('../../../lib/ssb-api').SSBClient} client
 * @param {object} deps
 * @param {import('lru-cache')} deps.responseCache
 * @param {number} deps.responseCacheTtlMs
 * @param {object} [deps.ctx]
 */
function createTennisScreenHandler(client, { responseCache, responseCacheTtlMs, ctx }) {
  async function runTennisScreen(args = {}) {
    const preferredBook = String(args.book || 'Pinnacle').trim() || 'Pinnacle';
    const requestedBooks = normalizeBookList(args.books);
    const marketResolution = resolveMarkets(args, 'Tennis');
    const marketQuery = normalizeTennisMarketQuery(marketResolution.single);

    // Cache check for tennis screen
    const canCache = !args.compact && !args.fields && !args.include;
    const cacheKey = canCache
      ? buildCacheKey(
          'tennis',
          {
            ...args,
            books: requestedBooks.length ? requestedBooks : ALL_SCREEN_BOOKS,
            market: marketResolution.single
          },
          'Tennis'
        )
      : null;
    if (cacheKey) {
      const cached = responseCache.get(cacheKey);
      if (cached) {
        return { ...cached, resultMeta: { ...cached.resultMeta, cached: true } };
      }
    }

    const queryFn =
      typeof client.queryScreenOdds === 'function'
        ? client.queryScreenOdds.bind(client)
        : client.queryScreenOddsBestComps.bind(client);

    const payloads = [];

    if (payloads.length === 0) {
      for (const market of marketQuery) {
        const payload = await queryFn({
          market,
          league: 'Tennis',
          books: ALL_SCREEN_BOOKS,
          is_live: false
        });
        payloads.push(payload);
      }
    }

    const scopedPayloads = payloads.map((payload) => filterPayloadByLeagueName(payload, args.leagueName));
    const rows = scopedPayloads.flatMap((payload) => extractScreenRows(payload));

    const hasScreenBooks = rows.some((row) => {
      const text = JSON.stringify(row || '');
      return (
        text.includes('"Pinnacle"') ||
        text.includes('"Circa"') ||
        text.includes('"BetOnline"') ||
        text.includes('"Kalshi"')
      );
    });
    const hasScreenConsensus = rows.some((row) => {
      const text = JSON.stringify(row || '');
      return text.includes('"consensus"') || text.includes('"ev"') || text.includes('"value"');
    });

    if (hasScreenBooks || hasScreenConsensus) {
      const screenResult = await buildRankedScreenResponseShared({
        client,
        payloads: scopedPayloads,
        args,
        league: 'Tennis',
        focusBook: preferredBook,
        sharpOddsProvider: args.enableSharpOddsHistory === true ? getSharedSharpOddsProvider(ctx) : null,
        // Tennis start times must be corrected BEFORE the shared builder's
        // card-window filter. PP's raw gameId timestamp is stale (commonly a
        // full day off), so a `today` window applied to the raw value serves
        // next-day matches while row-filtering the games that are actually
        // upcoming. Cache + ESPN only here (skipUnmatched): the expensive
        // per-match web resolver still runs later on the survivors via
        // enrichTennisEvCandidates.
        startTimeNormalizer: (rows) => correctTennisTimes(rows, { skipUnmatched: true }),
        rankRows: (hydratedRows, { debug: rankDebug } = {}) =>
          rankTennisScreenRows(hydratedRows, {
            limit: getLimit(args),
            preferredBook,
            includeAll: getIncludeAll(args),
            maxAgeMs: getMaxAgeMs(args),
            debug: rankDebug,
            requirePreferredBook: requestedBooks.length > 0,
            playableOnly: args.playableOnly === true
          })
      });
      if (marketResolution.aliasesUsed.length) {
        screenResult.resultMeta = {
          ...screenResult.resultMeta,
          markets_alias_used: marketResolution.aliasesUsed
        };
      }
      if (cacheKey) {
        const hasResults = Array.isArray(screenResult.result) && screenResult.result.length > 0;
        const hasError = screenResult.error || (screenResult.resultMeta && screenResult.resultMeta.error);
        if (hasResults && !hasError) {
          responseCache.set(cacheKey, screenResult, responseCacheTtlMs);
        }
      }
      return screenResult;
    }

    // Free-access mode does not call the paid +EV endpoint. A truthful empty
    // response is safer than silently substituting a paid discovery source.
    return {
      ok: true,
      result: [],
      league: 'Tennis',
      resultMeta: { debugEnabled: false, source: 'fallback_empty' },
      freshness: { rowCount: rows.length, newestAgeMs: 0, oldestAgeMs: 0, staleCount: 0, stale: false },
      warning:
        'No tennis data available from the free /screen endpoint; no tennis candidates in the requested card window'
    };
  }

  return { runTennisScreen };
}

module.exports = { createTennisScreenHandler, filterTennisRowsByCardWindow };
