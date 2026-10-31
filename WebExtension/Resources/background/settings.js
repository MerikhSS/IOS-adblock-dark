/*
 * settings.js — single source of truth: browser.storage.local["settings"].
 * The host app never writes here directly; it drops edits into the App Group
 * inbox and native-sync.js merges them (see native-sync.js).
 */
(function (root) {
  'use strict';
  const ABD = root.ABD || (root.ABD = {});
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const DEFAULT_SETTINGS = {
    schema: 1,
    blockingPaused: false,
    enabledLists: null,          // null => lists with defaultEnabled in rules/index.json
    dark: {
      defaultOn: false,          // global default for sites without an override
      engine: 'filter',          // 'filter' | 'dynamic'
      brightness: 100,           // percent (filter engine: applied via CSS vars)
      contrast: 100,
      sepia: 0,
      autoNative: true,          // skip sites that are already dark
    },
    sites: {},                   // host -> { dark: 'on'|'off', engine?: 'filter'|'dynamic' }
    nativeDark: [],              // hosts detected as already dark (auto-excluded when defaultOn)
    allowlist: [],               // hosts where blocking + cosmetics are disabled
    customRules: '',             // user filters, ABP/uBO syntax, one per line
    hostRevApplied: 0,           // last host-app inbox revision merged
    rev: 0,                      // bumped on every change (host app shows it)
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function withDefaults(s) {
    const d = clone(DEFAULT_SETTINGS);
    if (!s || typeof s !== 'object') return d;
    const out = Object.assign(d, s);
    out.dark = Object.assign(clone(DEFAULT_SETTINGS.dark), s.dark || {});
    out.sites = s.sites || {};
    out.allowlist = Array.isArray(s.allowlist) ? s.allowlist : [];
    out.nativeDark = Array.isArray(s.nativeDark) ? s.nativeDark : [];
    return out;
  }

  async function get() {
    const r = await api.storage.local.get('settings');
    return withDefaults(r.settings);
  }

  let chain = Promise.resolve();
  const listeners = [];

  /** Serialized read-modify-write. fn(settings) mutates or returns a new object. */
  function update(fn) {
    const p = chain.then(async () => {
      const s = await get();
      const before = JSON.stringify(s);
      const ns = withDefaults(fn(s) || s);
      if (JSON.stringify(ns) === before) return ns;
      ns.rev = (s.rev || 0) + 1;
      await api.storage.local.set({ settings: ns });
      for (const l of listeners) { try { l(ns, JSON.parse(before)); } catch (e) { console.error(e); } }
      return ns;
    });
    chain = p.catch(() => {});
    return p;
  }

  function onChange(fn) { listeners.push(fn); }

  /** Normalize a URL or hostname to the key we store per-site settings under. */
  function siteKey(urlOrHost) {
    if (!urlOrHost) return '';
    let host = urlOrHost;
    if (/^[a-z][a-z0-9+.-]*:/i.test(urlOrHost)) {
      try {
        const u = new URL(urlOrHost);
        if (!/^https?:$/.test(u.protocol)) return '';
        host = u.hostname;
      } catch (_) { return ''; }
    }
    host = ABD.filterParser.toASCIIHost(host).replace(/^www\./, '').replace(/\.$/, '');
    return host;
  }

  function hostInList(host, list) {
    return list.some((d) => host === d || host.endsWith('.' + d));
  }

  /** Effective dark mode for a host: {on:boolean, engine, source} */
  function darkFor(settings, host) {
    const site = settings.sites[host] || findParentSite(settings, host);
    const engine = (site && site.engine) || settings.dark.engine;
    if (site && site.dark === 'on') return { on: true, engine, source: 'site' };
    if (site && site.dark === 'off') return { on: false, engine, source: 'site' };
    if (settings.dark.defaultOn && settings.dark.autoNative && hostInList(host, settings.nativeDark)) {
      return { on: false, engine, source: 'native' };
    }
    return { on: !!settings.dark.defaultOn, engine, source: 'default' };
  }

  function findParentSite(settings, host) {
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const s = settings.sites[parts.slice(i).join('.')];
      if (s) return s;
    }
    return null;
  }

  ABD.settings = { DEFAULT_SETTINGS, get, update, onChange, siteKey, hostInList, darkFor, withDefaults };
})(globalThis);
