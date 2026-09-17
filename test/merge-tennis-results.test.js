'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  surnameTokens,
  sideFor,
  categoryInfo,
  stripToIso,
  STATUS_OF_STAGE
} = require('../scripts/merge-tennis-results');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'merge-tennis-results.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssb-merge-'));

test('surnameTokens drops a trailing initial and keeps multi-token surnames', () => {
  assert.deepEqual(surnameTokens('Samson L.'), ['SAMSON']);
  assert.deepEqual(surnameTokens('Samson'), ['SAMSON']);
  assert.deepEqual(surnameTokens('De Stefano S.'), ['DE', 'STEFANO']);
  assert.deepEqual(surnameTokens('Campana Lee G.'), ['CAMPANA', 'LEE']);
});

test('sideFor assigns the resolved player to the side whose surname it ends with', () => {
  assert.equal(sideFor('Laura Samson', 'Samson L.', 'Blinkova A.'), 'home');
  assert.equal(sideFor('Laura Samson', 'Blinkova A.', 'Samson L.'), 'away');
  assert.equal(sideFor('Samira De Stefano', 'De Stefano S.', 'Ristic M.'), 'home');
});

test('sideFor refuses to guess when both or neither side matches', () => {
  assert.equal(sideFor('Anna Blinkova', 'Blinkova A.', 'Blinkova A.'), null);
  assert.equal(sideFor('Nobody Here', 'Samson L.', 'Blinkova A.'), null);
});

test('categoryInfo maps Flashscore categories to a tour, and flags doubles', () => {
  assert.deepEqual(categoryInfo('WTA - SINGLES'), { tour: 'WTA', doubles: false });
  assert.deepEqual(categoryInfo('ATP - SINGLES'), { tour: 'ATP', doubles: false });
  assert.deepEqual(categoryInfo('CHALLENGER WOMEN - SINGLES'), { tour: 'WTA', doubles: false });
  assert.deepEqual(categoryInfo('CHALLENGER MEN - DOUBLES'), { tour: 'ATP', doubles: true });
  assert.deepEqual(categoryInfo('ITF WOMEN - DOUBLES'), { tour: 'WTA', doubles: true });
  assert.equal(categoryInfo(''), null);
  assert.equal(categoryInfo('EXHIBITION - SINGLES'), null);
});

test('stripToIso reads the day label and infers the year from the capture', () => {
  assert.equal(stripToIso('17/09 Th', '2026-09-17T10:00:00-05:00'), '2026-09-17');
  assert.equal(stripToIso('10/09', '2026-09-17T10:00:00-05:00'), '2026-09-10');
  // A January capture walking back into December must not read as next year.
  assert.equal(stripToIso('28/12 Mo', '2027-01-02T10:00:00-06:00'), '2026-12-28');
  assert.equal(stripToIso('', '2026-09-17T10:00:00-05:00'), null);
  assert.equal(stripToIso('nonsense', '2026-09-17T10:00:00-05:00'), null);
});

test('STATUS_OF_STAGE maps Flashscore stages onto the importer vocabulary', () => {
  assert.equal(STATUS_OF_STAGE('Finished'), 'completed');
  assert.equal(STATUS_OF_STAGE('Retired'), 'retired');
  assert.equal(STATUS_OF_STAGE('Walkover'), 'walkover');
  assert.equal(STATUS_OF_STAGE('Awarded'), 'completed');
  assert.equal(STATUS_OF_STAGE(''), 'unknown');
});

/** Run the real CLI against temp files. */
function runMerge({ archive, days, extra = [], asOf = null }) {
  const dir = tmp();
  const archivePath = path.join(dir, 'archive.csv');
  const capturePath = path.join(dir, 'capture.json');
  const outPath = path.join(dir, 'out.csv');
  fs.writeFileSync(archivePath, archive);
  fs.writeFileSync(capturePath, JSON.stringify({ scrapedAt: '2026-09-17T10:00:00-05:00', days }));
  const args = [SCRIPT, '--results', capturePath, '--archive', archivePath, '--out', outPath, ...extra];
  if (asOf) args.push('--as-of', asOf);
  const res = spawnSync('node', args, { encoding: 'utf8' });
  const out = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  return { res, out, dir, archivePath, outPath };
}

const ARCHIVE =
  'date,tour,surface,winner,loser,status\n' +
  '2026-05-01,WTA,clay,Laura Samson,Anna Blinkova,completed\n' +
  '2026-05-02,WTA,clay,Samira De Stefano,Mia Ristic,completed\n';

function dayBlock(strip, matches) {
  return { strip, offset: 0, result: { matches } };
}

test('merges a capture, resolving names through the shared resolver', () => {
  const { res, out } = runMerge({
    archive: ARCHIVE,
    days: [
      dayBlock('17/09 Th', [
        {
          stage: 'Finished',
          tournament: 'Ljubljana (Slovenia)',
          category: 'WTA - SINGLES',
          surface: '',
          home: 'Samson L.',
          away: 'Blinkova A.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['blinkova-anna', 'samson-laura']
        }
      ])
    ]
  });
  assert.equal(res.status, 0, res.stderr);
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'date,tour,surface,winner,loser,status');
  assert.match(lines[1], /^2026-09-17,WTA,,Laura Samson,Anna Blinkova,completed$/);
  const stats = JSON.parse(res.stdout);
  assert.equal(stats.rowsOut, 1);
});

test('drops the whole row when either side cannot be resolved', () => {
  const { res, out } = runMerge({
    archive: ARCHIVE,
    days: [
      dayBlock('17/09 Th', [
        {
          stage: 'Finished',
          tournament: 'X',
          category: 'WTA - SINGLES',
          surface: '',
          home: 'Samson L.',
          away: 'Nobody Z.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['nobody-zed', 'samson-laura']
        }
      ])
    ]
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(out.trim().split('\n').length, 1);
  assert.equal(JSON.parse(res.stdout).unresolved, 1);
});

test('skips doubles and unknown categories', () => {
  const { res } = runMerge({
    archive: ARCHIVE,
    days: [
      dayBlock('17/09 Th', [
        {
          stage: 'Finished',
          tournament: 'X',
          category: 'WTA - DOUBLES',
          surface: '',
          home: 'Samson L.',
          away: 'Blinkova A.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['blinkova-anna', 'samson-laura']
        },
        {
          stage: 'Finished',
          tournament: 'X',
          category: 'EXHIBITION - SINGLES',
          surface: '',
          home: 'Samson L.',
          away: 'Blinkova A.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['a-b', 'c-d']
        }
      ])
    ]
  });
  const stats = JSON.parse(res.stdout);
  assert.equal(stats.doublesSkipped, 1);
  assert.equal(stats.unknownCategory, 1);
  assert.equal(stats.rowsOut, 0);
});

test('a repeated day label is treated as a stalled walk, not a second day', () => {
  const match = {
    stage: 'Finished',
    tournament: 'X',
    category: 'WTA - SINGLES',
    surface: '',
    home: 'Samson L.',
    away: 'Blinkova A.',
    homeWinner: true,
    awayWinner: false,
    slugs: ['blinkova-anna', 'samson-laura']
  };
  const { res, out } = runMerge({
    archive: ARCHIVE,
    days: [dayBlock('17/09 Th', [match]), dayBlock('17/09 Th', [match])]
  });
  const stats = JSON.parse(res.stdout);
  assert.equal(stats.stalledDaysSkipped, 1);
  assert.equal(out.trim().split('\n').length, 2, 'one header plus one row');
});

test('duplicates already present in the archive within a day are suppressed', () => {
  // Same pair, archive four days earlier: outside the window, so it is new.
  const far = runMerge({
    archive: ARCHIVE,
    days: [
      dayBlock('17/09 Th', [
        {
          stage: 'Finished',
          tournament: 'X',
          category: 'WTA - SINGLES',
          surface: '',
          home: 'Samson L.',
          away: 'Blinkova A.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['blinkova-anna', 'samson-laura']
        }
      ])
    ]
  });
  assert.equal(JSON.parse(far.res.stdout).rowsOut, 1);

  // Same pair one day off the archive row: the sources disagree on the date, so
  // this must be suppressed rather than counted twice.
  const near = runMerge({
    archive: 'date,tour,surface,winner,loser,status\n2026-09-16,WTA,clay,Laura Samson,Anna Blinkova,completed\n',
    days: [
      dayBlock('17/09 Th', [
        {
          stage: 'Finished',
          tournament: 'X',
          category: 'WTA - SINGLES',
          surface: '',
          home: 'Samson L.',
          away: 'Blinkova A.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['blinkova-anna', 'samson-laura']
        }
      ])
    ]
  });
  const nearStats = JSON.parse(near.res.stdout);
  assert.equal(nearStats.rowsOut, 0);
  assert.equal(nearStats.duplicate, 1);
});

test('an --existing file is deduped against and used to resolve names', () => {
  const dir = tmp();
  const existingPath = path.join(dir, 'existing.csv');
  fs.writeFileSync(
    existingPath,
    'date,tour,surface,winner,loser,status\n2026-09-14,WTA,hard,Tara Wurth,Ana Konjuh,completed\n'
  );
  const { res } = runMerge({
    archive: ARCHIVE,
    extra: ['--existing', existingPath],
    days: [
      // Known only from --existing: suppresses as a duplicate.
      dayBlock('15/09 Tu', [
        {
          stage: 'Finished',
          tournament: 'X',
          category: 'WTA - SINGLES',
          surface: '',
          home: 'Wurth T.',
          away: 'Konjuh A.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['konjuh-ana', 'wurth-tara']
        }
      ]),
      // Known only from --existing: a NEW pair, so it is kept and named from there.
      dayBlock('14/09 Mo', [
        {
          stage: 'Retired',
          tournament: 'X',
          category: 'WTA - SINGLES',
          surface: '',
          home: 'Wurth T.',
          away: 'Konjuh A.',
          homeWinner: false,
          awayWinner: true,
          slugs: ['konjuh-ana', 'wurth-tara']
        }
      ])
    ]
  });
  const stats = JSON.parse(res.stdout);
  assert.equal(stats.duplicate, 1, 'the 15/09 listing is a duplicate of the known pair');
  assert.equal(stats.rowsOut, 1, 'the reversed result on 14/09 is a different pair');
});

test('--as-of drops later rows and a missing surface falls back to the map', () => {
  const dir = tmp();
  const mapPath = path.join(dir, 'map.json');
  fs.writeFileSync(mapPath, JSON.stringify({ ljubljana: 'clay', 'ljubljana|2026-09': 'clay' }));
  const { res, out } = runMerge({
    archive: ARCHIVE,
    extra: ['--surface-map', mapPath],
    asOf: '2026-09-16',
    days: [
      dayBlock('17/09 Th', [
        {
          stage: 'Finished',
          tournament: 'Ljubljana (Slovenia)',
          category: 'WTA - SINGLES',
          surface: '',
          home: 'Samson L.',
          away: 'Blinkova A.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['blinkova-anna', 'samson-laura']
        }
      ])
    ]
  });
  const stats = JSON.parse(res.stdout);
  assert.equal(stats.afterAsOf, 1);
  assert.equal(stats.rowsOut, 0);
  assert.equal(out.trim().split('\n').length, 1);

  const kept = runMerge({
    archive: ARCHIVE,
    extra: ['--surface-map', mapPath],
    asOf: '2026-09-18',
    days: [
      dayBlock('17/09 Th', [
        {
          stage: 'Finished',
          tournament: 'Ljubljana (Slovenia)',
          category: 'WTA - SINGLES',
          surface: '',
          home: 'Samson L.',
          away: 'Blinkova A.',
          homeWinner: true,
          awayWinner: false,
          slugs: ['blinkova-anna', 'samson-laura']
        }
      ])
    ]
  });
  const keptStats = JSON.parse(kept.res.stdout);
  assert.equal(keptStats.rowsOut, 1);
  assert.equal(keptStats.surfaceFromMap, 1);
  assert.match(kept.out.trim().split('\n')[1], /,clay,/);
});
