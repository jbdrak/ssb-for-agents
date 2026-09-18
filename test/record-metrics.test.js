'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../lib/record-metrics');

describe('record-metrics: Wilson interval', () => {
  it('is null with no observations', () => {
    assert.equal(metrics.wilsonInterval(0, 0), null);
    assert.equal(metrics.wilsonInterval(3, NaN), null);
  });

  it('brackets the point estimate and stays inside [0, 1]', () => {
    const ci = metrics.wilsonInterval(30, 50);
    assert.ok(ci.low < 0.6 && ci.high > 0.6);
    assert.ok(ci.low >= 0 && ci.high <= 1);
  });

  it('widens as the sample shrinks', () => {
    const small = metrics.wilsonInterval(3, 5);
    const large = metrics.wilsonInterval(300, 500);
    assert.ok(small.high - small.low > large.high - large.low);
  });

  it('handles a perfect and an empty record without leaving [0, 1]', () => {
    const perfect = metrics.wilsonInterval(10, 10);
    assert.ok(perfect.low > 0.6 && perfect.high === 1);
    const none = metrics.wilsonInterval(0, 10);
    assert.equal(none.low, 0);
  });
});

describe('record-metrics: profit units', () => {
  it('prices a favourite, a dog, a loss and a push', () => {
    assert.equal(Math.round(metrics.profitUnits({ odds: -110, stake: 1, outcome: 'win' }) * 1e4) / 1e4, 0.9091);
    assert.equal(metrics.profitUnits({ odds: 150, stake: 1, outcome: 'win' }), 1.5);
    assert.equal(metrics.profitUnits({ odds: -110, stake: 1, outcome: 'loss' }), -1);
    assert.equal(metrics.profitUnits({ odds: -110, stake: 1, outcome: 'push' }), 0);
  });

  it('refuses a row whose price is not a price', () => {
    assert.equal(metrics.profitUnits({ odds: '49.0%', stake: 1, outcome: 'win' }), null);
    assert.equal(metrics.profitUnits({ odds: null, stake: 1, outcome: 'win' }), null);
  });

  it('refuses a row with no usable stake', () => {
    assert.equal(metrics.profitUnits({ odds: -110, stake: 0, outcome: 'win' }), null);
  });
});

describe('record-metrics: price buckets', () => {
  it('separates a heavy favourite from a big underdog', () => {
    assert.equal(metrics.oddsBucket(-250), 'heavy_favourite');
    assert.equal(metrics.oddsBucket(-110), 'favourite');
    assert.equal(metrics.oddsBucket(100), 'even');
    assert.equal(metrics.oddsBucket(150), 'underdog');
    assert.equal(metrics.oddsBucket(400), 'big_underdog');
    assert.equal(metrics.oddsBucket('49.0%'), 'unpriced');
  });
});

describe('record-metrics: summarise', () => {
  it('reports hit rate with an interval, ROI, and flags a thin sample', () => {
    const rows = [
      { odds: -110, stake: 1, outcome: 'win' },
      { odds: -110, stake: 1, outcome: 'loss' }
    ];
    const stats = metrics.summarise(rows);
    assert.equal(stats.sample, 2);
    assert.equal(stats.decided, 2);
    assert.equal(stats.hitRate, 0.5);
    assert.equal(stats.stakedUnits, 2);
    assert.equal(stats.pnlUnits, -0.0909);
    assert.equal(stats.insufficientSample, true);
  });

  it('never reports a 0 mean CLV when no close was ever captured', () => {
    const stats = metrics.summarise([{ odds: -110, stake: 1, outcome: 'win' }]);
    assert.equal(stats.meanClvPct, null);
    assert.equal(stats.clvSample, 0);
  });

  it('averages only the rows that actually carry a close', () => {
    const stats = metrics.summarise([
      { odds: -110, stake: 1, outcome: 'win', clvPct: 2 },
      { odds: -110, stake: 1, outcome: 'loss', clvPct: -1 },
      { odds: -110, stake: 1, outcome: 'win', clvPct: null }
    ]);
    assert.equal(stats.clvSample, 2);
    assert.equal(stats.meanClvPct, 0.5);
  });

  it('excludes an unpriced row from ROI instead of counting it as zero', () => {
    const stats = metrics.summarise([
      { odds: '49.0%', stake: 1, outcome: 'win' },
      { odds: -100, stake: 1, outcome: 'win' }
    ]);
    assert.equal(stats.unpricedRows, 1);
    assert.equal(stats.stakedUnits, 1);
    assert.equal(stats.roiPct, 100);
  });

  it('has no hit rate when nothing has been decided', () => {
    const stats = metrics.summarise([{ odds: -110, stake: 1, outcome: 'push' }]);
    assert.equal(stats.hitRate, null);
    assert.equal(stats.hitRateCi, null);
    assert.equal(stats.insufficientSample, true);
  });
});

describe('record-metrics: beat the close', () => {
  const ledger = {
    candidates: [
      {
        candidateId: 'a',
        tier: 'TIER 1',
        market: 'Moneyline',
        league: 'MLB',
        closeBook: 'NoVigApp',
        odds: -127,
        closeOdds: -118,
        clvPct: 1.8
      },
      {
        candidateId: 'b',
        tier: 'TIER 1',
        market: 'Moneyline',
        league: 'MLB',
        closeBook: 'NoVigApp',
        odds: -110,
        closeOdds: -125,
        clvPct: -2.4
      },
      {
        candidateId: 'c',
        tier: 'TIER 2',
        market: 'Total Runs',
        league: 'MLB',
        closeBook: 'NoVigApp',
        odds: -105,
        closeOdds: -100,
        clvPct: 1.1
      },
      { candidateId: 'd', tier: 'TIER 2', market: 'Total Runs', league: 'MLB' },
      {
        candidateId: 'e',
        tier: 'TIER 3',
        market: 'Total Runs',
        league: 'MLB',
        closeImpliedProbability: 0.5,
        clvReason: 'decision_price_not_a_price'
      }
    ]
  };

  it('counts only rows that have both a close and a computable CLV', () => {
    const report = metrics.beatTheCloseReport(ledger);
    assert.equal(report.candidates, 5);
    assert.equal(report.withoutClose, 1);
    assert.equal(report.withCloseNoPrice, 1);
    assert.equal(report.sample, 3);
    assert.equal(report.beat, 2);
    assert.ok(Math.abs(report.rate - 0.6667) < 0.001);
    assert.ok(report.rateCi.low < report.rate && report.rateCi.high > report.rate);
  });

  it('splits by tier with a sample size on every bucket', () => {
    const report = metrics.beatTheCloseReport(ledger);
    assert.equal(report.byTier['TIER 1'].sample, 2);
    assert.equal(report.byTier['TIER 1'].beat, 1);
    assert.equal(report.byTier['TIER 2'].sample, 1);
    assert.equal(report.byTier['TIER 2'].insufficientSample, true);
    assert.ok(report.byTier['TIER 1'].meanClvPct != null);
  });

  it('is null, not zero, when nothing has a close', () => {
    const empty = metrics.beatTheCloseReport({ candidates: [{ candidateId: 'x' }] });
    assert.equal(empty.sample, 0);
    assert.equal(empty.rate, null);
    assert.equal(empty.meanClvPct, null);
    assert.equal(empty.insufficientSample, true);
  });

  it('counts one observation once, even when a scan was recorded twice', () => {
    // record-scan is keyed on the scan record's content, so re-recording one
    // scan file yields two scan ids and two candidate ids for one play. Both
    // rows carry the same close, and counting both inflates the denominator.
    const duplicated = {
      candidates: [
        {
          candidateId: 'a',
          gameId: 'G1',
          market: 'Moneyline',
          selection: 'X',
          odds: -110,
          closeOdds: -120,
          clvPct: 1.5
        },
        {
          candidateId: 'b',
          gameId: 'G1',
          market: 'Moneyline',
          selection: 'X',
          odds: -110,
          closeOdds: -120,
          clvPct: 1.5
        }
      ]
    };
    const report = metrics.beatTheCloseReport(duplicated);
    assert.equal(report.sample, 1);
    assert.equal(report.beat, 1);
  });

  it('still counts a genuinely different observation of the same play', () => {
    const repriced = {
      candidates: [
        {
          candidateId: 'a',
          gameId: 'G1',
          market: 'Moneyline',
          selection: 'X',
          odds: -110,
          closeOdds: -120,
          clvPct: 1.5
        },
        {
          candidateId: 'b',
          gameId: 'G1',
          market: 'Moneyline',
          selection: 'X',
          odds: -125,
          closeOdds: -120,
          clvPct: -2.1
        }
      ]
    };
    assert.equal(metrics.beatTheCloseReport(repriced).sample, 2);
  });
});

describe('record-metrics: settled rows and the full document', () => {
  it('joins the latest settlement per bet and takes CLV from the candidate', () => {
    const ledger = {
      candidates: [{ candidateId: 'a', tier: 'TIER 1', market: 'Moneyline', league: 'MLB', clvPct: 1.8 }],
      bets: [
        {
          id: 'bet-1',
          candidateId: 'a',
          market: 'Moneyline',
          league: 'MLB',
          oddsAtDecision: -127,
          stake: 2,
          status: 'pending'
        }
      ],
      settlements: [
        { betId: 'bet-1', status: 'loss', settledAt: '2026-09-17T20:00:00.000Z' },
        { betId: 'bet-1', status: 'win', settledAt: '2026-09-17T21:00:00.000Z' }
      ]
    };
    const rows = metrics.settledRows(ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'win');
    assert.equal(rows[0].tier, 'TIER 1');
    assert.equal(rows[0].clvPct, 1.8);
  });

  it('ignores a bet that is not settled', () => {
    const ledger = { candidates: [], bets: [{ id: 'b', status: 'pending' }], settlements: [] };
    assert.equal(metrics.settledRows(ledger).length, 0);
  });

  it('produces a full document on an empty ledger without inventing results', () => {
    const document = metrics.evaluateLedger({ version: 2, scans: [], candidates: [], bets: [], settlements: [] });
    assert.equal(document.overall.sample, 0);
    assert.equal(document.overall.hitRate, null);
    assert.equal(document.overall.roiPct, null);
    assert.equal(document.overall.insufficientSample, true);
    assert.equal(document.beatTheClose.sample, 0);
    assert.equal(document.minSample, 30);
  });

  it('honours a custom trust floor', () => {
    const ledger = {
      candidates: [],
      bets: [{ id: 'b1', status: 'win', oddsAtDecision: -110, stake: 1 }],
      settlements: []
    };
    assert.equal(metrics.evaluateLedger(ledger, { minSample: 1 }).overall.insufficientSample, false);
  });
});

describe('record-metrics: a pending settlement must not shadow a decided bet', () => {
  // Regression: `settle-record` writes a `pending` settlement row for any bet it
  // cannot match, and migrated bets have an unresolvable start (`eventDate:
  // 'unknown'`) while carrying their real outcome ON the bet. An earlier version
  // took the settlement whenever one merely EXISTED, so adding the pending rows
  // turned a decided 13W/12L legacy record into a reported 0W/0L.
  const ledgerWith = (settlementStatus) => ({
    version: 2,
    scans: [],
    candidates: [],
    bets: [
      { id: 'b1', status: 'win', plUnits: 0.77, oddsAtDecision: -130, stake: 1, league: 'MLB', market: 'Moneyline' }
    ],
    settlements: [{ betId: 'b1', status: settlementStatus, reasonCode: 'no_event_match' }]
  });

  it('counts the bet own outcome when the settlement is pending', () => {
    const rows = metrics.settledRows(ledgerWith('pending'));
    assert.equal(rows.length, 1, 'the decided bet must still produce a row');
    assert.equal(rows[0].outcome, 'win');
  });

  it('still lets a DECIDED settlement win', () => {
    const rows = metrics.settledRows(ledgerWith('loss'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'loss', 'a real settlement must override the bet status');
  });

  it('reports the legacy 13W/12L record as decided, not as zero', () => {
    const bets = [];
    const settlements = [];
    for (let i = 0; i < 25; i += 1) {
      const outcome = i < 13 ? 'win' : 'loss';
      bets.push({
        id: `b${i}`,
        status: outcome,
        plUnits: outcome === 'win' ? 0.7 : -1,
        oddsAtDecision: -110,
        stake: 1,
        league: 'MLB',
        market: 'Moneyline'
      });
      // Exactly what the cron wrote for these bets.
      settlements.push({ betId: `b${i}`, status: 'pending', reasonCode: 'no_event_match' });
    }
    const overall = metrics.evaluateLedger(
      { version: 2, scans: [], candidates: [], bets, settlements },
      { minSample: 30 }
    ).overall;
    assert.equal(overall.wins, 13);
    assert.equal(overall.losses, 12);
    assert.ok(overall.wins + overall.losses === 25);
  });
});

describe('record-metrics: close eligibility', () => {
  // A candidate with no resolvable fixture can NEVER take a close, because
  // validate_play requires a gameId. Reporting it inside "no close" makes a
  // structurally impossible close look like a failing sweep.
  const candidate = (overrides) => ({
    candidateId: `c-${Math.random()}`,
    market: 'Moneyline',
    selection: 'A',
    odds: -110,
    ...overrides
  });

  it('separates still-closable rows from permanently unclosable ones', () => {
    const report = metrics.beatTheCloseReport({
      candidates: [
        candidate({ gameId: 'g1' }), // closable, no close yet
        candidate({ playId: 'MLB:GAME:x:y:1::Moneyline::A' }), // closable via playId
        candidate({}), // recorded before playId was stored: never closable
        candidate({ gameId: 'g2', closeOdds: -105, clvPct: 1.2 }) // closed
      ]
    });
    assert.equal(report.candidates, 4);
    assert.equal(report.sample, 1, 'one row has a close-relative CLV');
    assert.equal(report.withoutClose, 3);
    assert.equal(report.notYetClosed, 2);
    assert.equal(report.neverClosable, 1);
  });

  it('reports zero unclosable rows when every fixture is resolvable', () => {
    const report = metrics.beatTheCloseReport({ candidates: [candidate({ gameId: 'g1' })] });
    assert.equal(report.neverClosable, 0);
    assert.equal(report.notYetClosed, 1);
  });

  it('dedupes BEFORE the eligibility split, so the closable count is not inflated', () => {
    // Measured on the live ledger: 209 counted vs 158 actually distinct, because the
    // same play is recorded once per scan run. Counting before deduping overstated
    // the rows that can still be measured by 24%.
    const dup = () => candidate({ gameId: 'g1', candidateId: `c-${Math.random()}`, odds: -110 });
    const report = metrics.beatTheCloseReport({ candidates: [dup(), dup(), dup()] });
    assert.equal(report.candidates, 3, 'raw row count is still reported');
    assert.equal(report.uniqueCandidates, 1, 'but only one distinct observation exists');
    assert.equal(report.withoutClose, 1, 'and the no-close bucket is deduped too');
    assert.equal(report.notYetClosed, 1);
  });
});
