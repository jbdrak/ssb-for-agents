'use strict';

/**
 * Closing-price capture for recorded scan candidates.
 *
 * The ledger records `odds` at DECISION time — the price when the scan ran.
 * Closing line value needs the price at the CLOSE, and nothing in this repo has
 * ever captured one (`bin/pp-cli.js` says so in as many words: "No producer
 * writes these yet"). Without a close there is no way to tell a decision price
 * that beat the market from one that simply arrived after the market had
 * already moved — which is precisely what the "CLV +5.92%" cards were
 * unknowingly claiming.
 *
 * This module is the pure half of that capture: decide which candidates are
 * due, and stamp a supplied close onto one. It performs no I/O and no network
 * call, and it never invents a price — a candidate with no resolvable start or
 * no identity is reported as excluded, never guessed.
 *
 * Two things are load-bearing about the close record:
 *
 *   - `closeKind` distinguishes a genuine pregame close (`'pregame'`) from a
 *     capture taken after the event started (`'post_start'`, only inside the
 *     grace window). A post-start quote is not a close, so it is labelled
 *     rather than silently treated as one.
 *   - The close is attached to the ledger row in place. The stored
 *     `candidateId` is the DECISION-time identity and is never recomputed: it
 *     is the join key `pp record-card` already uses, and rehashing the row
 *     after adding a close would silently orphan every bet linked to it.
 */

const { classifyPrice, candidateStartMs, beatTheClose } = require('./record-quality');

const DEFAULT_WINDOW_MINUTES = 30;
const DEFAULT_LATE_MINUTES = 5;

/**
 * Which candidates are due for a close capture.
 *
 * @param {Object} ledger - v2 ledger
 * @param {Object} [opts]
 * @param {number} [opts.nowMs] - current epoch ms (never read inside); required at runtime
 * @param {number} [opts.windowMinutes=30] - capture from this far before start
 * @param {number} [opts.lateMinutes=5] - grace window after start
 * @param {boolean} [opts.force=false] - re-capture rows that already hold a close
 * @returns {{targets: Array<Object>, excluded: Object, totals: Object}}
 */
function selectCloseTargets(ledger, opts = {}) {
  const nowMs = opts.nowMs;
  if (!Number.isFinite(nowMs)) throw new TypeError('selectCloseTargets requires a finite nowMs');
  const windowMs = (opts.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60 * 1000;
  const lateMs = (opts.lateMinutes ?? DEFAULT_LATE_MINUTES) * 60 * 1000;
  const force = Boolean(opts.force);

  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const targets = [];
  const excluded = {
    already_captured: 0,
    undated: 0,
    missing_identity: 0,
    not_due: 0,
    too_late: 0
  };

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (!force && (candidate.closeOdds != null || candidate.closeImpliedProbability != null)) {
      excluded.already_captured += 1;
      continue;
    }
    if (!hasIdentity(candidate)) {
      excluded.missing_identity += 1;
      continue;
    }
    const startMs = candidateStartMs(candidate);
    if (startMs == null) {
      excluded.undated += 1;
      continue;
    }
    const untilStart = startMs - nowMs;
    if (untilStart > windowMs) {
      excluded.not_due += 1;
      continue;
    }
    if (untilStart < -lateMs) {
      excluded.too_late += 1;
      continue;
    }
    targets.push({
      candidate,
      startMs,
      closeKind: untilStart >= 0 ? 'pregame' : 'post_start'
    });
  }

  return {
    targets,
    excluded,
    totals: { candidates: candidates.length, due: targets.length }
  };
}

/**
 * A candidate can be re-priced only if something identifies the fixture. A
 * `gameId` is ideal; `league` + `game` is the identity the ledger-derived
 * ratings gate already uses, so it is accepted as the fallback. A row with
 * neither is not re-priceable and is excluded rather than matched by guesswork.
 */
function hasIdentity(candidate) {
  if (typeof candidate.gameId === 'string' && candidate.gameId.trim() !== '') return true;
  return (
    typeof candidate.league === 'string' &&
    candidate.league.trim() !== '' &&
    typeof candidate.game === 'string' &&
    candidate.game.trim() !== ''
  );
}

/**
 * Stamp a supplied close onto a candidate, in place.
 *
 * The close is stored as whatever it actually is. For a NoVig-family book the
 * structured `odds` field in the scan/validate payload is a DISPLAY STRING
 * (`'49.0%'`) rather than a price — `lib/ssb-formatter.js` overwrites it via
 * `oddsValueForDisplay` whenever the execution book is NoVig. So a close can
 * legitimately arrive as an implied probability and not a price field. It is
 * recorded as an implied probability under its own key, never converted into an
 * American price: turning a single-sided implied probability into a price means
 * inventing a de-vig, which is the one derivation this repo refuses to make.
 *
 * @param {Object} target - entry from selectCloseTargets
 * @param {Object} close - { odds, fairProbability?, book? }
 * @param {Object} [opts] - { capturedAt }
 * @returns {{ok: boolean, reason?: string}}
 */
function applyClose(target, close, opts = {}) {
  const candidate = target && target.candidate;
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'no_candidate' };
  if (!close || typeof close !== 'object') return { ok: false, reason: 'no_close' };

  const classified = classifyPrice(close.odds);
  if (!classified.ok) return { ok: false, reason: 'close_not_a_price' };

  const isPrice = classified.american != null || classified.decimal != null;
  candidate.closeOdds = isPrice ? (classified.american != null ? classified.american : classified.decimal) : null;
  candidate.closeImpliedProbability = isPrice ? null : classified.impliedProbability;
  candidate.closeIsPrice = isPrice;
  candidate.closeOddsFormat = classified.format;
  const fair = Number(close.fairProbability);
  candidate.closeFairProbability = Number.isFinite(fair) && fair > 0 && fair < 1 ? fair : null;
  candidate.closeBook = typeof close.book === 'string' && close.book.trim() !== '' ? close.book : null;
  candidate.closeKind = target.closeKind || null;
  candidate.closeCapturedAt = opts.capturedAt ?? null;

  // Real close-relative CLV, computed only now that both prices exist. The
  // decision price is `candidate.odds`; the close is whatever we just stored.
  // Beat-the-close is the leading indicator, and it is deliberately separate
  // from the row's open-to-current `clvProxyPct`, which is a different quantity.
  const clv = beatTheClose(candidate.odds, isPrice ? candidate.closeOdds : candidate.closeImpliedProbability);
  candidate.clvPct = clv.ok ? clv.clvPct : null;
  candidate.clvReason = clv.ok ? null : clv.reason;
  return { ok: true };
}

/**
 * Count how many candidates hold a close, and of what kind. Read-only.
 *
 * @param {Object} ledger
 * @returns {Object}
 */
function summarizeCloses(ledger) {
  const candidates = Array.isArray(ledger && ledger.candidates) ? ledger.candidates : [];
  const summary = {
    candidates: candidates.length,
    captured: 0,
    pregame: 0,
    post_start: 0,
    withoutStart: 0,
    asPrice: 0,
    asImpliedProbability: 0,
    withClv: 0
  };
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (candidateStartMs(candidate) == null) summary.withoutStart += 1;
    const hasClose = candidate.closeOdds != null || candidate.closeImpliedProbability != null;
    if (!hasClose) continue;
    summary.captured += 1;
    if (typeof candidate.clvPct === 'number') summary.withClv += 1;
    if (candidate.closeIsPrice) summary.asPrice += 1;
    else summary.asImpliedProbability += 1;
    if (candidate.closeKind === 'post_start') summary.post_start += 1;
    else if (candidate.closeKind === 'pregame') summary.pregame += 1;
  }
  return summary;
}

module.exports = {
  selectCloseTargets,
  applyClose,
  summarizeCloses,
  hasIdentity,
  DEFAULT_WINDOW_MINUTES,
  DEFAULT_LATE_MINUTES
};
