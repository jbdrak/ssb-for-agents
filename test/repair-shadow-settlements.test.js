'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repair = require('../scripts/repair-shadow-settlements');

const ledgerWith = ({ status, reasonCode, settlementStatus }) => ({
  version: 2,
  scans: [],
  candidates: [],
  bets: [{ id: 'b1', status, plUnits: 0.7, oddsAtDecision: -110, stake: 1 }],
  settlements: [{ betId: 'b1', status: settlementStatus, reasonCode }]
});

describe('repair-shadow-settlements: only removes genuinely shadowing rows', () => {
  it('removes a pending unmatched row over a decided bet', () => {
    const { shadowing, kept } = repair.findShadowingSettlements(
      ledgerWith({ status: 'win', reasonCode: 'no_event_match', settlementStatus: 'pending' })
    );
    assert.equal(shadowing.length, 1);
    assert.equal(kept.length, 0);
  });

  it('KEEPS a pending row for a bet that has no decided outcome', () => {
    // Legitimate bookkeeping: the bet is still open, so the pending row is the
    // only trace of the settle attempt.
    const { shadowing, kept } = repair.findShadowingSettlements(
      ledgerWith({ status: 'pending', reasonCode: 'no_event_match', settlementStatus: 'pending' })
    );
    assert.equal(shadowing.length, 0);
    assert.equal(kept.length, 1);
  });

  it('keeps a DECIDED settlement even on a decided bet', () => {
    const { shadowing, kept } = repair.findShadowingSettlements(
      ledgerWith({ status: 'win', reasonCode: 'no_event_match', settlementStatus: 'loss' })
    );
    assert.equal(shadowing.length, 0);
    assert.equal(kept.length, 1);
  });

  it('keeps a pending row with a different reason code', () => {
    const { shadowing } = repair.findShadowingSettlements(
      ledgerWith({ status: 'win', reasonCode: 'no_scheduled_start', settlementStatus: 'pending' })
    );
    assert.equal(shadowing.length, 0);
  });

  it('keeps a settlement whose bet is missing from the ledger', () => {
    const ledger = {
      version: 2,
      scans: [],
      candidates: [],
      bets: [],
      settlements: [{ betId: 'ghost', status: 'pending', reasonCode: 'no_event_match' }]
    };
    assert.equal(repair.findShadowingSettlements(ledger).shadowing.length, 0);
  });

  it('tolerates a missing settlements array', () => {
    assert.deepEqual(repair.findShadowingSettlements({ version: 2, bets: [] }), { shadowing: [], kept: [] });
  });
});
