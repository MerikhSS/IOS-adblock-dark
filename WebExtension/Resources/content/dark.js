/*
 * dark.js — companion to dark-filter.css (registered together, top frame only).
 *  1. applies brightness/contrast/sepia tuning via CSS variables
 *  2. tags elements with CSS background images so they get re-inverted
 *  3. detects sites that are already dark and turns the filter off there
 *     (and remembers them, unless the user forced dark mode on for the site)
 */
(function () {
  'use strict';
  if (window.top !== window || window.__abdDarkLoaded) return;
  window.__abdDarkLoaded = true;
  const api = typeof browser !== 'undefined' ? browser : chrome;
  // Safari runs document_start scripts after <html> exists; be defensive anyway.
  if (!document.documentElement) {
    const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); start(); } });
    mo.observe(document, { childList: true });
  } else start();

  function start() {
  const html = document.documentElement;
  html.setAttribute('data-abd-dark', 'filter');

  const siteKey = location.hostname.replace(/^www\./, '');

  function siteSetting(settings) {
    const sites = (settings && settings.sites) || {};
    const parts = siteKey.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const s = sites[parts.slice(i).join('.')];
      if (s) return s;
    }
    return null;
  }

  // ---- 1. tuning ----
  api.storage.local.get('settings').then(({ settings }) => {
    const d = (settings && settings.dark) || {};
    const st = html.style;
    if (d.brightness && d.brightness !== 100) st.setProperty('--abd-br', String(d.brightness / 100));
    if (d.contrast && d.contrast !== 100) st.setProperty('--abd-ct', String(d.contrast / 100));
    if (d.sepia) st.setProperty('--abd-sp', String(d.sepia / 100));
    const site = siteSetting(settings);
    const forced = site && site.dark === 'on';
    if (!forced && d.autoNative !== false) scheduleNativeCheck();
  }).catch(() => {});

  // ---- 3. native dark detection ----
  function parseRGB(s) {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(s || '');
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }
  function luminance(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function pageLooksDark() {
    const body = document.body;
    if (!body) return false;
    // Computed styles are not affected by our CSS filter (only rendering is),
    // but our html background override is; so look at body first.
    const bodyBg = parseRGB(getComputedStyle(body).backgroundColor);
    const text = parseRGB(getComputedStyle(body).color);
    if (bodyBg && bodyBg.a > 0.5) return luminance(bodyBg) < 0.2;
    // Body transparent: check a large first-level container.
    const main = document.querySelector('body > div, body > main, #app, #root, #__next');
    if (main) {
      const bg = parseRGB(getComputedStyle(main).backgroundColor);
      if (bg && bg.a > 0.5 && main.getBoundingClientRect().height > innerHeight * 0.6) return luminance(bg) < 0.2;
    }
    // Light text on an otherwise-unknown background ⇒ probably a dark design.
    return !!(text && luminance(text) > 0.6);
  }
  function scheduleNativeCheck() {
    const check = () => {
      if (!pageLooksDark()) return;
      html.setAttribute('data-abd-dark-off', 'native');
      api.runtime.sendMessage({ type: 'nativeDark', host: siteKey }).catch(() => {});
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check, { once: true });
    else check();
  }

  // ---- 2. background images ----
  const MIN_AREA = 40 * 40;
  let queue = [];
  let scheduled = false;
  function enqueue(node) {
    if (node && node.nodeType === 1) queue.push(node);
    if (!scheduled) { scheduled = true; setTimeout(drain, 30); }
  }
  function check(el) {
    if (el.hasAttribute('data-abd-bg')) return;
    const bi = getComputedStyle(el).backgroundImage;
    if (!bi || bi === 'none' || bi.indexOf('url(') === -1) return;
    if (/\.svg|data:image\/svg/i.test(bi)) return; // icons: keep inverted like text
    const r = el.getBoundingClientRect();
    if (r.width * r.height < MIN_AREA) return;
    el.setAttribute('data-abd-bg', '');
  }
  function drain() {
    scheduled = false;
    const start = performance.now();
    while (queue.length) {
      const root = queue.shift();
      if (!root.isConnected) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el = root;
      let n = 0;
      while (el && n < 1500) {
        check(el);
        el = walker.nextNode();
        n++;
      }
      if (performance.now() - start > 12) { scheduled = true; setTimeout(drain, 50); return; }
    }
  }
  function startBg() {
    enqueue(document.body || html);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') enqueue(r.target);
        else for (const n of r.addedNodes) enqueue(n);
      }
    }).observe(html, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startBg, { once: true });
  else startBg();
  window.addEventListener('load', () => enqueue(document.body || html), { once: true });
  }
})();
