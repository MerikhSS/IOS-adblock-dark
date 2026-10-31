/*
 * dark-dynamic.js — "dynamic" dark engine using the vendored Dark Reader
 * library (MIT, vendor/darkreader.js). Registered for hosts that use this
 * engine (all frames, document_start).
 *
 * Cross-origin stylesheets can't be read from the page, so Dark Reader's fetch
 * is routed through the background page, which has host permissions.
 */
(function () {
  'use strict';
  if (window.__abdDynamicLoaded) return;
  window.__abdDynamicLoaded = true;
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const DR = globalThis.DarkReader;
  if (!DR) return;

  DR.setFetchMethod((url) => api.runtime.sendMessage({ type: 'fetchCSS', url: String(url) }).then((r) => {
    if (!r || !r.ok) throw new Error('ABD: could not fetch ' + url);
    return new Response(r.text, { headers: { 'Content-Type': r.type || 'text/css' } });
  }));

  const theme = { mode: 1, brightness: 100, contrast: 100, sepia: 0 };
  const enable = () => { try { DR.enable(theme); } catch (e) { console.debug('[ABD dynamic]', e); } };
  // Dark Reader needs <html>; Safari creates it before document_start scripts run.
  if (document.documentElement) enable();
  else {
    const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); enable(); } });
    mo.observe(document, { childList: true });
  }

  api.storage.local.get('settings').then(({ settings }) => {
    const d = (settings && settings.dark) || {};
    const t = { mode: 1, brightness: d.brightness || 100, contrast: d.contrast || 100, sepia: d.sepia || 0 };
    if (t.brightness !== 100 || t.contrast !== 100 || t.sepia !== 0) {
      try { DR.enable(t); } catch (_) { /* ignore */ }
    }
  }).catch(() => {});
})();
