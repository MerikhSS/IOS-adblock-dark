'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { preprocess, evalExpr } = require('../src/preprocess.js');

test('!#if evaluation', () => {
  assert.strictEqual(evalExpr('env_safari'), true);
  assert.strictEqual(evalExpr('env_firefox'), false);
  assert.strictEqual(evalExpr('!env_chromium && env_mv3'), true);
  assert.strictEqual(evalExpr('(env_firefox || env_safari) && !false'), true);
});

test('nested blocks with else', () => {
  const out = preprocess(['a', '!#if env_firefox', 'b', '!#else', 'c', '!#if env_safari', 'd', '!#endif', '!#endif', 'e'].join('\n'));
  assert.deepStrictEqual(out, ['a', 'c', 'd', 'e']);
});
