/*
 * stats.js — lightweight counters for the popup and the host app.
 *   network: from declarativeNetRequest.getMatchedRules (per tab, per page load)
 *   cosmetic: elements hidden by site-specific/procedural/custom rules (reported by content script)
 * Classic Content Blocker extensions report nothing, so overflow-list blocks are not counted.
 */
(function (root) {
  'use strict';
  const ABD = root.ABD || (root.ABD = {});
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const tabs = new Map(); // tabId -> {host, start, cosmetic, network}
  const KEEP_DAYS = 30;

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  let pending = { days: {}, sites: {} };
  let flushTimer = 0;

  function add(host, network, cosmetic) {
    if (!host || (!network && !cosmetic)) return;
    const d = today();
    const day = pending.days[d] || (pending.days[d] = { network: 0, cosmetic: 0 });
    day.network += network; day.cosmetic += cosmetic;
    const site = pending.sites[host] || (pending.sites[host] = { network: 0, cosmetic: 0 });
    site.network += network; site.cosmetic += cosmetic;
    if (!flushTimer) flushTimer = setTimeout(flush, 3000);
  }

  async function flush() {
    flushTimer = 0;
    const p = pending;
    pending = { days: {}, sites: {} };
    const st = (await api.storage.local.get('stats')).stats || { days: {}, sites: {}, since: today() };
    for (const [k, v] of Object.entries(p.days)) {
      const t = st.days[k] || (st.days[k] = { network: 0, cosmetic: 0 });
      t.network += v.network; t.cosmetic += v.cosmetic;
    }
    for (const [k, v] of Object.entries(p.sites)) {
      const t = st.sites[k] || (st.sites[k] = { network: 0, cosmetic: 0 });
      t.network += v.network; t.cosmetic += v.cosmetic;
    }
    const days = Object.keys(st.days).sort();
    for (const k of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete st.days[k];
    const sites = Object.entries(st.sites).sort((a, b) => (b[1].network + b[1].cosmetic) - (a[1].network + a[1].cosmetic));
    st.sites = Object.fromEntries(sites.slice(0, 200));
    await api.storage.local.set({ stats: st });
  }

  /** Called when a tab starts a new top-level navigation: finalize the previous page. */
  async function onNavigate(tabId, url) {
    const prev = tabs.get(tabId);
    if (prev) await finalize(tabId, prev);
    tabs.set(tabId, { host: ABD.settings.siteKey(url), start: Date.now(), cosmetic: 0, network: null });
  }

  async function finalize(tabId, t) {
    if (t.network === null) t.network = (await ABD.dnr.matchedCount(tabId, t.start)) || 0;
    add(t.host, t.network, t.cosmetic);
  }

  function onCosmetic(tabId, count) {
    const t = tabs.get(tabId);
    if (t) t.cosmetic = Math.max(t.cosmetic, count);
  }

  async function forTab(tabId) {
    const t = tabs.get(tabId);
    const network = await ABD.dnr.matchedCount(tabId, t ? t.start : undefined);
    if (t && network !== null) t.network = network;
    return { network, cosmetic: t ? t.cosmetic : 0 };
  }

  function onTabRemoved(tabId) {
    const t = tabs.get(tabId);
    tabs.delete(tabId);
    if (t) finalize(tabId, t).catch(() => {});
  }

  async function get() {
    await flush();
    return (await api.storage.local.get('stats')).stats || { days: {}, sites: {} };
  }

  async function reset() {
    pending = { days: {}, sites: {} };
    await api.storage.local.set({ stats: { days: {}, sites: {}, since: today() } });
  }

  ABD.stats = { onNavigate, onCosmetic, forTab, onTabRemoved, get, reset, flush };
})(globalThis);
