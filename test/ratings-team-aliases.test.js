'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

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
    // `Southern California` is an NCAAF variant for USC. Seeding NCAAB must not
    // silently reuse the football registry, so it stays null there.
    assert.equal(canonicalTeam('Southern California', 'NCAAF'), 'USC');
    assert.equal(canonicalTeam('Southern California', 'NCAAB'), null);
    assert.equal(canonicalTeam('Texas Christian', 'NCAAF'), 'TCU');
    assert.equal(canonicalTeam('Texas Christian', 'NCAAB'), null);
    assert.equal(canonicalTeam('Louisiana State', 'NCAAF'), 'LSU');
    assert.equal(canonicalTeam('Louisiana State', 'NCAAB'), null);

    // ...and a NCAAB-only program is not resolved under NCAAF.
    assert.equal(canonicalTeam('Bucknell', 'NCAAB'), 'Bucknell');
    assert.equal(canonicalTeam('Bucknell', 'NCAAF'), null);
  });

  it('lifts a covered Massey NCAAB row above unresolved', () => {
    const massey = require('../lib/ratings-sources/massey');
    // Same column layout as a real Massey NCAAB export (the source prints its own
    // names and its `Rat`/`Pwr` cells carry a leading rank). Hand-built, not a
    // Massey dump.
    const raw = [
      'College Basketball : NCAA D1 Using games thru Preseason',
      'Team,Rec,&Delta;,Rat,Pwr,Off,Def,HFA,SoS,SSF,EW,EL',
      'Indiana,0-0 0.000,+1,1 12.10,1 85.00,1 70.00,1 45.00,2.14,1 60.00,1 70.00,8.59,1.41',
      'Ohio St,0-0 0.000,+2,6 10.94,6 80.17,6 68.02,1 45.01,2.29,5 68.11,16 67.14,8.60,1.40',
      'Lindenwood,0-0 0.000,+3,7 10.00,7 79.00,7 67.00,1 44.00,2.20,7 60.00,7 66.00,8.00,2.00'
    ].join('\n');

    const result = massey.normalizeMassey({ raw, league: 'NCAAB', fetchedAt: '2026-09-15T12:00:00.000Z' });
    assert.equal(result.coverage, 'full');
    assert.equal(result.records.length, 3);

    const byTeam = (name) => result.records.find((record) => record.teamA === name);
    for (const name of ['Indiana', 'Ohio State']) {
      const record = byTeam(name);
      assert.ok(record, `${name} must be present`);
      assert.notEqual(record.matchStatus, 'unresolved', `${name} must join a game, not stay unresolved`);
      assert.equal(record.matchStatus, 'unmatched');
      assert.equal(record.coverage, 'full');
      assert.equal(record.unresolvedReason, null);
    }

    // ESPN publishes no team for Lindenwood, so it stays fail-closed rather than
    // being welded onto a guessed key.
    const gap = byTeam('Lindenwood');
    assert.equal(gap.matchStatus, 'unresolved');
    assert.equal(gap.coverage, 'partial');
    assert.match(gap.unresolvedReason, /Lindenwood/);
  });
});
