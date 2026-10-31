'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { abdScriptletRunner, SUPPORTED } = require('../../WebExtension/Resources/lib/scriptlet-runner.js');

// Minimal window shim: the runner only touches what each scriptlet needs.
function withWindow(fn) {
  const prev = globalThis.window;
  globalThis.window = globalThis;
  try { return fn(); } finally { globalThis.window = prev; if (prev === undefined) delete globalThis.window; }
}

test('runner is self-contained (serializable)', () => {
  const src = abdScriptletRunner.toString();
  const fn = new Function('return (' + src + ')')();
  assert.strictEqual(typeof fn, 'function');
  assert.ok(SUPPORTED.includes('json-prune'));
});

test('set-constant defines nested values', () => {
  withWindow(() => {
    abdScriptletRunner([['set-constant', ['abdTest.flags.ads', 'false']]]);
    globalThis.abdTest = { flags: { ads: true, other: 1 } };
    assert.strictEqual(globalThis.abdTest.flags.ads, false);
    globalThis.abdTest.flags.ads = true;
    assert.strictEqual(globalThis.abdTest.flags.ads, false);
    delete globalThis.abdTest;
  });
});

test('json-prune removes properties from JSON.parse results', () => {
  const orig = JSON.parse;
  withWindow(() => {
    abdScriptletRunner([['json-prune', ['playerAds adPlacements', '']]]);
    const o = JSON.parse('{"playerAds":[1],"adPlacements":[2],"video":"ok"}');
    assert.deepStrictEqual(o, { video: 'ok' });
  });
  JSON.parse = orig;
});

test('no-setTimeout-if neuters matching callbacks', async () => {
  const orig = globalThis.setTimeout;
  await withWindow(async () => {
    abdScriptletRunner([['no-setTimeout-if', ['adblock']]]);
    let ran = false;
    let other = false;
    setTimeout(function adblockDetector() { ran = true; }, 1);
    setTimeout(() => { other = true; }, 1);
    await new Promise((r) => orig(r, 20));
    assert.strictEqual(ran, false);
    assert.strictEqual(other, true);
  });
  globalThis.setTimeout = orig;
});
