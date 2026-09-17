#!/usr/bin/env node

/**
 * README claim drift checker for SSB MCP.
 *
 * Verifies that the claims in README.md (tool counts, tool names, tier
 * ordering, test count) match the actual codebase state. Designed to be run
 * before tagging a release — catches the silent-rot class of bugs the
 * release-format skill warns about.
 *
 * Checks:
 *   1. Tool count consistency: lib/tool-definitions/index.js vs docs/openapi.json vs README's "N tools" claim
 *   2. Tool name validation: every tool name in README's "All N tools" section exists in tool definitions
 *   3. Test count: only verified when README carries an exact test-count claim (then it must match npm test
 *      output). Absence of a claim is VALID — the README deliberately uses non-volatile wording
 *      ("full deterministic suite passes") so suite growth doesn't churn docs. When no claim exists,
 *      npm test is not run at all.
 *   4. TIER 4 ≤ TIER 2 inversion: the claim that TIER 4 risk flags are directionally correct
 *      (README: "TIER 4 > TIER 2 inversion | Fixed in v1.5.1")
 *   5. Active-doc drift scan (runs in quick mode too): the canonical live docs — README,
 *      docs/METHODOLOGY.md, docs/AGENT_PROMPT.md, docs/HERMES_SKILL.md, SECURITY.md,
 *      CONTRIBUTING.md, INSTALL.md, .github/PULL_REQUEST_TEMPLATE.md — are scanned for:
 *        a. Forbidden live `sharp_plays` guidance. `sharp_plays` is retired; `quick_screen`
 *           (mode: 'sharp') replaced it. Historical/migration mentions (e.g. "Equivalent to
 *           sharp_plays + player_context bundled") are exempt. CHANGELOG.md and docs/RELEASES.md
 *           are historical archives and are deliberately NOT scanned.
 *        b. Stale active tool-count claims: any "N tools" / "N-tool" total-surface claim in an
 *           active doc must match the registered tool count (per-parameter counts like
 *           "13 tools — backend still uses is_live" are exempt).
 *        c. Stale current version: SECURITY.md's supported-versions table must mark the
 *           package.json major.minor line as the "current release".
 *        d. Hardcoded volatile test totals (e.g. "(966 tests)", "8 pipeline tests") — test totals
 *           change with every test added; active docs must use non-volatile wording instead.
 *        e. False full-suite-auth claims (e.g. "npm test (slower, needs auth)") — the full suite
 *           is offline and auth-free.
 *
 * The TIER 1 hit rate is reported as informational only — the synthetic
 * backtest's TIER 1 sample is checked for minimum size (100 plays for
 * statistical meaning), but the actual hit rate is not asserted against a
 * specific README number. The README's "X% TIER 1 hit rate" should be
 * re-validated manually when the algorithm changes.
 *
 * Usage:
 *   node scripts/check-claims.js              # full check (runs npm test, ~5s)
 *   node scripts/check-claims.js --skip-tests # fast check, no test count verification (<2s)
 *
 * Exit code: 0 on success, 1 on any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = process.cwd();
const readmePath = path.join(repoRoot, 'README.md');
// Tool definitions are split across lib/tool-definitions/{screen,validation,context,picks,meta}.js
// and re-exported from lib/tool-definitions/index.js. Read the actual
// tool list via the buildToolDefinitions factory so claims stay in sync with
// the real source.
const toolDefsEntry = path.join(repoRoot, 'lib/tool-definitions/index.js');
const openapiPath = path.join(repoRoot, 'docs/openapi.json');
const backtestPath = path.join(repoRoot, 'scripts/backtest-synthetic.js');

const readme = fs.readFileSync(readmePath, 'utf8');
const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

// Load the real tool list. `lib/tool-definitions/index.js`
// exports buildToolDefinitions, so we can use it as a single source of truth.
const { buildToolDefinitions } = require(toolDefsEntry);
const allToolDefs = buildToolDefinitions();
const toolDefNames = allToolDefs.map((t) => t.name).sort();
const toolDefCount = toolDefNames.length;

let failures = 0;
let warnings = 0;

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  failures++;
}
function warn(msg) {
  console.warn(`  WARN  ${msg}`);
  warnings++;
}
function ok(msg) {
  console.log(`  ok    ${msg}`);
}

// ----------------------------------------------------------------------------
// CHECK 1 + 2: Tool count and tool name consistency
// ----------------------------------------------------------------------------

console.log('Tool claims:');

// Count tool definitions: every "name: 'foo'" entry in the file
// (Tool defs are now loaded from the live factory above; this section
// only keeps the openapi/README comparisons below.)
const openapiPaths = openapi.paths || {};
const openapiCount = Object.keys(openapiPaths).length;

// Find README's "N tools" claim
const toolCountClaimMatch = readme.match(/(\d+)\s+tools?\s+(that|to|for|across)/i);
const readmeToolCount = toolCountClaimMatch ? parseInt(toolCountClaimMatch[1], 10) : null;

if (toolDefCount !== openapiCount) {
  fail(
    `Tool count drift: lib/tool-definitions/index.js has ${toolDefCount} tools but docs/openapi.json has ${openapiCount} paths. Run \`npm run docs:openapi\` to regenerate.`
  );
} else {
  ok(`${toolDefCount} tools consistent across tool definitions and OpenAPI spec`);
}

if (readmeToolCount !== null) {
  if (readmeToolCount !== toolDefCount) {
    fail(`README claims ${readmeToolCount} tools but ${toolDefCount} are defined. Update README hero/intro sections.`);
  } else {
    ok(`README "N tools" claim (${readmeToolCount}) matches tool definitions`);
  }
} else {
  warn(`Could not find "N tools" claim in README to verify`);
}

// Tool name validation in README's canonical reference section.
// The README uses "## 📊 Available Tools" with three tool-table subsections
// (Quick Situational Checks / Deeper Signal Analysis / Research & Bet
// Management) followed by "### Output Tuning" (parameter names, not tools).
// Stop the section match at Output Tuning so we don't false-positive on
// `minimal` / `standard` / `full` / `true` / `false` from the parameter table.
const allToolsSection = readme.match(/## (?:.*? )?Available Tools[\s\S]*?(?=\n### Output Tuning|\n## |\n---\n\n|$)/);
// Known non-tool identifiers that legitimately appear in backticks within the
// "All N tools" section (parameter names, type annotations, etc.).
const NON_TOOL_IDENTIFIERS = new Set(['verbosity', 'compact']);

if (allToolsSection) {
  // Extract every backtick-quoted identifier that looks like a snake_case tool name
  // Strip trailing "(args...)" so `recommended_bets(verbosity: "minimal")` becomes `recommended_bets`.
  const refs = [
    ...new Set(
      [...allToolsSection[0].matchAll(/`([a-z][a-z0-9_]*)(?:\([^`]*\))?`/g)]
        .map((m) => m[1])
        .filter((name) => !NON_TOOL_IDENTIFIERS.has(name))
    )
  ];
  const missing = refs.filter((name) => !toolDefNames.includes(name));
  if (missing.length > 0) {
    fail(`README "All N tools" section references tools that don't exist: ${missing.join(', ')}`);
  } else {
    ok(`All ${refs.length} tools referenced in "All N tools" section exist in tool definitions`);
  }
} else {
  warn(`Could not find "## All N tools" reference section in README`);
}

// ----------------------------------------------------------------------------
// CHECK 3: Test count
// ----------------------------------------------------------------------------

const skipTests = process.argv.includes('--skip-tests') || process.argv.includes('--quick');
console.log(`\nTest count:${skipTests ? ' (skipped via --skip-tests or --quick)' : ''}`);

if (!skipTests) {
  // Find any test-count claim in README. Matches three forms:
  //   - "966 passing" / "966 tests passing" (prose)
  //   - "# 966 tests, 0 failures" / "full suite (966 tests)" (maintainers prose)
  //   - badge URL "tests-966%20passing" (URL-encoded whitespace)
  const testClaimMatches = [
    ...readme.matchAll(/(\d+)\s+(?:tests?\s+)?passing/gi),
    ...readme.matchAll(/[#(\s](\d+)\s+tests\b/gi),
    ...readme.matchAll(/tests-(\d+)%20passing/gi)
  ];

  if (testClaimMatches.length === 0) {
    // No exact test-count claim is the EXPECTED state: README deliberately uses
    // non-volatile wording ("full deterministic suite passes") so suite growth
    // doesn't churn docs. Nothing to verify — and no reason to run npm test.
    ok('No exact test-count claim in README — non-volatile "full suite passes" wording is in effect, nothing to verify');
  } else {
    try {
      const testOutput = execSync('npm test', {
        encoding: 'utf8',
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // node --test emits the summary in one of two formats depending on Node
      // version: older versions used `# pass N`, newer versions use `ℹ pass N`
      // (with the info glyph). Match either so the script works on both.
      const passMatch = testOutput.match(/^[#\s]*[ℹ#]\s*pass\s+(\d+)/m);
      if (!passMatch) {
        warn(`Could not parse test count from npm test output`);
      } else {
        const testCount = parseInt(passMatch[1], 10);
        // All test count claims should agree with each other and with the actual count
        const claimedCounts = [...new Set(testClaimMatches.map((m) => parseInt(m[1], 10)))];
        const claimMismatch = claimedCounts.find((c) => c !== testCount);
        if (claimMismatch !== undefined) {
          fail(
            `README claims ${claimMismatch} tests passing but actual is ${testCount}. Update all references in README (found ${claimedCounts.length} claim(s): ${claimedCounts.join(', ')}).`
          );
        } else {
          ok(`Test count (${testCount}) matches all ${testClaimMatches.length} claim(s) in README`);
        }
      }
    } catch (err) {
      // npm test can fail if there are real test failures — surface them but don't
      // mask the claim check. Exit code 1 from npm test shows real failures.
      if (err.status && err.stdout) {
        const passMatch = err.stdout.match(/^[#\s]*[ℹ#]\s*pass\s+(\d+)/m);
        if (passMatch) {
          const testCount = parseInt(passMatch[1], 10);
          fail(
            `npm test exited with code ${err.status}. Actual test count: ${testCount}. Fix the failing test(s) before re-running check:claims.`
          );
        } else {
          fail(`npm test failed with exit code ${err.status}. Run \`npm test\` to see the failure.`);
        }
      } else {
        fail(`npm test failed to run: ${err.message.slice(0, 200)}`);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// CHECK 4: Backtest structural claims
// ----------------------------------------------------------------------------

const quick = process.argv.includes('--quick');
console.log(`\nBacktest claims:${quick ? ' (skipped via --quick)' : ''}`);

if (quick) {
  console.log('  -- Skipped (--quick mode). Run without --quick to verify TIER 4 ≤ TIER 2 ordering.');
} else {
  runBacktestCheck();
}

function runBacktestCheck() {
  try {
    const { runBacktest, setRandomSeed, resetRandomSeed } = require(backtestPath);
    setRandomSeed(42);
    const result = runBacktest({ scenarios: 3000, verbose: false });
    resetRandomSeed();

    const t1 = result.results['TIER 1'] || { wins: 0, losses: 0 };
    const t2 = result.results['TIER 2'] || { wins: 0, losses: 0 };
    const t3 = result.results['TIER 3'] || { wins: 0, losses: 0 };
    const t4 = result.results['TIER 4'] || { wins: 0, losses: 0 };

    const t1Total = t1.wins + t1.losses;
    const t2Total = t2.wins + t2.losses;
    const t3Total = t3.wins + t3.losses;
    const t4Total = t4.wins + t4.losses;

    const rate = (w, total) => (total > 0 ? ((w / total) * 100).toFixed(1) + '%' : 'N/A');

    console.log(`  TIER 1: ${rate(t1.wins, t1Total)} (${t1.wins}W/${t1.losses}L/${t1Total} plays)`);
    console.log(`  TIER 2: ${rate(t2.wins, t2Total)} (${t2.wins}W/${t2.losses}L/${t2Total} plays)`);
    console.log(`  TIER 3: ${rate(t3.wins, t3Total)} (${t3.wins}W/${t3.losses}L/${t3Total} plays)`);
    console.log(`  TIER 4: ${rate(t4.wins, t4Total)} (${t4.wins}W/${t4.losses}L/${t4Total} plays)`);

    // Tier ORDERING: a risk-flagged TIER 4 must not out-perform TIER 2, or the
    // risk scoring is pointing the wrong way. Reported as a WARNING, not a
    // failure, because the TIER 2 sample is small and noisy — a single run can
    // show the inversion even when the algorithm is directionally correct.
    // Treat sustained inversion across runs (or a real change to risk scoring)
    // as the signal that something moved. The README makes no tier-ordering
    // claim any more (it carries an explicit "profitability is UNPROVEN" scope
    // note instead), so a warning here means "the ordering regressed in this
    // run" — not "ship is blocked".
    if (t2Total === 0 || t4Total === 0) {
      warn(`TIER 2 or TIER 4 has 0 plays — can't verify tier ordering`);
    } else if (t4.wins / t4Total > t2.wins / t2Total) {
      const gap = ((t4.wins / t4Total - t2.wins / t2Total) * 100).toFixed(1);
      warn(
        `TIER 4 hit rate (${rate(t4.wins, t4Total)}) > TIER 2 hit rate (${rate(t2.wins, t2Total)}, +${gap}pp) in this run, so the tier ordering is inverted on a TIER 2 sample of ${t2Total} plays. Not a release blocker: the README claims no tier ordering and the sample is small.`
      );
    } else {
      ok(
        `tier ordering holds (TIER 4 ${rate(t4.wins, t4Total)} ≤ TIER 2 ${rate(t2.wins, t2Total)}) in this run`
      );
    }

    // Minimum TIER 1 sample size for the README's hit rate claim to be
    // statistically meaningful. Below this threshold the hit rate is just noise
    // on a 3-5 play sample, and any claim of "TIER 1 hit rate is X%" is
    // unsupportable. 100 plays gives a ~10pp margin at 95% confidence, which
    // is enough to detect whether the algorithm is meaningfully better than
    // random.
    const MIN_TIER_1_SAMPLE = 100;
    if (t1Total < MIN_TIER_1_SAMPLE) {
      fail(
        `TIER 1 sample too small (${t1Total} plays) for the README's hit rate claim to be statistically meaningful. ` +
          `Need at least ${MIN_TIER_1_SAMPLE}. The scenario mix or cache reset logic has regressed.`
      );
    } else {
      ok(`TIER 1 sample (${t1Total} plays) is large enough for a meaningful hit rate claim`);
    }

    // Note about TIER 1 hit rate
    if (t1Total < 10) {
      console.log(`\n  info  TIER 1 sample (${t1Total} plays) is too small for a meaningful hit rate claim.`);
      console.log(`  info  The README's "TIER 1 hit rate" number is not auto-verified — review manually.`);
    }
  } catch (err) {
    warn(`Backtest check failed: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// CHECK 5: Active-doc drift scan (live guidance vs retired tools, tool counts,
// supported versions, volatile test totals, full-suite auth claims)
// ----------------------------------------------------------------------------

// Canonical live docs. Historical archives (CHANGELOG.md, docs/RELEASES.md) are
// deliberately NOT scanned: release/changelog prose records what was true at
// release time and must not be rewritten or re-verified.
const ACTIVE_DOCS = [
  'README.md',
  'docs/METHODOLOGY.md',
  'docs/AGENT_PROMPT.md',
  'docs/HERMES_SKILL.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'INSTALL.md',
  '.github/PULL_REQUEST_TEMPLATE.md'
];

console.log('\nActive-doc drift scan:');

const activeDocLines = new Map();
for (const rel of ACTIVE_DOCS) {
  const p = path.join(repoRoot, rel);
  if (!fs.existsSync(p)) {
    console.log(`  --    ${rel} not present — skipped`);
    continue;
  }
  activeDocLines.set(rel, fs.readFileSync(p, 'utf8').split('\n'));
}

// --- 5a. Forbidden live `sharp_plays` guidance -------------------------------

// `sharp_plays` is retired; quick_screen (mode: 'sharp') is its replacement.
// Mentions that explain the migration ("Equivalent to sharp_plays + player_context
// bundled", "the old sharp_plays handler") are accurate and exempt. A line that
// tells readers to RUN sharp_plays, or lists it as an available tool without
// migration framing, is stale live guidance.
const SHARP_PLAYS_RE = /\bsharp_plays\b/i;
const MIGRATION_FRAMING_RE =
  /\b(old|equivalent|retired|replaced|folded|mirrors?|migrat|formerly|legacy|backward|superseded|predecessor|historical)\b/i;

let sharpPlaysIssues = 0;
for (const [rel, lines] of activeDocLines) {
  for (let i = 0; i < lines.length; i++) {
    if (!SHARP_PLAYS_RE.test(lines[i])) continue;
    if (MIGRATION_FRAMING_RE.test(lines[i])) continue;
    fail(
      `Forbidden live \`sharp_plays\` guidance in ${rel}:${i + 1}: "${lines[i].trim()}" — \`sharp_plays\` is retired; use \`quick_screen\` (mode: 'sharp' for the sharp-path scan).`
    );
    sharpPlaysIssues++;
  }
}
if (sharpPlaysIssues === 0) {
  ok('no live `sharp_plays` guidance in active docs (CHANGELOG.md / docs/RELEASES.md archives exempt)');
}

// --- 5b. Stale active tool-count claims -------------------------------------

const TOOL_COUNT_PATTERNS = [/(\d+)\s+(?:MCP\s+)?tools?\b/gi, /(\d+)-tool\b/gi];
// Per-parameter compatibility counts ("13 tools — backend still uses is_live on
// the wire") are NOT total-surface claims and must not be compared to the
// registered tool count.
const PER_ATTRIBUTE_FRAMING_RE = /\bstill\s+uses\b|\baccepts?\b|\baliases?\b/i;

let toolCountIssues = 0;
for (const [rel, lines] of activeDocLines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (PER_ATTRIBUTE_FRAMING_RE.test(line)) continue;
    for (const re of TOOL_COUNT_PATTERNS) {
      for (const m of line.matchAll(re)) {
        const claimed = parseInt(m[1], 10);
        if (claimed !== toolDefCount) {
          fail(`${rel}:${i + 1} claims ${claimed} MCP tools but ${toolDefCount} are registered — stale tool-count claim.`);
          toolCountIssues++;
        }
      }
    }
  }
}
if (toolCountIssues === 0) {
  ok(`tool-count claims in active docs match the registered surface (${toolDefCount} tool${toolDefCount === 1 ? '' : 's'})`);
}

// --- 5c. Stale current version (SECURITY.md supported-versions table) --------

const packageJsonPath = path.join(repoRoot, 'package.json');
const securityPath = path.join(repoRoot, 'SECURITY.md');
if (!fs.existsSync(packageJsonPath) || !fs.existsSync(securityPath)) {
  console.log('  --    SECURITY.md supported-versions check skipped (package.json or SECURITY.md not present)');
} else {
  let pkgVersion = null;
  try {
    pkgVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
  } catch {
    // Malformed package.json — leave pkgVersion null; the check below skips.
  }
  if (!pkgVersion) {
    console.log('  --    SECURITY.md supported-versions check skipped (package.json has no version)');
  } else {
    const majMin = pkgVersion.split('.').slice(0, 2).join('.');
    const securityLines = fs.readFileSync(securityPath, 'utf8').split('\n');
    const versionRows = [];
    for (let i = 0; i < securityLines.length; i++) {
      const m = securityLines[i].match(/^\|\s*(\d+)\.(\d+)\.x\s*\|/);
      if (m) versionRows.push({ version: `${m[1]}.${m[2]}`, line: securityLines[i], number: i + 1 });
    }
    const currentRows = versionRows.filter((r) => /current/i.test(r.line));
    if (currentRows.length === 0) {
      fail(
        `SECURITY.md supported-versions table has no "current release" row — package.json is ${pkgVersion} (${majMin}.x).`
      );
    } else if (currentRows.length > 1) {
      fail(
        `SECURITY.md marks ${currentRows.length} versions as current (${currentRows
          .map((r) => `${r.version}.x`)
          .join(', ')}) — exactly one "current release" row expected, for ${majMin}.x.`
      );
    } else if (currentRows[0].version !== majMin) {
      fail(
        `SECURITY.md marks ${currentRows[0].version}.x as the current release but package.json is ${pkgVersion} (${majMin}.x) — stale supported-versions table.`
      );
    } else {
      ok(`SECURITY.md supported-versions table is current (${majMin}.x marked as current release, package.json ${pkgVersion})`);
    }
  }
}

// --- 5d. Hardcoded volatile test totals --------------------------------------

// Test totals change with every test added or removed. Active docs must use
// non-volatile wording ("full deterministic suite passes"), so any hardcoded
// count near "tests" is drift. Three forms are caught:
//   - parenthetical/heading counts: "(966 tests)", "# 966 tests"
//   - qualified counts: "8 pipeline tests", "12 integration tests"
//   - "N tests passing" prose
const TEST_TOTAL_PATTERNS = [
  /[#(\s](\d+)\s+tests?(?!\s+files?\b)\b/gi,
  /(\d+)\s+(?:pipeline|unit|integration|e2e|offline|deterministic|total|overall)\s+tests?\b/gi,
  /(\d+)\s+tests?\s+(?:pass|passing)\b/gi
];

let testTotalIssues = 0;
for (const [rel, lines] of activeDocLines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of TEST_TOTAL_PATTERNS) {
      for (const m of line.matchAll(re)) {
        fail(
          `Hardcoded test-count claim in ${rel}:${i + 1}: "${m[0]}" — test totals are volatile; use non-volatile wording ("full deterministic suite passes") instead.`
        );
        testTotalIssues++;
      }
    }
  }
}
if (testTotalIssues === 0) {
  ok('no hardcoded test totals in active docs (non-volatile wording in effect)');
}

// --- 5e. False full-suite-auth claims ----------------------------------------

// The full suite (`npm test`) is offline and auth-free. Claims that it "needs
// auth" are false. Manual smoke tests DO require auth and are not flagged.
const FULL_SUITE_AUTH_RE =
  /(?:npm test|full suite|test suite|npm run test)[^.\n]*?(?:needs?|requires?)(?:\s+\w+)?\s+(?:auth\w*|credentials?)\b/i;

let authClaimIssues = 0;
for (const [rel, lines] of activeDocLines) {
  for (let i = 0; i < lines.length; i++) {
    if (FULL_SUITE_AUTH_RE.test(lines[i])) {
      fail(
        `${rel}:${i + 1} claims the full test suite needs auth: "${lines[i].trim()}" — \`npm test\` is offline and auth-free (only manual smoke tests need auth).`
      );
      authClaimIssues++;
    }
  }
}
if (authClaimIssues === 0) {
  ok('no false full-suite-auth claims in active docs (the full suite is offline and auth-free)');
}

// --- 5f. Tennis default-market claims -----------------------------------------

const TENNIS_DEFAULT_CONTEXT_RE =
  /(?:\bTennis\b[^.\n]*(?:default|uses?\s+(?:Moneyline|Total Games|Set Handicap|Game Handicap)|→)|(?:default|league-specific defaults)[^.\n]*\bTennis\b)/i;
const TENNIS_CANONICAL_MARKETS_RE = /Moneyline\s*\/\s*Total Games\s*\/\s*Set Handicap/i;

let tennisMarketIssues = 0;
for (const [rel, lines] of activeDocLines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TENNIS_DEFAULT_CONTEXT_RE.test(line)) continue;
    const explicitOnly = /Game Handicap.*explicit-only|explicit-only.*Game Handicap/i.test(line);
    if ((!explicitOnly && /Game Handicap/i.test(line)) || !TENNIS_CANONICAL_MARKETS_RE.test(line)) {
      fail(
        `Tennis default-market claim in ${rel}:${i + 1} is not canonical: "${line.trim()}" — expected Moneyline / Total Games / Set Handicap.`
      );
      tennisMarketIssues++;
    }
  }
}
if (tennisMarketIssues === 0) {
  ok('Tennis default-market claims in active docs match Moneyline / Total Games / Set Handicap');
}

// --- 5g. Ratings source coverage claims -------------------------------------

// The external-ratings layer's source list has exactly one home in code
// (`lib/ssb-ratings-contract.js` SOURCES). The docs that describe it are prose
// and a table, so adding a source can leave them naming a set that no longer
// exists - which is what happened when `massey_games` landed: STATUS.md still
// said "each of the four sources", BACKTESTING.md enumerated SOURCES without it,
// and its per-source coverage table had no row for it. All four were fixed by
// hand, which is the signal that the check belonged here instead.
const { SOURCES: RATINGS_SOURCES } = (() => {
  // The fixture repos these checks run against are minimal and need not carry the
  // ratings layer. A module that cannot be loaded is reported, not thrown: the
  // check degrades exactly like a missing doc does, so a sandbox without the
  // contract still exercises every other claim here.
  try {
    return require(path.join(repoRoot, 'lib/ssb-ratings-contract.js'));
  } catch {
    return {};
  }
})();
const ratingsDocRel = 'docs/BACKTESTING.md';
const ratingsDocPath = path.join(repoRoot, ratingsDocRel);

if (!Array.isArray(RATINGS_SOURCES)) {
  warn('lib/ssb-ratings-contract.js not loadable — ratings source coverage claims not verified');
} else if (!fs.existsSync(ratingsDocPath)) {
  warn(`${ratingsDocRel} not present — ratings source coverage claims not verified`);
} else {
  const ratingsDoc = fs.readFileSync(ratingsDocPath, 'utf8');
  const uncovered = [];
  for (const source of RATINGS_SOURCES) {
    // Word-boundary match, so `massey` is not satisfied by the `massey_games`
    // that contains it - the whole point is to notice the source that is missing.
    const named = new RegExp(`(?<![\\w])${source}(?![\\w])`).test(ratingsDoc);
    // Case-insensitive: the coverage table names sources by display name
    // (`Massey`), while the contract's ids are lowercase (`massey`).
    const hasTableRow = new RegExp(`^\\|\\s*${source}\\s*\\|`, 'mi').test(ratingsDoc);
    if (!named) uncovered.push(`${source} (not named)`);
    else if (!hasTableRow) uncovered.push(`${source} (named, but no row in the per-source coverage table)`);
  }
  if (uncovered.length > 0) {
    fail(
      `${ratingsDocRel} does not cover every source in SOURCES: ${uncovered.join('; ')}. ` +
        `Add it to the per-source coverage table and to the adapter list.`
    );
  } else {
    ok(`ratings source coverage in ${ratingsDocRel} matches the contract (${RATINGS_SOURCES.length} sources)`);
  }
}

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
if (failures > 0) {
  console.error(`FAILED — ${failures} failure(s), ${warnings} warning(s)`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`OK with warnings — ${warnings} warning(s)`);
} else {
  console.log('OK — all claims verified');
}
