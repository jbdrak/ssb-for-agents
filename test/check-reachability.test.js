'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const reach = require('../scripts/check-reachability');

describe('check-reachability: requiresOf picks up every wiring form', () => {
  it('finds plain requires', () => {
    assert.deepEqual(reach.requiresOf("const a = require('./a');"), ['./a']);
  });

  it('finds the PROJECT + form used by the CLI', () => {
    assert.deepEqual(reach.requiresOf("require(PROJECT + '/lib/record-metrics')"), ['/lib/record-metrics']);
  });

  it('finds the __dirname + form', () => {
    assert.deepEqual(reach.requiresOf("require(__dirname + '/x.js')"), ['/x.js']);
  });

  it('finds JSDoc type imports — a types-only module has no require at all', () => {
    // Without this, lib/tool-definitions/types.js (2 lines, no require) looks dead
    // even though tsc resolves it via `import('./types')`.
    assert.deepEqual(reach.requiresOf("/** @returns {import('./types').ToolDefinition[]} */"), ['./types']);
  });

  it('does not mistake a bare package spec for a local file', () => {
    assert.equal(reach.resolveSpec('node:fs', __dirname), null);
    assert.equal(reach.resolveSpec('lodash', __dirname), null);
  });
});

describe('check-reachability: the handler wiring guard actually fires', () => {
  it('reports a symbol no wired module provides', () => {
    const callSites = new Map([['runTennisScreen', new Set(['lib/x.js'])]]);
    const provided = new Set(['quick_screen', 'validate_play']);
    const bad = reach.unprovidedHandlers(callSites, provided);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].symbol, 'runTennisScreen');
    assert.deepEqual(bad[0].calledFrom, ['lib/x.js']);
  });

  it('reports nothing when every call site has a provider', () => {
    const callSites = new Map([['quick_screen', new Set(['lib/x.js'])]]);
    const provided = new Set(['quick_screen']);
    assert.deepEqual(reach.unprovidedHandlers(callSites, provided), []);
  });

  it('sorts output so the report is stable', () => {
    const callSites = new Map([
      ['zeta', new Set(['b.js'])],
      ['alpha', new Set(['a.js'])]
    ]);
    assert.deepEqual(
      reach.unprovidedHandlers(callSites, new Set()).map((r) => r.symbol),
      ['alpha', 'zeta']
    );
  });
});

describe('check-reachability: the live repo is clean', () => {
  it('has no unreachable production file and no unprovided handler call site', () => {
    const result = reach.run();
    assert.deepEqual(result.unreachable, [], `unreachable: ${result.unreachable.join(', ')}`);
    assert.deepEqual(
      result.unprovided,
      [],
      `unprovided handler symbols: ${result.unprovided.map((r) => r.symbol).join(', ')}`
    );
    assert.ok(result.filesScanned > 100, 'should scan the real production tree');
  });
});
