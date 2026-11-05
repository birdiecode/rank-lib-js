import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { compileMask, count, generate } from '../src/index.js';

const require = createRequire(import.meta.url);

test('fixed strings and empty mask', () => {
  assert.equal(count('ABC'), 1n);
  assert.equal(generate('ABC', 0n), 'ABC');
  assert.equal(count(''), 1n);
  assert.equal(generate('', 0n), '');
});

test('variable lengths, deterministic indexing', () => {
  assert.equal(count('?d{8,10}'), 11100000000n);
  assert.equal(generate('?d{8,10}', 0n), '00000000');
  assert.equal(generate('?d{8,10}', 100000000n), '000000000');
  const model = compileMask('[ab]{1,3}');
  assert.equal(model.total, 14n);
  assert.deepEqual(Array.from({ length: 14 }, (_, i) => model.at(BigInt(i))),
    ['a', 'b', 'aa', 'ab', 'ba', 'bb', 'aaa', 'aab', 'aba', 'abb', 'baa', 'bab', 'bba', 'bbb']);
});

test('duplicate strings from optional positions are counted once', () => {
  const model = compileMask('[a]{0,1}[a]{0,1}');
  assert.equal(model.total, 3n);
  assert.deepEqual([model.at(0n), model.at(1n), model.at(2n)], ['', 'a', 'aa']);
  assert.equal(count('[ab]{0,1}[ba]{0,1}'), 7n);
});

test('custom sets, range, Unicode codepoints, escapes', () => {
  const custom = { '1': 'abcdef', '2': '012345' };
  assert.equal(count('?1{2}?2{2}', custom), 1296n);
  assert.equal(generate('?1{2}?2{2}', 0n, custom), 'aa00');
  assert.equal(count('😀[аб]{0,1}'), 3n);
  assert.equal(count('[a-c0-1]'), 5n);
  assert.equal(count('\\['), 1n);
  assert.equal(generate('??', 0n), '?');
  assert.equal(count('[aaa]'), 1n);
});

test('bounds validation and malformed masks', () => {
  assert.throws(() => generate('[ab]', -1n), RangeError);
  assert.throws(() => generate('[ab]', 2n), RangeError);
  assert.throws(() => generate('[ab]', 0), TypeError);
  assert.throws(() => count('?x'), /набор/i);
  assert.throws(() => count('[z-a]'), /диапазон/i);
  assert.throws(() => count('[abc'), /Незакрытый/i);
  assert.throws(() => count('a{4,3}'), /повторений/i);
  assert.throws(() => count('?d{129}'), /128/);
});

test('browser bundle exposes same public API', () => {
  const code = readFileSync(new URL('../dist/rank-lib.js', import.meta.url), 'utf8');
  const context = {};
  runInNewContext(code, context);
  assert.equal(context.RankLib.count('[ab]{1,3}'), count('[ab]{1,3}'));
  assert.equal(context.RankLib.generate('[ab]{1,3}', 13n), 'bbb');
  assert.equal(context.RankLib.compileMask('[a]{0,1}[a]{0,1}').total, 3n);
});

test('CommonJS package entry works', () => {
  const lib = require('../dist/rank-lib.cjs');
  assert.equal(lib.count('?d{2}'), 100n);
  assert.equal(lib.generate('?d{2}', 99n), '99');
});

test('demo loads browser bundle instead of embedding library', () => {
  const html = readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\.\.\/dist\/rank-lib\.js"><\/script>/);
  assert.match(html, /const \{ compileMask, count, generate \} = window\.RankLib/);
  assert.doesNotMatch(html, /function compileMask\(/);
});
