/*
 * dnr-convert.js — convert parsed network filters into Safari-compatible
 * declarativeNetRequest rules.
 *
 * Safari-specific constraints baked in here (verified against WebKit's
 * _WKWebExtensionDeclarativeNetRequestRule.mm):
 *   - resource types WebKit understands: main_frame sub_frame stylesheet script
 *     image font media ping websocket xmlhttprequest other  (no `object`,
 *     `csp_report`, `webtransport`, `webbundle`) — an empty resourceTypes array
 *     makes the rule INVALID, so we drop such filters.
 *   - regexFilter must be in WebKit's regex subset (see regex-subset.js).
 *   - initiatorDomains -> if-frame-url, requestDomains -> one WebKit rule each.
 *   - we never use the legacy `domains`/`excludedDomains` keys (they compile to
 *     if-domain, which can't be mixed with the if-top-url that allowAllRequests
 *     produces in the same list — WebKit bug 207540).
 *
 * Priorities (higher wins):
 *   10000 user allowlist (dynamic)     5000 user custom rules (dynamic)
 *    4000 $important                   3000 exceptions (@@)
 *    2000 redirect=                    1500 removeparam=
 *    1000 block / csp
 */
(function (root) {
  'use strict';

  const RS = (root.ABD && root.ABD.regexSubset) || (typeof require === 'function' ? require('./regex-subset.js') : null);
  const FP = (root.ABD && root.ABD.filterParser) || (typeof require === 'function' ? require('./filter-parser.js') : null);

  const PRIORITY = {
    allowlist: 10000, custom: 5000, important: 4000, exception: 3000,
    redirect: 2000, removeparam: 1500, block: 1000,
  };

  const TYPE_MAP = {
    script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
    xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest', subdocument: 'sub_frame',
    frame: 'sub_frame', ping: 'ping', beacon: 'ping', websocket: 'websocket', media: 'media',
    font: 'font', other: 'other', document: 'main_frame', doc: 'main_frame',
    object: null, 'object-subrequest': null, webrtc: null,
  };
  const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'media', 'ping', 'websocket', 'xmlhttprequest', 'other'];
  const DEFAULT_TYPES = ALL_TYPES.filter((t) => t !== 'main_frame');

  // uBO redirect resource names -> files shipped in Resources/surrogates/
  const SURROGATES = {
    'noopjs': 'noop.js', 'noop.js': 'noop.js', 'abp-resource:blank-js': 'noop.js', 'blank-js': 'noop.js',
    'noopframe': 'noop.html', 'noop.html': 'noop.html', 'abp-resource:blank-html': 'noop.html',
    'nooptext': 'noop.txt', 'noop.txt': 'noop.txt', 'abp-resource:blank-text': 'noop.txt',
    'noopcss': 'noop.css', 'noop.css': 'noop.css', 'abp-resource:blank-css': 'noop.css',
    'noop.json': 'noop.json', 'noopjson': 'noop.json',
    '1x1.gif': '1x1.gif', '1x1-transparent.gif': '1x1.gif', 'abp-resource:1x1-transparent-gif': '1x1.gif',
    '2x2.png': '2x2.png', '2x2-transparent.png': '2x2.png', 'abp-resource:2x2-transparent-png': '2x2.png',
    '3x2.png': '3x2.png', '3x2-transparent.png': '3x2.png', 'abp-resource:3x2-transparent-png': '3x2.png',
    '32x32.png': '32x32.png', '32x32-transparent.png': '32x32.png', 'abp-resource:32x32-transparent-png': '32x32.png',
    'google-analytics_analytics.js': 'google-analytics_analytics.js', 'google-analytics.com/analytics.js': 'google-analytics_analytics.js',
    'googletagmanager_gtm.js': 'google-analytics_analytics.js', 'googletagmanager.com/gtm.js': 'google-analytics_analytics.js',
    'google-analytics_ga.js': 'google-analytics_ga.js', 'google-analytics.com/ga.js': 'google-analytics_ga.js',
    'googletagservices_gpt.js': 'googletagservices_gpt.js', 'googletagservices.com/gpt.js': 'googletagservices_gpt.js',
    'googlesyndication_adsbygoogle.js': 'googlesyndication_adsbygoogle.js', 'googlesyndication.com/adsbygoogle.js': 'googlesyndication_adsbygoogle.js',
    'scorecardresearch_beacon.js': 'scorecardresearch_beacon.js', 'scorecardresearch.com/beacon.js': 'scorecardresearch_beacon.js',
    'amazon_apstag.js': 'amazon_apstag.js', 'amazon-adsystem.com/aax2/apstag.js': 'amazon_apstag.js',
  };

  function domainOpt(options, name) {
    const o = options[name];
    if (!o || o.value == null) return null;
    return FP.parseDomainList(o.value, '|');
  }

  /**
   * Convert one parsed network filter.
   * @returns {{rules: object[], meta?: object, skip?: string}}
   *   meta: cosmetic side-effects of exception filters (elemhide/generichide/specifichide/document)
   */
  function convertNetworkFilter(f, opts) {
    opts = opts || {};
    const o = f.options;
    const has = (n) => Object.prototype.hasOwnProperty.call(o, n);

    // --- unsupported options -> drop the whole filter ---
    for (const n of ['popup', 'popunder', 'redirect-rule', 'header', 'replace', 'urlskip', 'uritransform',
      'urltransform', 'permissions', 'cname', 'ipaddress', 'stealth', 'cookie', 'network', 'app', 'webrtc',
      'jsonprune', 'xmlprune', 'hls', 'extension', 'genericblock', 'content', 'redirect-url']) {
      if (has(n)) return { rules: [], skip: 'option ' + n };
    }

    // --- cosmetic-only exception options ---
    const metaFlags = {};
    for (const [n, flag] of [['elemhide', 'elemhide'], ['ehide', 'elemhide'], ['generichide', 'generichide'],
      ['ghide', 'generichide'], ['specifichide', 'specifichide'], ['shide', 'specifichide']]) {
      if (has(n)) metaFlags[flag] = true;
    }
    if (Object.keys(metaFlags).length) {
      if (!f.exception) return { rules: [], skip: 'cosmetic option on block filter' };
      const host = anchoredHost(f.pattern);
      if (!host) return { rules: [], skip: 'cosmetic exception without host' };
      // If only cosmetic flags (no types), it's purely a cosmetic exception.
      const onlyCosmetic = Object.keys(o).every((n) => ['elemhide', 'ehide', 'generichide', 'ghide', 'specifichide', 'shide', 'domain', 'from'].includes(n));
      if (onlyCosmetic) return { rules: [], meta: { host, flags: metaFlags } };
    }

    // --- action ---
    let action = { type: f.exception ? 'allow' : 'block' };
    let priority = f.exception ? PRIORITY.exception : PRIORITY.block;
    if (has('important') && !f.exception) priority = PRIORITY.important;

    const condition = {};
    let forcedTypes = null;
    let meta;

    // removeparam
    const rp = o.removeparam || o.queryprune;
    if (rp) {
      if (f.exception) return { rules: [], skip: 'removeparam exception' };
      const v = rp.value;
      if (rp.neg || !v || v[0] === '/' || v[0] === '~' || v.includes('|')) return { rules: [], skip: 'complex removeparam' };
      action = { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [v] } } } };
      priority = PRIORITY.removeparam;
      forcedTypes = ['main_frame', 'sub_frame', 'xmlhttprequest'];
    }

    // csp / inline-script / inline-font
    let csp = null;
    if (has('csp')) csp = o.csp.value;
    if (has('inline-script')) csp = "script-src 'self' * 'unsafe-eval' blob: data:";
    if (has('inline-font')) csp = 'font-src *';
    if (csp !== null) {
      if (f.exception) return { rules: [], skip: 'csp exception' };
      if (!csp) return { rules: [], skip: 'empty csp' };
      if (!anchoredHost(f.pattern) && !has('domain') && !has('from')) return { rules: [], skip: 'generic csp' };
      action = { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: csp }] };
      forcedTypes = ['main_frame', 'sub_frame'];
    }

    // redirect
    const red = o.redirect || o.rewrite || (has('empty') ? { value: '__empty' } : null) || (has('mp4') ? { value: '__mp4' } : null);
    if (red && !f.exception) {
      let name = (red.value || '').replace(/:\d+$/, '');
      let file = SURROGATES[name];
      if (name === '__empty') file = null;
      if (file) {
        action = { type: 'redirect', redirect: { extensionPath: '/surrogates/' + file } };
        priority = has('important') ? PRIORITY.important : PRIORITY.redirect;
      }
      // unknown resource -> plain block (uBO's redirect= also blocks)
    } else if (red && f.exception) {
      return { rules: [], skip: 'redirect exception' };
    }

    // resource types
    const included = new Set();
    const excluded = new Set();
    let sawUnsupportedType = false;
    for (const [n, v] of Object.entries(o)) {
      if (n === 'all') { if (!v.neg) ALL_TYPES.forEach((t) => included.add(t)); continue; }
      if (!(n in TYPE_MAP)) continue;
      const t = TYPE_MAP[n];
      if (t === null) { if (!v.neg) sawUnsupportedType = true; continue; }
      (v.neg ? excluded : included).add(t);
    }
    if (forcedTypes && !included.size) forcedTypes.forEach((t) => included.add(t));
    if (sawUnsupportedType && !included.size) return { rules: [], skip: 'only unsupported types' };

    // $document on exception = allowlist the whole page
    if (f.exception && included.has('main_frame') && (included.size === 1 || (included.size === 2 && included.has('sub_frame')))) {
      action = { type: 'allowAllRequests' };
      included.clear();
      included.add('main_frame');
      included.add('sub_frame');
      const host = anchoredHost(f.pattern);
      if (host) meta = { host, flags: { document: true } };
    }

    if (included.size) {
      let types = Array.from(included).filter((t) => !excluded.has(t));
      if (!types.length) return { rules: [], skip: 'empty types' };
      condition.resourceTypes = types.sort();
    } else if (excluded.size) {
      condition.excludedResourceTypes = Array.from(excluded).sort();
      if (DEFAULT_TYPES.every((t) => excluded.has(t))) return { rules: [], skip: 'all types excluded' };
    }

    if (action.type === 'redirect' && action.redirect.extensionPath && !condition.resourceTypes) {
      // Give redirects a sensible type scope (uBO infers from the resource).
      const file = action.redirect.extensionPath;
      condition.resourceTypes = /\.js$/.test(file) ? ['script'] : /\.(gif|png)$/.test(file) ? ['image']
        : /\.html$/.test(file) ? ['sub_frame'] : /\.css$/.test(file) ? ['stylesheet'] : ['xmlhttprequest', 'other'];
      delete condition.excludedResourceTypes;
    }

    // party
    const third = (has('third-party') && !o['third-party'].neg) || (has('3p') && !o['3p'].neg) || (has('strict3p'))
      || (has('first-party') && o['first-party'].neg) || (has('1p') && o['1p'].neg);
    const first = (has('first-party') && !o['first-party'].neg) || (has('1p') && !o['1p'].neg) || has('strict1p')
      || (has('third-party') && o['third-party'].neg) || (has('3p') && o['3p'].neg);
    if (third && !first) condition.domainType = 'thirdParty';
    else if (first && !third) condition.domainType = 'firstParty';

    // initiator domains
    const dom = domainOpt(o, 'domain') || domainOpt(o, 'from');
    if (dom) {
      if (dom.exclude.some(FP.isEntity)) return { rules: [], skip: 'entity exclusion' };
      const inc = dom.include.filter((d) => !FP.isEntity(d));
      if (dom.include.length && !inc.length) return { rules: [], skip: 'entity-only domains' };
      if (inc.length) condition.initiatorDomains = inc;
      if (dom.exclude.length) condition.excludedInitiatorDomains = dom.exclude;
      if (!inc.length && !dom.exclude.length) return { rules: [], skip: 'bad domain option' };
    }

    // request domains
    const to = domainOpt(o, 'to');
    if (to) {
      if (to.include.some(FP.isEntity) || to.exclude.some(FP.isEntity)) return { rules: [], skip: 'entity to=' };
      if (to.include.length) condition.requestDomains = to.include;
      if (to.exclude.length) condition.excludedRequestDomains = to.exclude;
    }
    const deny = domainOpt(o, 'denyallow');
    if (deny) {
      if (deny.include.some(FP.isEntity)) return { rules: [], skip: 'entity denyallow' };
      condition.excludedRequestDomains = (condition.excludedRequestDomains || []).concat(deny.include);
    }

    // methods
    if (has('method') && o.method.value) {
      const inc = [];
      const exc = [];
      for (let m of o.method.value.toLowerCase().split('|')) {
        const neg = m[0] === '~';
        m = m.replace(/^~/, '');
        if (!['get', 'head', 'options', 'trace', 'put', 'delete', 'post', 'patch', 'connect'].includes(m)) return { rules: [], skip: 'bad method' };
        (neg ? exc : inc).push(m);
      }
      if (inc.length) condition.requestMethods = inc;
      if (exc.length) condition.excludedRequestMethods = exc;
    }

    if (has('match-case')) condition.isUrlFilterCaseSensitive = true;

    // --- pattern ---
    const patterns = [];
    if (f.isRegex) {
      const r = RS.toWebKitRegexes(f.pattern.slice(1, -1));
      if (!r.ok) return { rules: [], skip: 'regex: ' + r.reason };
      for (const re of r.regexes) patterns.push({ regexFilter: re });
    } else {
      let p = f.pattern;
      if (/[^\x20-\x7e]/.test(p)) {
        // try punycoding the host part of ||host^ patterns
        const m = /^\|\|([^/^:?*|]+)(.*)$/.exec(p);
        if (!m) return { rules: [], skip: 'non-ascii pattern' };
        const h = FP.toASCIIHost(m[1]);
        if (!h || /[^\x20-\x7e]/.test(m[2])) return { rules: [], skip: 'non-ascii pattern' };
        p = '||' + h + m[2];
      }
      if (p.startsWith('||*')) p = p.slice(2);
      if (!p.startsWith('||') && !p.startsWith('|')) p = p.replace(/^\*+/, '');
      if (!p.endsWith('|')) p = p.replace(/\*+$/, '');
      if (p === '||' || p === '|') p = '';
      if (p === '' || p === '^' ) {
        const transformOnly = action.type === 'redirect' && action.redirect.transform;
        if (!condition.initiatorDomains && !condition.requestDomains && !transformOnly) {
          if (action.type !== 'allowAllRequests') return { rules: [], skip: 'matches everything' };
        }
        patterns.push({});
      } else {
        // Optimisation: plain "||host^" becomes requestDomains (merged later).
        const hm = /^\|\|([a-z0-9._-]+)\^?$/.exec(p);
        if (hm && !condition.requestDomains && !condition.isUrlFilterCaseSensitive && hm[1].includes('.') &&
            action.type !== 'allowAllRequests' && p.endsWith('^')) {
          patterns.push({ requestDomains: [hm[1]] });
        } else {
          patterns.push({ urlFilter: p });
        }
      }
    }

    const rules = patterns.map((pat) => ({
      priority,
      action: JSON.parse(JSON.stringify(action)),
      condition: Object.assign({}, condition, pat),
    }));
    return { rules, meta };
  }

  function anchoredHost(pattern) {
    const m = /^\|\|([a-z0-9.*_-]+)\^?\/?$/i.exec(pattern || '');
    if (!m || m[1].includes('*')) return null;
    return FP.toASCIIHost(m[1]);
  }

  // ---------- rule-set level helpers ----------

  function ruleKey(rule) {
    return JSON.stringify([rule.priority, rule.action, sortKeys(rule.condition)]);
  }
  function sortKeys(o) {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = Array.isArray(o[k]) ? o[k].slice().sort() : o[k];
    return out;
  }

  /** Merge rules that differ only by requestDomains (from `||host^`). Dedupes too. */
  function mergeRules(rules, maxDomainsPerRule) {
    maxDomainsPerRule = maxDomainsPerRule || 1000;
    const groups = new Map();
    const out = [];
    const seen = new Set();
    for (const r of rules) {
      const c = r.condition;
      const mergeable = c.requestDomains && c.requestDomains.length === 1 && !c.urlFilter && !c.regexFilter && !c.excludedRequestDomains;
      if (mergeable) {
        const rest = Object.assign({}, c);
        delete rest.requestDomains;
        const k = JSON.stringify([r.priority, r.action, sortKeys(rest)]);
        let g = groups.get(k);
        if (!g) { g = { proto: { priority: r.priority, action: r.action, condition: rest }, domains: new Set() }; groups.set(k, g); }
        g.domains.add(c.requestDomains[0]);
        continue;
      }
      const k = ruleKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    for (const g of groups.values()) {
      // Remove domains already covered by a parent domain in the same group.
      const all = Array.from(g.domains).sort((a, b) => a.length - b.length);
      const kept = new Set();
      for (const d of all) {
        const parts = d.split('.');
        let covered = false;
        for (let i = 1; i < parts.length - 1; i++) {
          if (kept.has(parts.slice(i).join('.'))) { covered = true; break; }
        }
        if (!covered) kept.add(d);
      }
      const list = Array.from(kept).sort();
      for (let i = 0; i < list.length; i += maxDomainsPerRule) {
        out.push({
          priority: g.proto.priority,
          action: g.proto.action,
          condition: Object.assign({ requestDomains: list.slice(i, i + maxDomainsPerRule) }, g.proto.condition),
        });
      }
    }
    return out;
  }

  /**
   * Estimate how many WebKit content-rule-list rules Safari will generate for
   * a DNR rule (mirrors ruleInWebKitFormat in WebKit). Needed because the
   * 150,000 limit applies to the converted list.
   */
  function webkitCost(rule) {
    const c = rule.condition;
    const isAAR = rule.action.type === 'allowAllRequests';
    const methods = (!isAAR && c.requestMethods) ? c.requestMethods.length : 1;
    const exMethods = (!isAAR && c.excludedRequestMethods) ? c.excludedRequestMethods.length : 0;
    const bothInit = c.initiatorDomains && c.excludedInitiatorDomains && !isAAR ? 2 : 1;
    const https = rule.action.type === 'upgradeScheme' ? 2 : 1;
    let n = 0;
    if (c.excludedRequestDomains) n += c.excludedRequestDomains.length * Math.max(1, exMethods) * bothInit;
    else if (exMethods) n += exMethods * bothInit;
    const reqDomains = (c.requestDomains && !c.regexFilter) ? c.requestDomains.length : 1;
    n += reqDomains * methods * bothInit * https;
    return n;
  }

  function assignIds(rules, start) {
    let id = start || 1;
    for (const r of rules) r.id = id++;
    return rules;
  }

  const api = { PRIORITY, SURROGATES, ALL_TYPES, DEFAULT_TYPES, convertNetworkFilter, mergeRules, webkitCost, assignIds, anchoredHost };
  const ABD = root.ABD || (root.ABD = {});
  ABD.dnrConvert = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
