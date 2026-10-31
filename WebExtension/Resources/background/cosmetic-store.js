/*
 * cosmetic-store.js — puts site-specific cosmetic data where content scripts
 * can read it quickly without waking the background page:
 *   storage.local["c:<listId>:<hostKey>"] = Entry   (see lib/cosmetic-compile.js)
 *   storage.local["cosmeticLists"]           = enabled list ids (+ "custom")
 *   storage.local["customGeneric"]           = user generic selectors
 * Content scripts read 2 small batches of keys per frame.
 */
(function (root) {
  'use strict';
  const ABD = root.ABD || (root.ABD = {});
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const CC = ABD.cosmeticCompile;

  const CHUNK = 2000;

  async function loadJSON(path) {
    const res = await fetch(api.runtime.getURL(path));
    if (!res.ok) throw new Error(path + ' ' + res.status);
    return res.json();
  }

  async function setInChunks(obj) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i += CHUNK) {
      const part = {};
      for (const k of keys.slice(i, i + CHUNK)) part[k] = obj[k];
      await api.storage.local.set(part);
    }
  }

  async function allKeys() {
    if (api.storage.local.getKeys) {
      try { return await api.storage.local.getKeys(); } catch (_) { /* fall through */ }
    }
    return Object.keys(await api.storage.local.get(null));
  }

  let loading = null;

  /** (Re)load bundled list data into storage when the bundle changed (install/update). */
  function ensureListData(index) {
    if (loading) return loading;
    loading = (async () => {
      const st = await api.storage.local.get('cosmeticBuiltAt');
      if (st.cosmeticBuiltAt === index.builtAt) return false;
      const keep = new Set();
      for (const l of index.lists) {
        let spec;
        try { spec = await loadJSON(`cosmetic/${l.id}.specific.json`); } catch (e) { console.warn(e); continue; }
        const batch = {};
        for (const [k, v] of Object.entries(spec)) { const key = `c:${l.id}:${k}`; batch[key] = v; keep.add(key); }
        await setInChunks(batch);
      }
      const stale = (await allKeys()).filter((k) => k.startsWith('c:') && !k.startsWith('c:custom:') && !keep.has(k));
      for (let i = 0; i < stale.length; i += CHUNK) await api.storage.local.remove(stale.slice(i, i + CHUNK));
      await api.storage.local.set({ cosmeticBuiltAt: index.builtAt });
      return true;
    })().finally(() => { loading = null; });
    return loading;
  }

  let customSpecific = {};

  /** Compile the user's custom cosmetic/scriptlet filters into storage. */
  async function applyCustom(items) {
    const hash = JSON.stringify(items.map((x) => x.raw || x.meta));
    const st = await api.storage.local.get('customCosmeticHash');
    if (st.customCosmeticHash === hash) return null;
    const filters = items.filter((x) => !x.meta);
    const metas = items.filter((x) => x.meta).map((x) => x.meta);
    const cc = CC.compileCosmetic(filters, metas, { supportedScriptlets: new Set(ABD.scriptletRunner.SUPPORTED) });
    customSpecific = cc.specific;
    const old = (await allKeys()).filter((k) => k.startsWith('c:custom:'));
    if (old.length) await api.storage.local.remove(old);
    const batch = {};
    for (const [k, v] of Object.entries(cc.specific)) batch['c:custom:' + k] = v;
    await setInChunks(batch);
    await api.storage.local.set({ customGeneric: cc.genericHide, customGenericScriptlets: cc.genericScriptlets, customCosmeticHash: hash });
    return cc;
  }

  async function setEnabledLists(ids, settings) {
    const lists = settings.blockingPaused ? [] : ids.concat(['custom']);
    await api.storage.local.set({ cosmeticLists: lists });
  }

  const genericCache = new Map();
  /** Generic selectors for hosts excluded from the static CSS, minus that host's exceptions. */
  async function genericSelectors(enabledIds, exceptions) {
    const ex = new Set(exceptions || []);
    const out = [];
    for (const id of enabledIds) {
      if (!genericCache.has(id)) {
        try { genericCache.set(id, await loadJSON(`cosmetic/${id}.generic.json`)); } catch (_) { genericCache.set(id, []); }
      }
      for (const s of genericCache.get(id)) if (!ex.has(s)) out.push(s);
    }
    return out;
  }

  /** Scriptlet calls from the user's custom rules for a hostname (run via executeScript). */
  async function customScriptletsFor(hostname) {
    if (!Object.keys(customSpecific).length) {
      const keys = (await allKeys()).filter((k) => k.startsWith('c:custom:'));
      const data = keys.length ? await api.storage.local.get(keys) : {};
      customSpecific = {};
      for (const [k, v] of Object.entries(data)) customSpecific[k.slice('c:custom:'.length)] = v;
    }
    const res = CC.resolveForHost(hostname, (k) => customSpecific[k]);
    const st = await api.storage.local.get('customGenericScriptlets');
    return (st.customGenericScriptlets || []).concat(res.scriptlets);
  }

  ABD.cosmeticStore = { ensureListData, applyCustom, setEnabledLists, genericSelectors, customScriptletsFor };
})(globalThis);
