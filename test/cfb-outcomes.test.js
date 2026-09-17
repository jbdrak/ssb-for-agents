'use strict';

// Coverage for the college-football outcome resolver (lib/cfb-outcomes.js).
//
// This module decides which settled result belongs to which ratings fixture, so
// its failure modes matter more than its happy path: attaching the WRONG night's
// result would be scored as evidence and quietly move a source's calibration.
// Each refusal is asserted, not just the match.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildCfbOutcomeIndex, matchCfbOutcomes, fixtureKey } = require('../lib/cfb-outcomes');

/** Minimal ESPN scoreboard event. ESPN prints the canonicalizable name in `location`. */
function event(name, away, home, { winner = 'home', completed = true } = {}) {
  return {
    name,
    competitions: [
      {
        status: { type: { completed } },
        competitors: [
          { team: { location: away, displayName: `${away} Mascots` }, winner: winner === 'away' },
          { team: { location: home, displayName: `${home} Mascots` }, winner: winner === 'home' }
        ]
      }
    ]
  };
}

function record(teamA, teamB) {
  return { source: 'sagarin', league: 'NCAAF', teamA, teamB };
}

describe('cfb-outcomes: index', () => {
  it('indexes a completed game under the layer own order-independent fixture key', () => {
    const index = buildCfbOutcomeIndex([event('Pittsburgh Panthers at Syracuse Orange', 'Pittsburgh', 'Syracuse')]);
    // Order must not matter: the record may print the pair either way round.
    assert.ok(index.byPair.has(fixtureKey('Pittsburgh', 'Syracuse', 'NCAAF')));
    assert.ok(index.byPair.has(fixtureKey('Syracuse', 'Pittsburgh', 'NCAAF')));
    assert.equal(index.skipped.length, 0);
  });

  it('refuses an unfinished game rather than inventing a winner', () => {
    const index = buildCfbOutcomeIndex([event('A at B', 'Pittsburgh', 'Syracuse', { completed: false })]);
    assert.equal(index.byPair.size, 0);
    assert.equal(index.skipped[0].reason, 'not_completed');
  });

  it('refuses a game with no single winner', () => {
    const index = buildCfbOutcomeIndex([event('A at B', 'Pittsburgh', 'Syracuse', { winner: 'none' })]);
    assert.equal(index.byPair.size, 0);
    assert.equal(index.skipped[0].reason, 'no_single_winner');
  });

  it('refuses a name it cannot resolve instead of approximating it', () => {
    const index = buildCfbOutcomeIndex([event('A at B', 'Nowhere State', 'Syracuse')]);
    assert.equal(index.byPair.size, 0);
    assert.equal(index.skipped[0].reason, 'team_unresolved');
  });

  it('marks a pairing listed twice as ambiguous, not last-one-wins', () => {
    const index = buildCfbOutcomeIndex([
      event('Pittsburgh at Syracuse', 'Pittsburgh', 'Syracuse'),
      event('Pittsburgh at Syracuse', 'Pittsburgh', 'Syracuse', { winner: 'away' })
    ]);
    assert.equal(index.byPair.size, 1, 'the first is stored');
    assert.ok(index.ambiguous.has(fixtureKey('Pittsburgh', 'Syracuse', 'NCAAF')));
    assert.ok(index.skipped.some((entry) => entry.reason === 'duplicate_fixture'));
  });
});

describe('cfb-outcomes: match', () => {
  const index = buildCfbOutcomeIndex([
    event('Pittsburgh Panthers at Syracuse Orange', 'Pittsburgh', 'Syracuse', { winner: 'home' }),
    event('Oregon Ducks at Portland State Vikings', 'Oregon', 'Portland State', { winner: 'away' })
  ]);

  it('reports the winner using the RECORD own label, either way the pair is printed', () => {
    const forward = matchCfbOutcomes([record('Pittsburgh', 'Syracuse')], index);
    assert.deepEqual(forward.outcomes, [{ league: 'NCAAF', game: 'Pittsburgh vs Syracuse', winner: 'Syracuse' }]);

    // Same game, record printed the other way round: the box score did not change,
    // so the winner must still be the side that actually won.
    const reversed = matchCfbOutcomes([record('Syracuse', 'Pittsburgh')], index);
    assert.deepEqual(reversed.outcomes, [{ league: 'NCAAF', game: 'Syracuse vs Pittsburgh', winner: 'Syracuse' }]);
  });

  it('resolves the away winner too', () => {
    const result = matchCfbOutcomes([record('Oregon', 'Portland State')], index);
    assert.equal(result.outcomes[0].winner, 'Oregon');
  });

  it('leaves an unplayed fixture unmatched and counts why', () => {
    const result = matchCfbOutcomes([record('Texas', 'Ohio State')], index);
    assert.equal(result.matched, 0);
    assert.equal(result.unmatched, 1);
    assert.equal(result.reasons.no_settled_result, 1);
  });

  it('refuses an ambiguous pairing and an unresolvable record', () => {
    const ambiguous = buildCfbOutcomeIndex([
      event('A at B', 'Pittsburgh', 'Syracuse'),
      event('A at B', 'Pittsburgh', 'Syracuse')
    ]);
    const refused = matchCfbOutcomes([record('Pittsburgh', 'Syracuse')], ambiguous);
    assert.equal(refused.matched, 0);
    assert.equal(refused.reasons.ambiguous_fixture, 1);

    const unresolved = matchCfbOutcomes([record('Nowhere State', 'Syracuse')], index);
    assert.equal(unresolved.matched, 0);
    assert.equal(unresolved.reasons.record_identity_unresolved, 1);
  });

  it('is empty, not throwing, on empty input', () => {
    assert.deepEqual(matchCfbOutcomes([], index).outcomes, []);
    assert.deepEqual(matchCfbOutcomes([record('Pittsburgh', 'Syracuse')], buildCfbOutcomeIndex([])).outcomes, []);
  });
});
