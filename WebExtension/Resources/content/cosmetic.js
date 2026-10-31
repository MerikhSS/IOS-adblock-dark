/*
 * cosmetic.js — site-specific element hiding (declared in manifest.json,
 * document_start, all frames). Generic hiding is a static stylesheet that
 * Safari injects itself (see background/registrations.js).
 *
 * Data comes straight from storage.local (2 small reads, no background wake):
 *   settings, cosmeticLists, customGeneric, then c:<list>:<hostKey> entries.
 */
(function () {
  'use strict';
  if (window.__abdCosmeticLoaded) return;
  window.__abdCosmeticLoaded = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const ABD = globalThis.ABD;
  const FP = ABD.filterParser;
  const CC = ABD.cosmeticCompile;

  const hostname = location.hostname;
  if (!hostname) return;
  const isTop = window.top === window;

  function topHostname() {
    if (isTop) return hostname;
    try { return window.top.location.hostname; } catch (_) { /* cross-origin */ }
    const ao = location.ancestorOrigins;
    if (ao && ao.length) { try { return new URL(ao[ao.length - 1]).hostname; } catch (_) { /* ignore */ } }
    return hostname;
  }

  function inList(host, list) {
    host = host.replace(/^www\./, '');
    return (list || []).some((d) => host === d || host.endsWith('.' + d));
  }

  function mergeEntries(entries) {
    if (!entries.length) return undefined;
    if (entries.length === 1) return entries[0];
    const out = {};
    for (const e of entries) {
      for (const [k, v] of Object.entries(e)) {
        if (Array.isArray(v)) out[k] = (out[k] || []).concat(v);
        else if (v) out[k] = v;
      }
    }
    return out;
  }

  let styleEl = null;
  function injectCSS(text) {
    if (!text) return;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-abd', 'cosmetic');
    }
    styleEl.textContent += text + '\n';
    const mount = () => {
      if (styleEl.isConnected) return true;
      const parent = document.head || document.documentElement;
      if (!parent) return false;
      parent.appendChild(styleEl);
      return true;
    };
    if (!mount()) {
      const mo = new MutationObserver(() => { if (mount()) mo.disconnect(); });
      mo.observe(document, { childList: true, subtree: true });
    }
    // Pages sometimes wipe <head>; re-attach if removed.
    const guard = new MutationObserver(() => { if (!styleEl.isConnected) mount(); });
    if (document.documentElement) guard.observe(document.documentElement, { childList: true });
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  async function main() {
    const base = await api.storage.local.get(['settings', 'cosmeticLists', 'customGeneric']);
    const settings = base.settings || {};
    if (settings.blockingPaused) return;
    if (inList(topHostname(), settings.allowlist)) return;

    const lists = base.cosmeticLists || [];
    const keys = FP.hostnameKeys(hostname);
    const want = [];
    for (const l of lists) for (const k of keys) want.push(`c:${l}:${k}`);
    const data = want.length ? await api.storage.local.get(want) : {};

    const lookup = (k) => mergeEntries(lists.map((l) => data[`c:${l}:${k}`]).filter(Boolean));
    const res = CC.resolveForHost(hostname, lookup);
    if (res.document || res.elemhide) return;

    let hide = res.hide.slice();
    if (!res.generichide) hide = hide.concat((base.customGeneric || []).filter((s) => !res.exceptions.has(s)));

    // Was this host excluded from the static generic stylesheet? (Same rule as registrations.js.)
    const staticExcluded = keys.some((k) => !FP.isEntity(k) && lists.some((l) => {
      const e = data[`c:${l}:${k}`];
      return e && (e.x || e.gh || e.eh || e.doc);
    }));
    if (staticExcluded && !res.generichide) {
      try {
        const r = await api.runtime.sendMessage({ type: 'getGenericSelectors', exceptions: Array.from(res.exceptions) });
        if (r && r.selectors) hide = hide.concat(r.selectors);
      } catch (_) { /* background unavailable */ }
    }

    if (hide.length) injectCSS(CC.buildHideCSS(Array.from(new Set(hide)), 32));
    if (res.styles.length) injectCSS(res.styles.map(([sel, style]) => `${sel}{${style}}`).join('\n'));

    let removed = 0;
    if (res.remove.length) {
      const sel = res.remove.join(',');
      const doRemove = () => {
        for (const s of res.remove) {
          try { document.querySelectorAll(s).forEach((el) => { el.remove(); removed++; }); } catch (_) { /* bad selector */ }
        }
      };
      onReady(() => {
        doRemove();
        let t = 0;
        new MutationObserver(() => { if (!t) t = setTimeout(() => { t = 0; doRemove(); }, 150); })
          .observe(document.documentElement, { childList: true, subtree: true });
      });
      void sel;
    }

    let proc = { count: () => 0 };
    if (res.procedural.length && ABD.procedural) proc = ABD.procedural.start(res.procedural);

    if (isTop) {
      const report = () => {
        let n = 0;
        for (const s of hide) {
          try { n += document.querySelectorAll(s).length; } catch (_) { /* ignore */ }
          if (n > 5000) break;
        }
        n += removed + proc.count();
        api.runtime.sendMessage({ type: 'cosmeticReport', count: n }).catch(() => {});
      };
      // Only count when it's cheap: limit to pages where we injected something.
      if (hide.length < 3000 && (hide.length || res.remove.length || res.procedural.length)) {
        window.addEventListener('load', () => setTimeout(report, 1500), { once: true });
      }
    }
  }

  main().catch((e) => console.debug('[ABD cosmetic]', e));
})();
