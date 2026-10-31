/*
 * native-sync.js — two-way sync with the SwiftUI host app through the
 * extension's native handler (SafariWebExtensionHandler.swift) and an App Group.
 *
 *   extension ──sendNativeMessage({type:'sync', state})──▶ handler
 *     handler writes  <AppGroup>/state.json      (host app reads it)
 *     handler reads   <AppGroup>/inbox.json      (host app writes edits there)
 *   handler ──{ok, appGroup, inbox}──▶ extension merges inbox if inbox.rev is new
 *
 * If App Groups are unavailable (free account limitation, or entitlement not
 * set), the handler answers {ok:true, appGroup:false} and the extension's own
 * Options page remains the management UI.
 */
(function (root) {
  'use strict';
  const ABD = root.ABD || (root.ABD = {});
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const MIN_INTERVAL_MS = 20000;
  let lastSync = 0;
  let inFlight = null;
  let lastResult = null;

  async function buildState() {
    const settings = await ABD.settings.get();
    const index = await ABD.dnr.loadIndex();
    const enabled = ABD.dnr.enabledListIds(settings, index);
    const st = await api.storage.local.get(['customRuleErrors', 'registrationErrors']);
    return {
      schema: 1,
      extensionVersion: api.runtime.getManifest().version,
      generatedAt: new Date().toISOString(),
      settings,
      lists: index.lists.map((l) => ({
        id: l.id, name: l.name, group: l.group, engine: l.engine, defaultEnabled: l.defaultEnabled,
        enabled: enabled.includes(l.id), webkitCost: l.webkitCost, dnrRules: l.dnrRules, builtAt: l.builtAt,
      })),
      budget: ABD.dnr.checkBudget(enabled, index),
      filtersBuiltAt: index.builtAt,
      stats: await ABD.stats.get(),
      errors: { customRules: st.customRuleErrors || [], registrations: st.registrationErrors || [] },
    };
  }

  function mergeInbox(s, inbox) {
    if (Array.isArray(inbox.enabledLists)) s.enabledLists = inbox.enabledLists;
    if (typeof inbox.customRules === 'string') s.customRules = inbox.customRules;
    if (Array.isArray(inbox.allowlist)) s.allowlist = inbox.allowlist.map(ABD.settings.siteKey).filter(Boolean);
    if (inbox.dark && typeof inbox.dark === 'object') s.dark = Object.assign({}, s.dark, inbox.dark);
    if (inbox.sites && typeof inbox.sites === 'object') s.sites = inbox.sites;
    if (typeof inbox.blockingPaused === 'boolean') s.blockingPaused = inbox.blockingPaused;
    s.hostRevApplied = inbox.rev;
    return s;
  }

  async function sync(force) {
    if (inFlight) return inFlight;
    if (!force && Date.now() - lastSync < MIN_INTERVAL_MS) return lastResult;
    inFlight = (async () => {
      lastSync = Date.now();
      let res;
      try {
        res = await api.runtime.sendNativeMessage('application.id', { type: 'sync', state: await buildState() });
      } catch (e) {
        lastResult = { ok: false, error: String(e && e.message || e) };
        return lastResult;
      }
      lastResult = Object.assign({ at: new Date().toISOString() }, res || { ok: false, error: 'no response' });
      const inbox = res && res.inbox;
      const settings = await ABD.settings.get();
      if (inbox && typeof inbox.rev === 'number' && inbox.rev > (settings.hostRevApplied || 0)) {
        await ABD.settings.update((s) => mergeInbox(s, inbox));
        if (inbox.resetStats) await ABD.stats.reset();
        // Report the merged state back right away so the app sees it applied.
        setTimeout(() => sync(true), 500);
      }
      await api.storage.local.set({ lastNativeSync: lastResult });
      return lastResult;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function probe() {
    try {
      return await api.runtime.sendNativeMessage('application.id', { type: 'probe' });
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  ABD.nativeSync = { sync, probe, last: () => lastResult };
})(globalThis);
