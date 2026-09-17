'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatScanDiagnostics,
  normalizeWatchCandidates,
  summarizeUnresolvedCandidates
} = require('../lib/scan-diagnostics');
const { formatScan } = require('../bin/pp-cli');

it('marks validation-skipped candidates as watch-only in machine-readable output', () => {
  const [candidate] = normalizeWatchCandidates([
    {
      selection: 'Nice +0.5',
      verdict: 'BET',
      finalVerdict: 'BET',
      kaiCall: 'BET',
      official: false,
      validationFailureReason: 'validation not selected within validation budget'
    }
  ]);

  assert.equal(candidate.verdict, 'WATCH');
  assert.equal(candidate.finalVerdict, 'WATCH');
  assert.equal(candidate.kaiCall, 'WATCH');
  assert.equal(candidate.displayTier, 'WATCH');
  assert.equal(candidate.originalVerdict, 'BET');
  assert.equal(candidate.diagnosticOnly, true);
  assert.equal(candidate.official, false);
});

it('renders consensus edge in the already-percent unit returned by PP', () => {
  const output = formatScan([
    {
      league: 'MLB',
      market: 'Moneyline',
      plays: [{ selection: 'Miami', odds: -108, consensusEdge: 1.4, edge: 1.4, verdict: 'BET' }]
    }
  ]);

  assert.match(output, /edge \+1\.4%/);
  assert.doesNotMatch(output, /edge \+140\.0%/);
});

describe('formatScanDiagnostics', () => {
  it('returns empty lines for a clean scan', () => {
    const lines = formatScanDiagnostics({
      mixedScan: false,
      tennisFallbackApplied: false,
      emptySlate: [],
      scanHealth: null
    });
    assert.deepEqual(lines, []);
  });

  it('mentions truncated leagues with skipped row counts', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate: [],
      scanHealth: {
        truncated: true,
        incomplete: true,
        preHistoryShortlist: [
          { league: 'MLB', market: 'Moneyline', truncated: true, skippedRowCount: 12 },
          { league: 'MLB', market: 'Run Line', truncated: false }
        ]
      }
    });
    assert.ok(
      lines.some((l) => /truncated/i.test(l)),
      'should mention truncation'
    );
    assert.ok(
      lines.some((l) => /MLB/.test(l)),
      'should name the truncated league'
    );
    assert.ok(
      lines.some((l) => /not hydrated|incomplete/i.test(l)),
      'should explain rows were not hydrated'
    );
  });

  it('lists empty league/market pairs, capped at 12', () => {
    const emptySlate = Array.from({ length: 15 }, (_, i) => ({
      league: `League${i}`,
      market: 'Moneyline',
      reason: 'no_ranked_rows_scanned'
    }));
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate,
      scanHealth: null
    });
    assert.ok(
      lines.some((l) => /League0/.test(l)),
      'should list an empty pair'
    );
    assert.ok(
      lines.some((l) => /no_ranked_rows_scanned/.test(l)),
      'should include the reason'
    );
    assert.ok(
      lines.some((l) => /3 more/.test(l)),
      'should report the capped remainder'
    );
  });

  it('warns when a mixed scan was filled by tennis fallback', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: true,
      emptySlate: [],
      scanHealth: null
    });
    assert.ok(
      lines.some((l) => /tennis fallback/i.test(l) && /mixed/i.test(l)),
      'should warn that tennis fallback filled a mixed scan'
    );
  });

  it('does not warn about tennis fallback on a tennis-only scan', () => {
    const lines = formatScanDiagnostics({
      mixedScan: false,
      tennisFallbackApplied: true,
      emptySlate: [],
      scanHealth: null
    });
    assert.equal(lines.length, 0, 'tennis-only fallback is expected behavior, not a warning');
  });

  it('adds a pp rank recovery hint when validation budget was exhausted', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate: [],
      scanHealth: { validationBudgetExhausted: true, league: 'MLB' }
    });
    assert.ok(
      lines.some((l) => /pp rank MLB/.test(l)),
      'should suggest a focused scan'
    );
  });

  it('reports validated candidates when none survived as BET (no survivors)', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate: [],
      playCount: 0,
      scanHealth: {
        truncated: true,
        incomplete: true,
        validation: { eligible: 16, selected: 10, completedCount: 10 },
        preHistoryShortlist: [{ league: 'ufc', market: 'Moneyline', truncated: true }]
      }
    });
    assert.ok(
      lines.some((l) => /16 candidate/.test(l) && /none survived as BET/.test(l) && /exact reason/.test(l)),
      'should report the validated candidates with no BET survivors'
    );
    assert.ok(
      lines.some((l) => /pp rank ufc/.test(l)),
      'should suggest a focused re-scan'
    );
  });

  it('does not flag candidates when plays survived the scan', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate: [],
      playCount: 3,
      scanHealth: { validation: { eligible: 16, selected: 10, completedCount: 10 } }
    });
    assert.ok(!lines.some((l) => /none survived as BET/.test(l)), 'no no-survivors warning when plays are present');
  });

  it('labels an empty market unresolved when its scan block was truncated', () => {
    const lines = formatScanDiagnostics({
      mixedScan: false,
      tennisFallbackApplied: false,
      emptySlate: [{ league: 'UFC', market: 'Moneyline', reason: 'no_ranked_rows_scanned' }],
      scanHealth: {
        truncated: true,
        incomplete: true,
        preHistoryShortlist: [{ league: 'UFC', market: 'Moneyline', truncated: true }]
      }
    });
    assert.ok(
      lines.some((l) => /Unresolved: UFC › Moneyline/.test(l)),
      'should flag the truncated market as unresolved'
    );
    assert.ok(
      !lines.some((l) => /No plays: UFC › Moneyline/.test(l)),
      'should not label the truncated market as an ordinary empty market'
    );
  });

  it('labels an empty market unresolved when validation was short (budget exhausted)', () => {
    const lines = formatScanDiagnostics({
      mixedScan: false,
      tennisFallbackApplied: false,
      emptySlate: [{ league: 'MLB', market: 'Moneyline', reason: 'no_ranked_rows_scanned' }],
      scanHealth: { validationBudgetExhausted: true, validation: { eligible: 5, selected: 5, completedCount: 0 } }
    });
    assert.ok(
      lines.some((l) => /Unresolved: MLB › Moneyline/.test(l)),
      'should flag the validation-short market as unresolved'
    );
    // Retains the existing clean validation-budget message.
    assert.ok(
      lines.some((l) => /validation budget exhausted/.test(l)),
      'should retain the validation-budget-exhausted message'
    );
  });

  it('keeps the ordinary No plays label for a genuinely empty market with a complete scan', () => {
    const lines = formatScanDiagnostics({
      mixedScan: false,
      tennisFallbackApplied: false,
      emptySlate: [{ league: 'NBA', market: 'Spread', reason: 'no_ranked_rows_scanned' }],
      scanHealth: null
    });
    assert.ok(
      lines.some((l) => /No plays: NBA › Spread/.test(l)),
      'should keep the ordinary No plays label when the scan was complete'
    );
    assert.ok(!lines.some((l) => /Unresolved/.test(l)), 'should not flag a complete-scan empty market as unresolved');
  });

  it('names the date window and the rerun flag when rows exist outside it', () => {
    // Regression: the default `today` window is empty late in the day while the
    // next slate is full. Reporting `no_ranked_rows_scanned` with 0 scanned rows
    // reads as "the feed has nothing" and hides the whole board.
    const lines = formatScanDiagnostics({
      mixedScan: false,
      tennisFallbackApplied: false,
      emptySlate: [
        {
          league: 'MLB',
          market: 'Moneyline',
          reason: 'outside_card_window',
          cardWindow: 'today',
          filteredRowCount: 18
        },
        {
          league: 'MLB',
          market: 'Total Runs',
          reason: 'outside_card_window',
          cardWindow: 'today',
          filteredRowCount: 182
        }
      ]
    });
    assert.ok(
      lines.some((l) => /No plays: MLB › Moneyline \(outside_card_window\)/.test(l)),
      'should carry the window reason on the pair line'
    );
    const hint = lines.find((l) => l.includes('--card-window all'));
    assert.ok(hint, 'should hint the flag that shows the out-of-window rows');
    assert.ok(hint.includes('the today window'), 'should name the window it is empty for');
    assert.ok(hint.includes('200 rows'), 'should sum the dropped-row counts');
    assert.ok(hint.includes('the slate is not empty'), 'should say the slate is not empty');
  });

  it('says nothing about windows when no pair was dropped by the window', () => {
    const lines = formatScanDiagnostics({
      emptySlate: [{ league: 'NBA', market: 'Spread', reason: 'no_ranked_rows_scanned' }]
    });
    assert.ok(!lines.some((l) => l.includes('--card-window all')), 'should not hint widening for a windowless empty');
  });
});

it('passes small unresolved lists through untouched', () => {
  const rows = [{ selection: 'A', validationFailureReason: 'x' }];
  assert.equal(summarizeUnresolvedCandidates(rows), rows, 'small lists must keep their exact shape');
});

it('summarizes large unresolved lists to total + byReason + sample', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    selection: `row-${i}`,
    validationFailureReason: i % 2 ? 'history not hydrated within bounded scan budget' : 'other'
  }));
  const out = summarizeUnresolvedCandidates(rows);
  assert.equal(out.total, 120);
  assert.equal(out.omitted, 70);
  assert.deepEqual(out.byReason, {
    'history not hydrated within bounded scan budget': 60,
    other: 60
  });
  assert.equal(out.sample.length, 50);
});

it('returns [] for non-array unresolved input', () => {
  assert.deepEqual(summarizeUnresolvedCandidates(null), []);
});
