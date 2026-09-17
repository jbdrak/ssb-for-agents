'use strict';

/**
 * Build a settlement results document from real, fetched result data.
 *
 * `scripts/settle-record.js` deliberately never calls the network — it takes a
 * supplied results file. Nothing produced one, so the ledger could never be
 * settled and the loop never closed: 0 settlements across the whole ledger.
 * This module is the missing producer.
 *
 * Output contract: `{ provider, sourceUrl, events: [...] }`, the shape
 * `validateResultPayload` (lib/record-results.js) requires. Events are FLAT
 * (`{ eventId, homeTeam, awayTeam, homeScore, awayScore, date, status, winner }`)
 * because `normalizeEvent` accepts flat objects directly.
 *
 * Two integrity rules are load-bearing:
 *
 *   - **Tennis results never carry `homeScore`/`awayScore`.** Flashscore's board
 *     reports SETS, not games. `settleTotal` grades a total as
 *     `homeScore + awayScore`, so publishing sets as scores would settle an
 *     `Under 21.5 games` bet off `2 + 0 = 2` — a silent, confident wrong answer.
 *     Leaving the score fields null makes `settleTotal` fail closed to
 *     `pendingResult('final scores missing from supplied result data')`, which
 *     is the truthful state. Set counts ride along in non-contract fields
 *     (`setsHome`/`setsAway`) for a human, and moneyline still settles off
 *     `winner`.
 *   - **An event whose status is not final is still emitted, and is never
 *     graded.** `settleTotal`/moneyline both refuse a non-final status, so
 *     emitting it is how a postponed match stays visibly pending instead of
 *     silently absent.
 */

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

/** Canonical settlement statuses understood by lib/record-settlement's normalizeEvent. */
const SETTLEMENT_STATUSES = Object.freeze(['final', 'retired', 'postponed', 'scheduled', 'in_progress']);

/**
 * Map an arbitrary status string (ESPN's description, Flashscore's stage label)
 * onto the small set `normalizeEvent` understands.
 *
 * Order matters: a retirement is a retirement even when the event is also over,
 * and "not started" must not be read as "in progress" just because it contains
 * the substring `start`.
 *
 * @param {unknown} text
 * @returns {'final'|'retired'|'postponed'|'scheduled'|'in_progress'|'unknown'}
 */
function settlementStatus(text) {
  const value = String(text == null ? '' : text).trim();
  if (value === '') return 'unknown';
  if (/retir|walkover|abandon|w\/o/i.test(value)) return 'retired';
  if (/postpon|suspend|delay|cancel|ppd/i.test(value)) return 'postponed';
  // ESPN says 'Final'; Flashscore's board says 'Finished'.
  if (/(^|\W)(final|finished)(\W|$)/i.test(value)) return 'final';
  if (/in progress|halftime|live|(^|\W)in(\W|$)/i.test(value)) return 'in_progress';
  if (/scheduled|not started|pre-?game|pre\b/i.test(value)) return 'scheduled';
  return 'unknown';
}

/** Shift an ISO calendar date by a whole number of days. Returns null on bad input. */
function shiftIsoDate(isoDate, days) {
  const parsed = Date.parse(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Map ESPN scoreboard competitions (from lib/ssb-espn-resolver) to result events.
 *
 * `eventId` is left null on purpose: the resolver's competition shape does not
 * carry ESPN's event id, and inventing a synthetic one would give the
 * same-ID guard something to match on that no source can verify. With a null id
 * the settlement path falls through to its name+date match, which re-checks
 * participants and the date window — the fail-safe branch.
 *
 * @param {Object<string, Array<Object>>} boards - { MLB: [competitions], ... }
 * @param {Object} [opts] - { date }
 * @returns {Array<Object>}
 */
function eventsFromEspnBoards(boards, opts = {}) {
  const events = [];
  const entries = boards && typeof boards === 'object' ? Object.entries(boards) : [];
  for (const [league, competitions] of entries) {
    if (!Array.isArray(competitions)) continue;
    const sourceUrl = `${ESPN_BASE}/${league.toLowerCase()}/scoreboard`;
    for (const comp of competitions) {
      if (!comp || !comp.homeTeam || !comp.awayTeam) continue;
      const status = comp.isFinal === true ? 'final' : settlementStatus(comp.status);
      events.push({
        eventId: null,
        league,
        homeTeam: String(comp.homeTeam),
        awayTeam: String(comp.awayTeam),
        homeScore: comp.homeScore == null || comp.homeScore === '' ? null : Number(comp.homeScore),
        awayScore: comp.awayScore == null || comp.awayScore === '' ? null : Number(comp.awayScore),
        date: comp.date || opts.date || null,
        status,
        winner: comp.winner || null,
        provider: 'espn',
        sourceUrl
      });
    }
  }
  return events;
}

/**
 * Map a `flashscore-results.py` payload to result events.
 *
 * @param {Object} payload - { days: [{ strip, offset, result: { matches: [...] } }] }
 * @param {Object} [opts] - { date } the day the scraper was run for (offset 0)
 * @returns {Array<Object>}
 */
function eventsFromFlashscorePayload(payload, opts = {}) {
  const events = [];
  const days = payload && Array.isArray(payload.days) ? payload.days : [];
  for (const day of days) {
    const matches = day && day.result && Array.isArray(day.result.matches) ? day.result.matches : [];
    // `offset` counts days back from the run date (0 = today).
    const offset = Number.isFinite(Number(day && day.offset)) ? Number(day.offset) : null;
    const date = offset == null || !opts.date ? null : shiftIsoDate(opts.date, -offset);
    for (const match of matches) {
      if (!match || !match.home || !match.away) continue;
      const status = settlementStatus(match.stage);
      const winner = match.homeWinner ? match.home : match.awayWinner ? match.away : null;
      events.push({
        eventId: null,
        league: 'TENNIS',
        homeTeam: String(match.home),
        awayTeam: String(match.away),
        // Never the sets: see the module header. Null keeps a total failing
        // closed instead of settling off a set count.
        homeScore: null,
        awayScore: null,
        setsHome: match.setsHome ?? null,
        setsAway: match.setsAway ?? null,
        tournament: match.tournament || null,
        date,
        status,
        winner: status === 'final' || status === 'retired' ? winner : null,
        provider: 'flashscore',
        sourceUrl: 'https://www.flashscore.com/tennis/results/'
      });
    }
  }
  return events;
}

/**
 * Dedupe events by matchup + day. First occurrence wins, so a caller controls
 * precedence by board order.
 *
 * @param {Array<Object>} events
 * @returns {Array<Object>}
 */
function mergeResultEvents(events) {
  const out = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !event.homeTeam || !event.awayTeam) continue;
    const key = [event.homeTeam, event.awayTeam, String(event.date || '').slice(0, 10)]
      .map((v) => v.toLowerCase().replace(/\s+/g, ' ').trim())
      .join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

/**
 * Assemble the settlement document, deriving top-level provenance from the
 * events that are actually present so the header can never claim a source that
 * contributed nothing.
 *
 * @param {Array<Object>} events
 * @returns {{ok: boolean, provider?: string, sourceUrl?: string, events?: Array<Object>, counts?: Object, error?: string}}
 */
function buildResultsDocument(events) {
  const merged = mergeResultEvents(events);
  if (!merged.length) {
    return { ok: false, error: 'no result events: refusing to write an empty results document' };
  }
  const providers = [...new Set(merged.map((e) => e.provider).filter(Boolean))];
  const urls = [...new Set(merged.map((e) => e.sourceUrl).filter(Boolean))];
  const counts = merged.reduce((acc, event) => {
    acc[event.status] = (acc[event.status] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    provider: providers.join('+'),
    sourceUrl: urls.join(' '),
    events: merged,
    counts
  };
}

module.exports = {
  settlementStatus,
  shiftIsoDate,
  eventsFromEspnBoards,
  eventsFromFlashscorePayload,
  mergeResultEvents,
  buildResultsDocument,
  SETTLEMENT_STATUSES,
  ESPN_BASE
};
