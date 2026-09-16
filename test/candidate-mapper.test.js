'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapCandidateRow, tennisStartNote } = require('../lib/ssb-mcp-candidate-mapper');

describe('mapCandidateRow screenUrl', () => {
  it('builds a screenUrl deep-link when gameId/market/selection present', () => {
    const out = mapCandidateRow({
      gameId: 'WNBA:PREMATCH:Las_Vegas_Aces:Phoenix_Mercury:1783807200',
      market: 'Total Points',
      league: 'WNBA',
      selection: 'Under 166.5',
      start: '2026-07-11T22:00:00.000Z'
    });
    assert.equal(
      out.screenUrl,
      'https://app.propprofessor.com/screen?market=Total%20Points' +
        '&game=WNBA%3APREMATCH%3ALas_Vegas_Aces%3APhoenix_Mercury%3A1783807200' +
        '&league=WNBA&participant=Under%20166.5'
    );
  });

  it('returns null screenUrl when required fields are missing', () => {
    const out = mapCandidateRow({ selection: 'Lakers' });
    assert.equal(out.screenUrl, null);
  });

  it('recomputes movementDisposition via computeMovementDisposition (honors sharpBookMovementConfirmed)', () => {
    const out = mapCandidateRow({
      gameId: 'Tennis:PREMATCH:Rodionov:Tabur:1783937400',
      market: 'Moneyline',
      selection: 'Rodionov',
      movementGrade: 'yellow',
      movementLabel: 'insufficient_history',
      recentSharpMoveDirection: 'insufficient_history',
      fullWindowSharpMoveDirection: 'insufficient_history',
      sharpBookMovementConfirmed: true,
      sharpBookMovementSource: 'Pinnacle',
      confidenceTier: 'TIER 2',
      consensusBookCount: 16
    });
    assert.equal(out.movementDisposition, 'supportive_bouncy');
    assert.equal(out.sharpBookMovementConfirmed, true);
  });

  it('preserves movement provenance for validation parity', () => {
    const out = mapCandidateRow({
      gameId: 'NBA:PREMATCH:A:B:1783937400',
      market: 'Moneyline',
      selection: 'A',
      lineHistoryLookbackHours: 24,
      recentWindowHours: 3,
      movementSourceBook: 'Pinnacle',
      movementMode: 'comparison_book'
    });
    assert.equal(out.lineHistoryLookbackHours, 24);
    assert.equal(out.recentWindowHours, 3);
    assert.equal(out.movementSourceBook, 'Pinnacle');
    assert.equal(out.movementMode, 'comparison_book');
  });

  it('keeps the current quote when movement evidence is aged', () => {
    const out = mapCandidateRow({
      gameId: 'Tennis:PREMATCH:Fery:Duckworth:1783937400',
      market: 'Moneyline',
      selection: 'Fery',
      odds: -144,
      currentOdds: -144,
      targetBookOdds: -144,
      liquidityUsd: 232,
      movementGrade: 'green',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      clvProxyPct: 1.1,
      lastPointAgeMs: 72 * 60 * 1000
    });
    assert.equal(out.odds, -144);
    assert.equal(out.liquidityUsd, 232);
    assert.equal(out.movementDisposition, 'supportive_clean');
    assert.equal(out.movementEvidenceAged, true);
  });
  it('does not trust a stale incoming movementDisposition when the flag is present', () => {
    // Incoming row carries a stale 'insufficient' stamp (pre-tag) — mapper must override it.
    const out = mapCandidateRow({
      gameId: 'Tennis:PREMATCH:Rodionov:Tabur:1783937400',
      market: 'Moneyline',
      selection: 'Rodionov',
      movementDisposition: 'insufficient',
      movementGrade: 'yellow',
      movementLabel: 'insufficient_history',
      recentSharpMoveDirection: 'insufficient_history',
      fullWindowSharpMoveDirection: 'insufficient_history',
      sharpBookMovementConfirmed: true
    });
    assert.equal(out.movementDisposition, 'supportive_bouncy');
  });

  it('recomputed disposition drives staleMovementWarning correctly', () => {
    const out = mapCandidateRow({
      gameId: 'G:1',
      market: 'Moneyline',
      selection: 'X',
      movementDisposition: 'adverse_full', // stale incoming — must be ignored
      movementGrade: 'red',
      movementLabel: 'adverse',
      recentSharpMoveDirection: 'adverse',
      fullWindowSharpMoveDirection: 'adverse',
      sharpBookMovementConfirmed: false,
      confidenceTier: 'TIER 1',
      consensusBookCount: 12
    });
    assert.equal(out.movementDisposition, 'adverse_full');
    assert.equal(out.staleMovementWarning, true);
  });

  it('movementSummary renders consensusEdge as percentage points (no 100x inflation)', () => {
    const out = mapCandidateRow({
      gameId: 'MLB:PREMATCH:TeamA:TeamB:1783937400',
      market: 'Moneyline',
      selection: 'TeamA',
      movementGrade: 'green',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      consensusEdge: 2.5
    });
    assert.equal(out.movementDisposition, 'supportive_clean');
    assert.ok(out.movementSummary.includes('2.5% edge'), `summary was: ${out.movementSummary}`);
    assert.ok(!out.movementSummary.includes('250.0%'), `summary was: ${out.movementSummary}`);
  });

  it('carries steam provenance (steamMove/steamBookCount/steamOriginatorCount) to the candidate', () => {
    const out = mapCandidateRow({
      gameId: 'NBA:PREMATCH:Lakers:Warriors:1783937400',
      market: 'Moneyline',
      selection: 'Lakers',
      movementGrade: 'green',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      consensusEdge: 1.5,
      steamMove: true,
      steamBookCount: 3,
      steamOriginatorCount: 2
    });
    assert.equal(out.steamMove, true);
    assert.equal(out.steamBookCount, 3);
    assert.equal(out.steamOriginatorCount, 2);
  });

  it('defaults steam fields to safe falsy/zero when absent', () => {
    const out = mapCandidateRow({ selection: 'X', gameId: 'G:1', market: 'Moneyline' });
    assert.equal(out.steamMove, false);
    assert.equal(out.steamBookCount, 0);
    assert.equal(out.steamOriginatorCount, 0);
  });

  it('surfaces the confirming originator book name in movementSummary (clean path)', () => {
    const out = mapCandidateRow({
      gameId: 'NBA:PREMATCH:Lakers:Warriors:1783937400',
      market: 'Moneyline',
      selection: 'Lakers',
      movementGrade: 'green',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      consensusEdge: 1.5,
      sharpBookMovementConfirmed: true,
      sharpBookMovementSource: 'Pinnacle'
    });
    assert.equal(out.movementDisposition, 'supportive_clean');
    assert.ok(
      out.movementSummary.includes('sharp-originator confirmation (Pinnacle)'),
      `summary should name originator, got: ${out.movementSummary}`
    );
    assert.equal(out.sharpBookMovementOrigin, 'originator');
  });
});

describe('tennisStartNote', () => {
  const tennis = (extra) => ({ league: 'Tennis', game: 'A vs B', ...extra });
  const SCHEDULED = 'Scheduled start — tennis matches may be delayed';

  it('keeps the plain note when Flashscore corroborated the start', () => {
    assert.equal(tennisStartNote(tennis({ startSource: 'flashscore', startConfidence: 0.95 })), SCHEDULED);
    assert.equal(tennisStartNote(tennis({ startSource: 'flashscore-verified', startConfidence: 0.95 })), SCHEDULED);
  });

  it('flags a web-search estimate as unverified, naming the source and confidence', () => {
    const note = tennisStartNote(tennis({ startSource: 'web_search', startConfidence: 0.6 }));
    assert.match(note, /NOT Flashscore-verified/);
    assert.match(note, /web_search/);
    assert.match(note, /0\.6/);
    assert.notEqual(note, SCHEDULED);
  });

  it('flags raw feed data and an absent source as unverified', () => {
    assert.match(
      tennisStartNote(tennis({ startSource: 'pp-mcp (unverified)', startConfidence: 0.3 })),
      /NOT Flashscore-verified/
    );
    assert.match(tennisStartNote(tennis({})), /NOT corroborated by Flashscore/);
  });

  it('leaves non-tennis rows alone', () => {
    assert.equal(tennisStartNote({ league: 'MLB', startSource: 'web_search' }), null);
  });

  it('flows through mapCandidateRow', () => {
    const out = mapCandidateRow(tennis({ startSource: 'web_search', startConfidence: 0.6 }));
    assert.match(out.startNote, /NOT Flashscore-verified/);
    assert.equal(mapCandidateRow(tennis({ startSource: 'flashscore' })).startNote, SCHEDULED);
  });
});
