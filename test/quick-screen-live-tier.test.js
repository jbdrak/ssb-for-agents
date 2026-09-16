'use strict';

/**
 * Regression: the scan's validation echo must use the LIVE ranker tier.
 *
 * The ranker stamps two tiers: `confidenceTier` (hysteresis-smoothed) and
 * `confidenceTierLive` (raw, current read). In a multi-pass aggregate scan the
 * smoothed tier can be several levels stale (observed TIER 4 while live was
 * TIER 1). The candidate mapper used to drop the live tier, so validate echoed
 * the stale TIER 4 back for a BET row, and applyFinalVerdict's
 * contradictory-tier clamp (BET + TIER 4 -> TIER 2) shipped real TIER 1 plays
 * as TIER 2, which silently emptied `pp scan -t 1`.
 */

const test = require('node:test');
const assert = require('node:assert');

const { mapCandidateRow } = require('../lib/ssb-mcp-candidate-mapper');
const { buildQuickScreenValidationArgs } = require('../scripts/server/handlers/quick-screen');

const row = {
  gameId: 'MLB:GAME:Baltimore_Orioles:Toronto_Blue_Jays:1789240020',
  game: 'Baltimore Orioles vs Toronto Blue Jays',
  league: 'MLB',
  market: 'Moneyline',
  selection: 'Toronto Blue Jays',
  playId: 'MLB:GAME:Baltimore_Orioles:Toronto_Blue_Jays:1789240020::Moneyline::toronto blue jays',
  odds: -125,
  book: 'Fliff',
  kaiCall: 'BET',
  confidenceTier: 'TIER 4',
  confidenceTierLive: 'TIER 1'
};

test('mapCandidateRow carries the live tier through to the candidate', () => {
  const mapped = mapCandidateRow({ ...row });
  assert.equal(mapped.confidenceTier, 'TIER 4');
  assert.equal(mapped.confidenceTierLive, 'TIER 1', 'live tier must survive mapping');
});

test('mapCandidateRow falls back to the smoothed tier when no live tier exists', () => {
  const mapped = mapCandidateRow({ ...row, confidenceTierLive: undefined });
  assert.equal(mapped.confidenceTierLive, 'TIER 4');
});

test('validation args echo the live tier, not the smoothed tier', () => {
  const candidate = mapCandidateRow({ ...row });
  const args = buildQuickScreenValidationArgs(candidate, { league: 'MLB', market: 'Moneyline' }, { book: 'Fliff' });
  assert.equal(args.screenTier, 'TIER 1');
});
