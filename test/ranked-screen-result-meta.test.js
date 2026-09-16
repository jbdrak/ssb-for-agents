'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COMPACT_FIELDS } = require('../lib/ssb-mcp-ranked-screen');
const { buildResultMeta } = require('../lib/ssb-ranked-screen-meta');

describe('buildResultMeta', () => {
  it('builds the ranked-screen metadata without dropping optional fields', () => {
    const freshness = {
      freshnessFallbackUsed: true,
      timestampSources: ['upstream']
    };
    const ranked = {
      coverageGaps: ['NBA:Total'],
      focusBookMissingRows: [{ gameId: 'game-1' }]
    };
    const preHistoryShortlist = { enabled: true, shortlistedRows: 2 };
    const preHistoryRecovery = { enabled: true, recoveredRowCount: 1 };

    const result = buildResultMeta({
      targetBook: 'NoVigApp',
      sharpBooks: ['Pinnacle'],
      lookbackHoursUsed: 6,
      debug: true,
      freshness,
      warnings: ['degraded'],
      compact: false,
      fields: ['market', 'selection'],
      args: { markets: ['Total'] },
      ranked,
      compactFields: COMPACT_FIELDS,
      preHistoryShortlistMeta: preHistoryShortlist,
      preHistoryRecoveryMeta: preHistoryRecovery
    });

    assert.deepEqual(result, {
      focusBook: 'NoVigApp',
      historySportsbooksRequested: ['Pinnacle'],
      lookbackHoursUsed: 6,
      debugEnabled: true,
      freshnessFallbackUsed: true,
      timestampSources: ['upstream'],
      degradedDataWarningCount: 1,
      compact: false,
      fields: ['market', 'selection'],
      markets_queried: ['Total'],
      coverageGaps: ['NBA:Total'],
      focusBookMissingRowCount: 1,
      targetBookCoverage: {
        targetBook: 'NoVigApp',
        sourceRowCount: null,
        rankedRowCount: 0,
        unrankedRowCount: 0,
        boundedSample: false,
        targetBookQuoteCount: 0,
        missingQuoteCount: 1
      },
      droppedAltLineCount: 0,
      preHistoryShortlist,
      preHistoryRecovery
    });
  });

  it('uses compact fields and defaults markets when explicit fields are absent', () => {
    const result = buildResultMeta({
      targetBook: '',
      sharpBooks: [],
      lookbackHoursUsed: 3,
      debug: false,
      freshness: { freshnessFallbackUsed: false, timestampSources: [] },
      warnings: [],
      compact: true,
      fields: null,
      args: {},
      ranked: {},
      compactFields: COMPACT_FIELDS
    });

    assert.equal(result.focusBook, null);
    assert.equal(result.fields, COMPACT_FIELDS);
    assert.deepEqual(result.markets_queried, ['Moneyline']);
    assert.equal(result.coverageGaps.length, 0);
    assert.equal(result.focusBookMissingRowCount, 0);
    assert.equal(result.preHistoryShortlist, undefined);
    assert.equal(result.preHistoryRecovery, undefined);
  });

  it('discloses a capped sample when the feed returns more rows than were ranked', () => {
    const result = buildResultMeta({
      targetBook: 'Fliff',
      sharpBooks: ['Pinnacle'],
      lookbackHoursUsed: 6,
      debug: false,
      freshness: { freshnessFallbackUsed: false, timestampSources: [] },
      warnings: [],
      compact: true,
      fields: null,
      args: { market: 'Total Runs' },
      ranked: [{ targetBookOdds: -120 }, { targetBookOdds: 105 }],
      compactFields: COMPACT_FIELDS,
      sourceRowCount: 168
    });

    assert.equal(result.targetBookCoverage.sourceRowCount, 168);
    assert.equal(result.targetBookCoverage.rankedRowCount, 2);
    assert.equal(result.targetBookCoverage.unrankedRowCount, 166);
    assert.equal(result.targetBookCoverage.boundedSample, true);
  });

  it('does not flag a bounded sample when every source row was ranked', () => {
    const result = buildResultMeta({
      targetBook: 'Fliff',
      sharpBooks: [],
      lookbackHoursUsed: 6,
      debug: false,
      freshness: { freshnessFallbackUsed: false, timestampSources: [] },
      warnings: [],
      compact: true,
      fields: null,
      args: { market: 'Moneyline' },
      ranked: [{ targetBookOdds: -110 }],
      compactFields: COMPACT_FIELDS,
      sourceRowCount: 1
    });

    assert.equal(result.targetBookCoverage.unrankedRowCount, 0);
    assert.equal(result.targetBookCoverage.boundedSample, false);
  });
});
