'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { dnrToWebKit, buildContentBlockerJSON, urlFilterToRegex } = require('../src/to-webkit.js');

test('urlFilter to WebKit regex matches WebKit translation', () => {
  assert.strictEqual(urlFilterToRegex('||ads.example.com^'), '^[^:]+://+([^:/]+\\.)?ads\\.example\\.com[^a-zA-Z0-9_.%-]');
  assert.strictEqual(urlFilterToRegex('|https://x.com/a*b|'), '^https://x\\.com/a.*b$');
});

test('block + allow ordering', () => {
  const json = buildContentBlockerJSON([
    { priority: 3000, action: { type: 'allow' }, condition: { urlFilter: '||good.com^' } },
    { priority: 1000, action: { type: 'block' }, condition: { requestDomains: ['ads.com', 'trk.com'] } },
  ]);
  assert.deepStrictEqual(json.map((r) => r.action.type), ['block', 'block', 'ignore-previous-rules']);
  assert.ok(!JSON.stringify(json).includes('if-domain'), 'never emit if-domain');
});

test('unsupported actions are dropped', () => {
  assert.deepStrictEqual(dnrToWebKit({ priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/x' } }, condition: { urlFilter: 'x' } }), []);
});
