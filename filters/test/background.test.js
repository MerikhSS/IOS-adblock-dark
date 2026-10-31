'use strict';
/*
 * Runs the real background scripts (WebExtension/Resources/background/*.js)
 * inside a vm sandbox with a mocked Safari `browser.*` API, and checks the
 * DNR / registration / sync behaviour that is hard to debug on a phone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RES = path.resolve(__dirname, '../../WebExtension/Resources');
const manifest = JSON.parse(fs.readFileSync(path.join(RES, 'manifest.json'), 'utf8'));

function makeEnv(opts) {
  opts = opts || {};
  const store = {};
  const calls = { updateDynamicRules: 0, updateEnabledRulesets: [], register: [], native: [] };
  let enabledRulesets = manifest.declarative_net_request.rule_resources.filter((r) => r.enabled).map((r) => r.id);
  let dynamicRules = [];
  let registered = [];
  const listeners = { message: [], installed: [], startup: [], committed: [], completed: [] };
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  const browser = {
    storage: { local: {
      async get(keys) {
        if (keys === null || keys === undefined) return clone(store);
        if (typeof keys === 'string') keys = [keys];
        const out = {};
        for (const k of keys) if (k in store) out[k] = clone(store[k]);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = clone(v); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
      async getKeys() { return Object.keys(store); },
    } },
    declarativeNetRequest: {
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 30000,
      async getEnabledRulesets() { return enabledRulesets.slice(); },
      async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
        calls.updateEnabledRulesets.push({ enableRulesetIds, disableRulesetIds });
        enabledRulesets = enabledRulesets.filter((id) => !disableRulesetIds.includes(id)).concat(enableRulesetIds);
      },
      async getDynamicRules() { return clone(dynamicRules); },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        calls.updateDynamicRules++;
        if (opts.rejectDynamic && addRules.some((r) => r.priority === 5000)) throw new Error('invalid rule');
        dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id)).concat(clone(addRules));
      },
      async isRegexSupported() { return { isSupported: true }; },
      async setExtensionActionOptions() {},
      async getMatchedRules() { return { rulesMatchedInfo: [] }; },
    },
    scripting: {
      async getRegisteredContentScripts() { return clone(registered); },
      async registerContentScripts(list) { calls.register.push(...clone(list)); registered.push(...clone(list)); },
      async unregisterContentScripts({ ids }) { registered = registered.filter((r) => !ids.includes(r.id)); },
      async executeScript() {},
    },
    runtime: {
      getURL: (p) => 'file://' + path.join(RES, p),
      getManifest: () => manifest,
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      async sendNativeMessage(_id, msg) {
        calls.native.push(clone(msg));
        if (opts.native) return opts.native(msg);
        return { ok: true, appGroup: false };
      },
    },
    webNavigation: { onCommitted: { addListener: (f) => listeners.committed.push(f) }, onCompleted: { addListener: (f) => listeners.completed.push(f) } },
    tabs: { onRemoved: { addListener() {} }, async reload() {} },
  };

  const sandbox = {
    browser, console: { log() {}, warn() {}, error() {}, debug() {} }, URL, setTimeout, clearTimeout, navigator: { userAgent: 'test' },
    fetch: async (url) => {
      const p = url.replace(/^file:\/\//, '');
      const body = fs.readFileSync(p, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body, headers: { get: () => 'application/json' } };
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of manifest.background.scripts) vm.runInContext(fs.readFileSync(path.join(RES, f), 'utf8'), sandbox, { filename: f });

  const send = (msg, sender) => new Promise((resolve) => {
    for (const l of listeners.message) if (l(msg, sender || {}, resolve) === true) return;
    resolve(undefined);
  });
  const settle = () => new Promise((r) => setTimeout(r, 150));
  return { store, calls, send, settle, get dynamicRules() { return dynamicRules; }, get registered() { return registered; }, get enabledRulesets() { return enabledRulesets; }, listeners };
}

test('wake: default lists enabled, generic CSS + MAIN-world scriptlets registered, no dark', async () => {
  const env = makeEnv();
  await env.settle();
  const ids = env.registered.map((r) => r.id);
  assert.ok(ids.includes('abd-generic-css'));
  assert.ok(!ids.includes('abd-dark-filter'));
  const css = env.registered.find((r) => r.id === 'abd-generic-css');
  assert.ok(css.css.includes('cosmetic/easylist.generic.css'));
  assert.ok(!css.css.includes('cosmetic/liste-fr.generic.css'), 'disabled lists are not injected');
  const sl = env.registered.filter((r) => r.id.startsWith('abd-sl-'));
  assert.ok(sl.length > 0 && sl.every((r) => r.world === 'MAIN' && r.runAt === 'document_start'));
  assert.deepStrictEqual(env.dynamicRules, []);
  assert.ok(env.store.cosmeticBuiltAt, 'specific cosmetic data loaded into storage');
  assert.ok(Object.keys(env.store).some((k) => k.startsWith('c:ubo-filters:')));
  assert.deepStrictEqual(env.store.cosmeticLists.slice(-1), ['custom']);
});

test('per-site dark on → filter engine registered for that host only', async () => {
  const env = makeEnv();
  await env.settle();
  await env.send({ type: 'setSiteDark', host: 'https://www.news.example.org/a', mode: 'on' });
  await env.settle();
  const reg = env.registered.find((r) => r.id === 'abd-dark-filter');
  assert.deepStrictEqual(reg.matches, ['*://*.news.example.org/*']);
  assert.strictEqual(reg.allFrames, false);
  assert.deepStrictEqual(reg.css, ['content/dark-filter.css']);
  // switch that site to the dynamic engine
  await env.send({ type: 'setSiteDark', host: 'news.example.org', engine: 'dynamic' });
  await env.settle();
  assert.ok(!env.registered.find((r) => r.id === 'abd-dark-filter'));
  assert.deepStrictEqual(env.registered.find((r) => r.id === 'abd-dark-dynamic').matches, ['*://*.news.example.org/*']);
});

test('global dark default on → all sites except "off" ones', async () => {
  const env = makeEnv();
  await env.settle();
  await env.send({ type: 'setSiteDark', host: 'bright.com', mode: 'off' });
  await env.send({ type: 'setDarkDefaults', dark: { defaultOn: true } });
  await env.settle();
  const reg = env.registered.find((r) => r.id === 'abd-dark-filter');
  assert.deepStrictEqual(reg.matches, ['<all_urls>']);
  assert.deepStrictEqual(reg.excludeMatches, ['*://*.bright.com/*']);
  const st = await env.send({ type: 'getPopupState', url: 'https://bright.com/' });
  assert.strictEqual(st.dark.on, false);
  const st2 = await env.send({ type: 'getPopupState', url: 'https://other.com/' });
  assert.strictEqual(st2.dark.on, true);
});

test('auto-detected native dark sites are excluded but forced-on wins', async () => {
  const env = makeEnv();
  await env.settle();
  await env.send({ type: 'setDarkDefaults', dark: { defaultOn: true } });
  await env.send({ type: 'nativeDark', host: 'darksite.com' });
  await env.settle();
  assert.ok(env.registered.find((r) => r.id === 'abd-dark-filter').excludeMatches.includes('*://*.darksite.com/*'));
  await env.send({ type: 'setSiteDark', host: 'darksite.com', mode: 'on' });
  await env.settle();
  assert.strictEqual(env.registered.find((r) => r.id === 'abd-dark-filter').excludeMatches, undefined);
});

test('allowlist → allowAllRequests dynamic rule + excluded from cosmetics/scriptlets', async () => {
  const env = makeEnv();
  await env.settle();
  await env.send({ type: 'setAllowlisted', host: 'https://shop.example.com/', allowlisted: true });
  await env.settle();
  const aar = env.dynamicRules.find((r) => r.action.type === 'allowAllRequests');
  assert.deepStrictEqual(aar.condition, { requestDomains: ['shop.example.com'], resourceTypes: ['main_frame', 'sub_frame'] });
  assert.strictEqual(aar.priority, 10000);
  assert.ok(env.registered.find((r) => r.id === 'abd-generic-css').excludeMatches.includes('*://*.shop.example.com/*'));
  assert.ok(env.registered.filter((r) => r.id.startsWith('abd-sl-')).every((r) => r.excludeMatches.includes('*://*.shop.example.com/*')));
  const st = await env.send({ type: 'getPopupState', url: 'https://www.shop.example.com/x' });
  assert.strictEqual(st.allowlisted, true);
});

test('custom rules: network → dynamic, cosmetic → storage, errors reported', async () => {
  const env = makeEnv();
  await env.settle();
  const r = await env.send({ type: 'setCustomRules', text: '||evil-ads.test^\nexample.org##.sticky-ad\n##.my-generic\n||x.com^$popup\n! comment' });
  await env.settle();
  const block = env.dynamicRules.find((x) => x.condition.requestDomains && x.condition.requestDomains.includes('evil-ads.test'));
  assert.strictEqual(block.priority, 5000);
  assert.deepStrictEqual(env.store['c:custom:example.org'].h, [['.sticky-ad']]);
  assert.deepStrictEqual(env.store.customGeneric, ['.my-generic']);
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].line, 4);
});

test('re-applying unchanged settings does not recompile Safari rules', async () => {
  const env = makeEnv();
  await env.settle();
  await env.send({ type: 'setCustomRules', text: '||a.test^' });
  await env.settle();
  const before = env.calls.updateDynamicRules;
  await env.send({ type: 'reapply' });
  await env.settle();
  assert.strictEqual(env.calls.updateDynamicRules, before);
});

test('Safari rejecting custom rules falls back to allowlist-only', async () => {
  const env = makeEnv({ rejectDynamic: true });
  await env.settle();
  await env.send({ type: 'setAllowlisted', host: 'ok.com', allowlisted: true });
  const r = await env.send({ type: 'setCustomRules', text: '||bad.test^' });
  await env.settle();
  assert.ok(env.dynamicRules.every((x) => x.priority === 10000));
  assert.ok(r.errors.some((e) => /rejected/.test(e.reason)));
});

test('enabling lists past the rule budget is refused', async () => {
  const env = makeEnv();
  await env.settle();
  const index = JSON.parse(fs.readFileSync(path.join(RES, 'rules/index.json'), 'utf8'));
  const all = index.lists.filter((l) => l.engine === 'dnr').map((l) => l.id);
  const total = index.lists.filter((l) => l.engine === 'dnr').reduce((n, l) => n + l.webkitCost, 0);
  const r = await env.send({ type: 'setEnabledLists', ids: all });
  if (total > 149000) assert.strictEqual(r.ok, false);
  const ok = await env.send({ type: 'setEnabledLists', ids: ['easylist', 'easyprivacy'] });
  assert.strictEqual(ok.ok, true);
  await env.settle();
  assert.deepStrictEqual(env.enabledRulesets.sort(), ['easylist', 'easyprivacy']);
  assert.ok(env.registered.find((r) => r.id === 'abd-generic-css').css.every((c) => /easylist|easyprivacy/.test(c)));
});

test('pause disables every ruleset, cosmetics and scriptlets', async () => {
  const env = makeEnv();
  await env.settle();
  await env.send({ type: 'setPaused', paused: true });
  await env.settle();
  assert.deepStrictEqual(env.enabledRulesets, []);
  assert.ok(!env.registered.some((r) => r.id === 'abd-generic-css' || r.id.startsWith('abd-sl-')));
  assert.deepStrictEqual(env.store.cosmeticLists, []);
});

test('host-app inbox is merged once (rev), and state is published', async () => {
  let inbox = { rev: 3, allowlist: ['https://www.Bank.example/', 'news.test'], dark: { defaultOn: true }, customRules: '||t.test^' };
  const env = makeEnv({ native: (msg) => (msg.type === 'sync' ? { ok: true, appGroup: true, inbox } : { ok: true }) });
  await env.settle();
  await env.send({ type: 'syncNow' });
  await env.settle();
  const s = env.store.settings;
  assert.deepStrictEqual(s.allowlist, ['bank.example', 'news.test']);
  assert.strictEqual(s.dark.defaultOn, true);
  assert.strictEqual(s.hostRevApplied, 3);
  const last = env.calls.native.filter((m) => m.type === 'sync').pop();
  assert.ok(last.state.lists.length > 5 && last.state.settings);
  // same rev again → no change
  const rev = s.rev;
  inbox = Object.assign({}, inbox, { allowlist: ['changed.test'] });
  await env.send({ type: 'syncNow' });
  await env.settle();
  assert.strictEqual(env.store.settings.rev, rev);
});
