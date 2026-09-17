'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  playsInScanResponse,
  outsideCardWindowPairs,
  shouldAutoWiden,
  scanWindowLabel,
  widenScanNote,
  runScanWithWindowWiden
} = require('../lib/ssb-scan-card-window');

const response = (plays, emptySlate = []) => ({
  data: {
    results: plays ? [{ plays }] : [],
    ...(emptySlate.length ? { emptySlate } : {})
  }
});

const outsidePair = { league: 'MLB', market: 'Moneyline', reason: 'outside_card_window', cardWindow: 'today' };

describe('playsInScanResponse', () => {
  it('counts plays across result groups', () => {
    assert.equal(playsInScanResponse({ data: { results: [{ plays: [1, 2] }, { plays: [3] }] } }), 3);
  });

  it('counts candidates when plays is absent and handles empty responses', () => {
    assert.equal(playsInScanResponse({ data: { results: [{ candidates: [1] }] } }), 1);
    assert.equal(playsInScanResponse(null), 0);
    assert.equal(playsInScanResponse({ data: { results: [] } }), 0);
  });
});

describe('outsideCardWindowPairs', () => {
  it('keeps only pairs dropped by the date window', () => {
    const pairs = outsideCardWindowPairs({
      data: { emptySlate: [outsidePair, { league: 'NBA', market: 'Moneyline', reason: 'no_ranked_rows_scanned' }] }
    });
    assert.deepEqual(pairs, [outsidePair]);
    assert.deepEqual(outsideCardWindowPairs(null), []);
  });
});

describe('shouldAutoWiden', () => {
  it('widens a default window that produced no plays', () => {
    assert.equal(shouldAutoWiden({ res: response([], [outsidePair]), cardWindow: 'today' }), true);
  });

  it('widens even when no pair reported a window reason (paths that cannot attribute the drop)', () => {
    assert.equal(shouldAutoWiden({ res: response([]), cardWindow: 'today' }), true);
  });

  it('never widens an explicit --card-window', () => {
    assert.equal(
      shouldAutoWiden({ res: response([], [outsidePair]), cardWindow: 'today', windowWasExplicit: true }),
      false
    );
  });

  it('never widens when the window already produced plays', () => {
    assert.equal(shouldAutoWiden({ res: response([{ selection: 'A' }]), cardWindow: 'today' }), false);
  });

  it('never widens the all window or an unset window', () => {
    assert.equal(shouldAutoWiden({ res: response([]), cardWindow: 'all' }), false);
    assert.equal(shouldAutoWiden({ res: response([]), cardWindow: '' }), false);
    assert.equal(shouldAutoWiden({ res: response([]), cardWindow: undefined }), false);
  });
});

describe('scanWindowLabel', () => {
  it('labels each window', () => {
    assert.equal(scanWindowLabel({ cardWindow: 'today' }), 'Today');
    assert.equal(scanWindowLabel({ cardWindow: 'next' }), 'Next day');
    assert.equal(scanWindowLabel({ cardWindow: 'all' }), 'All upcoming');
  });

  it('says the result was widened and from which window', () => {
    assert.equal(
      scanWindowLabel({ cardWindow: 'all', autoWidenedFrom: 'today' }),
      'All upcoming (widened: the today window had no plays)'
    );
  });
});

describe('widenScanNote', () => {
  it('names the window, the out-of-window pair count, and the opt-out flag', () => {
    const note = widenScanNote('today', 3);
    assert.match(note, /0 plays inside the today window \(3 pair\(s\) have rows outside it\)/);
    assert.match(note, /rescanning all upcoming games/);
    assert.match(note, /pass --card-window today to keep the window/);
  });

  it('omits the pair count when no pair reported one', () => {
    const note = widenScanNote('next');
    assert.match(note, /0 plays inside the next window;/);
  });
});

describe('runScanWithWindowWiden', () => {
  it('re-runs once over all upcoming rows and reports the widen', async () => {
    const windows = [];
    const result = await runScanWithWindowWiden({
      cardWindow: 'today',
      windowWasExplicit: false,
      run: async (window) => {
        windows.push(window);
        return window === 'all' ? response([{ selection: 'A' }]) : response([], [outsidePair]);
      }
    });
    assert.deepEqual(windows, ['today', 'all']);
    assert.equal(result.effectiveCardWindow, 'all');
    assert.equal(result.autoWidenedFrom, 'today');
    assert.equal(playsInScanResponse(result.res), 1);
  });

  it('keeps the original response when the widened pass is also empty', async () => {
    const windows = [];
    const result = await runScanWithWindowWiden({
      cardWindow: 'today',
      run: async (window) => {
        windows.push(window);
        return response([]);
      }
    });
    assert.deepEqual(windows, ['today', 'all']);
    assert.equal(result.effectiveCardWindow, 'today');
    assert.equal(result.autoWidenedFrom, null);
  });

  it('does not re-run at all when the first pass produced plays or the window was explicit', async () => {
    const windows = [];
    const run = async (window) => {
      windows.push(window);
      return response([{ selection: 'A' }]);
    };
    const withPlays = await runScanWithWindowWiden({ cardWindow: 'today', run });
    assert.deepEqual(windows, ['today']);
    assert.equal(withPlays.autoWidenedFrom, null);

    windows.length = 0;
    const explicit = await runScanWithWindowWiden({ cardWindow: 'today', windowWasExplicit: true, run });
    assert.deepEqual(windows, ['today']);
    assert.equal(explicit.effectiveCardWindow, 'today');
  });
});
