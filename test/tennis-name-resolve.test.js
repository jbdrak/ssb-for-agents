'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildNameMap,
  buildSurnameIndex,
  resolveName,
  resolveSlug,
  slugRotations
} = require('../lib/tennis-name-resolve');

const ROWS = [
  { tour: 'WTA', winner: 'Laura Samson', loser: 'Anna Blinkova' },
  { tour: 'WTA', winner: 'Samira De Stefano', loser: 'Mia Ristic' },
  { tour: 'WTA', winner: 'Mia Ristic', loser: 'Jelena Ristic' },
  { tour: 'ATP', winner: 'Gerard Campana Lee', loser: 'Alex Marti Pujolras' }
];

const map = buildNameMap(ROWS);
const idx = { ATP: buildSurnameIndex(map.ATP), WTA: buildSurnameIndex(map.WTA) };

test('buildNameMap keys by normalized name and keeps the archive display spelling', () => {
  assert.equal(map.WTA['LAURA SAMSON'], 'Laura Samson');
  assert.equal(map.WTA['SAMIRA DE STEFANO'], 'Samira De Stefano');
  assert.equal(map.ATP['GERARD CAMPANA LEE'], 'Gerard Campana Lee');
});

test('buildNameMap isolates tours: the same name in both tours stays two people', () => {
  const both = buildNameMap([
    { tour: 'WTA', winner: 'Alex Doe', loser: 'Ana Roe' },
    { tour: 'ATP', winner: 'Alex Doe', loser: 'Ben Poe' }
  ]);
  assert.equal(both.WTA['ALEX DOE'], 'Alex Doe');
  assert.equal(both.ATP['ALEX DOE'], 'Alex Doe');
  assert.notEqual(both.WTA, both.ATP);
});

test('resolveName matches a full name exactly', () => {
  assert.equal(resolveName('Laura Samson', map.WTA, idx.WTA), 'Laura Samson');
  assert.equal(resolveName('laura samson', map.WTA, idx.WTA), 'Laura Samson');
});

test('resolveName matches surname plus initial when exactly one player fits', () => {
  assert.equal(resolveName('Samson L.', map.WTA, idx.WTA), 'Laura Samson');
  assert.equal(resolveName('Blinkova A', map.WTA, idx.WTA), 'Anna Blinkova');
});

test('resolveName refuses an ambiguous surname plus initial', () => {
  // Mia and Jelena both start with J... but Mia vs Jelena share only the surname.
  assert.equal(resolveName('Ristic M.', map.WTA, idx.WTA), 'Mia Ristic');
  assert.equal(resolveName('Ristic J.', map.WTA, idx.WTA), 'Jelena Ristic');
  // Two M-Ristics would be ambiguous: build that case explicitly.
  const two = buildNameMap([
    { tour: 'WTA', winner: 'Mia Ristic', loser: 'Ana Roe' },
    { tour: 'WTA', winner: 'Mila Ristic', loser: 'Ana Roe' }
  ]);
  const twoIdx = buildSurnameIndex(two.WTA);
  assert.equal(resolveName('Ristic M.', two.WTA, twoIdx), null);
});

test('resolveName returns null for an unknown player and for junk', () => {
  assert.equal(resolveName('Nobody Here', map.WTA, idx.WTA), null);
  assert.equal(resolveName('', map.WTA, idx.WTA), null);
  assert.equal(resolveName(null, map.WTA, idx.WTA), null);
});

test('resolveName never substring-matches a longer surname', () => {
  const m = buildNameMap([{ tour: 'WTA', winner: 'Mia Risticton', loser: 'Ana Roe' }]);
  const i = buildSurnameIndex(m.WTA);
  assert.equal(resolveName('Ristic M.', m.WTA, i), null);
});

test('slugRotations covers surname-first and forename-first slugs', () => {
  assert.deepEqual(slugRotations('blinkova-anna'), ['blinkova anna', 'anna blinkova']);
  assert.deepEqual(slugRotations('samira-de-stefano'), ['samira de stefano', 'de stefano samira', 'stefano samira de']);
  assert.deepEqual(slugRotations('single'), []);
});

test('resolveSlug pins the forename-order variants to one archive player', () => {
  assert.equal(resolveSlug('blinkova-anna', map.WTA), 'Anna Blinkova');
  assert.equal(resolveSlug('samira-de-stefano', map.WTA), 'Samira De Stefano');
  assert.equal(resolveSlug('gerard-campana-lee', map.ATP), 'Gerard Campana Lee');
});

test('resolveSlug fails closed when rotations land on two different players', () => {
  // "samson-laura" only matches Laura Samson, so a colliding pair is built here:
  // both "Anna Blinkova" and "Blinkova Anna"-shaped names exist under one token set.
  const two = buildNameMap([
    { tour: 'WTA', winner: 'Anna Blinkova', loser: 'Ana Roe' },
    { tour: 'WTA', winner: 'Blinkova Anna', loser: 'Ana Roe' }
  ]);
  assert.equal(resolveSlug('blinkova-anna', two.WTA), null);
});

test('resolveSlug returns null for an unknown slug', () => {
  assert.equal(resolveSlug('nobody-here', map.WTA), null);
  assert.equal(resolveSlug('', map.WTA), null);
});
