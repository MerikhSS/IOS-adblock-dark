'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FP = require('../../WebExtension/Resources/lib/filter-parser.js');

test('comments and headers', () => {
  assert.strictEqual(FP.parseFilter('! comment').type, 'comment');
  assert.strictEqual(FP.parseFilter('[Adblock Plus 2.0]').type, 'comment');
  assert.strictEqual(FP.parseFilter('').type, 'comment');
});

test('network filters with options', () => {
  const f = FP.parseFilter('||ads.example.com^$script,third-party,domain=a.com|~b.a.com');
  assert.strictEqual(f.type, 'network');
  assert.strictEqual(f.pattern, '||ads.example.com^');
  assert.ok(f.options.script && f.options['third-party'] && f.options.domain);
  assert.strictEqual(f.options.domain.value, 'a.com|~b.a.com');
  const e = FP.parseFilter('@@||example.com^$document');
  assert.strictEqual(e.exception, true);
  const r = FP.parseFilter('/ad[0-9]+\\.js$/$script');
  assert.strictEqual(r.isRegex, true);
  assert.strictEqual(r.pattern, '/ad[0-9]+\\.js$/');
  // "$" followed by something that isn't a known option stays part of the URL pattern
  const d = FP.parseFilter('||example.com/path$foo=1');
  assert.strictEqual(d.pattern, '||example.com/path$foo=1');
  assert.strictEqual(FP.parseFilter('||x.com^$bogus-option,script').type, 'unsupported');
});

test('hosts-file lines', () => {
  const f = FP.parseFilter('0.0.0.0 tracker.example.net');
  assert.strictEqual(f.type, 'network');
  assert.strictEqual(f.pattern, '||tracker.example.net^');
  assert.strictEqual(FP.parseFilter('127.0.0.1 localhost').type, 'comment');
});

test('cosmetic filters', () => {
  const g = FP.parseFilter('##.ad-banner');
  assert.deepStrictEqual([g.type, g.selector, g.kind, g.exception], ['cosmetic', '.ad-banner', 'hide', false]);
  const s = FP.parseFilter('example.com,~sub.example.com##.ad');
  assert.deepStrictEqual(s.domains.include, ['example.com']);
  assert.deepStrictEqual(s.domains.exclude, ['sub.example.com']);
  const x = FP.parseFilter('example.com#@#.ad');
  assert.strictEqual(x.exception, true);
  const p = FP.parseFilter('example.com##div:has-text(Sponsored):upward(2)');
  assert.strictEqual(p.procedural, true);
  const st = FP.parseFilter('example.com##body:style(overflow: auto !important)');
  assert.deepStrictEqual([st.kind, st.selector, st.style], ['style', 'body', 'overflow: auto !important']);
  const rm = FP.parseFilter('example.com##.overlay:remove()');
  assert.strictEqual(rm.kind, 'remove');
  assert.strictEqual(FP.parseFilter('example.com##^script:has-text(ad)').type, 'unsupported');
  const native = FP.parseFilter('example.com##div:has(> .ad)');
  assert.strictEqual(native.procedural, false);
  const ent = FP.parseFilter('google.*##.ad');
  assert.deepStrictEqual(ent.domains.include, ['google.*']);
});

test('scriptlets', () => {
  const f = FP.parseFilter("example.com##+js(aopr, foo.bar)");
  assert.deepStrictEqual([f.type, f.name, f.args], ['scriptlet', 'abort-on-property-read', ['foo.bar']]);
  const q = FP.parseFilter("example.com##+js(set, a.b, 'x, y')");
  assert.deepStrictEqual([q.name, q.args], ['set-constant', ['a.b', 'x, y']]);
  const esc = FP.parseFilter('example.com##+js(nostif, a\\, b, 100)');
  assert.deepStrictEqual(esc.args, ['a, b', '100']);
  const ex = FP.parseFilter('example.com#@#+js()');
  assert.strictEqual(ex.exception, true);
});

test('host helpers', () => {
  assert.ok(FP.hostMatchesDomain('www.example.com', 'example.com'));
  assert.ok(!FP.hostMatchesDomain('notexample.com', 'example.com'));
  assert.ok(FP.hostMatchesDomain('www.google.co.uk', 'google.*'));
  assert.ok(!FP.hostMatchesDomain('google.evil.example.com', 'google.*'));
  assert.ok(FP.hostnameKeys('a.b.example.com').includes('example.com'));
  assert.ok(FP.hostnameKeys('www.google.co.uk').includes('google.*'));
  assert.strictEqual(FP.toASCIIHost('bücher.de'), 'xn--bcher-kva.de');
});
