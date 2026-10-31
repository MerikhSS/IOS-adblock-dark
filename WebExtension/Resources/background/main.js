/*
 * main.js — background entry point (non-persistent on iOS: Safari unloads it
 * when idle, so everything here must be idempotent and state lives in storage).
 */
(function (root) {
  'use strict';
  const ABD = root.ABD;
  const api = typeof browser !== 'undefined' ? browser : chrome;

  // ---------------- apply pipeline ----------------

  let applyTimer = 0;
  let applyChain = Promise.resolve();
  let lastApplyError = null;

  function scheduleApply(reason, force) {
    clearTimeout(applyTimer);
    return new Promise((resolve) => {
      applyTimer = setTimeout(() => {
        applyChain = applyChain.then(() => applyAll(reason, force)).catch((e) => {
          lastApplyError = String(e && e.message || e);
          console.error('applyAll', e);
        }).then(resolve);
      }, 50);
    });
  }

  async function applyAll(reason, force) {
    const settings = await ABD.settings.get();
    const index = await ABD.dnr.loadIndex();
    await ABD.cosmeticStore.ensureListData(index);
    const enabled = await ABD.dnr.applyRulesets(settings);
    const dyn = await ABD.dnr.applyDynamic(settings);
    await ABD.cosmeticStore.applyCustom(dyn.cosmetic);
    await ABD.cosmeticStore.setEnabledLists(enabled, settings);
    await ABD.registrations.sync(settings, enabled, index, force);
    lastApplyError = null;
    await api.storage.local.set({ lastApply: { at: new Date().toISOString(), reason } });
  }

  ABD.settings.onChange(() => { scheduleApply('settings'); });

  // ---------------- lifecycle ----------------

  api.runtime.onInstalled.addListener(async (details) => {
    // Registered scripts survive relaunches but not extension updates, so re-register.
    await scheduleApply('installed:' + details.reason, true);
    await ABD.dnr.enableBadge();
    ABD.nativeSync.sync(true);
  });

  if (api.runtime.onStartup) {
    api.runtime.onStartup.addListener(async () => {
      await scheduleApply('startup');
      ABD.nativeSync.sync(true);
    });
  }

  // ---------------- navigation hooks ----------------

  if (api.webNavigation) {
    api.webNavigation.onCommitted.addListener(async (d) => {
      if (d.frameId !== 0) return;
      ABD.stats.onNavigate(d.tabId, d.url);
      // Custom user scriptlets (best effort: may run after early page scripts).
      const host = ABD.settings.siteKey(d.url);
      if (!host) return;
      const settings = await ABD.settings.get();
      if (settings.blockingPaused || ABD.settings.hostInList(host, settings.allowlist)) return;
      const calls = await ABD.cosmeticStore.customScriptletsFor(new URL(d.url).hostname);
      if (calls.length) {
        try {
          await api.scripting.executeScript({ target: { tabId: d.tabId }, world: 'MAIN', func: ABD.scriptletRunner.abdScriptletRunner, args: [calls] });
        } catch (e) { console.warn('custom scriptlets', e); }
      }
    });
    api.webNavigation.onCompleted.addListener((d) => {
      if (d.frameId === 0) ABD.nativeSync.sync(false);
    });
  }
  if (api.tabs && api.tabs.onRemoved) api.tabs.onRemoved.addListener((tabId) => ABD.stats.onTabRemoved(tabId));

  // ---------------- messages ----------------

  async function popupState(msg) {
    const settings = await ABD.settings.get();
    const index = await ABD.dnr.loadIndex();
    const host = ABD.settings.siteKey(msg.url);
    const dark = host ? ABD.settings.darkFor(settings, host) : null;
    const counts = msg.tabId != null ? await ABD.stats.forTab(msg.tabId) : null;
    return {
      host,
      supported: !!host,
      paused: settings.blockingPaused,
      allowlisted: host ? ABD.settings.hostInList(host, settings.allowlist) : false,
      allowlistEntry: host ? settings.allowlist.find((d) => host === d || host.endsWith('.' + d)) || null : null,
      siteDark: host ? ((settings.sites[host] && settings.sites[host].dark) || 'default') : 'default',
      siteEngine: host ? ((settings.sites[host] && settings.sites[host].engine) || null) : null,
      dark,
      darkDefaults: settings.dark,
      counts,
      enabledLists: ABD.dnr.enabledListIds(settings, index).length,
    };
  }

  async function optionsState() {
    const settings = await ABD.settings.get();
    const index = await ABD.dnr.loadIndex();
    const enabled = ABD.dnr.enabledListIds(settings, index);
    const st = await api.storage.local.get(['customRuleErrors', 'registrationErrors', 'lastNativeSync', 'lastApply', 'cosmeticBuiltAt']);
    return {
      settings, index, enabled,
      budget: ABD.dnr.checkBudget(enabled, index),
      customRuleErrors: st.customRuleErrors || [],
      registrationErrors: st.registrationErrors || [],
      lastNativeSync: st.lastNativeSync || null,
      lastApply: st.lastApply || null,
      lastApplyError,
      cosmeticReady: st.cosmeticBuiltAt === index.builtAt,
      stats: await ABD.stats.get(),
      version: api.runtime.getManifest().version,
    };
  }

  async function fetchText(url) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, text: await res.text(), type: res.headers.get('content-type') || 'text/css' };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const handlers = {
    async getPopupState(msg) { return popupState(msg); },
    async getOptionsState() { return optionsState(); },

    async setSiteDark({ host, mode, engine }) {
      host = ABD.settings.siteKey(host);
      if (!host) return { ok: false };
      await ABD.settings.update((s) => {
        const cur = Object.assign({}, s.sites[host] || {});
        if (mode === 'default') delete cur.dark; else if (mode) cur.dark = mode;
        if (engine === null) delete cur.engine; else if (engine) cur.engine = engine;
        if (Object.keys(cur).length) s.sites[host] = cur; else delete s.sites[host];
        if (mode === 'on') s.nativeDark = s.nativeDark.filter((h) => h !== host);
      });
      await scheduleApply('site-dark');
      return { ok: true };
    },

    async setAllowlisted({ host, allowlisted }) {
      host = ABD.settings.siteKey(host);
      if (!host) return { ok: false };
      await ABD.settings.update((s) => {
        const list = s.allowlist.filter((d) => !(host === d || host.endsWith('.' + d)));
        if (allowlisted) list.push(host);
        s.allowlist = Array.from(new Set(list)).sort();
      });
      await scheduleApply('allowlist');
      return { ok: true };
    },

    async setAllowlist({ hosts }) {
      await ABD.settings.update((s) => { s.allowlist = Array.from(new Set((hosts || []).map(ABD.settings.siteKey).filter(Boolean))).sort(); });
      await scheduleApply('allowlist');
      return { ok: true };
    },

    async setEnabledLists({ ids }) {
      const index = await ABD.dnr.loadIndex();
      const b = ABD.dnr.checkBudget(ids, index);
      if (!b.ok) return { ok: false, error: `Over budget: ${b.cost} converted rules (limit ~${b.budget}). Disable another list first.`, budget: b };
      await ABD.settings.update((s) => { s.enabledLists = ids; });
      await scheduleApply('lists');
      return { ok: true, budget: b };
    },

    async setCustomRules({ text }) {
      await ABD.settings.update((s) => { s.customRules = String(text || ''); });
      await scheduleApply('custom');
      const st = await api.storage.local.get('customRuleErrors');
      return { ok: true, errors: st.customRuleErrors || [] };
    },

    async addCustomRule({ rule }) {
      await ABD.settings.update((s) => { s.customRules = (s.customRules.replace(/\s+$/, '') + '\n' + rule).replace(/^\n/, ''); });
      await scheduleApply('custom');
      return { ok: true };
    },

    async setDarkDefaults({ dark }) {
      await ABD.settings.update((s) => { s.dark = Object.assign({}, s.dark, dark); });
      await scheduleApply('dark-defaults');
      return { ok: true };
    },

    async setSites({ sites }) {
      await ABD.settings.update((s) => { s.sites = sites || {}; });
      await scheduleApply('sites');
      return { ok: true };
    },

    async setPaused({ paused }) {
      await ABD.settings.update((s) => { s.blockingPaused = !!paused; });
      await scheduleApply('pause');
      return { ok: true };
    },

    async nativeDark(msg, sender) {
      const host = ABD.settings.siteKey(msg.host || (sender.url || ''));
      if (!host) return { ok: false };
      await ABD.settings.update((s) => {
        if (s.sites[host] && s.sites[host].dark === 'on') return;
        if (!s.nativeDark.includes(host)) s.nativeDark = s.nativeDark.concat([host]).slice(-500);
      });
      return { ok: true };
    },

    async clearNativeDark() {
      await ABD.settings.update((s) => { s.nativeDark = []; });
      return { ok: true };
    },

    async cosmeticReport(msg, sender) {
      if (sender.tab && sender.frameId === 0) ABD.stats.onCosmetic(sender.tab.id, msg.count || 0);
      return { ok: true };
    },

    async getGenericSelectors({ exceptions }) {
      const settings = await ABD.settings.get();
      const index = await ABD.dnr.loadIndex();
      const ids = ABD.dnr.enabledListIds(settings, index);
      return { selectors: await ABD.cosmeticStore.genericSelectors(ids, exceptions) };
    },

    async fetchCSS({ url }) {
      if (!/^https?:/.test(url || '')) return { ok: false };
      return fetchText(url);
    },

    async startPicker({ tabId }) {
      await api.scripting.executeScript({ target: { tabId }, files: ['content/picker.js'] });
      return { ok: true };
    },

    async reloadTab({ tabId }) {
      await api.tabs.reload(tabId);
      return { ok: true };
    },

    async syncNow() { return ABD.nativeSync.sync(true); },
    async resetStats() { await ABD.stats.reset(); return { ok: true }; },
    async reapply() { await scheduleApply('manual', true); return { ok: true, error: lastApplyError }; },

    async probe() { return runProbe(); },
  };

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const h = msg && handlers[msg.type];
    if (!h) return false;
    Promise.resolve(h(msg, sender)).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  });

  // ---------------- capability probe (Milestone 0) ----------------

  async function runProbe() {
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
    const dnr = api.declarativeNetRequest;
    rec('declarativeNetRequest API', !!dnr);
    if (dnr) {
      rec('MAX_NUMBER_OF_STATIC_RULESETS', dnr.MAX_NUMBER_OF_STATIC_RULESETS !== undefined, dnr.MAX_NUMBER_OF_STATIC_RULESETS);
      rec('MAX_NUMBER_OF_ENABLED_STATIC_RULESETS', dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS !== undefined, dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS);
      rec('MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES', (dnr.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || dnr.MAX_NUMBER_OF_DYNAMIC_RULES) !== undefined, dnr.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || dnr.MAX_NUMBER_OF_DYNAMIC_RULES);
      try { const e = await dnr.getEnabledRulesets(); rec('getEnabledRulesets', true, e.join(', ')); } catch (e) { rec('getEnabledRulesets', false, e.message); }
      try { const d = await dnr.getDynamicRules(); rec('getDynamicRules', true, d.length + ' rules'); } catch (e) { rec('getDynamicRules', false, e.message); }
      try { const m = await dnr.getMatchedRules({}); rec('getMatchedRules (blocked-count stats)', true, ((m && m.rulesMatchedInfo) || []).length + ' matches'); } catch (e) { rec('getMatchedRules (blocked-count stats)', false, e.message); }
      try { const r = await dnr.isRegexSupported({ regex: '^https?://ads[0-9]+\\.example\\.com/' }); rec('isRegexSupported', !!r && r.isSupported !== false, JSON.stringify(r)); } catch (e) { rec('isRegexSupported', false, e.message); }
      rec('setExtensionActionOptions (badge count)', typeof dnr.setExtensionActionOptions === 'function');
    }
    rec('scripting.registerContentScripts', !!(api.scripting && api.scripting.registerContentScripts));
    try {
      await api.scripting.registerContentScripts([{ id: 'abd-probe-main', matches: ['*://probe.invalid/*'], js: ['content/probe-main.js'], world: 'MAIN', runAt: 'document_start', persistAcrossSessions: false }]);
      rec('registerContentScripts world:MAIN (scriptlets)', true);
      await api.scripting.unregisterContentScripts({ ids: ['abd-probe-main'] });
    } catch (e) { rec('registerContentScripts world:MAIN (scriptlets)', false, e.message); }
    try {
      await api.scripting.registerContentScripts([{ id: 'abd-probe-ex', matches: ['<all_urls>'], excludeMatches: ['*://*.example.com/*'], css: ['content/probe.css'], runAt: 'document_start', persistAcrossSessions: false }]);
      rec('registerContentScripts excludeMatches', true);
      await api.scripting.unregisterContentScripts({ ids: ['abd-probe-ex'] });
    } catch (e) { rec('registerContentScripts excludeMatches', false, e.message); }
    try {
      const regs = await api.scripting.getRegisteredContentScripts();
      rec('registered abd-* scripts', true, regs.filter((r) => r.id.startsWith('abd-')).map((r) => r.id).join(', ') || 'none');
    } catch (e) { rec('getRegisteredContentScripts', false, e.message); }
    const st = await api.storage.local.get(['registrationErrors', 'customRuleErrors', 'cosmeticBuiltAt']);
    rec('registration errors', !(st.registrationErrors || []).length, (st.registrationErrors || []).join(' | ') || 'none');
    const index = await ABD.dnr.loadIndex();
    rec('cosmetic data loaded into storage', st.cosmeticBuiltAt === index.builtAt, st.cosmeticBuiltAt || 'not yet');
    try {
      const est = await navigator.storage.estimate();
      rec('storage estimate', true, Math.round((est.usage || 0) / 1024) + ' KB used');
    } catch (_) { /* ignore */ }
    const native = await ABD.nativeSync.probe();
    rec('native messaging', !!(native && native.ok), JSON.stringify(native));
    if (native && native.ok) {
      rec('App Group container (host app sync)', !!native.appGroup, native.appGroupId || native.appGroupError || '');
      rec('SFContentBlockerManager from extension', native.contentBlockerManager !== false, native.contentBlockerDetail || '');
    }
    const settings = await ABD.settings.get();
    const enabled = ABD.dnr.enabledListIds(settings, index);
    const b = ABD.dnr.checkBudget(enabled, index);
    rec('rule budget', b.ok, `${b.cost} converted WebKit rules for ${enabled.length} lists (cap ${b.hardCap})`);
    return { results: out, userAgent: navigator.userAgent, at: new Date().toISOString(), version: api.runtime.getManifest().version };
  }

  // Background page may be (re)started by any event; make sure state is applied.
  scheduleApply('wake');
})(globalThis);
