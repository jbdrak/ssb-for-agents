'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/ssb-mcp-server');

const FANTASY_FIXTURE = [
  { id: 'fp-1', player: 'Luka Doncic', market: 'Points', line: 28.5, odds: -110 },
  { id: 'fp-2', player: 'Shai Gilgeous-Alexander', market: 'Assists', line: 7.5, odds: -105 }
];

function createMockClientForFantasy() {
  return {
    queryBackendFantasyPicks() {
      return Promise.resolve(FANTASY_FIXTURE);
    },
    queryFantasyPicks() {
      throw new Error('UNEXPECTED: queryFantasyPicks (slipgen) called — handler must use queryBackendFantasyPicks');
    }
  };
}

function createHandlers() {
  const client = createMockClientForFantasy();
  const handlers = createMcpHandlers({ client });
  // Stub player_context so it doesn't hit network
  handlers.player_context = async () => ({ riskFlag: 'clean', tweets: [], news: [] });
  return handlers;
}

describe('fantasy_optimizer routing', () => {
  it('calls queryBackendFantasyPicks, not the legacy slipgen queryFantasyPicks', async () => {
    const handlers = createHandlers();
    const result = await handlers.fantasy_optimizer({
      fantasyApps: ['PrizePicks'],
      leagues: ['NBA']
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
    assert.equal(result.result.length, FANTASY_FIXTURE.length);
    assert.equal(result.result[0].player, 'Luka Doncic');
  });

  it('handles empty result from backend', async () => {
    const client = {
      queryBackendFantasyPicks() {
        return Promise.resolve([]);
      },
      queryFantasyPicks() {
        throw new Error('UNEXPECTED');
      }
    };
    const handlers = createMcpHandlers({ client });
    handlers.player_context = async () => ({ riskFlag: 'clean', tweets: [], news: [] });

    const result = await handlers.fantasy_optimizer({ leagues: ['NFL'] });
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.result, []);
  });

  it('unwraps the live { freeTier, threshold, omitted, bets } envelope', async () => {
    const client = {
      queryBackendFantasyPicks() {
        return Promise.resolve({ freeTier: true, threshold: null, omitted: 3, bets: FANTASY_FIXTURE });
      },
      queryFantasyPicks() {
        throw new Error('UNEXPECTED');
      }
    };
    const handlers = createMcpHandlers({ client });
    handlers.player_context = async () => ({ riskFlag: 'clean', tweets: [], news: [] });

    const result = await handlers.fantasy_optimizer({ fantasyApps: ['Betr'], leagues: ['NFL', 'MLB'] });

    assert.equal(result.ok, true);
    assert.equal(result.count, FANTASY_FIXTURE.length);
    assert.equal(result.result.length, FANTASY_FIXTURE.length);
    assert.equal(result.result[0].player, 'Luka Doncic');
  });

  it('reports an empty board when the envelope carries no bets array', async () => {
    const client = {
      queryBackendFantasyPicks() {
        return Promise.resolve({ freeTier: true, threshold: null, omitted: 0 });
      },
      queryFantasyPicks() {
        throw new Error('UNEXPECTED');
      }
    };
    const handlers = createMcpHandlers({ client });
    handlers.player_context = async () => ({ riskFlag: 'clean', tweets: [], news: [] });

    const result = await handlers.fantasy_optimizer({ leagues: ['NFL'] });
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.result, []);
  });
});
