'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const review = require('../scripts/review-record');

// Task 6 tests: scripts/review-record.js is a pure local review of the
// tracker ledger — no network, no writes. The official record counts
// ledger.bets only; LEAN/PASS candidates are counted but never enter the
// W-L-P-V record or the official ROI. All date filtering is the strict
// America/Chicago calendar day.

const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard';

function round2(value) {
  return Math.round(value * 100) / 100;
}

function makeBet(overrides = {}) {
  return {
    id: 'bet-under-75',
    candidateId: 'cand-under-75',
    gameId: 'g-1',
    game: 'Siniakova vs Rakhimova',
    league: 'WTA',
    market: 'Total Games',
    selection: 'Under 7.5',
    oddsAtDecision: 90,
    stake: 1,
    status: 'pending',
    tier: 'A',
    movement: 'up',
    decisionSource: 'manual-review',
    scheduledStart: '2024-08-04T23:30:00Z',
    ...overrides
  };
}

function makeCobolliBet(overrides = {}) {
  return {
    id: 'bet-cobolli',
    candidateId: 'cand-cobolli',
    gameId: 'g-2',
    game: 'Cobolli vs Nakashima',
    league: 'ATP',
    market: 'Moneyline',
    selection: 'Cobolli',
    oddsAtDecision: -110,
    stake: 1,
    status: 'loss',
    tier: 'B',
    movement: 'down',
    decisionSource: 'pp-scan',
    scheduledStart: '2024-08-04T20:00:00Z',
    ...overrides
  };
}

// Aug 4 acceptance fixture: Under 7.5 win +0.90u (via settlement pnlUnits)
// and Cobolli ML loss -1.00u on 1u each => net -0.10u, ROI -5%. The
// Siniakova/Rakhimova LEAN candidate (plus a PASS) is excluded from the
// official record entirely.
function makeAug4Ledger() {
  return {
    version: 2,
    scans: [],
    candidates: [
      {
        candidateId: 'cand-under-75',
        scanId: 'scan-1',
        gameId: 'g-1',
        game: 'Siniakova vs Rakhimova',
        league: 'WTA',
        market: 'Total Games',
        selection: 'Under 7.5',
        odds: 90,
        tier: 'A',
        movement: 'up',
        start: '2024-08-04T23:30:00Z',
        status: 'promoted'
      },
      {
        candidateId: 'cand-cobolli',
        scanId: 'scan-2',
        gameId: 'g-2',
        game: 'Cobolli vs Nakashima',
        league: 'ATP',
        market: 'Moneyline',
        selection: 'Cobolli',
        odds: -110,
        tier: 'B',
        movement: 'down',
        start: '2024-08-04T20:00:00Z',
        status: 'promoted'
      },
      {
        candidateId: 'cand-siniakova',
        scanId: 'scan-1',
        gameId: 'g-1',
        game: 'Siniakova vs Rakhimova',
        league: 'WTA',
        market: 'Moneyline',
        selection: 'Siniakova',
        odds: -140,
        tier: 'B',
        movement: 'flat',
        start: '2024-08-04T23:30:00Z',
        status: 'lean'
      },
      {
        candidateId: 'cand-pass',
        scanId: 'scan-2',
        gameId: 'g-2',
        game: 'Cobolli vs Nakashima',
        league: 'ATP',
        market: 'Total Games',
        selection: 'Over 21.5',
        odds: -110,
        tier: 'C',
        movement: 'down',
        start: '2024-08-04T20:00:00Z',
        status: 'pass'
      }
    ],
    bets: [makeBet(), makeCobolliBet()],
    settlements: [
      {
        id: 'settlement-under-75',
        betId: 'bet-under-75',
        status: 'win',
        pnlUnits: 0.9,
        scheduledStart: '2024-08-04T23:30:00Z',
        actualStart: '2024-08-04T23:32:00Z',
        sourceUrl: ESPN_URL,
        reason: 'final total 5 under 7.5'
      },
      {
        id: 'settlement-cobolli',
        betId: 'bet-cobolli',
        status: 'loss',
        scheduledStart: '2024-08-04T20:00:00Z',
        actualStart: '2024-08-04T20:15:00Z',
        sourceUrl: ESPN_URL,
        reason: 'completed match; winner Nakashima'
      }
    ]
  };
}

/** fs mock that only allows reads — any write attempt fails the test. */
function makeReadOnlyFs(ledger) {
  return {
    readFileSync() {
      return JSON.stringify(ledger);
    },
    writeFileSync() {
      throw new Error('review-record must never write');
    },
    renameSync() {
      throw new Error('review-record must never write');
    },
    mkdirSync() {
      throw new Error('review-record must never write');
    }
  };
}

function writeTempLedger(ledger) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-record-'));
  const file = path.join(directory, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify(ledger));
  return file;
}

describe('review-record parseArgs', () => {
  it('defaults to review mode with no mode arguments', () => {
    assert.deepEqual(review.parseArgs(['node', 'scripts/review-record.js']), {
      mode: 'review',
      date: null,
      json: false
    });
  });

  it('accepts --stats/--pending flags and positional modes', () => {
    assert.equal(review.parseArgs(['node', 'x', '--stats']).mode, 'stats');
    assert.equal(review.parseArgs(['node', 'x', '--pending']).mode, 'pending');
    assert.equal(review.parseArgs(['node', 'x', 'review']).mode, 'review');
    assert.equal(review.parseArgs(['node', 'x', 'stats']).mode, 'stats');
    assert.equal(review.parseArgs(['node', 'x', 'stats', '--stats']).mode, 'stats');
  });

  it('rejects conflicting modes', () => {
    assert.ok(review.parseArgs(['node', 'x', '--stats', '--pending']).parseError);
    assert.ok(review.parseArgs(['node', 'x', '--stats', 'review']).parseError);
  });

  it('rejects unknown flags and extra positionals', () => {
    assert.ok(review.parseArgs(['node', 'x', '--bogus']).parseError);
    assert.ok(review.parseArgs(['node', 'x', 'stats', 'review']).parseError);
  });

  it('parses --date, --date=, and --json', () => {
    assert.deepEqual(review.parseArgs(['node', 'x', '--date', '2024-08-04', '--json']), {
      mode: 'review',
      date: '2024-08-04',
      json: true
    });
    assert.equal(review.parseArgs(['node', 'x', '--date=2024-08-04']).date, '2024-08-04');
    assert.ok(review.parseArgs(['node', 'x', '--date']).parseError);
  });
});

describe('review-record Aug 4 acceptance', () => {
  const ledger = makeAug4Ledger();

  it('aggregates structured pending reason codes in official stats', () => {
    const pendingLedger = structuredClone(ledger);
    pendingLedger.bets[0].status = 'pending';
    pendingLedger.settlements[0] = {
      ...pendingLedger.settlements[0],
      status: 'pending',
      reasonCode: 'missing_final_score'
    };
    const result = review.buildReview(pendingLedger, { mode: 'stats', date: '2024-08-04' });
    assert.equal(result.official.pending, 1);
    assert.deepEqual(result.official.pendingReasons, { missing_final_score: 1 });
  });

  it('reports the official record: 1W 1L, -0.10u on 2u, ROI -5%', () => {
    const result = review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'review');
    assert.equal(result.date, '2024-08-04');
    assert.equal(result.official.total, 2);
    assert.equal(result.official.wins, 1);
    assert.equal(result.official.losses, 1);
    assert.equal(result.official.pushes, 0);
    assert.equal(result.official.voids, 0);
    assert.equal(result.official.pending, 0);
    assert.equal(result.official.unresolved, 0);
    assert.equal(result.official.retirement, 0);
    assert.equal(result.official.delayed, 0);
    assert.equal(round2(result.official.pnl.totalUnits), -0.1);
    assert.equal(round2(result.official.pnl.stakedUnits), 2);
    assert.equal(round2(result.official.pnl.roiPct), -5);
  });

  it('excludes LEAN/PASS candidates from official bets and ROI', () => {
    const result = review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    assert.equal(result.candidates.total, 4);
    assert.equal(result.candidates.promoted, 2);
    assert.equal(result.candidates.lean, 1);
    assert.equal(result.candidates.pass, 1);
    const betIds = result.bets.map((b) => b.id).sort();
    assert.deepEqual(betIds, ['bet-cobolli', 'bet-under-75']);
  });

  it('uses settlement pnlUnits for wins and -stake for losses', () => {
    const result = review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    const byId = new Map(result.bets.map((b) => [b.id, b]));
    assert.equal(byId.get('bet-under-75').status, 'win');
    assert.equal(round2(byId.get('bet-under-75').pnlUnits), 0.9);
    assert.equal(byId.get('bet-cobolli').status, 'loss');
    assert.equal(byId.get('bet-cobolli').pnlUnits, -1);
  });

  it('reports splits by league, market, tier, movement, decisionSource', () => {
    const result = review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    const { splits } = result.official;
    assert.deepEqual(splits.league.map((s) => s.key).sort(), ['ATP', 'WTA']);
    assert.deepEqual(splits.market.map((s) => s.key).sort(), ['Moneyline', 'Total Games']);
    assert.deepEqual(splits.tier.map((s) => s.key).sort(), ['A', 'B']);
    assert.deepEqual(splits.movement.map((s) => s.key).sort(), ['down', 'up']);
    assert.deepEqual(splits.decisionSource.map((s) => s.key).sort(), ['manual-review', 'pp-scan']);
    const wta = splits.league.find((s) => s.key === 'WTA');
    assert.equal(wta.wins, 1);
    assert.equal(round2(wta.pnl.totalUnits), 0.9);
  });

  it('lists settlement source URLs and linked settlement counts', () => {
    const result = review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    assert.equal(result.settlements.total, 2);
    assert.equal(result.settlements.linked, 2);
    assert.deepEqual(result.settlements.sourceUrls, [ESPN_URL]);
  });

  it('review mode includes per-bet detail; stats mode does not', () => {
    const reviewResult = review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    assert.equal(reviewResult.bets.length, 2);
    const statsResult = review.buildReview(ledger, { mode: 'stats', date: '2024-08-04' });
    assert.deepEqual(statsResult.bets, []);
  });

  it('reviewLedger is the read-only API alias of buildReview', () => {
    assert.deepEqual(
      review.reviewLedger(ledger, { mode: 'stats', date: '2024-08-04' }),
      review.buildReview(ledger, { mode: 'stats', date: '2024-08-04' })
    );
  });

  it('never mutates the ledger', () => {
    const snapshot = JSON.parse(JSON.stringify(ledger));
    review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    assert.deepEqual(ledger, snapshot);
  });
});

describe('review-record date filtering (America/Chicago)', () => {
  it('maps a UTC timestamp across the Chicago midnight boundary', () => {
    const ledger = {
      version: 2,
      scans: [],
      candidates: [],
      bets: [
        // 2024-08-05T04:59:59Z is 2024-08-04 23:59:59 CDT -> Aug 4
        makeBet({ id: 'bet-before-midnight', selection: 'Under 7.5', scheduledStart: '2024-08-05T04:59:59Z' }),
        // 2024-08-05T05:00:00Z is 2024-08-05 00:00:00 CDT -> Aug 5
        makeBet({ id: 'bet-after-midnight', selection: 'Under 6.5', scheduledStart: '2024-08-05T05:00:00Z' })
      ],
      settlements: []
    };
    const aug4 = review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    assert.deepEqual(
      aug4.bets.map((b) => b.id),
      ['bet-before-midnight']
    );
    assert.equal(aug4.official.total, 1);
    assert.equal(aug4.excludedUnknownDate, 0);
    const aug5 = review.buildReview(ledger, { mode: 'review', date: '2024-08-05' });
    assert.deepEqual(
      aug5.bets.map((b) => b.id),
      ['bet-after-midnight']
    );
  });

  it('filters by eventDate (migrated bets) and counts unknown dates', () => {
    const ledger = {
      version: 2,
      scans: [],
      candidates: [],
      bets: [
        makeBet({ id: 'bet-eventdate', eventDate: '2024-08-04T22:00:00Z', scheduledStart: null }),
        makeBet({
          id: 'bet-unknown-date',
          eventDate: 'unknown',
          scheduledStart: null,
          status: 'win',
          oddsAtDecision: -110
        })
      ],
      settlements: []
    };
    const result = review.buildReview(ledger, { mode: 'review', date: '2024-08-04' });
    assert.deepEqual(
      result.bets.map((b) => b.id),
      ['bet-eventdate']
    );
    assert.equal(result.official.total, 1);
    assert.equal(result.excludedUnknownDate, 1);
  });

  it('counts unknown-date bets only in unfiltered reviews', () => {
    const ledger = {
      version: 2,
      scans: [],
      candidates: [],
      bets: [makeBet({ id: 'bet-unknown-date', eventDate: 'unknown', status: 'win', oddsAtDecision: -110 })],
      settlements: []
    };
    const all = review.buildReview(ledger, { mode: 'review' });
    assert.equal(all.official.total, 1);
    assert.equal(all.excludedUnknownDate, 0);
  });

  it('returns an empty official record for a no-data date (exit 0)', () => {
    const result = review.runReviewRecord({
      fs: makeReadOnlyFs(makeAug4Ledger()),
      path: '/tmp/ledger.json',
      date: '2024-01-01'
    });
    assert.equal(result.ok, true);
    assert.equal(result.official.total, 0);
    assert.match(review.formatHuman(result), /No official bets on 2024-01-01\./);
  });
});

describe('review-record P&L', () => {
  it('computes American odds payouts', () => {
    assert.equal(round2(review.americanPnl(90, 1)), 0.9);
    assert.equal(round2(review.americanPnl(-110, 1)), 0.91);
    assert.equal(review.americanPnl(0, 1), null);
    assert.equal(review.americanPnl(null, 1), null);
    assert.equal(review.americanPnl(90, 0), null);
    assert.equal(review.americanPnl(90, -1), null);
  });

  it('grades win/loss/push/void from odds and stake', () => {
    const bet = makeBet();
    assert.equal(round2(review.betPnlUnits(bet, 'win')), 0.9);
    assert.equal(review.betPnlUnits(makeCobolliBet(), 'loss'), -1);
    assert.equal(review.betPnlUnits(bet, 'push'), 0);
    assert.equal(review.betPnlUnits(bet, 'void'), 0);
    assert.equal(review.betPnlUnits(bet, 'pending'), 0);
    assert.equal(review.betPnlUnits(bet, 'retirement'), 0);
    assert.equal(review.betPnlUnits(bet, 'unresolved'), 0);
  });

  it('prefers settlement pnlUnits over odds-derived P&L', () => {
    const bet = makeBet(); // +90 -> 0.9u by odds
    assert.equal(review.betPnlUnits(bet, 'win', { status: 'win', pnlUnits: 1.5 }), 1.5);
    assert.equal(review.betPnlUnits(bet, 'loss', { status: 'loss', pnlUnits: -0.5 }), -0.5);
  });

  it('falls back to recorded plUnits for migrated legacy bets', () => {
    const bet = makeBet({ id: 'bet-legacy', status: 'win', oddsAtDecision: null, plUnits: 0.75 });
    assert.equal(review.betPnlUnits(bet, 'win'), 0.75);
  });
});

describe('review-record pending mode', () => {
  it('lists only unresolved/delayed/retirement bets with settlement evidence', () => {
    const ledger = makeAug4Ledger();
    ledger.bets.push(
      makeBet({ id: 'bet-pending', selection: 'Over 7.5', oddsAtDecision: -110 }),
      makeBet({ id: 'bet-retirement', selection: 'Siniakova ML', oddsAtDecision: -140 })
    );
    ledger.settlements.push({
      id: 'settlement-retirement',
      betId: 'bet-retirement',
      status: 'retirement',
      scheduledStart: '2024-08-04T23:30:00Z',
      actualStart: '2024-08-05T12:00:00Z',
      sourceUrl: ESPN_URL,
      reason: 'tennis retirement; kept as explicit retirement status'
    });
    const result = review.buildReview(ledger, { mode: 'pending', date: '2024-08-04' });
    assert.deepEqual(
      result.bets.map((b) => b.id),
      ['bet-pending', 'bet-retirement']
    );
    assert.equal(result.official.total, 4);
    assert.equal(result.official.pending, 1);
    assert.equal(result.official.retirement, 1);
    assert.equal(result.official.delayed, 1);
    const retirement = result.bets.find((b) => b.id === 'bet-retirement');
    assert.equal(retirement.status, 'retirement');
    assert.equal(retirement.delayed, true);
    assert.equal(retirement.settlement.sourceUrl, ESPN_URL);
    // Settled bets still drive the official P&L; pending/retirement add none.
    assert.equal(round2(result.official.pnl.totalUnits), -0.1);
  });
});

describe('review-record CLI', () => {
  it('exits 2 for an invalid --date', async () => {
    const previous = process.exitCode;
    try {
      const result = await review.main(['node', 'scripts/review-record.js', '--date', '2024-13-01']);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 2);
      assert.equal(process.exitCode, 2);
    } finally {
      process.exitCode = previous;
    }
  });

  it('rejects non-calendar dates like 2024-02-30', () => {
    const result = review.runReviewRecord({ date: '2024-02-30' });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
  });

  it('rejects a missing --date value with exit 2', async () => {
    const previous = process.exitCode;
    try {
      const result = await review.main(['node', 'scripts/review-record.js', '--date']);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 2);
    } finally {
      process.exitCode = previous;
    }
  });

  it('prints JSON when --json is passed', async () => {
    const previousEnv = process.env.PP_RECORD_LEDGER;
    const previousExit = process.exitCode;
    const original = console.log;
    const captured = [];
    const ledger = makeAug4Ledger();
    const temp = writeTempLedger(ledger);
    process.env.PP_RECORD_LEDGER = temp;
    console.log = (...args) => captured.push(args.join(' '));
    try {
      const result = await review.main([
        'node',
        'scripts/review-record.js',
        '--date',
        '2024-08-04',
        '--json',
        '--stats'
      ]);
      assert.equal(result.ok, true);
      const parsed = JSON.parse(captured.join('\n'));
      assert.equal(parsed.mode, 'stats');
      assert.equal(parsed.date, '2024-08-04');
      assert.equal(parsed.official.wins, 1);
      assert.equal(parsed.official.losses, 1);
      assert.deepEqual(parsed.bets, []);
      assert.deepEqual(JSON.parse(fs.readFileSync(temp, 'utf8')), ledger);
    } finally {
      console.log = original;
      process.exitCode = previousExit;
      if (previousEnv === undefined) delete process.env.PP_RECORD_LEDGER;
      else process.env.PP_RECORD_LEDGER = previousEnv;
      fs.rmSync(path.dirname(temp), { recursive: true, force: true });
    }
  });

  it('formats human output with P&L, ROI, candidates, and source URLs', () => {
    const result = review.runReviewRecord({
      fs: makeReadOnlyFs(makeAug4Ledger()),
      path: '/tmp/ledger.json',
      date: '2024-08-04'
    });
    const text = review.formatHuman(result);
    assert.match(text, /Official: 2 bets — 1W \/ 1L \/ 0P \/ 0V/);
    assert.match(text, /P&L: -0\.10u on 2\.00u staked — ROI -5\.0%/);
    assert.match(text, /Candidates: 4 total \(2 promoted, 1 lean, 1 pass, 0 unreviewed, 0 invalid\)/);
    assert.match(text, /lean\/pass never count toward the official record/);
    assert.ok(text.includes(ESPN_URL));
  });
});

describe('review-record safety', () => {
  it('does not write to the ledger even with a write-capable filesystem', () => {
    const ledger = makeAug4Ledger();
    const temp = writeTempLedger(ledger);
    try {
      const before = fs.readFileSync(temp, 'utf8');
      const result = review.runReviewRecord({ path: temp, date: '2024-08-04' });
      assert.equal(result.ok, true);
      assert.equal(fs.readFileSync(temp, 'utf8'), before);
      assert.deepEqual(JSON.parse(fs.readFileSync(temp, 'utf8')), ledger);
    } finally {
      fs.rmSync(path.dirname(temp), { recursive: true, force: true });
    }
  });

  it('contains no network or child-process code', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'review-record.js'), 'utf8');
    assert.doesNotMatch(source, /require\(\s*['"](?:node:)?(?:http|https|net|dns|tls|child_process)['"]\s*\)/);
  });
});

describe('review-record: non-decided settlements never erase a decided bet', () => {
  // Regression: resolveStatus used to return `pending` for a pending settlement,
  // so the 25 pending rows that `settle-record` wrote for unmatched legacy bets
  // hid their real recorded outcomes and the record read 0W/0L.
  it('falls back to the bet own status when the settlement is pending', () => {
    const bet = { id: 'b1', status: 'win', plUnits: 0.77 };
    assert.equal(review.resolveStatus(bet, { betId: 'b1', status: 'pending' }), 'win');
  });

  it('lets a decided settlement override the bet status', () => {
    const bet = { id: 'b1', status: 'pending' };
    assert.equal(review.resolveStatus(bet, { betId: 'b1', status: 'loss' }), 'loss');
  });

  it('reports the legacy record as 13W/12L while the pending rows are present', () => {
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
        market: 'Moneyline',
        selection: `Team ${i}`,
        eventDate: 'unknown'
      });
      settlements.push({
        betId: `b${i}`,
        status: 'pending',
        reasonCode: 'no_event_match',
        settledAt: '2026-09-18T00:23:01.443Z'
      });
    }
    const doc = review.reviewLedger({ version: 2, scans: [], candidates: [], bets, settlements });
    const official = doc.official || doc.summary || doc;
    assert.equal(official.wins, 13);
    assert.equal(official.losses, 12);
    assert.equal(official.settled, 25);
  });
});
