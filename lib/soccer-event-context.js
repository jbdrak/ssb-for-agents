'use strict';

const { parseGameStartMs } = require('./ssb-shared-utils');
const { getSoccerEventIdentity, isSoccer } = require('./soccer-event-identity');

const SOCCER_ESPN_LEAGUE_SLUGS = Object.freeze({
  'serie a': 'ita.1',
  'la liga': 'esp.1',
  epl: 'eng.1',
  'premier league': 'eng.1',
  bundesliga: 'ger.1',
  'ligue 1': 'fra.1',
  'liga mx': 'mex.1',
  'champions league': 'uefa.champions',
  champions: 'uefa.champions',
  'europa league': 'uefa.europa',
  europa: 'uefa.europa',
  'efl championship': 'eng.2'
});

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_SCOREBOARD_TIMEOUT_MS = 10_000;
const scoreboardCache = new Map();

/**
 * Clubs the PP feed and ESPN spell differently.
 *
 * Matching is an exact compare of the normalized pair (see `matchesTeamPair`),
 * which is deliberate: loose matching lets `Levante` match `Levante Las Planas`
 * and `Barcelona` match `Barcelona SC` (both score 0.900 on nameSimilarity),
 * and those are different clubs. Spelling drift is corrected here instead, as
 * data, so the compare stays exact.
 *
 * Keys are normalized team names (lower-case, accent-stripped, punctuation
 * removed). Values are ESPN's spelling, which is also what a resolved event
 * reports back. Verified 2026-09-16 against ESPN's esp.1 board: the feed sends
 * "Athletic Bilbao"/"Deportivo La Coruna" for events ESPN lists as
 * "Athletic Club"/"Deportivo".
 */
const SOCCER_TEAM_ALIASES = Object.freeze({
  'athletic bilbao': 'athletic club',
  'deportivo la coruna': 'deportivo',
  'hapoel beer sheva': 'hapoel beer'
});

function normalizeSoccerTeamName(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return SOCCER_TEAM_ALIASES[normalized] || normalized;
}

function normalizeCompetition(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function getSoccerScoreboardUrl(leagueName, dateKey) {
  const slug = SOCCER_ESPN_LEAGUE_SLUGS[normalizeCompetition(leagueName)];
  if (!slug || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${String(dateKey).replaceAll('-', '')}`;
}

function getDateKey(value) {
  const ms = parseGameStartMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function getTeamNames(competitor) {
  const team = competitor?.team || competitor?.athlete || competitor || {};
  return [team.displayName, team.shortDisplayName, team.name, team.abbreviation]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function getCompetitors(event) {
  const competitors = event?.competitions?.[0]?.competitors;
  if (!Array.isArray(competitors)) return null;
  const home = competitors.find((entry) => entry?.homeAway === 'home');
  const away = competitors.find((entry) => entry?.homeAway === 'away');
  if (!home || !away) return null;
  const homeNames = getTeamNames(home);
  const awayNames = getTeamNames(away);
  if (!homeNames.length || !awayNames.length) return null;
  return { home, away, homeNames, awayNames };
}

function teamPairKey(first, second) {
  return [normalizeSoccerTeamName(first), normalizeSoccerTeamName(second)].sort().join('::');
}

function matchesTeamPair(row, competitors) {
  const rowHome = normalizeSoccerTeamName(row.homeTeam);
  const rowAway = normalizeSoccerTeamName(row.awayTeam);
  if (!rowHome || !rowAway) return false;
  return competitors.homeNames.some((homeName) =>
    competitors.awayNames.some((awayName) => teamPairKey(homeName, awayName) === teamPairKey(rowHome, rowAway))
  );
}

function cacheTtlMs(options = {}) {
  const value = Number(options.ttlMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CACHE_TTL_MS;
}

function scoreboardTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCOREBOARD_TIMEOUT_MS;
}

/**
 * @param {{leagueName?: string, dateKey?: string, fetchImpl?: typeof globalThis.fetch, nowMs?: number, ttlMs?: number, timeoutMs?: number}} options
 */
async function fetchSoccerScoreboard({
  leagueName,
  dateKey,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  ttlMs,
  timeoutMs
} = {}) {
  const url = getSoccerScoreboardUrl(leagueName, dateKey);
  if (!url || typeof fetchImpl !== 'function') return [];
  const key = `${normalizeCompetition(leagueName)}::${dateKey}`;
  const cached = scoreboardCache.get(key);
  if (cached && cached.expiresAt > nowMs) return cached.promise;

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), scoreboardTimeoutMs(timeoutMs));
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!response || response.ok === false) return [];
      const payload = await response.json();
      return Array.isArray(payload?.events) ? payload.events : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  })();
  scoreboardCache.set(key, { expiresAt: nowMs + cacheTtlMs({ ttlMs }), promise });
  return promise;
}

async function resolveSoccerEventContext(row = {}, options = {}) {
  if (!isSoccer(row) || !String(row.leagueName || '').trim()) {
    return { resolved: false, reason: 'missing_competition_scope' };
  }
  const dateKey = getDateKey(row.start ?? row.startTime ?? row.startTimestamp);
  if (!dateKey) return { resolved: false, reason: 'missing_event_date' };
  const events = await fetchSoccerScoreboard({
    leagueName: row.leagueName,
    dateKey,
    fetchImpl: options.fetchImpl,
    nowMs: options.nowMs,
    ttlMs: options.ttlMs,
    timeoutMs: options.timeoutMs
  });
  for (const event of events) {
    const eventDate = getDateKey(event?.date);
    const competitors = getCompetitors(event);
    if (!competitors || eventDate !== dateKey || !matchesTeamPair(row, competitors)) continue;
    const venue = event?.competitions?.[0]?.venue?.fullName || null;
    return {
      resolved: true,
      source: 'espn',
      competition: String(row.leagueName).trim(),
      eventDate: dateKey,
      start: event.date || null,
      homeTeam: competitors.homeNames[0],
      awayTeam: competitors.awayNames[0],
      venue
    };
  }
  return { resolved: false, reason: 'schedule_match_not_found' };
}

async function enrichSoccerEventRows(rows, options = {}) {
  const input = Array.isArray(rows) ? rows : [];
  return Promise.all(
    input.map(async (row) => {
      if (!row || !isSoccer(row)) return row;
      const context = await resolveSoccerEventContext(row, options);
      if (!context.resolved) return row;
      const enriched = {
        ...row,
        homeTeam: context.homeTeam,
        awayTeam: context.awayTeam,
        venue: context.venue || row.venue || null,
        venueOrderVerified: true,
        homeAwayVerified: true,
        soccerEventContext: context
      };
      return { ...enriched, game: getSoccerEventIdentity(enriched).label };
    })
  );
}

function clearSoccerEventCache() {
  scoreboardCache.clear();
}

module.exports = {
  SOCCER_ESPN_LEAGUE_SLUGS,
  DEFAULT_SCOREBOARD_TIMEOUT_MS,
  normalizeSoccerTeamName,
  getSoccerScoreboardUrl,
  fetchSoccerScoreboard,
  resolveSoccerEventContext,
  enrichSoccerEventRows,
  clearSoccerEventCache
};
