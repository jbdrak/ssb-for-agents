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
    assert.equal(canonicalTeam('Ohio State', 'NCAAB'), null);
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
});
