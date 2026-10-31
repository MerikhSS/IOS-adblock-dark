'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RS = require('../../WebExtension/Resources/lib/regex-subset.js');

const ok = (src, expected) => {
  const r = RS.toWebKitRegexes(src);
  assert.ok(r.ok, `${src} should convert: ${r.reason}`);
  if (expected) assert.deepStrictEqual(r.regexes, expected);
  return r.regexes;
};
const bad = (src) => assert.strictEqual(RS.toWebKitRegexes(src).ok, false, `${src} should be rejected`);

test('plain regexes pass through', () => {
  ok('^https?://ads\\.example\\.com/', ['^https?://ads\\.example\\.com/']);
  ok('/banner[0-9]+\\.gif$', ['/banner[0-9]+\\.gif$']);
});

test('character class shorthands are rewritten', () => {
  ok('ad\\d+\\.js', ['ad[0-9]+\\.js']);
  ok('[\\w-]+\\.ads\\.', ['[A-Za-z0-9_-]+\\.ads\\.']);
});

test('counted quantifiers are expanded', () => {
  ok('a[0-9]{3}x', ['a[0-9][0-9][0-9]x']);
  ok('a[0-9]{1,3}x', ['a[0-9][0-9]?[0-9]?x']);
  ok('a[0-9]{2,}x', ['a[0-9][0-9][0-9]*x']);
});

test('small disjunctions expand into several regexes', () => {
  const r = ok('^https?://(ads|track)\\.example\\.com/');
  assert.deepStrictEqual(r.sort(), ['^https?://(ads)\\.example\\.com/', '^https?://(track)\\.example\\.com/'].sort());
  const r2 = ok('/(?:pop|push)under\\.js');
  assert.strictEqual(r2.length, 2);
});

test('unsupported constructs are rejected', () => {
  bad('ads(?=foo)');          // lookahead
  bad('\\bads\\b');           // word boundary
  bad('(a)\\1');              // backreference
  bad('.*');                  // matches everything
  bad('a^b');                 // misplaced ^
  bad('(a|b)+c');             // quantified disjunction
  bad('(a|b|c)(d|e|f)(g|h)'); // too many alternatives (18 > 8)
  bad('é');                   // non-ascii
});
