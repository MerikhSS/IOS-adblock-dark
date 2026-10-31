/*
 * dnr.js — static ruleset enablement + dynamic rules (allowlist, custom rules).
 *
 * Budget: Safari compiles all enabled static + dynamic rules into ONE WebKit
 * content rule list capped at 150,000 converted rules. If the compiled list
 * exceeds that, Safari fails to load it and NOTHING is blocked. So we refuse
 * to enable lists past the budget from rules/index.json.
 */
(function (root) {
  'use strict';
  const ABD = root.ABD || (root.ABD = {});
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const DNR = ABD.dnrConvert;
  const FP = ABD.filterParser;

  const HARD_CAP = 150000;
  let indexCache = null;

  async function loadIndex() {
    if (!indexCache) {
      const res = await fetch(api.runtime.getURL('rules/index.json'));
      indexCache = await res.json();
    }
    return indexCache;
  }

  function enabledListIds(settings, index) {
    const all = index.lists;
    const ids = Array.isArray(settings.enabledLists) ? settings.enabledLists : all.filter((l) => l.defaultEnabled).map((l) => l.id);
    return ids.filter((id) => all.some((l) => l.id === id && l.engine === 'dnr'));
  }

  function costOf(ids, index) {
    return index.lists.filter((l) => ids.includes(l.id)).reduce((n, l) => n + l.webkitCost, 0);
  }

  /** Returns {ok, cost, budget} for a proposed set of list ids. */
  function checkBudget(ids, index, dynamicCost) {
    const budget = (index.budget && index.budget.dnrWebKitRules) || 135000;
    const cost = costOf(ids, index) + (dynamicCost || 0);
    return { ok: cost <= HARD_CAP - 1000 && costOf(ids, index) <= budget + 10000, cost, budget, hardCap: HARD_CAP };
  }

  async function applyRulesets(settings) {
    const index = await loadIndex();
    const want = settings.blockingPaused ? [] : enabledListIds(settings, index);
    const current = await api.declarativeNetRequest.getEnabledRulesets();
    const enable = want.filter((id) => !current.includes(id));
    const disable = current.filter((id) => !want.includes(id));
    if (enable.length || disable.length) {
      // Disable first so the combined list never transiently exceeds the cap.
      if (disable.length) await api.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: disable });
      if (enable.length) await api.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enable });
    }
    return want;
  }

  /**
   * Parse the user's custom rules. Network filters -> dynamic DNR rules,
   * cosmetic/scriptlet filters -> returned for cosmetic-store.
   */
  function compileCustom(text) {
    const errors = [];
    const rules = [];
    const cosmetic = [];
    const lines = String(text || '').split(/\r?\n/);
    lines.forEach((line, i) => {
      const f = FP.parseFilter(line);
      if (f.type === 'comment') return;
      if (f.type === 'unsupported') { errors.push({ line: i + 1, text: line, reason: f.reason }); return; }
      if (f.type === 'network') {
        const r = DNR.convertNetworkFilter(f);
        if (r.skip) { errors.push({ line: i + 1, text: line, reason: r.skip }); return; }
        for (const rule of r.rules) {
          // Custom rules outrank every list rule (but not the allowlist).
          const t = rule.action.type;
          rule.priority = t === 'allow' || t === 'allowAllRequests' ? 5100 : (f.options.important ? 5200 : 5000);
          rule._line = i + 1;
          rules.push(rule);
        }
        if (r.meta) cosmetic.push({ meta: r.meta });
        return;
      }
      cosmetic.push(f);
    });
    return { rules, cosmetic, errors };
  }

  function allowlistRules(hosts) {
    if (!hosts.length) return [];
    const domains = hosts.map((h) => FP.toASCIIHost(h)).filter(Boolean);
    if (!domains.length) return [];
    return [
      // Allow the page itself and everything it loads (Safari 26.0 fixed priority handling).
      { priority: DNR.PRIORITY.allowlist, action: { type: 'allowAllRequests' }, condition: { requestDomains: domains, resourceTypes: ['main_frame', 'sub_frame'] } },
      // Belt and braces for subresources initiated by allowlisted frames.
      { priority: DNR.PRIORITY.allowlist, action: { type: 'allow' }, condition: { initiatorDomains: domains } },
    ];
  }

  function sortObj(o) {
    if (Array.isArray(o)) return o.map(sortObj);
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = sortObj(o[k]);
    return out;
  }

  let lastDynamicErrors = [];
  let allowRuleCount = 0;

  async function applyDynamic(settings) {
    const custom = settings.blockingPaused ? { rules: [], errors: [], cosmetic: [] } : compileCustom(settings.customRules);
    const allowRules = allowlistRules(settings.allowlist);
    allowRuleCount = allowRules.length;
    let rules = allowRules.concat(custom.rules);

    // Validate regex rules with Safari itself when possible.
    if (api.declarativeNetRequest.isRegexSupported) {
      const checked = [];
      for (const r of rules) {
        if (r.condition.regexFilter) {
          try {
            const res = await api.declarativeNetRequest.isRegexSupported({ regex: r.condition.regexFilter, isCaseSensitive: !!r.condition.isUrlFilterCaseSensitive });
            if (res && res.isSupported === false) {
              custom.errors.push({ line: r._line, text: r.condition.regexFilter, reason: 'Safari rejected regex: ' + (res.reason || 'unsupported') });
              continue;
            }
          } catch (_) { /* older Safari: keep */ }
        }
        checked.push(r);
      }
      rules = checked;
    }

    const maxDyn = api.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || api.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 30000;
    if (rules.length > maxDyn) {
      custom.errors.push({ line: 0, text: '', reason: `Too many dynamic rules (${rules.length} > ${maxDyn}); extra rules ignored` });
      rules = rules.slice(0, maxDyn);
    }

    rules.forEach((r, i) => { r.id = i + 1; delete r._line; });
    const existing = await api.declarativeNetRequest.getDynamicRules();
    // Every update makes Safari recompile the WHOLE content rule list (static
    // + dynamic, ~100k+ rules), so never touch it when nothing changed.
    const canon = (list) => JSON.stringify(list.map((r) => ({ id: r.id, priority: r.priority, action: r.action, condition: sortObj(r.condition) })));
    // Compare against what we last wrote (Safari may normalize returned rules).
    const wanted = canon(rules);
    const stored = (await api.storage.local.get('dynamicRulesHash')).dynamicRulesHash;
    if (stored === wanted && existing.length === rules.length) {
      lastDynamicErrors = custom.errors;
      await api.storage.local.set({ customRuleErrors: custom.errors });
      return { cosmetic: custom.cosmetic, errors: custom.errors, dynamicCost: rules.reduce((n, r) => n + DNR.webkitCost(r), 0), unchanged: true };
    }
    try {
      await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
      await api.storage.local.set({ dynamicRulesHash: wanted });
    } catch (e) {
      // One bad rule rejects the whole update: fall back to allowlist only.
      custom.errors.push({ line: 0, text: '', reason: 'Safari rejected custom rules: ' + e.message + ' — only the allowlist is active' });
      const safe = allowlistRules(settings.allowlist);
      safe.forEach((r, i) => { r.id = i + 1; });
      await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: safe });
      await api.storage.local.set({ dynamicRulesHash: null });
    }
    lastDynamicErrors = custom.errors;
    await api.storage.local.set({ customRuleErrors: custom.errors });
    return { cosmetic: custom.cosmetic, errors: custom.errors, dynamicCost: rules.reduce((n, r) => n + DNR.webkitCost(r), 0) };
  }

  async function enableBadge() {
    try {
      if (api.declarativeNetRequest.setExtensionActionOptions) {
        await api.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
        return true;
      }
    } catch (e) { console.warn('badge', e); }
    return false;
  }

  /** Count blocked requests for a tab via getMatchedRules (needs declarativeNetRequestFeedback). */
  async function matchedCount(tabId, minTimeStamp) {
    try {
      const r = await api.declarativeNetRequest.getMatchedRules({ tabId, minTimeStamp });
      const list = (r && r.rulesMatchedInfo) || [];
      // Dynamic rules 1..allowRuleCount are the allowlist ("allow", not "blocked").
      return list.filter((m) => !(m.rule && m.rule.rulesetId === '_dynamic' && m.rule.ruleId <= allowRuleCount)).length;
    } catch (e) {
      return null;
    }
  }

  ABD.dnr = { loadIndex, enabledListIds, checkBudget, costOf, applyRulesets, applyDynamic, compileCustom, enableBadge, matchedCount, errors: () => lastDynamicErrors, HARD_CAP };
})(globalThis);
