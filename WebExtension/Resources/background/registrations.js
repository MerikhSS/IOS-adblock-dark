/*
 * registrations.js — keeps dynamically registered content scripts in sync with
 * settings (scripting.registerContentScripts, Safari 16.4+; excludeMatches is
 * honoured since Safari 26.0).
 *
 * Why registration instead of reading storage in a content script?
 *   Safari injects registered CSS before first paint. Reading storage first is
 *   async and would cause a white flash on dark sites. So the decision "dark or
 *   not on this host" is encoded in match patterns, not computed at load time.
 *
 * Registered IDs (all prefixed "abd-"):
 *   abd-dark-filter        CSS-filter dark engine (top frame only)
 *   abd-dark-dynamic       Dark Reader engine (all frames)
 *   abd-generic-css        static generic element hiding for enabled lists
 *   abd-sl-<file>          MAIN-world scriptlet shards for enabled lists
 */
(function (root) {
  'use strict';
  const ABD = root.ABD || (root.ABD = {});
  const api = typeof browser !== 'undefined' ? browser : chrome;

  function patternsFor(host) {
    if (!host) return [];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost' || host.includes(':')) {
      return [`*://${host}/*`];
    }
    return [`*://*.${host}/*`];
  }
  function patternsForHosts(hosts) {
    return Array.from(new Set(hosts.flatMap(patternsFor)));
  }

  function darkRegistrations(settings) {
    const regs = [];
    const def = settings.dark.engine;
    const sites = settings.sites || {};
    const entries = Object.entries(sites);
    const forcedOn = entries.filter(([, s]) => s.dark === 'on').map(([h]) => h);
    const off = entries.filter(([, s]) => s.dark === 'off').map(([h]) => h);
    const engineOf = (h) => (sites[h] && sites[h].engine) || def;

    for (const engine of ['filter', 'dynamic']) {
      let matches = [];
      let exclude = [];
      if (settings.dark.defaultOn) {
        if (engine === def) {
          matches = ['<all_urls>'];
          const otherEngine = entries.filter(([h, s]) => s.engine && s.engine !== def).map(([h]) => h);
          const native = settings.dark.autoNative ? settings.nativeDark.filter((h) => !forcedOn.includes(h)) : [];
          exclude = patternsForHosts(off.concat(otherEngine, native));
        } else {
          matches = patternsForHosts(entries.filter(([h, s]) => s.engine === engine && s.dark !== 'off').map(([h]) => h));
        }
      } else {
        matches = patternsForHosts(forcedOn.filter((h) => engineOf(h) === engine));
      }
      if (!matches.length) continue;
      if (engine === 'filter') {
        regs.push({
          id: 'abd-dark-filter', matches, excludeMatches: exclude.length ? exclude : undefined,
          css: ['content/dark-filter.css'], js: ['content/dark.js'],
          runAt: 'document_start', allFrames: false, persistAcrossSessions: true,
        });
      } else {
        regs.push({
          id: 'abd-dark-dynamic', matches, excludeMatches: exclude.length ? exclude : undefined,
          css: ['content/dark-dynamic-early.css'], js: ['vendor/darkreader.js', 'content/dark-dynamic.js'],
          runAt: 'document_start', allFrames: true, persistAcrossSessions: true,
        });
      }
    }
    return regs;
  }

  async function loadJSON(path) {
    const res = await fetch(api.runtime.getURL(path));
    if (!res.ok) throw new Error('fetch ' + path + ' ' + res.status);
    return res.json();
  }

  const excludeCache = new Map();
  async function excludeHostsFor(listId) {
    if (!excludeCache.has(listId)) {
      try { excludeCache.set(listId, await loadJSON(`cosmetic/${listId}.exclude.json`)); } catch (_) { excludeCache.set(listId, []); }
    }
    return excludeCache.get(listId);
  }

  async function cosmeticRegistrations(settings, enabledLists, index) {
    const regs = [];
    if (settings.blockingPaused) return regs;
    const allow = patternsForHosts(settings.allowlist);
    const lists = index.lists.filter((l) => enabledLists.includes(l.id));

    const css = lists.filter((l) => l.genericSelectors > 0).map((l) => `cosmetic/${l.id}.generic.css`);
    if (css.length) {
      const exclude = new Set(allow);
      for (const l of lists) for (const h of await excludeHostsFor(l.id)) patternsFor(h).forEach((p) => exclude.add(p));
      regs.push({
        id: 'abd-generic-css', matches: ['<all_urls>'], excludeMatches: exclude.size ? Array.from(exclude) : undefined,
        css, runAt: 'document_start', allFrames: true, persistAcrossSessions: true,
      });
    }

    for (const l of lists) {
      if (!l.hasScriptlets) continue;
      let shards = [];
      try { shards = await loadJSON(`scriptlets/${l.id}.index.json`); } catch (_) { continue; }
      for (const s of shards) {
        regs.push({
          id: 'abd-sl-' + s.file.replace(/^scriptlets\//, '').replace(/\.js$/, ''),
          matches: s.matches, excludeMatches: allow.length ? allow : undefined,
          js: [s.file], world: 'MAIN', runAt: 'document_start', allFrames: true, persistAcrossSessions: true,
        });
      }
    }
    return regs;
  }

  function hashRegs(regs) {
    // cheap stable hash to avoid re-registering identical sets
    const s = JSON.stringify(regs);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return s.length + ':' + h;
  }

  let running = Promise.resolve();
  let lastErrors = [];

  /** Bring registered scripts in line with settings. Safe to call often. */
  function sync(settings, enabledLists, index, force) {
    running = running.then(() => doSync(settings, enabledLists, index, force)).catch((e) => {
      console.error('registrations.sync', e);
      lastErrors.push(String(e && e.message || e));
    });
    return running;
  }

  async function doSync(settings, enabledLists, index, force) {
    lastErrors = [];
    const desired = darkRegistrations(settings).concat(await cosmeticRegistrations(settings, enabledLists, index));
    for (const r of desired) for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
    const hash = hashRegs(desired);
    const stored = await api.storage.local.get('registrationHash');
    const current = await api.scripting.getRegisteredContentScripts();
    const ours = current.filter((c) => c.id.startsWith('abd-'));
    if (!force && stored.registrationHash === hash && ours.length === desired.length) return;

    if (ours.length) await api.scripting.unregisterContentScripts({ ids: ours.map((c) => c.id) });
    // Register one by one so a single failure (e.g. world:MAIN unsupported) doesn't sink the rest.
    for (const r of desired) {
      try {
        await api.scripting.registerContentScripts([r]);
      } catch (e) {
        if (r.world === 'MAIN') {
          lastErrors.push(`${r.id}: ${e.message} (MAIN world scriptlets unavailable)`);
        } else {
          lastErrors.push(`${r.id}: ${e.message}`);
        }
      }
    }
    await api.storage.local.set({ registrationHash: hash, registrationErrors: lastErrors });
  }

  ABD.registrations = { sync, darkRegistrations, patternsFor, patternsForHosts, errors: () => lastErrors };
})(globalThis);
