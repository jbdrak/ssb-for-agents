'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalTeam } = require('../lib/ssb-ratings-team-aliases');

describe('ssb-ratings-team-aliases canonicalTeam', () => {
  it("joins the three sources' spellings of one program to one key", () => {
    const massey = canonicalTeam('Ohio St', 'NCAAF');
    const sagarin = canonicalTeam('Ohio State', 'NCAAF');
    const sasser = canonicalTeam('Ohio State', 'NCAAF');

    assert.ok(massey, 'the Massey spelling must resolve');
    assert.equal(massey, sagarin);
    assert.equal(sagarin, sasser);
    // Canonical spelling follows ESPN's own `location` field, so join keys stay stable.
    assert.equal(massey, 'Ohio State');
  });

  it('ignores case, whitespace and punctuation', () => {
    const base = canonicalTeam('Ohio State', 'NCAAF');
    const variants = ['ohio state', '  OHIO   STATE ', 'Ohio-State', 'Ohio  St.', 'OHIO ST'];

    for (const variant of variants) {
      assert.equal(canonicalTeam(variant, 'NCAAF'), base, `variant ${JSON.stringify(variant)}`);
    }
  });

  it('treats a trailing "St" and "State" as the same program', () => {
    for (const name of ['Michigan', 'Penn', 'Florida', 'Arizona', 'Oklahoma', 'Washington']) {
      assert.equal(
        canonicalTeam(`${name} St`, 'NCAAF'),
        canonicalTeam(`${name} State`, 'NCAAF'),
        `${name} St must equal ${name} State`
      );
    }
  });

  it('returns null for an ambiguous abbreviation instead of guessing', () => {
    // OSU is a real abbreviation for Ohio State, Oklahoma State and Oregon State.
    assert.equal(canonicalTeam('OSU', 'NCAAF'), null);
    assert.equal(canonicalTeam('osu', 'NCAAF'), null);
    assert.equal(canonicalTeam('Ohio St', 'NCAAF'), 'Ohio State');
  });

  it('returns null for an unknown team', () => {
    assert.equal(canonicalTeam('Nowhere Tech', 'NCAAF'), null);
    assert.equal(canonicalTeam('', 'NCAAF'), null);
    assert.equal(canonicalTeam('   ', 'NCAAF'), null);
    assert.equal(canonicalTeam(null, 'NCAAF'), null);
    assert.equal(canonicalTeam(undefined, 'NCAAF'), null);
    assert.equal(canonicalTeam(42, 'NCAAF'), null);
  });

  it('returns null for an unknown or missing league instead of a league-free key', () => {
    assert.equal(canonicalTeam('Ohio State'), null);
    assert.equal(canonicalTeam('Ohio State', ''), null);
    assert.equal(canonicalTeam('Ohio State', 'UFC'), null);
    assert.equal(canonicalTeam('Ohio State', 'NOT_A_LEAGUE'), null);
  });

  it('scopes a team to its own league', () => {
    assert.equal(canonicalTeam('Kansas City Chiefs', 'NFL'), 'Kansas City Chiefs');
    assert.equal(canonicalTeam('Kansas City Chiefs', 'NCAAF'), null);
  });

  it('normalizes diacritics and apostrophes', () => {
    assert.equal(canonicalTeam("Hawai'i", 'NCAAF'), canonicalTeam('Hawaii', 'NCAAF'));
    assert.equal(canonicalTeam('Hawaii', 'NCAAF'), "Hawai'i");
    assert.equal(canonicalTeam('Texas A&M', 'NCAAF'), canonicalTeam('Texas AM', 'NCAAF'));
  });

  it('ignores a leading "The"', () => {
    assert.equal(canonicalTeam('The Citadel', 'NCAAF'), canonicalTeam('Citadel', 'NCAAF'));
  });

  it('resolves a real program in every seeded league', () => {
    assert.equal(canonicalTeam('Kansas City Chiefs', 'NFL'), 'Kansas City Chiefs');
    assert.equal(canonicalTeam('Los Angeles Lakers', 'NBA'), 'Los Angeles Lakers');
    assert.equal(canonicalTeam('Boston Bruins', 'NHL'), 'Boston Bruins');
    assert.equal(canonicalTeam('New York Yankees', 'MLB'), 'New York Yankees');
    assert.equal(canonicalTeam('Los Angeles Sparks', 'WNBA'), 'Los Angeles Sparks');
    assert.equal(canonicalTeam('LA Galaxy', 'MLS'), 'LA Galaxy');
  });

  it('resolves registered abbreviations and leaves unregistered ones alone', () => {
    assert.equal(canonicalTeam('UGA', 'NCAAF'), 'Georgia');
    assert.equal(canonicalTeam('Bama', 'NCAAF'), null, 'an unregistered nickname stays unresolved');
    assert.equal(canonicalTeam('CFB', 'NCAAF'), null, 'a league name is not a team');
  });

  it('resolves every canonical key to itself', () => {
    const pairs = [
      ['Ohio State', 'NCAAF'],
      ['Michigan State', 'NCAAF'],
      ["Hawai'i", 'NCAAF'],
      ['Kansas City Chiefs', 'NFL'],
      ['Los Angeles Lakers', 'NBA'],
      ['New York Yankees', 'MLB'],
      ['Boston Bruins', 'NHL'],
      ['LA Galaxy', 'MLS']
    ];

    for (const [name, league] of pairs) {
      assert.equal(canonicalTeam(name, league), name, `${name} (${league}) must be stable`);
    }
  });

  it('accepts a league alias so adapters can pass the CLI spelling', () => {
    assert.equal(canonicalTeam('Ohio St', 'CFB'), 'Ohio State');
  });

  it('resolves the Massey FBS spellings a complete FBS table prints', () => {
    // The first live Massey NCAAF snapshot left these 54 of 138 rows
    // `unresolved` against a partial registry, so ~39% of the CFB benchmark was
    // unusable. Each pair is [massey print, ESPN `location`], verified against
    // the public teams endpoint. A registry edit that drops a program fails here
    // instead of silently shrinking the benchmark.
    const pairs = [
      ['Mississippi', 'Ole Miss'],
      ['South Florida', 'South Florida'],
      ['James Madison', 'James Madison'],
      ['Northwestern', 'Northwestern'],
      ['North Texas', 'North Texas'],
      ['N Dakota St', 'North Dakota State'],
      ['UT San Antonio', 'UTSA'],
      ['Tulane', 'Tulane'],
      ['New Mexico', 'New Mexico'],
      ['Fresno St', 'Fresno State'],
      ['San Diego St', 'San Diego State'],
      ['W Michigan', 'Western Michigan'],
      ['Colorado St', 'Colorado State'],
      ['Ohio', 'Ohio'],
      ['Old Dominion', 'Old Dominion'],
      ['East Carolina', 'East Carolina'],
      ['Marshall', 'Marshall'],
      ['San Jose St', 'San José State'],
      ['Troy', 'Troy'],
      ['South Alabama', 'South Alabama'],
      ['Louisiana', 'Louisiana'],
      ['Louisiana Tech', 'Louisiana Tech'],
      ['FL Atlantic', 'Florida Atlantic'],
      ['Temple', 'Temple'],
      ['Connecticut', 'UConn'],
      ['Ga Southern', 'Georgia Southern'],
      ['Georgia St', 'Georgia State'],
      ['Texas St', 'Texas State'],
      ['Coastal Car', 'Coastal Carolina'],
      ['Liberty', 'Liberty'],
      ['Arkansas St', 'Arkansas State'],
      ['Florida Intl', 'Florida International'],
      ['Jacksonville St', 'Jacksonville State'],
      ['UAB', 'UAB'],
      ['Wyoming', 'Wyoming'],
      ['Southern Miss', 'Southern Miss'],
      ['Missouri St', 'Missouri State'],
      ['Rice', 'Rice'],
      ['Delaware', 'Delaware'],
      ['C Michigan', 'Central Michigan'],
      ['E Michigan', 'Eastern Michigan'],
      ['New Mexico St', 'New Mexico State'],
      ['MTSU', 'Middle Tennessee'],
      ['UTEP', 'UTEP'],
      ['Ball St', 'Ball State'],
      ['Akron', 'Akron'],
      ['N Illinois', 'Northern Illinois'],
      ['Kennesaw', 'Kennesaw State'],
      ['Buffalo', 'Buffalo'],
      ['Bowling Green', 'Bowling Green'],
      ['Sam Houston St', 'Sam Houston'],
      ['ULM', 'UL Monroe'],
      ['Kent', 'Kent State'],
      ['CS Sacramento', 'Sacramento State']
    ];

    assert.equal(pairs.length, 54, 'the FBS gap was 54 rows; keep the guard complete');
    for (const [printed, canonical] of pairs) {
      assert.equal(canonicalTeam(printed, 'NCAAF'), canonical, `${printed} must resolve`);
    }
    // A genuinely unseeded program still fails closed.
    assert.equal(canonicalTeam('Nowhere Tech', 'NCAAF'), null);
  });
});

describe('ssb-ratings-team-aliases: the NCAAB registry', () => {
  it('resolves a NCAAB program to its ESPN canonical key', () => {
    // Canonical = ESPN's `location` for the college leagues (module header).
    assert.equal(canonicalTeam('Duke', 'NCAAB'), 'Duke');
    assert.equal(canonicalTeam('Gonzaga', 'NCAAB'), 'Gonzaga');
    assert.equal(canonicalTeam('Ohio State', 'NCAAB'), 'Ohio State');
    // `St`/`State` expansion is shared with the football registry.
    assert.equal(canonicalTeam('Iowa St', 'NCAAB'), 'Iowa State');
    assert.equal(canonicalTeam('Michigan St', 'NCAAB'), 'Michigan State');
  });

  it('joins the spellings Massey prints for NCAAB to the same key', () => {
    // Live Massey NCAAB export (2026-09-15) prints its own short forms, so each
    // needs a variant or the rating row never joins to a game. Pairs are
    // [massey print, ESPN `location`].
    const pairs = [
      ['Connecticut', 'UConn'],
      ["St Mary's CA", "Saint Mary's"],
      ['Miami FL', 'Miami'],
      ['Miami OH', 'Miami (OH)'],
      ['Mississippi', 'Ole Miss'],
      ['St Louis', 'Saint Louis'],
      ['IL Chicago', 'UIC'],
      ['Col Charleston', 'Charleston'],
      ['UTRGV', 'UT Rio Grande Valley'],
      ['New Orleans', 'LSU New Orleans'],
      ['Appalachian St', 'App State'],
      ['Cal Baptist', 'California Baptist'],
      ['CS Northridge', 'Cal State Northridge'],
      ['WKU', 'Western Kentucky'],
      ['Kent', 'Kent State'],
      ['San Jose St', 'San José State']
    ];

    for (const [printed, canonical] of pairs) {
      assert.equal(canonicalTeam(printed, 'NCAAB'), canonical, `${printed} must resolve`);
    }
  });

  it('accepts the CLI league spelling so adapters can pass it through', () => {
    assert.equal(canonicalTeam('Duke', 'ncaab'), 'Duke');
  });

  it('leaves a key that maps to two programs ambiguous instead of guessing', () => {
    // The ambiguity rule is derived from the registry, never listed, so it needs a
    // league where a key genuinely collides. `OSU` is registered for three football
    // programs and resolves to none of them. Nothing in NCAAB collides, so the same
    // string is unambiguous there - which is the point: the two registries are
    // separate tables, and a variant added to one never leaks into the other.
    assert.equal(canonicalTeam('OSU', 'NCAAF'), null);
    assert.equal(canonicalTeam('OSU', 'NCAAB'), 'Ohio State');

    // Two programs that share a printed form are still two keys, not one merged
    // guess: the Florida and Ohio Miami schools must not collapse together.
    assert.equal(canonicalTeam('Miami', 'NCAAB'), 'Miami');
    assert.equal(canonicalTeam('Miami (OH)', 'NCAAB'), 'Miami (OH)');
    assert.notEqual(canonicalTeam('Miami FL', 'NCAAB'), canonicalTeam('Miami OH', 'NCAAB'));
  });

  it('returns null for an unknown NCAAB program', () => {
    assert.equal(canonicalTeam('Nowhere Tech', 'NCAAB'), null);
    assert.equal(canonicalTeam('Bama', 'NCAAB'), null, 'an unregistered nickname stays unresolved');
    assert.equal(canonicalTeam('CFB', 'NCAAB'), null, 'a league name is not a team');
    assert.equal(canonicalTeam('', 'NCAAB'), null);
    assert.equal(canonicalTeam(null, 'NCAAB'), null);
  });

  it('does not carry one college league registry into the other', () => {
    // Both college registries now hold `Southern California` for USC, but for
    // two independent reasons: it is a football variant, and Sagarin's NCAAB
    // page prints exactly that spelling for the same school. A spelling printed
    // by one league's source is never the reason another league resolves it.
    assert.equal(canonicalTeam('Southern California', 'NCAAF'), 'USC');
    assert.equal(canonicalTeam('Southern California', 'NCAAB'), 'USC');

    // These stay football-only: nothing in the NCAAB registry knows them, and
    // Sagarin's NCAAB page does not print them either.
    assert.equal(canonicalTeam('Texas Christian', 'NCAAF'), 'TCU');
    assert.equal(canonicalTeam('Texas Christian', 'NCAAB'), null);
    assert.equal(canonicalTeam('Louisiana State', 'NCAAF'), 'LSU');
    assert.equal(canonicalTeam('Louisiana State', 'NCAAB'), null);

    // ...and a NCAAB-only program is not resolved under NCAAF. `Bucknell` is a
    // poor probe now that the football registry carries FCS programs too
    // (Bucknell plays FCS football), so this uses a school with no football
    // program at all.
    assert.equal(canonicalTeam('Gonzaga', 'NCAAB'), 'Gonzaga');
    assert.equal(canonicalTeam('Gonzaga', 'NCAAF'), null);
  });

  it('lifts a covered Massey NCAAB row above unresolved', () => {
    const massey = require('../lib/ratings-sources/massey');
    // Same column layout as a real Massey NCAAB export (the source prints its own
    // names and its `Rat`/`Pwr` cells carry a leading rank). Hand-built, not a
    // Massey dump. The heading is DATED on purpose: this fixture exists to
    // exercise team-alias resolution, and an undated `Using games thru
    // Preseason` export is deliberately `coverage: 'unavailable'` with zero
    // records (the massey source adapter's seasonal path), which would leave
    // nothing here to resolve.
    const raw = [
      'College Basketball : NCAA D1 Using games thru Mon, Dec 15, 2026',
      'Team,Rec,&Delta;,Rat,Pwr,Off,Def,HFA,SoS,SSF,EW,EL',
      'Indiana,0-0 0.000,+1,1 12.10,1 85.00,1 70.00,1 45.00,2.14,1 60.00,1 70.00,8.59,1.41',
      'Ohio St,0-0 0.000,+2,6 10.94,6 80.17,6 68.02,1 45.01,2.29,5 68.11,16 67.14,8.60,1.40',
      'Queens NC,0-0 0.000,+3,7 10.00,7 79.00,7 67.00,1 44.00,2.20,7 60.00,7 66.00,8.00,2.00',
      'Nowhere Tech,0-0 0.000,+4,8 9.00,8 78.00,8 77.00,1 43.00,2.20,8 59.00,8 65.00,7.00,3.00'
    ].join('\n');

    const result = massey.normalizeMassey({ raw, league: 'NCAAB', fetchedAt: '2026-09-15T12:00:00.000Z' });
    assert.equal(result.coverage, 'full');
    assert.equal(result.records.length, 4);
    assert.equal(result.asOf, '2026-12-15');

    const byTeam = (name) => result.records.find((record) => record.teamA === name);
    for (const name of ['Indiana', 'Ohio State', 'Queens University']) {
      const record = byTeam(name);
      assert.ok(record, `${name} must be present`);
      assert.notEqual(record.matchStatus, 'unresolved', `${name} must join a game, not stay unresolved`);
      assert.equal(record.matchStatus, 'unmatched');
      assert.equal(record.coverage, 'full');
      assert.equal(record.unresolvedReason, null);
    }

    // An unseeded program still fails closed rather than being welded onto a
    // guessed key. This row used to be `Lindenwood`, which now resolves, so the
    // negative case needs a name no registry knows.
    const gap = byTeam('Nowhere Tech');
    assert.equal(gap.matchStatus, 'unresolved');
    assert.equal(gap.coverage, 'partial');
    assert.match(gap.unresolvedReason, /Nowhere Tech/);
  });

  it('resolves the four recent D1 additions ESPN basketball does not publish', () => {
    // Live Massey NCAAB table (2026-09-16) prints all four; ESPN's
    // `basketball/mens-college-basketball` roster publishes none, so their keys
    // come from the same ESPN teams family under another sport (module header).
    // The source spellings are the real ones: Massey prints `Queens NC` /
    // `Lindenwood` / `Southern Indiana` / `St Francis PA`, and Sagarin prints
    // `Queens-NC` / `Lindenwood` / `Southern Indiana` / `Saint Francis-Pa.`.
    const pairs = [
      ['Queens NC', 'Queens University'],
      ['Queens-NC', 'Queens University'],
      ['Lindenwood', 'Lindenwood'],
      ['Southern Indiana', 'Southern Indiana'],
      ['St Francis PA', 'Saint Francis'],
      ['Saint Francis-Pa.', 'Saint Francis']
    ];

    for (const [printed, canonical] of pairs) {
      assert.equal(canonicalTeam(printed, 'NCAAB'), canonical, `${printed} must resolve`);
    }

    // Four programs, four keys: none unresolved, none merged into another.
    const keys = pairs.map(([printed]) => canonicalTeam(printed, 'NCAAB'));
    assert.ok(!keys.includes(null), 'every one of the four must resolve to a real key');
    assert.equal(new Set(keys).size, 4, 'the four programs must stay four distinct keys');
  });

  it('keeps two Saint Francis programs from collapsing onto one key', () => {
    // ESPN publishes the PA school as `Saint Francis` and a separate Brooklyn
    // program as `St. Francis (BKN)`. Only the PA-qualified source spellings are
    // registered, so a bare `St Francis` stays unresolved instead of being
    // welded onto whichever program happened to be added first.
    assert.equal(canonicalTeam('Saint Francis', 'NCAAB'), 'Saint Francis');
    assert.equal(canonicalTeam('St Francis PA', 'NCAAB'), 'Saint Francis');
    assert.equal(canonicalTeam('St Francis', 'NCAAB'), null);
    assert.equal(canonicalTeam('St. Francis (BKN)', 'NCAAB'), null);
  });

  it('leaves zero unresolved rows in the live Massey NCAAB table', () => {
    // The captured live NCAAB export (2026-09-16) plus ONLY a re-dated heading.
    // The capture is out of season, which the source adapter gates to
    // `coverage: 'unavailable'` with zero records, and that seasonal gate is
    // unrelated to name identity - so re-dating the heading (the same control
    // `test/ratings-massey-source.test.js` uses for NBA) keeps every real team
    // row and lets alias coverage be asserted against the vendor's own bytes
    // instead of a fixture shaped to the parser.
    const massey = require('../lib/ratings-sources/massey');
    const capture = fs.readFileSync(path.join(__dirname, 'fixtures', 'ratings', 'massey-ncaab-2026-09-16.csv'), 'utf8');
    assert.match(capture.split('\n')[0], /Using games thru Preseason/, 'the capture must be the real undated shape');

    const raw = capture.replace('Using games thru Preseason', 'Using games thru Mon, Dec 15, 2026');
    assert.notEqual(raw, capture);
    const result = massey.normalizeMassey({ raw, league: 'NCAAB', fetchedAt: '2026-09-16T12:00:00.000Z' });

    assert.equal(result.coverage, 'full');
    assert.equal(result.records.length, 365, 'the live D1 table is 365 rows');
    const unresolved = result.records.filter((record) => record.matchStatus === 'unresolved');
    assert.deepEqual(
      unresolved.map((record) => record.teamA),
      [],
      'every live Massey NCAAB row must resolve to a canonical program'
    );

    // And no two rows may have collapsed onto one canonical key.
    const keys = result.records.map((record) => record.teamA);
    assert.equal(new Set(keys).size, keys.length, 'canonical keys must stay one-per-program');
  });
});

// ---------------------------------------------------------------------------
// Sagarin's per-team RATINGS table: the adapter's own bytes decide the pin
// ---------------------------------------------------------------------------
//
// Asserting a hand-written list of ~180 spellings would only prove the list
// matches the registry. These tests instead run the landed adapter over the six
// committed captures and require that essentially every printed team resolves -
// so a spelling that gets dropped, or a vendor layout change that starts
// emitting a new one, fails here without anyone maintaining a list.

describe('ssb-ratings-team-aliases: the Sagarin team-table spellings', () => {
  const sagarinFixture = (league) =>
    fs.readFileSync(
      path.join(__dirname, 'fixtures', 'ratings', `sagarin-${league.toLowerCase()}-2026-09-16.html`),
      'utf8'
    );

  // Only the rows the page's own per-team RATINGS table produced (teamA === teamB
  // is the adapter's documented placeholder for a no-opponent ratings row).
  function teamRows(league) {
    const result = require('../lib/ratings-sources/sagarin').normalizeSagarin({
      raw: sagarinFixture(league),
      league,
      fetchedAt: '2026-09-16T12:00:00.000Z'
    });
    return { result, rows: result.records.filter((record) => record.teamA === record.teamB) };
  }

  function unresolvedNames(league) {
    const { rows } = teamRows(league);
    return rows
      .filter((record) => record.matchStatus === 'unresolved')
      .map((record) => /sagarin team "([^"]*)"/.exec(record.unresolvedReason)[1])
      .sort();
  }

  it('resolves every printed team except the three with no ESPN identity to seed', () => {
    // Measured before this registry change (same fixtures, same adapter):
    // NCAAF 133, NCAAB 43, NFL 1, NBA 1, MLS 6, NHL 0.
    assert.deepEqual(unresolvedNames('NCAAF'), ['UTRGV']);
    assert.deepEqual(unresolvedNames('NCAAB'), ['Hartford', 'St. Francis-NY']);
    assert.deepEqual(unresolvedNames('NFL'), []);
    assert.deepEqual(unresolvedNames('NBA'), []);
    assert.deepEqual(unresolvedNames('NHL'), []);
    assert.deepEqual(unresolvedNames('MLS'), []);

    // Guard the denominators: an empty or truncated parse would satisfy every
    // assertion above for the wrong reason.
    assert.equal(teamRows('NCAAF').rows.length, 266);
    assert.equal(teamRows('NCAAB').rows.length, 363);
    assert.equal(teamRows('NFL').rows.length, 32);
    assert.equal(teamRows('NBA').rows.length, 30);
    assert.equal(teamRows('NHL').rows.length, 32);
    assert.equal(teamRows('MLS').rows.length, 29);
  });

  it('keeps a name with no ESPN identity unresolved instead of inventing a key', () => {
    // Each of these prints on a committed capture with no ESPN-published program
    // to key it to, so unresolved is the contract, not a gap to fill by guessing.
    assert.equal(canonicalTeam('UTRGV', 'NCAAF'), null);
    assert.equal(canonicalTeam('Hartford', 'NCAAB'), null);
    assert.equal(canonicalTeam('St. Francis-NY', 'NCAAB'), null);
    // The positive control: neighbours in the same captures DO resolve, so the
    // three nulls above cannot be passing because the registry is unreachable.
    assert.equal(canonicalTeam('Incarnate Word', 'NCAAF'), 'Incarnate Word');
    assert.equal(canonicalTeam('Quinnipiac', 'NCAAB'), 'Quinnipiac');
  });

  it('pins the hand-mapped spellings the exact-match pass cannot reach', () => {
    // [source print, canonical] - every canonical is an ESPN-published
    // `location` (college) or `displayName` (pro). A renamed program maps to the
    // name ESPN publishes today; a state qualifier maps to the school in that
    // state, not to a second program.
    const pairs = [
      // NCAAF: qualifier names the state.
      ['Miami-Florida', 'NCAAF', 'Miami'],
      ['Miami-Ohio', 'NCAAF', 'Miami (OH)'],
      ['Louisiana-Lafayette', 'NCAAF', 'Louisiana'],
      ['LouisianaMonroe(ULM)', 'NCAAF', 'UL Monroe'],
      ['Fla. International', 'NCAAF', 'Florida International'],
      ['SE Missouri State', 'NCAAF', 'Southeast Missouri State'],
      ['Cal Poly-SLO', 'NCAAF', 'Cal Poly'],
      ['Albany-NY', 'NCAAF', 'UAlbany'],
      ['Tennessee-Martin', 'NCAAF', 'UT Martin'],
      ['Monmouth-NJ', 'NCAAF', 'Monmouth'],
      ['Ark.-Pine Bluff', 'NCAAF', 'Arkansas-Pine Bluff'],
      ['Miss. Valley State', 'NCAAF', 'Mississippi Valley State'],
      ['Central Florida(UCF)', 'NCAAF', 'UCF'],
      ['Army West Point', 'NCAAF', 'Army'],
      ['Grambling State', 'NCAAF', 'Grambling'],
      // NCAAF: the historical LIU Post program is the FCS LIU the board lists.
      ['LIU Post', 'NCAAF', 'Long Island University'],
      // NCAAB: the same seam, one league over.
      ["Saint Mary's-Cal.", 'NCAAB', "Saint Mary's"],
      ['Xavier-Ohio', 'NCAAB', 'Xavier'],
      ['Southern California', 'NCAAB', 'USC'],
      ['VCU(Va. Commonwealth)', 'NCAAB', 'VCU'],
      ['College of Charleston', 'NCAAB', 'Charleston'],
      ['NC Greensboro', 'NCAAB', 'UNC Greensboro'],
      ["Saint Joseph's-Pa.", 'NCAAB', "Saint Joseph's"],
      ['NC Wilmington', 'NCAAB', 'UNC Wilmington'],
      ['NC Asheville', 'NCAAB', 'UNC Asheville'],
      ['Texas A&M-CorpusChristi', 'NCAAB', 'Texas A&M-Corpus Christi'],
      ['Fort Wayne(PFW)', 'NCAAB', 'Purdue Fort Wayne'],
      ['Illinois-Chicago', 'NCAAB', 'UIC'],
      ['American U.', 'NCAAB', 'American University'],
      ['Md.-Eastern Shore(UMES)', 'NCAAB', 'Maryland Eastern Shore'],
      ['Long Island U.(LIU)', 'NCAAB', 'Long Island University'],
      ['Kansas City(UMKC)', 'NCAAB', 'Kansas City'],
      ['Omaha(Neb.-Omaha)', 'NCAAB', 'Omaha'],
      ['NJIT(New Jersey Tech)', 'NCAAB', 'NJIT'],
      ['USC Upstate', 'NCAAB', 'South Carolina Upstate'],
      ['Oakland-Mich.', 'NCAAB', 'Oakland'],
      ['Binghamton-NY', 'NCAAB', 'Binghamton'],
      ['Stony Brook-NY', 'NCAAB', 'Stony Brook'],
      ['Central Connecticut St.', 'NCAAB', 'Central Connecticut'],
      // Renames: the source's former/current name against ESPN's name today.
      ['Texas A&M-Commerce', 'NCAAB', 'East Texas A&M'],
      ['Washington Redskins', 'NFL', 'Washington Commanders'],
      ['Los Angeles Clippers', 'NBA', 'LA Clippers'],
      // Pro-league club names.
      ['Columbus Crew SC', 'MLS', 'Columbus Crew'],
      ['Los Angeles FC', 'MLS', 'LAFC'],
      ['New York Red Bulls', 'MLS', 'Red Bull New York'],
      ['Atlanta United', 'MLS', 'Atlanta United FC'],
      ['Vancouver Whitecaps FC', 'MLS', 'Vancouver Whitecaps'],
      ['St. Louis CITY FC', 'MLS', 'St. Louis CITY SC']
    ];

    for (const [printed, league, canonical] of pairs) {
      assert.equal(canonicalTeam(printed, league), canonical, `${printed} (${league})`);
    }
  });

  it('leaves a spelling that two programs could claim unresolved', () => {
    // The D1/FCS football registry now carries both an `Albany` and the D2
    // `Albany State` family, and both a `LIU` and the separate D2 `Post`
    // program. Only the D1 program may resolve: a spelling that could name two
    // different programs stays null rather than picking one.
    assert.equal(canonicalTeam('Albany', 'NCAAF'), 'UAlbany');
    assert.equal(canonicalTeam('Albany State', 'NCAAF'), null);
    assert.equal(canonicalTeam('LIU Post', 'NCAAF'), 'Long Island University');
    assert.equal(canonicalTeam('Post', 'NCAAF'), null);

    // The Florida and Ohio Miami schools are two keys, never one - the exact
    // seam the Sagarin `-Florida` / `-Ohio` qualifiers sit on.
    assert.notEqual(canonicalTeam('Miami-Florida', 'NCAAF'), canonicalTeam('Miami-Ohio', 'NCAAF'));
    assert.notEqual(canonicalTeam('Miami-Florida', 'NCAAB'), canonicalTeam('Miami-Ohio', 'NCAAB'));
  });
});
