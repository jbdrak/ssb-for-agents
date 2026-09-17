'use strict';

/**
 * Pure scan-diagnostics formatter for pp scan output.
 *
 * Returns human-readable diagnostic lines (stderr material) for a scan
 * result that already carries the raw data: truncation/health info,
 * empty league×market pairs, and the tennis-fallback-on-mixed-scan caveat.
 *
 * Pure by design — no console, no process, no fs — so it can be unit
 * tested and rendered by any caller (CLI stderr, JSON, future UIs).
 */

const MAX_EMPTY_PAIRS_SHOWN = 12;

/**
 * Build diagnostic lines for a scan result.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.mixedScan] - True when the scan covered more than
 *   one league and at least one non-tennis league was requested.
 * @param {boolean} [opts.tennisFallbackApplied] - True when the tennis
 *   fallback actually injected plays into a scan that requested tennis.
 * @param {Array<Object>} [opts.emptySlate] - League×market pairs that
 *   returned zero rows, each with league/market/reason.
 * @param {Object|null} [opts.scanHealth] - quick_screen scanHealth payload
 *   (truncated, incomplete, validationBudgetExhausted, preHistoryShortlist,
 *   validation: {eligible, selected, completedCount}).
 * @param {number} [opts.playCount] - Total plays surviving the final scan
 *   output (after validation + filters). Used to detect the stale-label
 *   case: candidates were found and ranked as BETs, but fresh validation
 *   downgraded every one of them, so the slate LOOKS dead when it isn't.
 * @returns {string[]} Diagnostic lines. Empty array when nothing to say.
 */
function formatScanDiagnostics({
  mixedScan = false,
  tennisFallbackApplied = false,
  emptySlate = [],
  scanHealth = null,
  playCount = 0
} = {}) {
  const lines = [];

  const health = scanHealth && typeof scanHealth === 'object' ? scanHealth : {};
  const healthIncomplete = Boolean(health.incomplete || health.validationBudgetExhausted);
  const healthTruncated = Boolean(health.truncated);
  const leaguesWithIssues = (Array.isArray(health.preHistoryShortlist) ? health.preHistoryShortlist : [])
    .filter((pair) => pair && pair.truncated)
    .map((pair) => pair.league)
    .filter(Boolean);

  // Per-market truncation map: a league×market pair whose own scan block
  // was truncated (per-pair preHistoryShortlist flag). Used to distinguish
  // a genuinely empty market from one whose rows were never fully hydrated.
  const truncatedPairs = new Map();
  for (const pair of Array.isArray(health.preHistoryShortlist) ? health.preHistoryShortlist : []) {
    if (pair && pair.truncated && pair.league && pair.market) {
      truncatedPairs.set(`${pair.league} › ${pair.market}`, true);
    }
  }

  // Validation was "short" when the shared budget was exhausted, or when
  // fewer plays were validated than selected (validation did not complete).
  const validation = health.validation && typeof health.validation === 'object' ? health.validation : {};
  const validationSelected = Number(validation.selected || 0);
  const validationCompleted = Number(validation.completedCount || 0);
  const validationShort =
    Boolean(health.validationBudgetExhausted) || (validationSelected > 0 && validationCompleted < validationSelected);

  // A market is "unresolved" when its own scan block was truncated or
  // validation was short — its empty result cannot be confirmed.
  const isUnresolved = (league, market) =>
    Boolean(truncatedPairs.get(`${league || '?'} › ${market || '?'}`)) || validationShort;

  if (healthIncomplete || healthTruncated) {
    if (healthTruncated) {
      lines.push(
        `Warning: scan incomplete/truncated${leaguesWithIssues.length ? ` for ${[...new Set(leaguesWithIssues)].join(', ')}` : ''}; some rows were not hydrated.`
      );
    }
    // "Diagnostic only" means the shared validation budget was actually
    // exhausted and BET candidates never got a validate_play call. Plain
    // shortlist truncation (truncated/incomplete without the budget flag)
    // only means some weaker rows weren't hydrated — the plays shown ARE
    // hydrated and carry real CLV/movement evidence, so they are not
    // demoted to watch candidates.
    if (health.validationBudgetExhausted) {
      lines.push(
        'Warning: scan validation budget exhausted; BET candidates are diagnostic only (never official bets).'
      );
      const hintLeague = leaguesWithIssues[0] || health.league;
      if (hintLeague) lines.push(`Recovery: run pp rank ${hintLeague} for a focused scan.`);
    }
  }

  // No survivors: candidates were validated but none kept BET status, so
  // the slate LOOKS dead. Say exactly that — the old wording claimed BET
  // candidates were "downgraded" even when the screen never ranked them BET.
  const validationEligible = Number(health.validation?.eligible || 0);
  if (validationEligible > 0 && playCount === 0) {
    const hintLeague = leaguesWithIssues[0] || health.league;
    lines.push(
      `${validationEligible} candidate${validationEligible === 1 ? '' : 's'} validated, none survived as BET${
        health.validation?.completedCount > 0
          ? '; see watchCandidates for the exact reason'
          : ' (validation budget skipped them)'
      }. Re-scan or run pp rank ${hintLeague || '<league>'} for fresh data.`
    );
  }

  if (Array.isArray(emptySlate) && emptySlate.length) {
    const shown = emptySlate.slice(0, MAX_EMPTY_PAIRS_SHOWN);
    for (const pair of shown) {
      if (!pair || (!pair.league && !pair.market)) continue;
      const league = pair.league || '?';
      const market = pair.market || '?';
      // A genuinely empty market (complete scan block, validation done)
      // prints as an ordinary "No plays" line. When that market's scan
      // block was truncated or validation was short, the empty result is
      // UNRESOLVED — it cannot be confirmed to be truly empty, so label it
      // explicitly as unresolved rather than an ordinary empty market.
      const unresolved = isUnresolved(league, market);
      lines.push(
        `${unresolved ? 'Unresolved' : 'No plays'}: ${league} › ${market}${pair.reason ? ` (${pair.reason})` : ''}`
      );
    }
    if (emptySlate.length > MAX_EMPTY_PAIRS_SHOWN) {
      lines.push(`…and ${emptySlate.length - MAX_EMPTY_PAIRS_SHOWN} more empty league/market pairs.`);
    }
  }

  if (mixedScan && tennisFallbackApplied) {
    lines.push(
      'Tennis fallback filled this mixed scan; other leagues may be empty or truncated. Run pp rank <league> (or pp scan mlb / pp scan ufc) before treating this as a full slate.'
    );
  }

  // Date-window blindness: the scan default window is the local "today", which
  // is empty late in the day while the next slate is full. Rows dropped by the
  // window are NOT an empty slate, so name that explicitly along with the flag
  // that shows them; otherwise `no_ranked_rows_scanned` reads as a dead board
  // and the league looks unscannable when it is merely out of window.
  const outsideWindow = (Array.isArray(emptySlate) ? emptySlate : []).filter(
    (pair) => pair && pair.reason === 'outside_card_window'
  );
  if (outsideWindow.length) {
    const windows = [...new Set(outsideWindow.map((pair) => pair.cardWindow).filter(Boolean))];
    const rows = outsideWindow.reduce((sum, pair) => sum + Number(pair.filteredRowCount || 0), 0);
    const label = windows.length === 1 ? `the ${windows[0]} window` : 'the requested date window';
    lines.push(
      `${outsideWindow.length} league/market pair${outsideWindow.length === 1 ? '' : 's'} have rows outside ${label}` +
        `${rows ? ` (${rows} row${rows === 1 ? '' : 's'})` : ''} - the slate is not empty. ` +
        'Rerun with --card-window all to scan them.'
    );
  }

  return lines;
}

/**
 * Make budget-skipped candidates unambiguously non-actionable for JSON
 * consumers. The backend keeps the original screen verdict for discovery,
 * but those rows were never validated and must not look like official BETs.
 * @param {Array<Object>} candidates
 * @returns {Array<Object>}
 */
function normalizeWatchCandidates(candidates = []) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map((candidate) => ({
    ...candidate,
    official: false,
    verdict: 'WATCH',
    finalVerdict: 'WATCH',
    kaiCall: 'WATCH',
    displayTier: 'WATCH',
    status: 'unresolved',
    diagnosticOnly: true,
    originalVerdict:
      candidate.originalVerdict || candidate.verdict || candidate.finalVerdict || candidate.kaiCall || null,
    validationFailureReason: candidate.validationFailureReason || 'not validated'
  }));
}

/**
 * Shrink a large unresolved-candidate list for JSON output. Broad scans can
 * leave tens of thousands of rows unhydrated (each a full row object), which
 * turns the CLI response into tens of megabytes. Small lists pass through
 * untouched; large ones become a total + per-reason counts + sample.
 * @param {Array<Object>} [candidates]
 * @param {number} [sampleSize] - Rows kept in `sample`. Default 50.
 * @returns {Array<Object>|{total:number,omitted:number,byReason:Object<string,number>,sample:Array<Object>}}
 */
const MAX_UNRESOLVED_SAMPLE = 50;
function summarizeUnresolvedCandidates(candidates = [], sampleSize = MAX_UNRESOLVED_SAMPLE) {
  if (!Array.isArray(candidates)) return [];
  const cap =
    Number.isFinite(Number(sampleSize)) && Number(sampleSize) > 0
      ? Math.floor(Number(sampleSize))
      : MAX_UNRESOLVED_SAMPLE;
  if (candidates.length <= cap) return candidates;
  const byReason = {};
  for (const candidate of candidates) {
    const reason = (candidate && candidate.validationFailureReason) || 'unknown';
    byReason[reason] = (byReason[reason] || 0) + 1;
  }
  return {
    total: candidates.length,
    omitted: candidates.length - cap,
    byReason,
    sample: candidates.slice(0, cap)
  };
}

module.exports = { formatScanDiagnostics, normalizeWatchCandidates, summarizeUnresolvedCandidates };
