'use strict';

/**
 * Card-window helpers for `pp scan`.
 *
 * A plain scan defaults to the local "today" window. Late in the day that
 * window is empty while the next slate is full, and the old code reported the
 * result as `no_ranked_rows_scanned` with zero scanned rows - text
 * indistinguishable from "the feed has nothing" - so every league looked dead
 * until each one was re-scanned by hand. These helpers keep the widen decision,
 * the widened-result label, and the stderr note in one testable place.
 *
 * The scan widens only when the caller left the window at its default AND the
 * window produced no plays at all. An explicit `--card-window` is never widened.
 */

/**
 * Total plays (or candidates) across a quick_screen response.
 * @param {Object} res
 * @returns {number}
 */
function playsInScanResponse(res) {
  return (res?.data?.results || res?.results || []).reduce(
    (sum, group) => sum + (group.plays || group.candidates || []).length,
    0
  );
}

/**
 * Empty league/market pairs whose rows were dropped by the date window rather
 * than missing from the feed.
 * @param {Object} res
 * @returns {Array<Object>}
 */
function outsideCardWindowPairs(res) {
  return (res?.data?.emptySlate || res?.emptySlate || []).filter(
    (pair) => pair && pair.reason === 'outside_card_window'
  );
}

/**
 * True when the scan should re-run once over all upcoming rows.
 * @param {Object} [opts]
 * @param {Object} [opts.res] - first-pass quick_screen response
 * @param {string} [opts.cardWindow] - window used by the first pass
 * @param {boolean} [opts.windowWasExplicit=false] - caller passed --card-window
 * @returns {boolean}
 */
function shouldAutoWiden({ res, cardWindow, windowWasExplicit = false } = {}) {
  if (windowWasExplicit) return false;
  const window = String(cardWindow || '')
    .trim()
    .toLowerCase();
  if (!window || window === 'all') return false;
  return playsInScanResponse(res) === 0;
}

/**
 * Header label for the window the returned rows came from.
 * @param {Object} [opts]
 * @param {string} [opts.cardWindow] - effective window
 * @param {string|null} [opts.autoWidenedFrom=null] - window that came back empty
 * @returns {string}
 */
function scanWindowLabel({ cardWindow, autoWidenedFrom = null } = {}) {
  const base = cardWindow === 'today' ? 'Today' : cardWindow === 'next' ? 'Next day' : 'All upcoming';
  return autoWidenedFrom ? `${base} (widened: the ${autoWidenedFrom} window had no plays)` : base;
}

/**
 * stderr note printed when the default window came back empty and the scan
 * re-runs over all upcoming rows.
 * @param {string} cardWindow - window that produced no plays
 * @param {number} [pairCount=0] - pairs that reported rows outside the window
 * @returns {string}
 */
function widenScanNote(cardWindow, pairCount = 0) {
  return (
    `[scan] 0 plays inside the ${cardWindow} window` +
    (pairCount ? ` (${pairCount} pair(s) have rows outside it)` : '') +
    `; rescanning all upcoming games (pass --card-window ${cardWindow} to keep the window).`
  );
}

/**
 * Run a scan, and re-run it once over all upcoming rows when the default date
 * window produced no plays at all.
 *
 * The first pass cannot tell "no rows exist" from "every row is out of window"
 * for paths that do not report a window reason, so it is the widened pass that
 * decides whether the board is genuinely empty.
 *
 * @param {Object} opts
 * @param {string} opts.cardWindow - window requested by the caller
 * @param {boolean} [opts.windowWasExplicit=false] - caller passed --card-window
 * @param {(window: (string|undefined)) => Promise<Object>} opts.run - issues one quick_screen call for the given window
 * @returns {Promise<{res: Object, effectiveCardWindow: string, autoWidenedFrom: (string|null)}>}
 */
async function runScanWithWindowWiden({ cardWindow, windowWasExplicit = false, run }) {
  let res = await run(cardWindow);
  let effectiveCardWindow = cardWindow;
  let autoWidenedFrom = null;
  if (shouldAutoWiden({ res, cardWindow: effectiveCardWindow, windowWasExplicit })) {
    console.error(widenScanNote(effectiveCardWindow, outsideCardWindowPairs(res).length));
    const widened = await run('all');
    if (playsInScanResponse(widened) > 0) {
      res = widened;
      autoWidenedFrom = effectiveCardWindow;
      effectiveCardWindow = 'all';
    }
  }
  return { res, effectiveCardWindow, autoWidenedFrom };
}

module.exports = {
  playsInScanResponse,
  outsideCardWindowPairs,
  shouldAutoWiden,
  scanWindowLabel,
  widenScanNote,
  runScanWithWindowWiden
};
