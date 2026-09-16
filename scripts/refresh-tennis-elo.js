#!/usr/bin/env node
'use strict';

/**
 * refresh-tennis-elo.js — manual, local, license-aware Elo snapshot builder.
 *
 * Wraps lib/tennis-elo-data.js importMatchData() so a user can turn a
 * user-supplied match CSV into a versioned JSON snapshot. No downloader, no
 * bundled third-party data, no network access, no clock reads: every manifest
 * timestamp (--as-of, --imported-at) is supplied explicitly by the caller.
 * The server never refreshes at startup — this command is manual-only.
 *
 * The snapshot lands in the local state dir (`PP_RATINGS_DIR`, default
 * `~/.ssb-for-agents/`), never the repo. `--dry-run` parses, builds, and
 * validates via `importMatchData({ write: false })` and writes nothing at all.
 *
 * Usage:
 *   node scripts/refresh-tennis-elo.js --input <csv> --license <text> \
 *       --as-of <ISO> --imported-at <ISO> --model-version <version> \
 *       --source-url <url> [--output <json>] [--aliases <json file>] \
 *       [--dry-run]
 *
 * `--source-url` is required for any snapshot the ratings layer
 * (lib/ratings-sources/tennis-elo.js) will consume: that adapter refuses a
 * manifest without provenance, so a snapshot built without it can never yield a
 * single rating. `--engine-only` deliberately builds a snapshot for the pure
 * Elo engine that the ratings layer refuses.
 *
 * Exit codes:
 *   0  success (help, or snapshot built / dry-run validated; also when a
 *      downstream consumer closes stdout mid-write, e.g. `--help | head`)
 *   1  usage, input, or build error (message on stderr, no stack by default)
 *
 * Schema / license notes: lib/tennis-elo-data/README.md
 */

const fs = require('node:fs');

const { importMatchData, defaultSnapshotPath } = require('../lib/tennis-elo-data');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

const USAGE = `Usage:
  node scripts/refresh-tennis-elo.js --input <csv> --license <text>
      --as-of <ISO> --imported-at <ISO> --model-version <version>
      --source-url <url> [options]

Build a versioned, license-aware tennis-elo snapshot from a user-supplied CSV.
No network, no downloads, no bundled data — manual refresh only.

Required:
  --input <csv>          Path to the match CSV (see lib/tennis-elo-data/README.md
                         for the exact schema).
  --license <text>       License of the source data, e.g. "CC BY-NC-SA 4.0
                         (user-verified)". Recorded verbatim in the manifest.
  --as-of <ISO>          Data cutoff date, YYYY-MM-DD. Rows dated after this
                         are rejected as future-leaking.
  --imported-at <ISO>    Import timestamp, ISO 8601, e.g. 2026-08-14T12:00:00Z.
  --model-version <ver>  Model version string, e.g. tennis-elo@1.1.0.

Required for the ratings layer:
  --source-url <url>     Source URL, recorded in the manifest. Required unless
                         --engine-only is given: the ratings adapter
                         (lib/ratings-sources/tennis-elo.js) refuses a manifest
                         without provenance, so a snapshot built without it can
                         never yield a single rating.

Options:
  --output <json>        Snapshot output path. Default: $PP_TENNIS_ELO_SNAPSHOT
                         or $PP_RATINGS_DIR/tennis-elo-snapshot.json
                         or ~/.ssb-for-agents/tennis-elo-snapshot.json.
  --engine-only          Build a snapshot for the pure Elo engine only. Skips the
                         --source-url requirement and produces a snapshot the
                         ratings layer refuses (reasonKind: missing_provenance).
  --aliases <json file>  Optional JSON file of explicit aliases, e.g.
                         { "ATP": { "Nole": "Novak Djokovic" } }.
  --dry-run              Parse, build, and validate, then print a manifest
                         summary WITHOUT writing anything.
  --help                 Show this help and exit.

Examples (replace every placeholder — these are commands, not shipped data):
  node scripts/refresh-tennis-elo.js \\
    --input ~/data/tennis-matches.csv \\
    --license "CC BY-NC-SA 4.0 (user-verified)" \\
    --source-url https://example.invalid/tennis_atp.csv \\
    --as-of 2026-08-13 --imported-at 2026-08-14T12:00:00Z \\
    --model-version tennis-elo@1.1.0

  node scripts/refresh-tennis-elo.js \\
    --input ~/data/tennis-matches.csv \\
    --license "CC BY-NC-SA 4.0 (user-verified)" \\
    --source-url https://example.invalid/tennis_atp.csv \\
    --as-of 2026-08-13 --imported-at 2026-08-14T12:00:00Z \\
    --model-version tennis-elo@1.1.0 --dry-run

  # Engine-only, no ratings-layer provenance (the ratings layer will refuse it):
  node scripts/refresh-tennis-elo.js \\
    --input ~/data/tennis-matches.csv \\
    --license "CC BY-NC-SA 4.0 (user-verified)" --engine-only \\
    --as-of 2026-08-13 --imported-at 2026-08-14T12:00:00Z \\
    --model-version tennis-elo@1.1.0

On success a JSON summary is printed to stdout with output, sourceHash, rows,
matches, players, asOf, and modelVersion.
`;

class CliError extends Error {}

const FLAG_NAMES = {
  '--input': 'input',
  '--output': 'output',
  '--license': 'license',
  '--as-of': 'asOf',
  '--imported-at': 'importedAt',
  '--model-version': 'modelVersion',
  '--source-url': 'sourceUrl',
  '--aliases': 'aliases',
  '--dry-run': 'dryRun',
  '--engine-only': 'engineOnly',
  '--help': 'help'
};
const VALUE_FLAGS = new Set([
  'input',
  'output',
  'license',
  'asOf',
  'importedAt',
  'modelVersion',
  'sourceUrl',
  'aliases'
]);
const REQUIRED = [
  ['input', '--input <csv> (path to the match CSV)'],
  ['license', '--license <text> (source-data license, e.g. "CC BY-NC-SA 4.0")'],
  ['asOf', '--as-of <ISO> (data cutoff date, YYYY-MM-DD)'],
  ['importedAt', '--imported-at <ISO> (ISO 8601 import timestamp)'],
  ['modelVersion', '--model-version <version> (e.g. tennis-elo@1.1.0)']
];

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--') || token === '--') {
      throw new CliError(`Unexpected argument "${token}". Run with --help for usage.`);
    }
    const eq = token.indexOf('=');
    const name = eq > 2 ? token.slice(0, eq) : token;
    const key = FLAG_NAMES[name];
    if (!key) {
      throw new CliError(`Unknown option "${name}". Run with --help for usage.`);
    }
    let value = eq > 2 ? token.slice(eq + 1) : undefined;
    if (VALUE_FLAGS.has(key)) {
      if (value === undefined) {
        i += 1;
        if (i >= argv.length) {
          throw new CliError(`Option ${name} requires a value.`);
        }
        value = argv[i];
      }
      options[key] = value;
    } else if (value !== undefined) {
      throw new CliError(`Option ${name} does not take a value.`);
    } else {
      options[key] = true;
    }
  }
  return options;
}

function missingRequired(options) {
  return REQUIRED.filter(([key]) => {
    const value = options[key];
    return typeof value !== 'string' || value.trim() === '';
  }).map(([, flag]) => flag);
}

function validateValues(options) {
  const problems = [];
  if (!DATE_RE.test(options.asOf)) {
    problems.push(`--as-of must be a YYYY-MM-DD date, got "${options.asOf}".`);
  }
  if (!ISO_TIMESTAMP_RE.test(options.importedAt)) {
    problems.push(
      `--imported-at must be an ISO 8601 timestamp (e.g. 2026-08-14T12:00:00Z), got "${options.importedAt}".`
    );
  }
  return problems;
}

function readAliases(aliasesPath) {
  let raw;
  try {
    raw = fs.readFileSync(aliasesPath, 'utf8');
  } catch (err) {
    throw new CliError(`Cannot read aliases file "${aliasesPath}": ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`Aliases file "${aliasesPath}" is not valid JSON: ${err.message}`);
  }
}

function printSummary(snapshot, dryRun, outputPath) {
  const manifest = snapshot.manifest;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        dryRun,
        output: outputPath,
        sourceHash: manifest.sourceHash,
        rows: manifest.rowCount,
        matches: manifest.matchCount,
        players: manifest.playerCount,
        asOf: manifest.asOf,
        importedAt: manifest.importedAt,
        modelVersion: manifest.modelVersion,
        license: manifest.license,
        sourceUrl: manifest.sourceUrl
      },
      null,
      2
    )}\n`
  );
}

function fail(err) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`refresh-tennis-elo: ${message}\n`);
  if (process.env.DEBUG || process.env.PP_DEBUG) {
    process.stderr.write(`${err && err.stack ? err.stack : ''}\n`);
  }
  process.exitCode = 1;
}

// A downstream consumer (e.g. `--help | head`) can close stdout before the
// CLI finishes writing. That is not a CLI failure: behave like a native tool
// stopped by SIGPIPE and exit quietly with 0 instead of crashing with an
// unhandled EPIPE stack trace. Any other stdout error is a real I/O failure
// and must still surface, so only EPIPE is special-cased.
function installStdoutEpipeGuard() {
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err);
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const missing = missingRequired(options);
  if (missing.length > 0) {
    fail(new CliError(`Missing required option(s): ${missing.join(', ')}. Run with --help for usage.`));
    return;
  }
  const problems = validateValues(options);
  if (problems.length > 0) {
    fail(new CliError(problems.join(' ')));
    return;
  }
  // Provenance gate. The ratings layer (lib/ratings-sources/tennis-elo.js)
  // refuses a snapshot whose manifest has no sourceUrl, so a snapshot built
  // without one can never yield a rating. Refuse at BUILD time and name the
  // missing field, instead of leaving the gap to surface later as an
  // `unavailable` row at scan time. `--engine-only` is the documented way to
  // build for the pure Elo path and deliberately accepts the ratings refusal.
  if (!options.engineOnly && (typeof options.sourceUrl !== 'string' || options.sourceUrl.trim() === '')) {
    fail(
      new CliError(
        '--source-url <url> is required for a snapshot the ratings layer can use: ' +
          'lib/ratings-sources/tennis-elo.js refuses a manifest without provenance ' +
          '(missing_provenance), so a snapshot built without it can never yield a rating. ' +
          'Pass --source-url <url>, or --engine-only to build an engine-only snapshot. ' +
          'Run with --help for usage.'
      )
    );
    return;
  }
  if (!fs.existsSync(options.input) || !fs.statSync(options.input).isFile()) {
    fail(new CliError(`Input CSV not found: ${options.input}`));
    return;
  }
  const aliases = options.aliases === undefined ? undefined : readAliases(options.aliases);
  const dryRun = Boolean(options.dryRun);
  const outputPath = options.output === undefined ? defaultSnapshotPath() : options.output;

  try {
    // write: false is a true dry-run — importMatchData parses, builds, and
    // validates without touching the filesystem, so --dry-run never creates a
    // file (not even a temporary one).
    const snapshot = importMatchData({
      inputPath: options.input,
      outputPath,
      license: options.license,
      asOf: options.asOf,
      importedAt: options.importedAt,
      modelVersion: options.modelVersion,
      sourceUrl: options.sourceUrl,
      aliases,
      write: !dryRun
    });
    printSummary(snapshot, dryRun, outputPath);
  } catch (err) {
    fail(err);
  }
}

installStdoutEpipeGuard();
main();
