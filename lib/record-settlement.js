'use strict';

/**
 * Local-only settlement of logged bets against SUPPLIED result data.
 *
 * Scope (Task 5):
 *   - No network code in this slice. Callers fetch result data elsewhere and
 *     hand it to this module as { provider, sourceUrl, events }.
 *   - Match by stable game/event ID first; a conservative unambiguous
 *     name+date fallback is the ONLY fallback (never fuzzy name guessing).
 *   - MLB (and other score-based leagues): final-score win/loss/push and
 *     conservative game-total (Over/Under) grading at an explicit line.
 *   - Tennis: completed matches settle; retirements stay an explicit
 *     'retirement' status unless the caller supplies a settlement policy.
 *     Without a policy the module NEVER guesses a win/loss for a retirement.
 *   - Unknown or ambiguous events remain 'pending'.
 *   - Scheduled vs actual start dates are preserved separately so delayed
 *     games keep both the original schedule and the real start.
 *   - W/L/P finalization requires non-empty top-level provider and sourceUrl
 *     provenance on the supplied result data; event-specific source URLs are
 *     preserved only when that top-level provenance is valid.
 *   - Source URL and evidence are stored on every settlement record.
 *   - Persistence delegates to lib/record-ledger (atomic tmp+fsync+rename
 *     helpers); this module never touches the filesystem directly.
 */

const ledgerModule = require('./record-ledger');

const SETTLED_STATUSES = Object.freeze(['win', 'loss', 'push']);
const VALID_STATUSES = Object.freeze([...SETTLED_STATUSES, 'pending', 'retirement']);
const DEFAULT_MAX_DELAY_DAYS = 1;

// Deterministic MLB team abbreviation map used ONLY by the conservative
// name+date fallback (still requires both sides + date window + uniqueness).
const MLB_ABBREVIATIONS = {
  ari: 'Arizona Diamondbacks',
  atl: 'Atlanta Braves',
  bal: 'Baltimore Orioles',
  bos: 'Boston Red Sox',
  chc: 'Chicago Cubs',
  cws: 'Chicago White Sox',
  cin: 'Cincinnati Reds',
  cle: 'Cleveland Guardians',
  col: 'Colorado Rockies',
  det: 'Detroit Tigers',
  hou: 'Houston Astros',
  kc: 'Kansas City Royals',
  laa: 'Los Angeles Angels',
  lad: 'Los Angeles Dodgers',
  mia: 'Miami Marlins',
  mil: 'Milwaukee Brewers',
  min: 'Minnesota Twins',
  nym: 'New York Mets',
  nyy: 'New York Yankees',
  oak: 'Oakland Athletics',
  phi: 'Philadelphia Phillies',
  pit: 'Pittsburgh Pirates',
  sd: 'San Diego Padres',
  sf: 'San Francisco Giants',
  sea: 'Seattle Mariners',
  stl: 'St. Louis Cardinals',
  tb: 'Tampa Bay Rays',
  tex: 'Texas Rangers',
  tor: 'Toronto Blue Jays',
  wsh: 'Washington Nationals'
};

function normTeam(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normId(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

/**
 * Score how well a bet selection identifies a team/player name.
 * 2 = exact normalized equality, 1 = one-sided containment (min length 3)
 * or tennis "Lastname Initial" form, 0 = no match.
 */
function teamMatches(selection, teamName) {
  const sel = normTeam(selection);
  const team = normTeam(teamName);
  if (!sel || !team) return 0;
  if (sel === team) return 2;
  const longer = sel.length >= team.length ? sel : team;
  const shorter = sel.length >= team.length ? team : sel;
  if (shorter.length >= 3 && longer.includes(shorter)) return 1;
  // Tennis convention: "Djokovic N" -> last name + initial. Only the last
  // name is used for the containment check; if both players in one event
  // share a last name the side resolution below stays ambiguous (pending).
  const lastFirst = /^([a-z-]{3,})\s[a-z]$/.exec(sel);
  if (lastFirst && new RegExp(`(^|\\s)${lastFirst[1]}(\\s|$)`).test(team)) return 1;
  return 0;
}

function isTennis(league) {
  return /tennis/i.test(String(league || ''));
}

function invertResult(result) {
  if (result === 'win') return 'loss';
  if (result === 'loss') return 'win';
  return result;
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function competitorName(competitor) {
  if (!competitor || typeof competitor !== 'object') return '';
  const team = competitor.team;
  const athlete = competitor.athlete;
  return (
    (team && (team.displayName || team.shortDisplayName || team.abbreviation)) ||
    (athlete && (athlete.displayName || athlete.shortDisplayName || athlete.fullName)) ||
    competitor.displayName ||
    ''
  ).trim();
}

/**
 * Normalize one raw event/competition into the canonical settlement shape.
 * Accepts ESPN-style payloads (event.competitions[0], groupings flattened by
 * the caller) and already-flat objects ({ eventId, homeTeam, homeScore, ... }).
 */
function normalizeEvent(raw, fallbackUrl = null) {
  if (!raw || typeof raw !== 'object') return null;
  const rawStatusValue = raw.status;
  const rawStatusObject = rawStatusValue && typeof rawStatusValue === 'object' ? rawStatusValue : {};
  const type = rawStatusObject.type || {};
  const stringStatus = typeof rawStatusValue === 'string' ? rawStatusValue : '';
  const state = String(type.state || stringStatus || raw.state || '').toLowerCase();
  const description = String(type.description || stringStatus || raw.description || '').toLowerCase();
  const detail = String(type.detail || raw.detail || '').toLowerCase();
  const rawStatus = [description, detail].filter(Boolean).join(' ') || state || null;
  const eventId = String(raw.eventId || raw.id || '').trim();

  const competitors = Array.isArray(raw.competitors) ? raw.competitors : [];
  const pairs = [];
  for (const competitor of competitors) {
    const name = competitorName(competitor);
    if (!name) continue;
    const flag = String(competitor.homeAway || '').toLowerCase();
    const isWinner = competitor.winner === true || String(competitor.outcome || '').toLowerCase() === 'winner';
    const retiredFlag = competitor.retired === true || /retir|walkover|abandon/i.test(String(competitor.status || ''));
    pairs.push({ name, score: toNumber(competitor.score), flag, isWinner, retiredFlag });
  }

  let home = null;
  let away = null;
  for (const pair of pairs) {
    if (pair.flag === 'home' && !home) home = pair;
    else if (pair.flag === 'away' && !away) away = pair;
  }
  if (!home && pairs.length > 0) home = pairs[0];
  if (!away && pairs.length > 1 && pairs[1] !== home) away = pairs[1];
  // Tolerate pre-normalized flat events that skip the competitors array.
  if (home == null && raw.homeTeam) {
    home = { name: String(raw.homeTeam).trim(), score: toNumber(raw.homeScore), flag: 'home' };
    away = { name: String(raw.awayTeam).trim(), score: toNumber(raw.awayScore), flag: 'away' };
  }

  const winnerPair = pairs.find((pair) => pair.isWinner);
  const winner = (winnerPair && winnerPair.name) || String(raw.winner || '').trim() || null;
  const retiredPair = pairs.find((pair) => pair.retiredFlag);
  const notes = Array.isArray(raw.notes)
    ? raw.notes.map((note) => (note && (note.headline || note.text || '')) || '').join(' ')
    : String(raw.note || '');
  const statusText = `${description} ${detail} ${notes}`;
  const retiredEvent =
    raw.retired === true ||
    /retir|walkover|abandon/i.test(statusText) ||
    /(^|\W)w\/o(\W|$)/i.test(statusText) ||
    Boolean(retiredPair);

  let normalizedStatus;
  if (retiredEvent) normalizedStatus = 'retired';
  else if (state === 'post' || state === 'final' || /(^|\W)final(\W|$)/i.test(statusText)) normalizedStatus = 'final';
  else if (/postpon|suspend|delay|cancel|ppd/i.test(statusText)) normalizedStatus = 'postponed';
  else if (state === 'pre' || /scheduled|not started|pregame|pre-game/i.test(statusText))
    normalizedStatus = 'scheduled';
  else if (state === 'in' || /in progress|live|halftime/i.test(statusText)) normalizedStatus = 'in_progress';
  else normalizedStatus = 'unknown';

  return {
    eventId,
    homeTeam: home ? home.name : null,
    awayTeam: away ? away.name : null,
    homeScore: home ? home.score : null,
    awayScore: away ? away.score : null,
    status: normalizedStatus,
    rawStatus,
    winner,
    retired: retiredEvent,
    retiredSide: retiredPair ? retiredPair.name : String(raw.retiredSide || '').trim() || null,
    date: String(raw.date || raw.competitionDate || '').trim() || null,
    sourceUrl: String(raw.sourceUrl || fallbackUrl || '').trim() || null
  };
}

function collectCompetitions(rawEvent) {
  if (Array.isArray(rawEvent.competitions) && rawEvent.competitions.length > 0) return rawEvent.competitions;
  if (Array.isArray(rawEvent.groupings)) {
    const competitions = rawEvent.groupings.flatMap((group) =>
      Array.isArray(group && group.competitions) ? group.competitions : []
    );
    if (competitions.length > 0) return competitions;
  }
  return [rawEvent];
}

/**
 * Flatten supplied result data into normalized events. Accepts either an
 * array of events or { provider, sourceUrl, events }. ESPN tennis events
 * nest competitions under groupings — each competition becomes its own event.
 * Note: an array (or an object without top-level provider/sourceUrl) still
 * normalizes here, but solve() never finalizes settlements from data that
 * lacks non-empty top-level provenance.
 */
function normalizeResultData(resultData) {
  if (Array.isArray(resultData)) resultData = { events: resultData };
  const data = resultData || {};
  const provider = String(data.provider || '').trim() || null;
  const sourceUrl = String(data.sourceUrl || '').trim() || null;
  const rawEvents = Array.isArray(data.events) ? data.events : [];
  const events = [];
  for (const rawEvent of rawEvents) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    for (const competition of collectCompetitions(rawEvent)) {
      const normalized = normalizeEvent(competition, sourceUrl);
      if (!normalized) continue;
      if (!normalized.eventId && rawEvent.id) normalized.eventId = String(rawEvent.id).trim();
      if (!normalized.date && rawEvent.date) normalized.date = String(rawEvent.date).trim();
      events.push(normalized);
    }
  }
  return { provider, sourceUrl, events };
}

/**
 * Parse a bet's matchup into two team sides. Accepts explicit
 * homeTeam/awayTeam fields or a game string ("NYY @ BOS",
 * "Lakers vs Celtics", "Djokovic N vs Alcaraz C").
 */
function betSides(bet) {
  if (!bet || typeof bet !== 'object') return null;
  if (bet.homeTeam && bet.awayTeam) {
    return [String(bet.homeTeam).trim(), String(bet.awayTeam).trim()];
  }
  const game = String(bet.game || '').trim();
  if (!game) return null;
  const parts = game
    .split(/\s+(?:@|vs\.?|at|-)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 2 && parts[0] && parts[1]) return parts;
  return null;
}

function utcDayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * True when the event's actual start falls on the scheduled start's UTC
 * calendar day or up to maxDelayDays UTC days after it. Comparison is at
 * whole-UTC-day granularity: two timestamps on the same UTC calendar day
 * are in window regardless of their clock times, so an actual start that
 * is hours EARLIER than the scheduled time on the same UTC day still
 * counts as in window.
 */
function dateInWindow(scheduledIso, eventIso, maxDelayDays) {
  const scheduled = utcDayKey(scheduledIso);
  const actual = utcDayKey(eventIso);
  if (scheduled == null || actual == null) return false;
  const diffDays = Math.round((actual - scheduled) / 86400000);
  return diffDays >= 0 && diffDays <= maxDelayDays;
}

/**
 * The scheduled start a bet was made against. Card-promoted bets (created
 * by lib/record-card) record the schedule only inside candidateSnapshot, so
 * the snapshot fields are the fallback when the bet has no direct start.
 * Resolution order: bet.start, bet.scheduledStart, candidateSnapshot.start,
 * candidateSnapshot.startTimestamp, candidateSnapshot.scheduledStart.
 * Returns null when no recorded start exists (never guesses).
 */
function betStart(bet) {
  if (!bet || typeof bet !== 'object') return null;
  const snapshot = bet.candidateSnapshot && typeof bet.candidateSnapshot === 'object' ? bet.candidateSnapshot : null;
  return (
    bet.start ||
    bet.scheduledStart ||
    (snapshot && (snapshot.start || snapshot.startTimestamp || snapshot.scheduledStart)) ||
    null
  );
}

/**
 * Candidate normalized forms for one bet side: the literal name plus, when
 * it is a known MLB abbreviation, the expanded full team name.
 */
function sideForms(name) {
  const norm = normTeam(name);
  if (!norm) return [];
  const expanded = MLB_ABBREVIATIONS[norm];
  return expanded ? [norm, normTeam(expanded)] : [norm];
}

function sideMatches(betSide, teamName) {
  return sideForms(betSide).some((form) => teamMatches(form, teamName) > 0);
}

/**
 * Conservative pair equality: each bet side must identify one event team
 * (abbreviation table, containment, or tennis last-name form) and the two
 * sides must cover BOTH event teams (orientation-free). Uniqueness across
 * the supplied feed + the date window are enforced by the caller, so this
 * never settles on a partial or guessed pair.
 */
function samePair(sides, homeTeam, awayTeam) {
  const first = sides[0];
  const second = sides[1];
  if (!first || !second || !homeTeam || !awayTeam) return false;
  return (
    (sideMatches(first, homeTeam) && sideMatches(second, awayTeam)) ||
    (sideMatches(first, awayTeam) && sideMatches(second, homeTeam))
  );
}

/**
 * Verify that a same-ID result event really is the bet's game before
 * settling on it: the event must carry the same participant pair (when the
 * bet has a parseable matchup) AND its actual start must fall within the
 * scheduled date window. A unique game/event ID is necessary when the bet
 * has one, but never sufficient by itself.
 *
 * @param {Object} bet
 * @param {Object} event
 * @param {number} maxDelayDays
 * @returns {{ok: boolean, reason?: string}}
 */
function eventIdentityMatchesBet(bet, event, maxDelayDays) {
  const sides = betSides(bet);
  if (!sides) {
    return { ok: false, reason: 'game id matched but the bet has no parseable matchup to verify participant identity' };
  }
  if (!event.homeTeam || !event.awayTeam) {
    return {
      ok: false,
      reason: 'game id matched but the result event has no team names to verify participant identity'
    };
  }
  if (!samePair(sides, event.homeTeam, event.awayTeam)) {
    return { ok: false, reason: 'game id matched but event participants do not match the bet matchup' };
  }
  if (!betStart(bet)) {
    return { ok: false, reason: 'game id matched but the bet has no scheduled start to verify the date window' };
  }
  if (!event.date) {
    return { ok: false, reason: 'game id matched but the result event has no date to verify the date window' };
  }
  if (!dateInWindow(betStart(bet), event.date, maxDelayDays)) {
    return { ok: false, reason: 'game id matched but the event date falls outside the scheduled date window' };
  }
  return { ok: true };
}

/**
 * Match a bet to a result event.
 *
 * Primary: stable game/event ID equality, but a matching ID is necessary,
 * never sufficient — the same-ID event must also verify the bet's
 * participant pair and the scheduled date window (see
 * eventIdentityMatchesBet). Fallback (ONLY when the primary cannot match):
 * both team names must match exactly on both sides AND the event's actual
 * start must fall within the scheduled-day window AND exactly one event may
 * qualify. Anything less is 'pending', never a guess.
 *
 * @returns {{matched: boolean, event?: Object, method?: string, reason?: string}}
 */
function matchEvent(bet, events, opts = {}) {
  const maxDelayDays = Number.isInteger(opts.maxDelayDays) ? opts.maxDelayDays : DEFAULT_MAX_DELAY_DAYS;
  const normEvents = (events || []).filter(Boolean);
  const betId = normId(bet && bet.gameId);
  let idFailureReason = null;
  if (betId) {
    const byId = normEvents.filter((event) => event.eventId && normId(event.eventId) === betId);
    if (byId.length > 1) return { matched: false, reason: 'ambiguous: multiple events share the same game id' };
    if (byId.length === 1) {
      const identity = eventIdentityMatchesBet(bet, byId[0], maxDelayDays);
      if (identity.ok) return { matched: true, event: byId[0], method: 'gameId' };
      idFailureReason = identity.reason;
    }
  }
  const sides = betSides(bet);
  if (!sides) return { matched: false, reason: idFailureReason || 'no game id and no parseable matchup for fallback' };
  if (!betStart(bet))
    return { matched: false, reason: idFailureReason || 'no game id and no scheduled start for name fallback' };
  const candidates = normEvents.filter((event) => {
    if (!event.homeTeam || !event.awayTeam || !event.date) return false;
    if (!dateInWindow(betStart(bet), event.date, maxDelayDays)) return false;
    return samePair(sides, event.homeTeam, event.awayTeam);
  });
  if (candidates.length === 1) return { matched: true, event: candidates[0], method: 'name+date' };
  if (candidates.length > 1)
    return { matched: false, reason: 'ambiguous: multiple events match the same team pair and date window' };
  return { matched: false, reason: idFailureReason || 'no event matched the supplied result data' };
}

function sideName(side, event) {
  if (side === 'home') return event.homeTeam;
  if (side === 'away') return event.awayTeam;
  return null;
}

/**
 * Which side of the event does the bet's selection identify?
 * 'home' | 'away' | null (null = ambiguous or unknown — never guessed).
 */
function sideOfBet(bet, event) {
  const home = teamMatches(bet.selection, event.homeTeam) > 0;
  const away = teamMatches(bet.selection, event.awayTeam) > 0;
  if (home && !away) return 'home';
  if (away && !home) return 'away';
  return null;
}

function settled(status, reason) {
  return { status, outcome: status, result: status, isSettled: true, reason };
}

function reasonCode(reason) {
  const text = String(reason || '').toLowerCase();
  if (text.includes('provenance')) return 'missing_provenance';
  if (text.includes('selection') && (text.includes('unambiguously') || text.includes('both event sides')))
    return 'ambiguous_selection';
  if (text.includes('multiple events') || text.includes('ambiguous') || text.includes('unambiguously'))
    return 'ambiguous_identity';
  if (text.includes('date window') || text.includes('started before')) return 'outside_date_window';
  if (text.includes('unsupported')) return 'unsupported_market';
  if (text.includes('numeric line') || text.includes('over or under')) return 'missing_line';
  if (text.includes('scores missing') || text.includes('winner not indicated')) return 'missing_final_score';
  if (text.includes('retirement')) return 'tennis_retirement';
  if (text.includes('no event matched') || text.includes('no game id')) return 'no_event_match';
  return 'unresolved';
}

function pendingResult(reason) {
  return {
    status: 'pending',
    outcome: null,
    result: null,
    isSettled: false,
    reason,
    reasonCode: reasonCode(reason)
  };
}

/**
 * Grade a final score against a moneyline-style bet. Covers MLB and any
 * other score-based league; equal final scores are a push.
 */
function settleByScore(bet, event) {
  if (event.status !== 'final') return pendingResult(`event status '${event.status}' is not final`);
  if (event.homeScore == null || event.awayScore == null) {
    return pendingResult('final scores missing from supplied result data');
  }
  const side = sideOfBet(bet, event);
  if (!side) return pendingResult('selection does not unambiguously identify a side of the final score');
  const homeScore = event.homeScore;
  const awayScore = event.awayScore;
  if (homeScore === awayScore) return settled('push', `final score tied ${homeScore}-${awayScore}`);
  const won = side === 'home' ? homeScore > awayScore : awayScore > homeScore;
  return settled(won ? 'win' : 'loss', `final score ${homeScore}-${awayScore}`);
}

// Conservative game-total market names (normalized). Only unambiguous
// game-total markets grade locally; props like "Total Bases" never match.
const TOTAL_MARKETS = Object.freeze(['total', 'total runs', 'run total', 'total points', 'total goals', 'over under']);

function normMarketName(market) {
  return String(market || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTotalMarket(market) {
  return TOTAL_MARKETS.includes(normMarketName(market));
}

/**
 * The numeric line a total bet was graded against. Accepts bet.line or
 * bet.points, falling back to the same fields on the recorded candidate
 * snapshot. Returns null when absent or non-numeric (never guessed).
 */
function betLine(bet) {
  if (!bet || typeof bet !== 'object') return null;
  const candidate = bet.candidateSnapshot && typeof bet.candidateSnapshot === 'object' ? bet.candidateSnapshot : null;
  const raw = bet.line ?? bet.points ?? (candidate ? (candidate.line ?? candidate.points) : null);
  return toNumber(raw);
}

/**
 * Unambiguous Over/Under direction from the bet selection. Accepts
 * 'Over'/'Under', 'Over 7.5'/'Under 7.5', and bare 'O'/'U' tokens.
 * Anything else (a team name, both sides, or nothing) returns null.
 */
function totalDirection(selection) {
  const letters = String(selection == null ? '' : selection)
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (letters === 'over' || letters === 'o') return 'over';
  if (letters === 'under' || letters === 'u') return 'under';
  return null;
}

/**
 * Grade a game-total (Over/Under) bet against final scores. Conservative:
 * requires a totals market name, an explicit numeric line, and an
 * unambiguous Over/Under selection. An exact tie at the line is a push.
 */
function settleTotal(bet, event) {
  if (event.status !== 'final') return pendingResult(`event status '${event.status}' is not final`);
  if (event.homeScore == null || event.awayScore == null) {
    return pendingResult('final scores missing from supplied result data');
  }
  const line = betLine(bet);
  if (line == null) {
    return pendingResult('total market requires a numeric line (bet.line or bet.points)');
  }
  const direction = totalDirection(bet.selection);
  if (!direction) return pendingResult('selection does not unambiguously identify Over or Under');
  const total = event.homeScore + event.awayScore;
  if (total === line) return settled('push', `total ${total} pushed at line ${line}`);
  const won = direction === 'over' ? total > line : total < line;
  return settled(won ? 'win' : 'loss', `final total ${total} ${direction} ${line}`);
}

/**
 * Grade a tennis match. Completed matches settle by the explicit winner
 * flag; a retirement NEVER settles into win/loss without a caller-supplied
 * policy. policy.retirement may be 'win'|'loss'|'push'|'pending' (the value
 * graded when the BET side retired; opponent retirement inverts win<->loss)
 * or a function (bet, event, betSideTeamName) => status.
 */
function settleTennis(bet, event, policy = {}) {
  const betSide = sideOfBet(bet, event);
  const betSideTeam = sideName(betSide, event);
  const isRetirement = event.status === 'retired' || event.retired === true;

  if (isRetirement) {
    const rule = policy.retirement !== undefined ? policy.retirement : policy.onRetirement;
    if (rule == null || rule === 'pending') {
      return {
        status: 'retirement',
        outcome: null,
        result: null,
        isSettled: false,
        reason: 'tennis retirement; kept as explicit retirement status (no settlement policy supplied)'
      };
    }
    if (typeof rule === 'function') {
      const graded = rule(bet, event, betSideTeam);
      if (typeof graded !== 'string' || !SETTLED_STATUSES.includes(graded)) {
        return {
          status: 'retirement',
          outcome: null,
          result: null,
          isSettled: false,
          reason: 'tennis retirement; policy function returned no settled status'
        };
      }
      return settled(graded, 'tennis retirement graded by caller-supplied policy function');
    }
    if (!SETTLED_STATUSES.includes(rule)) {
      return {
        status: 'retirement',
        outcome: null,
        result: null,
        isSettled: false,
        reason: 'tennis retirement; invalid settlement policy value'
      };
    }
    if (!betSide || !event.retiredSide) {
      return {
        status: 'retirement',
        outcome: null,
        result: null,
        isSettled: false,
        reason: 'tennis retirement; retired side unknown, settlement policy not applied'
      };
    }
    const betRetired = teamMatches(event.retiredSide, betSideTeam) > 0;
    const graded = betRetired ? rule : invertResult(rule);
    return settled(
      graded,
      `tennis retirement; policy '${rule}' applied to ${betRetired ? 'bet-side' : 'opponent'} retirement`
    );
  }

  if (event.status !== 'final') return pendingResult(`tennis event status '${event.status}' is not final`);
  if (!event.winner) return pendingResult('tennis match completed but winner not indicated in supplied result data');
  if (!betSide) return pendingResult('selection does not unambiguously identify a side of the match');
  const won = teamMatches(betSideTeam, event.winner) > 0;
  return settled(won ? 'win' : 'loss', `completed match; winner ${event.winner}`);
}

/**
 * Pure grading entry point. Moneyline and game-total markets settle
 * locally; every other market stays pending.
 */
function settleEvent(bet, event, opts = {}) {
  if (!bet || typeof bet !== 'object' || !event) return pendingResult('missing bet or event');
  const market = String(bet.market || '')
    .trim()
    .toLowerCase();
  if (isTotalMarket(market)) return settleTotal(bet, event);
  if (!market || !/moneyline|^ml$/.test(market)) {
    return pendingResult(
      `market '${bet.market || '(missing)'}' is not supported by local settlement (moneyline and totals only)`
    );
  }
  if (isTennis(bet.league)) return settleTennis(bet, event, opts.policy || {});
  return settleByScore(bet, event);
}

function buildSettlementRecord(bet, event, match, settle, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : new Date().toISOString();
  const record = {
    betId: bet.id || bet.betId || bet.pickId || null,
    candidateId: bet.candidateId || null,
    gameId: bet.gameId || null,
    league: bet.league || null,
    market: bet.market || null,
    selection: bet.selection || null,
    odds: bet.oddsAtDecision ?? bet.odds ?? null,
    stake: bet.stake == null ? null : bet.stake,
    status: settle.status,
    outcome: settle.outcome,
    result: settle.result,
    isSettled: settle.isSettled,
    scheduledStart: betStart(bet),
    actualStart: event ? event.date || null : null,
    provider: opts.provider || null,
    sourceUrl: event && event.sourceUrl ? event.sourceUrl : opts.sourceUrl || null,
    eventId: event ? event.eventId || null : null,
    matchedBy: match && match.matched ? match.method : null,
    evidence: event
      ? {
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          homeScore: event.homeScore,
          awayScore: event.awayScore,
          status: event.status,
          rawStatus: event.rawStatus,
          winner: event.winner,
          retired: event.retired,
          retiredSide: event.retiredSide
        }
      : null,
    settledAt: now,
    reason: settle.reason,
    reasonCode: settle.reasonCode || null
  };
  const policy = opts.policy || {};
  if (policy.retirement !== undefined) {
    record.policy = {
      retirement: typeof policy.retirement === 'function' ? 'caller-provided-function' : policy.retirement
    };
  }
  return record;
}

/**
 * Replace any prior settlement for the same bet with the fresh record via
 * the ledger's atomic addRecord helper. Keeps settlements 1:1 with bets.
 */
function upsertSettlement(ledger, record, now) {
  const previous = record.betId
    ? (ledger.settlements || []).find((existing) => existing && existing.betId === record.betId)
    : null;
  if (previous && previous.status === 'retirement' && record.status === 'pending') {
    record = {
      ...record,
      status: 'retirement',
      outcome: null,
      result: null,
      isSettled: false,
      actualStart: previous.actualStart,
      provider: previous.provider,
      sourceUrl: previous.sourceUrl,
      eventId: previous.eventId,
      matchedBy: previous.matchedBy,
      evidence: previous.evidence,
      reason: previous.reason,
      reasonCode: previous.reasonCode || 'tennis_retirement'
    };
  }
  if (record.betId) {
    ledger.settlements = (ledger.settlements || []).filter(
      (existing) => !(existing && existing.betId === record.betId)
    );
  }
  const result = ledgerModule.addRecord(ledger, 'settlements', record, { now });
  return result.record;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Settlement provenance gate. W/L/P finalization requires non-empty top-level
 * provider and sourceUrl on the supplied result data, so every settled record
 * is traceable. Returns a precise reason when provenance is missing, or null
 * when the payload is eligible for settlement.
 */
function provenanceReason(resultData) {
  const provider = resultData && typeof resultData.provider === 'string' ? resultData.provider.trim() : '';
  const sourceUrl = resultData && typeof resultData.sourceUrl === 'string' ? resultData.sourceUrl.trim() : '';
  if (!provider && !sourceUrl) {
    return 'settlement provenance missing: results data must include non-empty top-level provider and sourceUrl';
  }
  if (!provider) return 'settlement provenance missing: results data must include a non-empty top-level provider';
  if (!sourceUrl) return 'settlement provenance missing: results data must include a non-empty top-level sourceUrl';
  return null;
}

/**
 * Settle bets against supplied result data in an in-memory ledger.
 *
 * Provenance: finalization requires non-empty top-level provider and
 * sourceUrl on the result data. A bare event array or { events } payload
 * without provenance produces pending records with a precise reason and
 * never settles a bet. Event-specific sourceUrl values are preserved only
 * when the top-level provenance is valid.
 *
 * @param {Object} ledger - ledger object (see record-ledger.createLedger)
 * @param {Object} [opts]
 * @param {Array<Object>} [opts.bets] - bets to settle (defaults to ledger.bets)
 * @param {Object|Array} [opts.resultData] - { provider, sourceUrl, events }
 * @param {Object} [opts.policy] - tennis retirement policy, e.g. { retirement: 'loss' }
 * @param {boolean} [opts.force] - re-settle bets that already have a settled status
 * @param {Function} [opts.now] - injectable clock
 * @param {number} [opts.maxDelayDays] - fallback date window after the scheduled day
 */
function solve(ledger, opts = {}) {
  const resultData = normalizeResultData(opts.resultData);
  const missingProvenance = provenanceReason(resultData);
  const provider = resultData.provider || null;
  const sourceUrl = resultData.sourceUrl || null;
  const bets = Array.isArray(opts.bets) ? opts.bets : Array.isArray(ledger && ledger.bets) ? ledger.bets : [];
  const policy = opts.policy || null;
  const force = opts.force === true;
  const now = opts.now;
  const settled = [];
  const pending = [];
  const skipped = [];

  for (const bet of bets) {
    if (!bet || typeof bet !== 'object') continue;
    const betKey = bet.id || bet.betId || bet.pickId;
    // Official bets always carry an id; an id-less bet cannot be tracked 1:1
    // in settlements (upsert dedup is keyed on betId), so skip it safely and
    // leave the bet row untouched instead of accumulating duplicate rows.
    if (!betKey) {
      skipped.push({
        betId: null,
        reason: 'bet has no id; settlement rows require a bet id (official bets always carry one)'
      });
      continue;
    }
    const existing = (ledger.settlements || []).filter((item) => item && item.betId === betKey);
    const alreadySettled = existing.some((item) => SETTLED_STATUSES.includes(item.status));
    if (alreadySettled && !force) {
      skipped.push({ betId: betKey, reason: 'already settled' });
      continue;
    }
    // Try to settle first, then decide whether writing is safe.
    let match;
    let event = null;
    let settle;
    if (missingProvenance) {
      match = { matched: false, reason: missingProvenance };
      settle = pendingResult(missingProvenance);
    } else {
      match = matchEvent(bet, resultData.events, opts);
      event = match.matched ? match.event : null;
      settle = match.matched ? settleEvent(bet, event, { policy }) : pendingResult(match.reason);
    }

    // NEVER downgrade a decided bet to `pending`. `migrate-tracker` stores the
    // real outcome on the bet itself for rows whose start is unresolvable
    // (`eventDate: 'unknown'`), so a name+date match can never improve them. A
    // written `pending` row then SHADOWS that outcome in every settlement-first
    // read and silently turns a decided record into 0W/0L. Only an actual
    // settlement, or an explicit --force, may replace a decided outcome.
    const betOutcome = String(bet.status || '').toLowerCase();
    if (!settle.isSettled && SETTLED_STATUSES.includes(betOutcome) && !force) {
      skipped.push({
        betId: betKey,
        reason: `bet already records a decided outcome (${betOutcome}); refusing to write a pending settlement over it`
      });
      continue;
    }

    const record = buildSettlementRecord(bet, event, match, settle, {
      now,
      provider: missingProvenance ? null : provider,
      sourceUrl: missingProvenance ? null : sourceUrl,
      policy
    });
    const stored = upsertSettlement(ledger, record, now);
    (settle.isSettled ? settled : pending).push(clone(stored));
  }

  return { ok: true, settled, pending, skipped, ledger };
}

/**
 * Load the ledger, settle against supplied result data, and persist with the
 * ledger's atomic helpers. No network code anywhere in this path.
 */
function solveLedger(opts = {}) {
  const loaded = ledgerModule.loadLedger(opts);
  if (!loaded.ok) return loaded;
  const result = solve(loaded.ledger, opts);
  const saved = ledgerModule.saveLedger(result.ledger, opts);
  if (!saved.ok) {
    return {
      ok: false,
      error: saved.error,
      settled: result.settled,
      pending: result.pending,
      skipped: result.skipped
    };
  }
  return { ok: true, path: saved.path, settled: result.settled, pending: result.pending, skipped: result.skipped };
}

module.exports = {
  SETTLED_STATUSES,
  VALID_STATUSES,
  DEFAULT_MAX_DELAY_DAYS,
  normTeam,
  teamMatches,
  isTennis,
  invertResult,
  normalizeEvent,
  normalizeResultData,
  betSides,
  betStart,
  samePair,
  eventIdentityMatchesBet,
  matchEvent,
  settleEvent,
  settleByScore,
  settleTotal,
  isTotalMarket,
  betLine,
  totalDirection,
  settleTennis,
  buildSettlementRecord,
  solve,
  solveLedger
};
