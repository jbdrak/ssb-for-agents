'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const recordCard = require('../lib/record-card');
const recordLedger = require('../lib/record-ledger');

// Focused Task 4 tests: promote an explicit reviewed card into official bets.
// A raw PP verdict is never an official bet; only an explicit reviewed card
// with decision BET creates a bet record. LEAN/PASS update the candidate only.

function makeLedger() {
  const current = recordLedger.createLedger();
  current.scans.push({
    id: 'scan-1',
    source: 'manual_cli_scan',
    recordedAt: '2026-08-04T01:00:00.000Z',
    requestedBook: 'Pinnacle',
    leagues: ['MLB'],
    command: 'scan --record',
    candidateCount: 1
  });
  current.candidates.push({
    candidateId: 'cand-under-75',
    scanId: 'scan-1',
    gameId: 'g-123',
    game: 'Pirates @ Brewers',
    league: 'MLB',
    market: 'Total Runs',
    selection: 'Under 7.5',
    odds: -110,
    tier: 'A',
    ppVerdict: 'BET',
    movement: '+5',
    edge: 3.2,
    clvProxyPct: 2.1,
    books: 4,
    start: '2026-08-04T23:40:00.000Z',
    startCST: '2026-08-04 18:40',
    startDisplay: 'Aug 4, 6:40 PM',
    startSource: 'pp_schedule',
    startConfidence: 'high',
    featureSnapshot: {
      schemaVersion: 1,
      capturedAt: '2026-08-04T01:00:00.000Z',
      signalTier: 'TIER 2',
      confidenceTier: 'TIER 2',
      signalQualityScore: 7.5,
      verdict: 'BET',
      movementDisposition: 'supportive_clean',
      movementGrade: 'A',
      consensusEdgePct: 3.1,
      clvProxyPct: 2.1,
      sharpBookCount: 4,
      consensusBookCount: 4,
      marketBookCount: 9,
      executionQuality: 'best',
      targetBookOdds: -110,
      bestAvailableOdds: -112,
      marketFairProbability: 0.52,
      modelWinProbability: null,
      modelMarketEdgePct: null
    },
    status: 'unreviewed',
    reviewNote: null
  });
  return current;
}

function baseCard(overrides = {}) {
  return {
    candidateId: 'cand-under-75',
    decision: 'BET',
    odds: -115,
    stake: 50,
    researchSummary: 'Brewers park plays under; public totals inflated.',
    scheduleVerification: 'start confirmed 2026-08-04 23:40Z via schedule check',
    lineVerification: 'Under 7.5 available at -115 at decision time',
    decisionSource: 'manual_review',
    notes: 'fade the public',
    ...overrides
  };
}

describe('record-card: BET promotion', () => {
  it('promotes a reviewed BET card into an official bet record', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(current.bets.length, 1);
    const bet = current.bets[0];
    assert.equal(bet.id, 'bet-cand-under-75');
    assert.equal(bet.candidateId, 'cand-under-75');
    assert.equal(bet.selection, 'Under 7.5');
    assert.equal(bet.market, 'Total Runs');
    assert.equal(bet.oddsAtDecision, -115);
    assert.equal(bet.stake, 50);
    assert.equal(bet.decisionAt, '2026-08-04T02:30:00.000Z');
    assert.equal(bet.decisionSource, 'manual_review');
    assert.equal(bet.researchSummary, 'Brewers park plays under; public totals inflated.');
    assert.equal(bet.status, 'pending');
    assert.equal(bet.settlementId, null);
    // Candidate is marked promoted.
    assert.equal(current.candidates[0].status, 'promoted');
    assert.equal(current.candidates[0].decisionAt, '2026-08-04T02:30:00.000Z');
  });

  it('stamps tier and movement tags top-level so stats splits never read unknown', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.ok, true);
    assert.equal(result.bet.tier, 'A');
    assert.equal(result.bet.movement, '+5');
  });

  it('keeps the decision timestamp separate from the event start time', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.bet.decisionAt, '2026-08-04T02:30:00.000Z');
    assert.equal(result.bet.candidateSnapshot.start, '2026-08-04T23:40:00.000Z');
    assert.notEqual(result.bet.decisionAt, result.bet.candidateSnapshot.start);
  });

  it('preserves the candidate snapshot and scan/source metadata on the bet', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    const bet = result.bet;
    assert.equal(bet.scanId, 'scan-1');
    assert.equal(bet.scanSource, 'manual_cli_scan');
    assert.equal(bet.scanRecordedAt, '2026-08-04T01:00:00.000Z');
    // Snapshot is a deep copy of the candidate as recorded at scan time
    // (status still 'unreviewed', event time preserved), not the promoted row.
    assert.equal(bet.candidateSnapshot.status, 'unreviewed');
    assert.equal(bet.candidateSnapshot.start, '2026-08-04T23:40:00.000Z');
    assert.equal(bet.candidateSnapshot.selection, 'Under 7.5');
    assert.equal(current.candidates[0].status, 'promoted');
    // Snapshot is a deep copy, not a live reference.
    bet.candidateSnapshot.selection = 'mutated';
    assert.equal(current.candidates[0].selection, 'Under 7.5');
  });

  it('rejects BET cards when the candidate has no settlement-usable start', () => {
    const ledger = makeLedger();
    delete ledger.candidates[0].start;
    const result = recordCard.promoteCard(ledger, baseCard());
    assert.equal(result.ok, false);
    assert.match(result.error, /scheduled start/);
    assert.equal(ledger.bets.length, 0);
  });

  it('stores the resolved scheduled start on the official bet', () => {
    const result = recordCard.promoteCard(makeLedger(), baseCard(), {
      now: () => '2026-08-04T02:30:00.000Z'
    });
    assert.equal(result.ok, true);
    assert.equal(result.bet.scheduledStart, '2026-08-04T23:40:00.000Z');
  });

  it('carries the candidate featureSnapshot into the official bet', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.ok, true);
    const bet = current.bets[0];
    assert.deepEqual(bet.featureSnapshot, current.candidates[0].featureSnapshot);
    assert.equal(bet.featureSnapshot.schemaVersion, 1);
    assert.equal(bet.featureSnapshot.capturedAt, '2026-08-04T01:00:00.000Z');
    assert.equal(bet.featureSnapshot.signalTier, 'TIER 2');
    assert.equal(bet.featureSnapshot.consensusEdgePct, 3.1);
  });

  it('keeps the bet featureSnapshot immutable: mutating the bet does not alter the candidate and vice versa', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    const bet = current.bets[0];
    // Mutating the bet snapshot must not alter the stored candidate snapshot.
    bet.featureSnapshot.signalTier = 'MUTATED';
    assert.equal(current.candidates[0].featureSnapshot.signalTier, 'TIER 2');
    // Mutating the candidate after promotion must not alter the stored bet snapshot.
    current.candidates[0].featureSnapshot.signalQualityScore = 1;
    assert.equal(bet.featureSnapshot.signalQualityScore, 7.5);
    // Mutating the returned bet object must not alter the stored bet record either.
    result.bet.featureSnapshot.executionQuality = 'MUTATED';
    assert.equal(bet.featureSnapshot.executionQuality, 'best');
  });

  it('promotes candidates without a featureSnapshot with a null snapshot', () => {
    const current = makeLedger();
    delete current.candidates[0].featureSnapshot;
    const result = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.ok, true);
    assert.equal(current.bets[0].featureSnapshot, null);
    // Candidate status behavior is unchanged.
    assert.equal(current.candidates[0].status, 'promoted');
  });

  it('rejects BET cards with a missing or invalid price', () => {
    for (const odds of [undefined, null, '', 'abc', 0, NaN, Infinity]) {
      const result = recordCard.promoteCard(makeLedger(), baseCard({ odds }));
      assert.equal(result.ok, false, `odds=${String(odds)} should be rejected`);
      assert.match(result.error, /odds/);
    }
  });

  it('rejects BET cards with a missing or invalid stake', () => {
    for (const stake of [undefined, null, '', 'abc', 0, -50, NaN]) {
      const result = recordCard.promoteCard(makeLedger(), baseCard({ stake }));
      assert.equal(result.ok, false, `stake=${String(stake)} should be rejected`);
      assert.match(result.error, /stake/);
    }
  });

  it('rejects BET cards with an unresolved schedule or unverified line', () => {
    const noSchedule = baseCard({ scheduleVerification: null });
    const result = recordCard.promoteCard(makeLedger(), noSchedule);
    assert.equal(result.ok, false);
    assert.match(result.error, /scheduleVerification/);

    const noLine = baseCard({ lineVerification: '' });
    const result2 = recordCard.promoteCard(makeLedger(), noLine);
    assert.equal(result2.ok, false);
    assert.match(result2.error, /lineVerification/);
  });

  it('rejects BET cards missing research summary or decision source', () => {
    const noSummary = baseCard({ researchSummary: '  ' });
    const result = recordCard.promoteCard(makeLedger(), noSummary);
    assert.equal(result.ok, false);
    assert.match(result.error, /researchSummary/);

    const noSource = baseCard({ decisionSource: undefined });
    const result2 = recordCard.promoteCard(makeLedger(), noSource);
    assert.equal(result2.ok, false);
    assert.match(result2.error, /decisionSource/);
  });
});

describe('record-card: LEAN and PASS', () => {
  it('records a LEAN without creating an official bet', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(
      current,
      baseCard({
        decision: 'lean',
        odds: undefined,
        stake: undefined,
        researchSummary: undefined,
        scheduleVerification: undefined,
        lineVerification: undefined,
        notes: 'needs more movement evidence'
      }),
      { now: () => '2026-08-04T02:30:00.000Z' }
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 'lean');
    assert.equal(current.bets.length, 0);
    assert.equal(current.candidates[0].status, 'lean');
    assert.equal(current.candidates[0].reviewNote, 'needs more movement evidence');
    assert.equal(current.candidates[0].decisionAt, '2026-08-04T02:30:00.000Z');
  });

  it('records a PASS without creating an official bet', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(
      current,
      baseCard({
        decision: 'PASS',
        odds: undefined,
        stake: undefined,
        researchSummary: undefined,
        scheduleVerification: undefined,
        lineVerification: undefined
      }),
      { now: () => '2026-08-04T02:30:00.000Z' }
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 'pass');
    assert.equal(current.bets.length, 0);
    assert.equal(current.candidates[0].status, 'pass');
  });

  it('requires decisionSource even for LEAN/PASS', () => {
    const result = recordCard.promoteCard(makeLedger(), baseCard({ decision: 'PASS', decisionSource: undefined }));
    assert.equal(result.ok, false);
    assert.match(result.error, /decisionSource/);
  });
});

describe('record-card: raw verdicts never promote', () => {
  it('does not promote a candidate whose raw PP verdict says BET when the card says PASS', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(
      current,
      baseCard({
        decision: 'PASS',
        odds: undefined,
        stake: undefined,
        researchSummary: undefined,
        scheduleVerification: undefined,
        lineVerification: undefined
      })
    );
    assert.equal(result.ok, true);
    assert.equal(current.bets.length, 0);
    assert.equal(current.candidates[0].status, 'pass');
  });

  it('promotes only when the explicit card decision is BET even if the raw verdict was not BET', () => {
    const current = makeLedger();
    current.candidates[0].ppVerdict = 'CONSIDER';
    const result = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.ok, true);
    assert.equal(current.bets.length, 1);
    assert.equal(current.candidates[0].status, 'promoted');
  });
});

describe('record-card: duplicate promotion is idempotent', () => {
  it('rejects re-importing the same BET card without creating a second bet', () => {
    const current = makeLedger();
    const first = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(first.duplicate, false);
    const second = recordCard.promoteCard(current, baseCard(), { now: () => '2026-08-04T03:00:00.000Z' });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.bet.id, first.bet.id);
    assert.equal(current.bets.length, 1);
    // Re-import never overwrites the original decision timestamp.
    assert.equal(current.bets[0].decisionAt, '2026-08-04T02:30:00.000Z');
  });

  it('treats re-recording the same LEAN as a no-op', () => {
    const current = makeLedger();
    const leanCard = baseCard({
      decision: 'LEAN',
      odds: undefined,
      stake: undefined,
      researchSummary: undefined,
      scheduleVerification: undefined,
      lineVerification: undefined,
      notes: 'watch line'
    });
    const first = recordCard.promoteCard(current, leanCard, { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(first.ok, true);
    const second = recordCard.promoteCard(current, leanCard, { now: () => '2026-08-04T03:00:00.000Z' });
    assert.equal(second.ok, true);
    assert.equal(second.status, 'lean');
    assert.equal(current.candidates[0].decisionAt, '2026-08-04T02:30:00.000Z');
  });
});

describe('record-card: dry-run', () => {
  it('reports what would be promoted without writing anything', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(current, baseCard(), { dryRun: true, now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.bet.candidateId, 'cand-under-75');
    assert.equal(result.bet.status, 'pending');
    assert.equal(current.bets.length, 0);
    assert.equal(current.candidates[0].status, 'unreviewed');
  });

  it('dry-run LEAN reports the would-be status without writing', () => {
    const current = makeLedger();
    const result = recordCard.promoteCard(
      current,
      baseCard({
        decision: 'LEAN',
        odds: undefined,
        stake: undefined,
        researchSummary: undefined,
        scheduleVerification: undefined,
        lineVerification: undefined
      }),
      { dryRun: true }
    );
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldSetStatus, 'lean');
    assert.equal(current.candidates[0].status, 'unreviewed');
  });
});

describe('record-card: batch promotion', () => {
  it('promotes an array of cards and aggregates per-card results', () => {
    const current = makeLedger();
    current.candidates.push({
      candidateId: 'cand-cobolli',
      scanId: 'scan-1',
      gameId: 'g-456',
      game: 'Cobolli F vs Marozsan F',
      league: 'Tennis',
      market: 'Moneyline',
      selection: 'Cobolli F',
      odds: +120,
      ppVerdict: 'BET',
      start: '2026-08-05T15:00:00.000Z',
      status: 'unreviewed',
      reviewNote: null
    });
    const cards = [
      baseCard(),
      baseCard({
        candidateId: 'cand-cobolli',
        odds: +125,
        stake: 25,
        scheduleVerification: 'start confirmed via schedule check',
        lineVerification: 'ML at +125 at decision time'
      }),
      baseCard({
        candidateId: 'cand-cobolli',
        odds: +130,
        stake: 25,
        scheduleVerification: 'dup import',
        lineVerification: 'dup'
      }),
      baseCard({
        candidateId: 'missing-cand',
        decision: 'BET',
        odds: -110,
        stake: 10,
        scheduleVerification: 'x',
        lineVerification: 'x',
        researchSummary: 'x',
        decisionSource: 'manual_review'
      })
    ];
    const result = recordCard.promoteCards(current, cards, { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.ok, true);
    assert.equal(result.summary.promoted, 2);
    assert.equal(result.summary.duplicates, 1);
    assert.equal(result.summary.rejected, 1);
    assert.equal(current.bets.length, 2);
    const cobolliResults = result.results.filter((r) => r.candidateId === 'cand-cobolli');
    assert.equal(cobolliResults.filter((r) => r.duplicate).length, 1);
    assert.equal(current.candidates.find((c) => c.candidateId === 'cand-cobolli').status, 'promoted');
  });

  it('accepts a single card object as a one-card batch', () => {
    const current = makeLedger();
    const result = recordCard.promoteCards(current, baseCard(), { now: () => '2026-08-04T02:30:00.000Z' });
    assert.equal(result.ok, true);
    assert.equal(result.summary.promoted, 1);
    assert.equal(current.bets.length, 1);
  });
});

describe('record-card: card validation', () => {
  it('rejects a non-object card', () => {
    const result = recordCard.promoteCard(makeLedger(), null);
    assert.equal(result.ok, false);
    assert.match(result.error, /card must be an object/);
  });

  it('rejects a card missing candidateId', () => {
    const card = baseCard();
    delete card.candidateId;
    const result = recordCard.promoteCard(makeLedger(), card);
    assert.equal(result.ok, false);
    assert.match(result.error, /candidateId/);
  });

  it('rejects an unknown decision value', () => {
    const card = baseCard({ decision: 'CONSIDER' });
    const result = recordCard.promoteCard(makeLedger(), card);
    assert.equal(result.ok, false);
    assert.match(result.error, /BET, LEAN, PASS/);
  });

  it('rejects a card whose candidate does not exist in the ledger', () => {
    const card = baseCard({ candidateId: 'no-such-candidate' });
    const result = recordCard.promoteCard(makeLedger(), card);
    assert.equal(result.ok, false);
    assert.match(result.error, /candidate not found/);
    assert.match(result.error, /no-such-candidate/);
  });
});
