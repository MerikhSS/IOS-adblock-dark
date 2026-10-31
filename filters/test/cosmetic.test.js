'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FP = require('../../WebExtension/Resources/lib/filter-parser.js');
const CC = require('../../WebExtension/Resources/lib/cosmetic-compile.js');

function compile(lines, metas) {
  return CC.compileCosmetic(lines.map(FP.parseFilter), metas || [], { supportedScriptlets: new Set(['set-constant']) });
}

test('generic vs specific vs exceptions', () => {
  const cc = compile([
    '##.ad', '##.banner', 'example.com##.promo', 'example.com#@#.banner', '~news.com##.sponsor',
    '#@#.removed-everywhere', '##.removed-everywhere',
  ]);
  assert.deepStrictEqual(cc.genericHide.sort(), ['.ad', '.banner', '.sponsor']);
  assert.ok(cc.genericExcludeHosts.includes('example.com'));
  assert.ok(cc.genericExcludeHosts.includes('news.com'));
  const res = CC.resolveForHost('www.example.com', (k) => cc.specific[k]);
  assert.deepStrictEqual(res.hide, ['.promo']);
  assert.ok(res.exceptions.has('.banner'));
});

test('sub-domain exclusions on specific rules', () => {
  const cc = compile(['example.com,~m.example.com##.x']);
  assert.deepStrictEqual(CC.resolveForHost('example.com', (k) => cc.specific[k]).hide, ['.x']);
  assert.deepStrictEqual(CC.resolveForHost('m.example.com', (k) => cc.specific[k]).hide, []);
});

test('procedural, style, remove, scriptlets', () => {
  const cc = compile([
    'a.com##div:has-text(Ad):upward(1)', 'a.com##body:style(overflow:auto!important)', 'a.com##.modal:remove()',
    'a.com##+js(set-constant, x, false)', 'a.com##+js(unsupported-thing)', 'b.a.com#@#+js(set-constant, x, false)',
  ]);
  const r = CC.resolveForHost('a.com', (k) => cc.specific[k]);
  assert.strictEqual(r.procedural.length, 1);
  assert.deepStrictEqual(r.styles, [['body', 'overflow:auto!important']]);
  assert.deepStrictEqual(r.remove, ['.modal']);
  assert.deepStrictEqual(r.scriptlets, [['set-constant', ['x', 'false']]]);
  assert.strictEqual(cc.stats.droppedScriptlets, 1);
  const sub = CC.resolveForHost('b.a.com', (k) => cc.specific[k]);
  assert.deepStrictEqual(sub.scriptlets, []);
});

test('network-derived cosmetic flags', () => {
  const cc = compile(['##.ad'], [{ host: 'site.com', flags: { generichide: true } }]);
  assert.ok(cc.genericExcludeHosts.includes('site.com'));
  assert.strictEqual(CC.resolveForHost('site.com', (k) => cc.specific[k]).generichide, true);
});

test('static CSS groups isolate bad selectors', () => {
  const css = CC.buildHideCSS(['.a', '.b', '.c'], 2);
  assert.strictEqual(css.split('{display:none!important}').length - 1, 2);
  assert.ok(!CC.plausibleSelector('div:has-text(x)'));
  assert.ok(CC.plausibleSelector('div[id^="ad-"] > .x'));
});
