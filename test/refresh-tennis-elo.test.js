'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadSnapshot } = require('../lib/tennis-elo-data');
const tennisElo = require('../lib/ratings-sources/tennis-elo');

const CLI = path.join(__dirname, '..', 'scripts', 'refresh-tennis-elo.js');

const CSV = [
  'date,tour,surface,winner,loser,status',
  '2026-01-01,ATP,hard,Novak Djokovic,Carlos Alcaraz,completed',
  '2026-01-02,ATP,clay,Novak Djokovic,Rafael Nadal,completed',
  '2026-01-03,WTA,hard,Iga Swiatek,Aryna Sabalenka,completed',
  '2026-01-04,ATP,hard,Daniel Evans,Andy Murray,walkover'
].join('\n');

const SOURCE_URL = 'https://example.invalid/tennis_atp.csv';
const PREDICTION_DATE = '2026-01-10';

// --license and --as-of are the two flags whose absence the card requires to be
// refused, so keep their flag+value pairs addressable for removal in tests.
const REQUIRED_ARGS = [
  '--license',
  'CC BY-NC-SA 4.0 (user-verified)',
  '--as-of',
  '2026-01-04',
  '--imported-at',
  '2026-01-05T12:00:00Z',
  '--model-version',
  'tennis-elo@1.1.0',
  '--source-url',
  SOURCE_URL
];

let tmpRoot;

function freshHome(name) {
  return fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
}

function writeCsv(dir, content = CSV, name = 'matches.csv') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function listDir(target) {
  try {
    return fs.readdirSync(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Resolve one ATP hard-court moneyline through the ratings adapter. */
function lookupMatch(snapshotInput) {
  return tennisElo.lookupMatch({
    snapshot: snapshotInput,
    tour: 'atp',
    playerA: 'Novak Djokovic',
    playerB: 'Carlos Alcaraz',
    surface: 'hard',
    market: 'Moneyline',
    asOf: PREDICTION_DATE
  });
}

/** Run the CLI with an isolated HOME + ratings state dir. */
function runCli(args, dir, extraEnv = {}) {
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, PP_RATINGS_DIR: dir, ...extraEnv };
  delete env.PP_TENNIS_ELO_SNAPSHOT;
  delete env.DEBUG;
  delete env.PP_DEBUG;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: dir });
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-tennis-elo-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('refresh-tennis-elo CLI', () => {
  it('prints usage and exits 0 on --help', () => {
    const dir = freshHome('help');
    const result = runCli(['--help'], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--dry-run/);
    // The help text is the contract the provenance gate enforces: a documented
    // happy path must be one the ratings layer accepts.
    assert.match(result.stdout, /Required for the ratings layer/);
    assert.match(result.stdout, /--engine-only/);
  });

  it('refuses a run with no flags at all', () => {
    const dir = freshHome('noreq');
    const result = runCli([], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing required option\(s\)/);
    assert.match(result.stderr, /--license/);
    assert.match(result.stderr, /--as-of/);
    assert.doesNotMatch(result.stderr, /at Object\.|at Module\./);
  });

  it('refuses a run without --license', () => {
    const dir = freshHome('nolicense');
    const input = writeCsv(dir);
    const args = ['--input', input, ...REQUIRED_ARGS];
    const licenseAt = args.indexOf('--license');
    args.splice(licenseAt, 2);
    const result = runCli(args, dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--license/);
    assert.doesNotMatch(result.stderr, /at Object\.|at Module\./);
    assert.deepEqual(
      listDir(dir).filter((f) => f.endsWith('.json')),
      []
    );
  });

  it('refuses a run without --as-of', () => {
    const dir = freshHome('noasof');
    const input = writeCsv(dir);
    const args = ['--input', input, ...REQUIRED_ARGS];
    const asOfAt = args.indexOf('--as-of');
    args.splice(asOfAt, 2);
    const result = runCli(args, dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--as-of/);
    assert.doesNotMatch(result.stderr, /at Object\.|at Module\./);
  });

  it('builds a snapshot and prints a pure JSON summary', () => {
    const dir = freshHome('build');
    const input = writeCsv(dir);
    const output = path.join(dir, 'snapshot.json');
    const result = runCli(['--input', input, ...REQUIRED_ARGS, '--output', output], dir);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.dryRun, false);
    assert.equal(summary.output, output);
    assert.match(summary.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(summary.rows, 4);
    assert.equal(summary.matches, 3);
    assert.equal(summary.players, 5);
    assert.equal(summary.asOf, '2026-01-04');
    assert.equal(summary.modelVersion, 'tennis-elo@1.1.0');
    assert.equal(summary.license, 'CC BY-NC-SA 4.0 (user-verified)');
    const written = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(written.manifest.sourceHash, summary.sourceHash);
  });

  it('writes the default snapshot under PP_RATINGS_DIR when --output is omitted', () => {
    const dir = freshHome('default');
    const input = writeCsv(dir);
    const result = runCli(['--input', input, ...REQUIRED_ARGS], dir);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const expected = path.join(dir, 'tennis-elo-snapshot.json');
    assert.equal(summary.output, expected);
    assert.equal(fs.existsSync(expected), true);
  });

  it('--dry-run validates without writing any file', () => {
    const dir = freshHome('dryoutput');
    const input = writeCsv(dir);
    const output = path.join(dir, 'snapshot.json');
    const result = runCli(['--input', input, ...REQUIRED_ARGS, '--output', output, '--dry-run'], dir);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.dryRun, true);
    assert.equal(fs.existsSync(output), false, 'the requested output is not written');
    assert.deepEqual(
      listDir(dir).filter((f) => f.endsWith('.json')),
      [],
      'dry-run leaves no json behind'
    );
  });

  it('--dry-run without --output leaves the state dir untouched', () => {
    const dir = freshHome('drydefault');
    const input = writeCsv(dir);
    const result = runCli(['--input', input, ...REQUIRED_ARGS, '--dry-run'], dir);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.dryRun, true);
    assert.equal(fs.existsSync(path.join(dir, 'tennis-elo-snapshot.json')), false);
  });

  it('exits 1 on a future-leaking CSV with no stack by default', () => {
    const dir = freshHome('leak');
    const input = writeCsv(
      dir,
      ['date,tour,surface,winner,loser,status', '2026-02-01,ATP,hard,Novak Djokovic,Carlos Alcaraz,completed'].join(
        '\n'
      )
    );
    const result = runCli(['--input', input, ...REQUIRED_ARGS], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /future-leaking row/);
    assert.doesNotMatch(result.stderr, /at Object\.|at Module\./);
  });

  it('exits 1 on a malformed --as-of', () => {
    const dir = freshHome('badasof');
    const input = writeCsv(dir);
    const args = [
      '--input',
      input,
      '--license',
      'CC BY-NC-SA 4.0',
      '--as-of',
      '2026/01/04',
      '--imported-at',
      '2026-01-05T12:00:00Z',
      '--model-version',
      'tennis-elo@1.1.0'
    ];
    const result = runCli(args, dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--as-of must be a YYYY-MM-DD date/);
  });

  it('exits 1 on an unreadable aliases file', () => {
    const dir = freshHome('badaliases');
    const input = writeCsv(dir);
    const aliases = path.join(dir, 'aliases.json');
    fs.writeFileSync(aliases, '{ not json', 'utf8');
    const result = runCli(['--input', input, ...REQUIRED_ARGS, '--aliases', aliases], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not valid JSON/);
  });

  it('exits 1 when the input CSV does not exist', () => {
    const dir = freshHome('noinput');
    const result = runCli(['--input', path.join(dir, 'nope.csv'), ...REQUIRED_ARGS], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Input CSV not found/);
  });

  // The builder and the ratings adapter used to disagree: the CLI documented
  // --source-url as optional while lib/ratings-sources/tennis-elo.js refuses a
  // manifest without it, so a snapshot built exactly as documented could never
  // yield a single rating, and the failure only appeared at scan time. The
  // builder now refuses at BUILD time and names the missing field.
  it('refuses a ratings-intended build without --source-url, naming the field', () => {
    const dir = freshHome('nosourceurl');
    const input = writeCsv(dir);
    const args = ['--input', input, ...REQUIRED_ARGS];
    args.splice(args.indexOf('--source-url'), 2);
    const result = runCli(args, dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--source-url/);
    assert.match(result.stderr, /ratings layer/);
    assert.match(result.stderr, /--engine-only/, 'the refusal names the documented escape hatch');
    assert.doesNotMatch(result.stderr, /at Object\.|at Module\./);
    assert.deepEqual(
      listDir(dir).filter((f) => f.endsWith('.json')),
      [],
      'a refused build writes nothing'
    );
  });

  it('--engine-only builds without --source-url, and the ratings layer still refuses it', () => {
    const dir = freshHome('engineonly');
    const input = writeCsv(dir);
    const output = path.join(dir, 'engine-only.json');
    const args = ['--input', input, ...REQUIRED_ARGS];
    args.splice(args.indexOf('--source-url'), 2);
    args.push('--engine-only', '--output', output);
    const result = runCli(args, dir);
    assert.equal(result.status, 0, result.stderr);

    const summary = JSON.parse(result.stdout);
    assert.equal(summary.sourceUrl, null);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).manifest.sourceUrl, null);

    // The negative case stays refused: an engine-only snapshot genuinely
    // missing provenance is not upgraded at lookup time.
    const loaded = loadSnapshot({ pathOverride: output, asOf: PREDICTION_DATE });
    assert.equal(loaded.available, true);
    const lookup = lookupMatch(loaded);
    assert.equal(lookup.coverage, 'unavailable');
    assert.equal(lookup.reasonKind, 'missing_provenance');
    assert.match(lookup.unresolvedReason, /--source-url/, 'the refusal names how to fix it');
    assert.deepEqual(lookup.records, []);
  });

  // The end-to-end seam this card exists for: build with ONLY the documented
  // flags (real engine, no injection) and consume the result through the
  // ratings adapter.
  it('a documented happy-path build yields coverage: full with real ratings', () => {
    const dir = freshHome('ratingshappy');
    const input = writeCsv(dir);
    const output = path.join(dir, 'snapshot.json');
    const result = runCli(['--input', input, ...REQUIRED_ARGS, '--output', output], dir);
    assert.equal(result.status, 0, result.stderr);

    const loaded = loadSnapshot({ pathOverride: output, asOf: PREDICTION_DATE });
    assert.equal(loaded.available, true, 'the built snapshot loads under the prediction date');

    const lookup = lookupMatch(loaded);
    assert.equal(lookup.coverage, 'full');
    assert.equal(lookup.reasonKind, null);
    assert.equal(lookup.unresolvedReason, null);
    assert.equal(lookup.records.length, 1);
    assert.ok(Number.isFinite(lookup.records[0].ratingA), 'ratingA is a real number');
    assert.ok(Number.isFinite(lookup.records[0].ratingB), 'ratingB is a real number');
    assert.equal(lookup.records[0].sourceUrl, SOURCE_URL);
  });
});
