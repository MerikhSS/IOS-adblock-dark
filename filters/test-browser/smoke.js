#!/usr/bin/env node
/*
 * smoke.js — load the extension's content scripts into Chromium (Playwright)
 * with a tiny `browser.*` shim and check the behaviour end to end.
 * This is NOT Safari: it catches logic bugs, not WebKit-specific quirks.
 *
 *   node test-browser/smoke.js        (needs `playwright` + a Chromium)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
let playwright;
try { playwright = require('playwright'); } catch (_) { console.log('playwright not installed — skipping browser smoke tests'); process.exit(0); }

const RES = path.resolve(__dirname, '../../WebExtension/Resources');
const read = (p) => fs.readFileSync(path.join(RES, p), 'utf8');

function shim(storage, messages) {
  return `
    window.__abdMessages = [];
    window.browser = {
      storage: { local: { get: async (keys) => {
        const s = ${JSON.stringify(storage)};
        if (keys === null) return s;
        if (typeof keys === 'string') keys = [keys];
        const out = {}; for (const k of keys) if (k in s) out[k] = s[k]; return out;
      } } },
      runtime: { sendMessage: async (m) => { window.__abdMessages.push(m); const r = (${JSON.stringify(messages || {})})[m.type]; return r || { ok: true }; } },
    };`;
}

async function page(browser, html, scripts, opts) {
  const ctx = await browser.newContext({ colorScheme: (opts && opts.colorScheme) || 'light' });
  const p = await ctx.newPage();
  await p.route('https://test.example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await p.route('https://img.example.com/**', (route) => route.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join(RES, 'images/icon-48.png')) }));
  for (const s of scripts) await p.addInitScript(s);
  await p.goto('https://test.example.com/page');
  await p.waitForLoadState('load');
  await p.waitForTimeout(400);
  return p;
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['✓', name]); } catch (e) { results.push(['✗', name + ' — ' + e.message]); }
}

(async () => {
  const browser = await playwright.chromium.launch();

  // ---------------- dark filter engine ----------------
  const darkCSS = read('content/dark-filter.css');
  const darkJS = read('content/dark.js');
  const injectDark = (storage) => [shim(storage), `document.addEventListener('readystatechange', () => {}, {once:true});
    (function(){ const s=document.createElement('style'); s.textContent=${JSON.stringify(darkCSS)};
      const add=()=>{ const p=document.head||document.documentElement; if(!p) return false; p.appendChild(s); return true; };
      if(!add()){ const mo=new MutationObserver(()=>{ if(add()) mo.disconnect(); }); mo.observe(document,{childList:true,subtree:true}); } })();`, darkJS];

  await check('dark filter: html inverted, media re-inverted, nested media not double-inverted', async () => {
    const p = await page(browser, `<!doctype html><html><head></head><body style="background:#fff;color:#111">
      <p>Hello</p><img id="i" src="https://img.example.com/a.png"><picture id="pic"><img id="pi" src="https://img.example.com/b.png"></picture>
      <img id="svg" src="https://img.example.com/logo.svg"></body></html>`, injectDark({ settings: { dark: { brightness: 100 } } }));
    const f = await p.evaluate(() => ({
      html: getComputedStyle(document.documentElement).filter,
      img: getComputedStyle(document.getElementById('i')).filter,
      pic: getComputedStyle(document.getElementById('pic')).filter,
      picImg: getComputedStyle(document.getElementById('pi')).filter,
      svg: getComputedStyle(document.getElementById('svg')).filter,
      off: document.documentElement.getAttribute('data-abd-dark-off'),
    }));
    assert.match(f.html, /invert\(0\.9\)/);
    assert.match(f.img, /invert\(1\)/);
    assert.match(f.pic, /invert\(1\)/);
    assert.strictEqual(f.picImg, 'none');
    assert.strictEqual(f.svg, 'none');
    assert.strictEqual(f.off, null);
  });

  await check('dark filter: brightness setting applied via CSS variable', async () => {
    const p = await page(browser, `<!doctype html><html><body style="background:#fff"><p>x</p></body></html>`,
      injectDark({ settings: { dark: { brightness: 80, contrast: 110 } } }));
    const f = await p.evaluate(() => getComputedStyle(document.documentElement).filter);
    assert.match(f, /brightness\(0\.8\)/);
    assert.match(f, /contrast\(1\.1\)/);
  });

  await check('dark filter: natively dark site detected and left alone', async () => {
    const p = await page(browser, `<!doctype html><html><body style="background:#121212;color:#eee"><p>dark site</p></body></html>`,
      injectDark({ settings: { dark: { autoNative: true } } }));
    const r = await p.evaluate(() => ({ off: document.documentElement.getAttribute('data-abd-dark-off'), f: getComputedStyle(document.documentElement).filter, msgs: window.__abdMessages }));
    assert.strictEqual(r.off, 'native');
    assert.strictEqual(r.f, 'none');
    assert.ok(r.msgs.some((m) => m.type === 'nativeDark'));
  });

  await check('dark filter: forced-on site skips native detection', async () => {
    const p = await page(browser, `<!doctype html><html><body style="background:#121212;color:#eee"><p>dark site</p></body></html>`,
      injectDark({ settings: { dark: { autoNative: true }, sites: { 'test.example.com': { dark: 'on' } } } }));
    const off = await p.evaluate(() => document.documentElement.getAttribute('data-abd-dark-off'));
    assert.strictEqual(off, null);
  });

  await check('dark filter: large CSS background images get re-inverted', async () => {
    const p = await page(browser, `<!doctype html><html><body style="background:#fff">
      <div id="hero" style="width:300px;height:200px;background-image:url(https://img.example.com/hero.png)"></div>
      <div id="icon" style="width:16px;height:16px;background-image:url(https://img.example.com/i.png)"></div></body></html>`, injectDark({ settings: {} }));
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => ({ hero: document.getElementById('hero').hasAttribute('data-abd-bg'), icon: document.getElementById('icon').hasAttribute('data-abd-bg') }));
    assert.deepStrictEqual(r, { hero: true, icon: false });
  });

  // ---------------- cosmetic engine ----------------
  const libs = ['lib/filter-parser.js', 'lib/cosmetic-compile.js', 'content/procedural.js', 'content/cosmetic.js'].map(read);
  const storage = {
    settings: { allowlist: [] },
    cosmeticLists: ['listA', 'custom'],
    customGeneric: ['.custom-generic'],
    'c:listA:example.com': {
      h: [['.ad-box'], ['.only-on-www', ['other.example.com']]],
      s: [['body', 'overflow: auto !important']],
      r: [['.paywall']],
      p: [['div.card:has-text(/Sponsored/):upward(1)', 'procedural'], ['span:has-text(Promoted)', 'remove']],
      x: ['.not-hidden'],
    },
  };
  const cosHTML = `<!doctype html><html><head></head><body style="overflow:hidden">
    <div class="ad-box" id="a">ad</div><div class="only-on-www" id="w">x</div><div class="custom-generic" id="cg">c</div>
    <div class="paywall" id="pw">pay</div>
    <section id="wrap"><div class="card">Sponsored content</div></section>
    <section id="wrap2"><div class="card">Normal content</div></section>
    <span id="pr">Promoted</span></body></html>`;

  await check('cosmetic: specific, custom generic, style, remove, procedural', async () => {
    const p = await page(browser, cosHTML, [shim(storage), ...libs]);
    await p.evaluate(() => {
      const late = document.createElement('section'); late.id = 'late';
      late.innerHTML = '<div class="card">Sponsored late</div>'; document.body.appendChild(late);
    });
    await p.waitForTimeout(500);
    const r = await p.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; };
      return { a: vis('a'), w: vis('w'), cg: vis('cg'), pw: !!document.getElementById('pw'), wrap: vis('wrap'), wrap2: vis('wrap2'),
        late: vis('late'), pr: !!document.getElementById('pr'), overflow: getComputedStyle(document.body).overflow };
    });
    assert.deepStrictEqual(r, { a: false, w: false, cg: false, pw: false, wrap: false, wrap2: true, late: false, pr: false, overflow: 'auto' });
  });

  await check('cosmetic: allowlisted site is untouched', async () => {
    const s2 = JSON.parse(JSON.stringify(storage));
    s2.settings.allowlist = ['example.com'];
    const p = await page(browser, cosHTML, [shim(s2), ...libs]);
    const vis = await p.evaluate(() => getComputedStyle(document.getElementById('a')).display);
    assert.notStrictEqual(vis, 'none');
  });

  await check('cosmetic: host excluded from static CSS asks background for generic minus exceptions', async () => {
    const p = await page(browser, `<!doctype html><html><body><div class="gen" id="g">g</div><div class="not-hidden" id="n">n</div></body></html>`,
      [shim(storage, { getGenericSelectors: { selectors: ['.gen'] } }), ...libs]);
    const r = await p.evaluate(() => ({ g: getComputedStyle(document.getElementById('g')).display, msgs: window.__abdMessages.map((m) => m.type), ex: (window.__abdMessages.find((m) => m.type === 'getGenericSelectors') || {}).exceptions }));
    assert.strictEqual(r.g, 'none');
    assert.ok(r.ex.includes('.not-hidden'));
  });

  // ---------------- scriptlets (generated bundle) ----------------
  await check('scriptlets: generated bundles are valid and run for their host', async () => {
    const idx = JSON.parse(read('scriptlets/ubo-filters.index.json'));
    const shard = idx.find((s) => s.matches.includes('*://*.example.com/*')) || idx[0];
    const src = read(shard.file);
    const p = await page(browser, '<!doctype html><html><body>x</body></html>', [src]);
    const ok = await p.evaluate(() => typeof window.setTimeout === 'function');
    assert.ok(ok);
  });

  await check('scriptlets: runner set-constant + abort-on-property-read in a page', async () => {
    const { abdScriptletRunner } = require(path.join(RES, 'lib/scriptlet-runner.js'));
    const src = `(${abdScriptletRunner.toString()})([["set-constant",["adsEnabled","false"]],["abort-on-property-read",["detectAdblock"]]]);
      window.adsEnabled = true; window.detectAdblock = function(){ return true; };`;
    const p = await page(browser, '<!doctype html><html><body><script>try { window.__r = detectAdblock(); } catch (e) { window.__r = "aborted"; }</script></body></html>', [src]);
    const r = await p.evaluate(() => ({ ads: window.adsEnabled, r: window.__r }));
    assert.deepStrictEqual(r, { ads: false, r: 'aborted' });
  });

  // ---------------- dynamic engine (Dark Reader) ----------------
  await check('dynamic dark engine (Dark Reader) darkens a light page', async () => {
    const p = await page(browser, `<!doctype html><html><head><style>body{background:#ffffff;color:#000}</style></head><body><p>Light</p></body></html>`,
      [shim({ settings: { dark: {} } }), read('vendor/darkreader.js'), read('content/dark-dynamic.js')]);
    await p.waitForTimeout(800);
    const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const m = bg.match(/\d+/g).map(Number);
    assert.ok(m[0] < 80 && m[1] < 80 && m[2] < 80, 'background is ' + bg);
  });

  // ---------------- picker ----------------
  await check('element picker builds a selector and saves a custom rule', async () => {
    const p = await page(browser, '<!doctype html><html><body><div class="promo-box" style="height:80px">promo</div></body></html>', [shim({})]);
    await p.addScriptTag({ content: read('content/picker.js') });
    await p.mouse.click(20, 20);
    await p.click('#abd-pick-panel button[data-a="hide"]');
    const r = await p.evaluate(() => ({ msgs: window.__abdMessages, disp: getComputedStyle(document.querySelector('.promo-box')).display }));
    const add = r.msgs.find((m) => m.type === 'addCustomRule');
    assert.ok(add && /##.*promo-box/.test(add.rule), JSON.stringify(r.msgs));
    assert.strictEqual(r.disp, 'none');
  });

  await browser.close();
  for (const [s, n] of results) console.log(s, n);
  process.exit(results.some(([s]) => s === '✗') ? 1 : 0);
})();
