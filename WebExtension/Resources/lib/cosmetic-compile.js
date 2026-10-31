/*
 * cosmetic-compile.js — turn parsed cosmetic + scriptlet filters into the
 * compact structures the content scripts consume.
 *
 * Output:
 * {
 *   genericHide: string[]           // static generic CSS (registered for all sites)
 *   genericExcludeHosts: string[]   // hosts where the static generic CSS must NOT be
 *                                   // injected (generichide / elemhide / #@# exceptions);
 *                                   // those hosts get generic CSS minus exceptions via JS.
 *   specific: { [hostKey]: Entry }  // hostKey = "example.com" or entity "example.*"
 *   genericScriptlets: [name, args[]][]
 *   scriptletHosts: string[]        // hosts (keys) that have scriptlets
 *   stats: {...}
 * }
 * Entry (all fields optional, arrays of tuples to keep JSON small):
 *   h:  [selector, excl?][]           hide
 *   s:  [selector, style, excl?][]    :style()
 *   r:  [selector, excl?][]           :remove()
 *   p:  [selector, kind, style?, excl?][]   procedural (kind: procedural|style|remove)
 *   x:  string[]                      exception selectors (#@#)
 *   sl: [name, args[], excl?][]       scriptlets
 *   sx: string[]                      scriptlet exceptions ('*' = all)
 *   gh/eh/sh/doc: 1                   generichide / elemhide / specifichide / $document
 * excl = array of sub-domains to exclude (from "~sub.example.com").
 */
(function (root) {
  'use strict';

  const FP = (root.ABD && root.ABD.filterParser) || (typeof require === 'function' ? require('./filter-parser.js') : null);

  function entry(map, key) {
    let e = map[key];
    if (!e) { e = {}; map[key] = e; }
    return e;
  }
  function push(e, field, item) { (e[field] || (e[field] = [])).push(item); }

  // Very cheap sanity check to keep obviously-broken selectors out of the
  // static stylesheet (one invalid selector would void its whole rule group).
  function plausibleSelector(sel) {
    if (!sel || sel.length > 1000) return false;
    if (/^[\s>+~,]|[\s>+~,]$/.test(sel)) return false;
    if (/\{|\}|;|<|\/\*/.test(sel)) return false;
    let depth = 0;
    let br = 0;
    for (const c of sel) {
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth < 0) return false; }
      else if (c === '[') br++;
      else if (c === ']') { br--; if (br < 0) return false; }
    }
    if (depth !== 0 || br !== 0) return false;
    // Non-standard pseudo-classes that only uBO/ABP understand.
    if (/:(-abp-|has-text|contains|upward|xpath|matches-|min-text|nth-ancestor|remove|style|watch-attr|others|if\(|if-not)/.test(sel)) return false;
    return true;
  }

  /**
   * @param {object[]} filters  parsed filters (type cosmetic|scriptlet)
   * @param {object[]} metas    [{host, flags:{elemhide,generichide,specifichide,document}}] from network exceptions
   * @param {object} opts       {supportedScriptlets:Set}
   */
  function compileCosmetic(filters, metas, opts) {
    opts = opts || {};
    const supported = opts.supportedScriptlets || null;
    const generic = new Set();
    const genericExceptAll = new Set();
    const specific = Object.create(null);
    const genericScriptlets = [];
    const excludeHosts = new Set();
    const stats = { generic: 0, specific: 0, procedural: 0, scriptlets: 0, exceptions: 0, droppedScriptlets: 0, droppedSelectors: 0 };
    const droppedScriptletNames = Object.create(null);

    for (const f of filters) {
      const inc = f.domains ? f.domains.include : [];
      const exc = f.domains ? f.domains.exclude : [];

      if (f.type === 'scriptlet') {
        if (f.exception) {
          const name = f.name || '*';
          for (const d of inc) push(entry(specific, d), 'sx', name);
          stats.exceptions++;
          continue;
        }
        if (supported && !supported.has(f.name)) {
          stats.droppedScriptlets++;
          droppedScriptletNames[f.name] = (droppedScriptletNames[f.name] || 0) + 1;
          continue;
        }
        if (!inc.length) {
          // Generic scriptlets (rare). Exclusions become per-host exceptions.
          genericScriptlets.push([f.name, f.args]);
          for (const d of exc) push(entry(specific, d), 'sx', f.name);
        } else {
          for (const d of inc) {
            const subEx = exc.filter((x) => FP.hostMatchesDomain(x, d));
            push(entry(specific, d), 'sl', subEx.length ? [f.name, f.args, subEx] : [f.name, f.args]);
          }
        }
        stats.scriptlets++;
        continue;
      }

      if (f.type !== 'cosmetic') continue;

      if (f.exception) {
        stats.exceptions++;
        if (!inc.length) { genericExceptAll.add(f.selector); continue; }
        for (const d of inc) {
          push(entry(specific, d), 'x', f.selector);
          if (!FP.isEntity(d)) excludeHosts.add(d);
        }
        continue;
      }

      if (!inc.length) {
        // generic
        if (f.procedural || f.kind !== 'hide') { stats.droppedSelectors++; continue; }
        if (!plausibleSelector(f.selector)) { stats.droppedSelectors++; continue; }
        generic.add(f.selector);
        for (const d of exc) {
          push(entry(specific, d), 'x', f.selector);
          if (!FP.isEntity(d)) excludeHosts.add(d);
        }
        stats.generic++;
        continue;
      }

      for (const d of inc) {
        const subEx = exc.filter((x) => FP.hostMatchesDomain(x, d));
        const e = entry(specific, d);
        if (f.procedural) {
          const t = [f.selector, f.kind];
          if (f.kind === 'style') t.push(f.style);
          else if (subEx.length) t.push(null);
          if (subEx.length) t.push(subEx);
          push(e, 'p', t);
          stats.procedural++;
        } else if (f.kind === 'style') {
          push(e, 's', subEx.length ? [f.selector, f.style, subEx] : [f.selector, f.style]);
        } else if (f.kind === 'remove') {
          push(e, 'r', subEx.length ? [f.selector, subEx] : [f.selector]);
        } else {
          push(e, 'h', subEx.length ? [f.selector, subEx] : [f.selector]);
        }
        stats.specific++;
      }
    }

    for (const m of metas || []) {
      const e = entry(specific, m.host);
      if (m.flags.generichide) e.gh = 1;
      if (m.flags.elemhide) e.eh = 1;
      if (m.flags.specifichide) e.sh = 1;
      if (m.flags.document) e.doc = 1;
      if (m.flags.generichide || m.flags.elemhide || m.flags.document) excludeHosts.add(m.host);
    }

    for (const sel of genericExceptAll) generic.delete(sel);

    // Dedupe tuples inside entries.
    for (const key of Object.keys(specific)) {
      const e = specific[key];
      for (const field of ['h', 's', 'r', 'p', 'sl']) {
        if (!e[field]) continue;
        const seen = new Set();
        e[field] = e[field].filter((t) => { const k = JSON.stringify(t); if (seen.has(k)) return false; seen.add(k); return true; });
      }
      for (const field of ['x', 'sx']) if (e[field]) e[field] = Array.from(new Set(e[field]));
    }

    const scriptletHosts = Object.keys(specific).filter((k) => specific[k].sl);

    return {
      genericHide: Array.from(generic),
      genericExcludeHosts: Array.from(excludeHosts).sort(),
      specific,
      genericScriptlets,
      scriptletHosts,
      stats,
      droppedScriptletNames,
    };
  }

  /** Build CSS text: selectors grouped so one bad selector only voids its own group. */
  function buildHideCSS(selectors, groupSize) {
    groupSize = groupSize || 64;
    const out = [];
    for (let i = 0; i < selectors.length; i += groupSize) {
      out.push(selectors.slice(i, i + groupSize).join(',\n') + '\n{display:none!important}');
    }
    return out.join('\n');
  }

  /**
   * Resolve everything that applies to `hostname` from a lookup function
   * (key -> Entry|undefined). Used by the content script and tests.
   */
  function resolveForHost(hostname, lookup) {
    const res = { hide: [], styles: [], remove: [], procedural: [], exceptions: new Set(), scriptlets: [], scriptletExceptions: new Set(), generichide: false, elemhide: false, specifichide: false, document: false };
    const keys = FP.hostnameKeys(hostname);
    const okFor = (excl) => !excl || !excl.some((x) => FP.hostMatchesDomain(hostname, x));
    for (const k of keys) {
      const e = lookup(k);
      if (!e) continue;
      if (FP.isEntity(k) && !FP.hostMatchesDomain(hostname, k)) continue;
      if (e.gh) res.generichide = true;
      if (e.eh) res.elemhide = true;
      if (e.sh) res.specifichide = true;
      if (e.doc) res.document = true;
      (e.x || []).forEach((s) => res.exceptions.add(s));
      (e.sx || []).forEach((s) => res.scriptletExceptions.add(s));
      for (const t of e.h || []) if (okFor(t[1])) res.hide.push(t[0]);
      for (const t of e.s || []) if (okFor(t[2])) res.styles.push([t[0], t[1]]);
      for (const t of e.r || []) if (okFor(t[1])) res.remove.push(t[0]);
      for (const t of e.p || []) if (okFor(t[3])) res.procedural.push({ selector: t[0], kind: t[1], style: t[2] || null });
      for (const t of e.sl || []) if (okFor(t[2])) res.scriptlets.push([t[0], t[1]]);
    }
    const ex = res.exceptions;
    res.hide = res.hide.filter((s) => !ex.has(s));
    res.styles = res.styles.filter((t) => !ex.has(t[0]));
    res.remove = res.remove.filter((s) => !ex.has(s));
    res.procedural = res.procedural.filter((p) => !ex.has(p.selector));
    if (res.scriptletExceptions.has('*')) res.scriptlets = [];
    else res.scriptlets = res.scriptlets.filter((t) => !res.scriptletExceptions.has(t[0]));
    if (res.specifichide) { res.hide = []; res.styles = []; res.remove = []; res.procedural = []; }
    return res;
  }

  const api = { compileCosmetic, buildHideCSS, resolveForHost, plausibleSelector };
  const ABD = root.ABD || (root.ABD = {});
  ABD.cosmeticCompile = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
