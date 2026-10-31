'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FP = require('../../WebExtension/Resources/lib/filter-parser.js');
const DNR = require('../../WebExtension/Resources/lib/dnr-convert.js');

const conv = (line) => DNR.convertNetworkFilter(FP.parseFilter(line));

test('domain block becomes requestDomains', () => {
  const { rules } = conv('||ads.example.com^');
  assert.strictEqual(rules.length, 1);
  assert.deepStrictEqual(rules[0].condition, { requestDomains: ['ads.example.com'] });
  assert.deepStrictEqual(rules[0].action, { type: 'block' });
  assert.strictEqual(rules[0].priority, DNR.PRIORITY.block);
});

test('options map to DNR conditions', () => {
  const { rules } = conv('||cdn.example.com/ads/$script,image,third-party,domain=a.com|~b.a.com');
  const c = rules[0].condition;
  assert.strictEqual(c.urlFilter, '||cdn.example.com/ads/');
  assert.deepStrictEqual(c.resourceTypes, ['image', 'script']);
  assert.strictEqual(c.domainType, 'thirdParty');
  assert.deepStrictEqual(c.initiatorDomains, ['a.com']);
  assert.deepStrictEqual(c.excludedInitiatorDomains, ['b.a.com']);
  assert.ok(!('domains' in c), 'never use legacy domains key');
});

test('exceptions, important, document allowlisting', () => {
  assert.strictEqual(conv('@@||example.com/ads.js').rules[0].action.type, 'allow');
  assert.strictEqual(conv('@@||example.com/ads.js').rules[0].priority, DNR.PRIORITY.exception);
  assert.strictEqual(conv('||x.com^$important').rules[0].priority, DNR.PRIORITY.important);
  const d = conv('@@||example.com^$document');
  assert.strictEqual(d.rules[0].action.type, 'allowAllRequests');
  assert.deepStrictEqual(d.rules[0].condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.deepStrictEqual(d.meta, { host: 'example.com', flags: { document: true } });
});

test('cosmetic-only exception options produce meta, no rules', () => {
  const r = conv('@@||example.com^$generichide');
  assert.strictEqual(r.rules.length, 0);
  assert.deepStrictEqual(r.meta, { host: 'example.com', flags: { generichide: true } });
});

test('redirect, removeparam and csp', () => {
  const r = conv('||googletagservices.com/tag/js/gpt.js$script,redirect=googletagservices_gpt.js');
  assert.deepStrictEqual(r.rules[0].action, { type: 'redirect', redirect: { extensionPath: '/surrogates/googletagservices_gpt.js' } });
  const unknown = conv('||x.com/a.js$script,redirect=does-not-exist.js');
  assert.strictEqual(unknown.rules[0].action.type, 'block');
  const rp = conv('$removeparam=utm_source');
  assert.deepStrictEqual(rp.rules[0].action.redirect.transform.queryTransform.removeParams, ['utm_source']);
  assert.deepStrictEqual(rp.rules[0].condition.resourceTypes, ['main_frame', 'sub_frame', 'xmlhttprequest']);
  const csp = conv("||example.com^$csp=script-src 'self'");
  assert.strictEqual(csp.rules[0].action.type, 'modifyHeaders');
  assert.ok(conv("*$csp=script-src 'self'").skip, 'generic csp is skipped');
});

test('unsupported things are skipped, not mangled', () => {
  assert.ok(conv('||x.com^$popup').skip);
  assert.ok(conv('||x.com^$redirect-rule=noopjs').skip);
  assert.ok(conv('/ads(?=x)/').skip);
  assert.ok(conv('||x.com^$domain=google.*').skip);
  assert.ok(conv('||x.com^$object').skip, 'object-only filters have no WebKit type');
  assert.ok(conv('*').skip);
});

test('regex with small disjunction makes several rules', () => {
  const r = conv('/^https?:\\/\\/(ads|adv)\\.example\\.com\\//$script');
  assert.strictEqual(r.rules.length, 2);
  for (const x of r.rules) assert.ok(x.condition.regexFilter);
});

test('mergeRules merges requestDomains and drops covered subdomains', () => {
  const rules = ['||a.com^', '||x.a.com^', '||b.com^', '||b.com^'].flatMap((l) => conv(l).rules);
  const merged = DNR.mergeRules(rules);
  assert.strictEqual(merged.length, 1);
  assert.deepStrictEqual(merged[0].condition.requestDomains, ['a.com', 'b.com']);
});

test('webkitCost mirrors WebKit expansion', () => {
  assert.strictEqual(DNR.webkitCost({ action: { type: 'block' }, condition: { requestDomains: ['a.com', 'b.com', 'c.com'] } }), 3);
  assert.strictEqual(DNR.webkitCost({ action: { type: 'block' }, condition: { urlFilter: 'x', excludedRequestDomains: ['a.com', 'b.com'] } }), 3);
  assert.strictEqual(DNR.webkitCost({ action: { type: 'block' }, condition: { urlFilter: 'x', initiatorDomains: ['a.com'], excludedInitiatorDomains: ['b.a.com'] } }), 2);
  assert.strictEqual(DNR.webkitCost({ action: { type: 'upgradeScheme' }, condition: { urlFilter: 'x' } }), 2);
});
