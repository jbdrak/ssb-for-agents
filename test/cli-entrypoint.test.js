'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');
const { renderScanOutput, formatError, formatValidate, cmdPrices } = require('../bin/pp-cli');

const validateResponse = {
  selection: 'Bonzi',
  verdict: 'BET',
  tier: 'TIER 1',
  play: {
    odds: 106,
    consensusBookCount: 18,
    movementLabel: 'supportive',
    executionQuality: 'playable'
  },
  verdictSummary: { movementDisposition: 'supportive_clean' }
};

it('formats NoVig validation quotes as probabilities', () => {
  assert.match(formatValidate(validateResponse, 'NoVigApp'), /odds: 48\.5%/);
});

it('keeps non-NoVig validation quotes in American odds', () => {
  assert.match(formatValidate(validateResponse, 'Pinnacle'), /odds: \+106/);
});

it('formats existing NoVig percentage quotes without reconverting them', () => {
  const response = { ...validateResponse, play: { ...validateResponse.play, odds: '49.0%' } };
  assert.match(formatValidate(response, 'NoVigApp'), /odds: 49\.0%/);
});

it('shows NoVig probabilities in the today slate', () => {
  const { formatToday } = require('../bin/pp-cli');
  const output = formatToday(
    { slate: [{ startCST: '3:00 PM CT', game: 'Bonzi vs Buse', selection: 'Bonzi', odds: 106, tier: 'TIER 1' }] },
    'NoVigApp'
  );
  assert.match(output, /Bonzi\s+48\.5%\s+TIER 1/);
});

it('keeps American odds in the today slate for another book', () => {
  const { formatToday } = require('../bin/pp-cli');
  const output = formatToday(
    { slate: [{ startCST: '3:00 PM CT', game: 'Bonzi vs Buse', selection: 'Bonzi', odds: 106, tier: 'TIER 1' }] },
    'Pinnacle'
  );
  assert.match(output, /Bonzi\s+\+106\s+TIER 1/);
});

const projectRoot = path.join(__dirname, '..');
const ppPath = path.join(projectRoot, 'bin', 'pp');
const backtestPath = path.join(projectRoot, 'bin', 'backtest');
const queryPath = path.join(projectRoot, 'scripts', 'query-ssb.js');

describe('pp CLI entrypoint', () => {
  it('shows NoVig prices as probabilities in the price-comparison command', async () => {
    const originalLog = console.log;
    const originalError = console.error;
    const stdout = [];
    try {
      console.log = (line = '') => stdout.push(String(line));
      console.error = () => {};
      await cmdPrices(
        {
          find_best_price: async () => ({
            data: {
              allPrices: [
                { book: 'NoVigApp', odds: -110 },
                { book: 'Pinnacle', odds: -105 }
              ],
              bestPrice: { book: 'NoVigApp', odds: -110 }
            }
          })
        },
        ['prices', 'Tennis:GAME:A:B:1788436800::Moneyline::a'],
        {}
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const output = stdout.join('\n');
    assert.match(output, /NoVigApp: 52\.4%/);
    assert.match(output, /Pinnacle: -105/);
    assert.match(output, /Best: NoVigApp @ 52\.4%/);
  });

  it('formats a null error without throwing another error', () => {
    assert.equal(formatError(null, 'pp scan'), 'Error: null');
  });

  it('prints help through the bin/pp wrapper', () => {
    const result = execFileSync(process.execPath, [ppPath, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.match(result, /pp — SSB CLI/);
    assert.match(result, /Usage: pp <command> \[args\.\.\.\]/);
    assert.notEqual(result.trim(), '');
  });

  it('documents all-market rank recovery in rank help', () => {
    const result = execFileSync(process.execPath, [ppPath, 'rank', '--help'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.match(result, /--all-markets/);
  });

  it('prints the package version for --version, not the help banner', () => {
    // Regression: --version fell through the `!positional[0]` branch into printHelp,
    // so it printed the banner and no version at all.
    const result = execFileSync(process.execPath, [ppPath, '--version'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.equal(result.trim(), require('../package.json').version);
    assert.doesNotMatch(result, /Usage:/);
  });

  it('prints help through the published backtest wrapper', () => {
    const result = execFileSync(process.execPath, [backtestPath, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.match(result, /SSB Backtest Runner/);
  });

  for (const flag of ['--help', '-h']) {
    it(`prints query help for ${flag}`, () => {
      const result = execFileSync(process.execPath, [queryPath, flag], {
        cwd: projectRoot,
        encoding: 'utf8'
      });

      assert.match(result, /SSB query CLI/);
    });
  }

  it('warns about incomplete scans and preserves health metadata in JSON', () => {
    const originalLog = console.log;
    const originalError = console.error;
    const stdout = [];
    const stderr = [];
    console.log = (value) => stdout.push(value);
    console.error = (value) => stderr.push(value);
    try {
      const res = {
        results: [{ league: 'MLB', market: 'Moneyline', plays: [] }],
        scanHealth: {
          incomplete: true,
          validationBudgetExhausted: true,
          truncated: true,
          preHistoryShortlist: [{ league: 'MLB', truncated: true }]
        }
      };
      renderScanOutput(res, {
        flags: { json: true },
        leagues: ['MLB'],
        marketList: ['Moneyline'],
        book: 'NoVigApp',
        targetTiers: ['TIER 1'],
        cardWindow: 'all',
        limit: 5
      });
      assert.match(stderr.join('\n'), /incomplete\/truncated/);
      assert.match(stderr.join('\n'), /scan validation budget exhausted/);
      assert.match(stderr.join('\n'), /pp rank MLB/);
      const parsed = JSON.parse(stdout[0]);
      assert.equal(parsed.scanHealth.validationBudgetExhausted, true);
      assert.deepEqual(parsed.results, res.results);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it('preserves zero-result watch candidates in JSON and human diagnostics', () => {
    const originalLog = console.log;
    const originalError = console.error;
    const stdout = [];
    const stderr = [];
    const watchCandidates = [{ gameId: 'watch-1', selection: 'Yankees', official: false }];
    const res = {
      results: [],
      scanHealth: { incomplete: true, validation: { eligible: 1, selected: 0 } },
      watchCandidates
    };
    try {
      console.log = (value) => stdout.push(value);
      console.error = (value) => stderr.push(value);
      renderScanOutput(res, {
        flags: { json: true },
        leagues: ['MLB'],
        marketList: ['Moneyline'],
        book: 'NoVigApp',
        targetTiers: ['TIER 1'],
        cardWindow: 'all',
        limit: 5
      });
      const parsed = JSON.parse(stdout[0]);
      assert.equal(parsed.watchCandidates.length, 1);
      assert.equal(parsed.watchCandidates[0].gameId, 'watch-1');
      assert.equal(parsed.watchCandidates[0].official, false);
      assert.equal(parsed.watchCandidates[0].verdict, 'WATCH');
      assert.equal(parsed.watchCandidates[0].diagnosticOnly, true);

      stdout.length = 0;
      stderr.length = 0;
      renderScanOutput(res, {
        flags: {},
        leagues: ['MLB'],
        marketList: ['Moneyline'],
        book: 'NoVigApp',
        targetTiers: ['TIER 1'],
        cardWindow: 'all',
        limit: 5
      });
      assert.match(stderr.join('\n'), /diagnostic only: 1 watch candidate/i);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
