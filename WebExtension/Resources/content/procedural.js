/*
 * procedural.js — a compact procedural cosmetic filter engine (uBO/ABP
 * extended selectors), written for this project.
 *
 * Supported operators:
 *   :has-text(text|/re/flags)  :contains()  :-abp-contains()
 *   :min-text-length(n)        :upward(n|selector)        :xpath(expr)
 *   :matches-css(prop: value|/re/)  :matches-css-before()  :matches-css-after()
 *   :matches-attr("name"="value" | /re/=/re/)            :matches-path(text|/re/)
 *   :-abp-has(sel) :has(sel-with-procedural) :if(sel) :if-not(sel) :not(sel-with-procedural)
 * Actions: hide (default), remove, style, remove-attr, remove-class
 * Native CSS (including :has() with plain selectors) is left to the browser.
 */
(function (root) {
  'use strict';
  const ABD = root.ABD || (root.ABD = {});

  const OPS = new Set(['has-text', 'contains', '-abp-contains', 'min-text-length', 'upward', 'xpath', 'matches-css',
    'matches-css-before', 'matches-css-after', 'matches-attr', 'matches-path', '-abp-has', 'has', 'if', 'if-not', 'not',
    'remove-attr', 'remove-class', 'nth-ancestor']);
  const ALWAYS_PROC = new Set(['has-text', 'contains', '-abp-contains', 'min-text-length', 'upward', 'xpath', 'matches-css',
    'matches-css-before', 'matches-css-after', 'matches-attr', 'matches-path', '-abp-has', 'if', 'if-not', 'remove-attr', 'remove-class', 'nth-ancestor']);

  function isProcedural(sel) {
    return /:(has-text|contains|-abp-contains|min-text-length|upward|xpath|matches-css|matches-attr|matches-path|-abp-has|if|if-not|remove-attr|remove-class|nth-ancestor)\(/.test(sel);
  }

  function toRegex(arg) {
    arg = arg.trim();
    const m = /^\/(.+)\/([imsu]*)$/.exec(arg);
    if (m) { try { return new RegExp(m[1], m[2]); } catch (_) { return null; } }
    if (/^".*"$/.test(arg) || /^'.*'$/.test(arg)) arg = arg.slice(1, -1);
    return new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  /** Split selector at top level into segments: {css} | {op, arg} */
  function tokenize(sel) {
    const segs = [];
    let css = '';
    let i = 0;
    while (i < sel.length) {
      const c = sel[i];
      if (c === '[') {
        const end = findClose(sel, i, '[', ']');
        css += sel.slice(i, end + 1); i = end + 1; continue;
      }
      if (c === '"' || c === "'") {
        const end = sel.indexOf(c, i + 1);
        css += sel.slice(i, end + 1); i = end + 1; continue;
      }
      if (c === ':') {
        const m = /^:([a-z-]+)\(/.exec(sel.slice(i));
        if (m && OPS.has(m[1])) {
          const open = i + m[0].length - 1;
          const close = findClose(sel, open, '(', ')');
          if (close === -1) return null;
          const arg = sel.slice(open + 1, close);
          const op = m[1];
          const procHere = ALWAYS_PROC.has(op) || ((op === 'has' || op === 'not') && isProcedural(arg));
          if (procHere) {
            if (css) { segs.push({ css }); css = ''; }
            segs.push({ op, arg });
            i = close + 1;
            continue;
          }
          css += sel.slice(i, close + 1); i = close + 1; continue;
        }
      }
      css += c; i++;
    }
    if (css) segs.push({ css });
    return segs;
  }

  function findClose(s, openIdx, open, close) {
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < s.length; i++) {
      const c = s[i];
      if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '\\') { i++; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function compile(selector) {
    const segs = tokenize(selector.trim());
    if (!segs || !segs.length) return null;
    const tasks = [];
    let first = null;
    let action = null;
    segs.forEach((s, idx) => {
      if (s.css !== undefined) {
        if (idx === 0) { first = s.css.trim(); return; }
        const t = s.css;
        if (/^\s*[>+~]/.test(t) || /^\s/.test(t)) tasks.push({ op: 'spath', arg: t.trim() });
        else tasks.push({ op: 'matches', arg: t.trim() });
        return;
      }
      const op = s.op;
      if (op === 'remove-attr' || op === 'remove-class') { action = { type: op, arg: s.arg.trim().replace(/^["']|["']$/g, '') }; return; }
      const task = { op, arg: s.arg };
      if (op === 'has-text' || op === 'contains' || op === '-abp-contains') { task.re = toRegex(s.arg); if (!task.re) throw new Error('bad regex'); }
      if (op === 'matches-path') task.re = toRegex(s.arg);
      if (op === 'min-text-length') task.n = parseInt(s.arg, 10) || 0;
      if (op === 'upward' || op === 'nth-ancestor') {
        const n = parseInt(s.arg, 10);
        if (String(n) === s.arg.trim()) task.n = n; else task.sel = s.arg.trim();
      }
      if (op.startsWith('matches-css')) {
        const m = /^\s*([a-z-]+)\s*:\s*(.+)$/i.exec(s.arg);
        if (!m) throw new Error('bad matches-css');
        task.prop = m[1];
        task.re = /^\/.+\/[a-z]*$/.test(m[2].trim()) ? toRegex(m[2]) : new RegExp('^' + m[2].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
        task.pseudo = op === 'matches-css-before' ? '::before' : op === 'matches-css-after' ? '::after' : null;
      }
      if (op === 'matches-attr') {
        const m = /^\s*("[^"]*"|\/[^/]+\/[a-z]*|[^=]+)\s*(?:=\s*("[^"]*"|\/.+\/[a-z]*|.+))?\s*$/.exec(s.arg);
        if (!m) throw new Error('bad matches-attr');
        task.name = toRegex(m[1].replace(/^"|"$/g, '').startsWith('/') ? m[1] : '/^' + m[1].replace(/^"|"$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$/');
        task.value = m[2] ? toRegex(m[2]) : null;
      }
      if (op === '-abp-has' || op === 'has' || op === 'if' || op === 'if-not' || op === 'not') {
        const arg = s.arg.trim();
        task.sub = isProcedural(arg) ? compile(arg.replace(/^>/, ':scope >')) : null;
        task.css = task.sub ? null : arg;
      }
      tasks.push(task);
    });
    return { first, tasks, action, source: selector };
  }

  function qsa(rootNode, sel) {
    try { return Array.from(rootNode.querySelectorAll(sel)); } catch (_) { return []; }
  }

  function exec(c, rootNode) {
    rootNode = rootNode || document;
    let nodes;
    if (c.first) {
      const f = c.first;
      nodes = rootNode === document ? qsa(document, f) : qsa(rootNode, /^\s*[>+~]/.test(f) ? ':scope ' + f : f);
    } else nodes = null; // null => "the root" for xpath / matches-path / spath
    for (const t of c.tasks) {
      nodes = runTask(t, nodes, rootNode);
      if (nodes && !nodes.length) return nodes;
    }
    return nodes || [];
  }

  function textOf(el) { return el.textContent || ''; }

  function runTask(t, nodes, rootNode) {
    const base = nodes || (rootNode === document ? [document.documentElement] : [rootNode]);
    switch (t.op) {
      case 'has-text': case 'contains': case '-abp-contains':
        return base.filter((el) => t.re.test(textOf(el)));
      case 'min-text-length':
        return base.filter((el) => textOf(el).length >= t.n);
      case 'upward': case 'nth-ancestor': {
        const out = new Set();
        for (const el of base) {
          let p = el;
          if (t.n !== undefined) { for (let i = 0; i < t.n && p; i++) p = p.parentElement; }
          else { p = el.parentElement; while (p && !safeMatches(p, t.sel)) p = p.parentElement; }
          if (p && p !== document.documentElement && p !== document.body) out.add(p);
        }
        return Array.from(out);
      }
      case 'xpath': {
        const out = [];
        const ctxs = nodes || [rootNode === document ? document : rootNode];
        for (const ctx of ctxs) {
          let r;
          try { r = document.evaluate(t.arg, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch (_) { return []; }
          for (let i = 0; i < r.snapshotLength; i++) { const n = r.snapshotItem(i); if (n.nodeType === 1) out.push(n); }
        }
        return out;
      }
      case 'matches-css': case 'matches-css-before': case 'matches-css-after':
        return base.filter((el) => { const v = getComputedStyle(el, t.pseudo).getPropertyValue(t.prop); return t.re.test(v); });
      case 'matches-attr':
        return base.filter((el) => Array.from(el.attributes).some((a) => t.name.test(a.name) && (!t.value || t.value.test(a.value))));
      case 'matches-path':
        return t.re.test(location.pathname + location.search) ? (nodes || base) : [];
      case '-abp-has': case 'has': case 'if':
        return base.filter((el) => (t.sub ? exec(t.sub, el).length > 0 : qsa(el, /^\s*[>+~]/.test(t.css) ? ':scope ' + t.css : t.css).length > 0));
      case 'if-not': case 'not':
        return base.filter((el) => (t.sub ? exec(t.sub, el).length === 0 : qsa(el, /^\s*[>+~]/.test(t.css) ? ':scope ' + t.css : t.css).length === 0));
      case 'spath': {
        const out = new Set();
        for (const el of base) for (const n of qsa(el, ':scope ' + t.arg)) out.add(n);
        return Array.from(out);
      }
      case 'matches':
        return base.filter((el) => safeMatches(el, t.arg));
      default:
        return [];
    }
  }

  function safeMatches(el, sel) { try { return el.matches(sel); } catch (_) { return false; } }

  /**
   * Run a list of procedural rules, keep re-running on DOM mutations.
   * rules: [{selector, kind:'procedural'|'remove'|'style', style?}]
   */
  function start(rules, opts) {
    opts = opts || {};
    const compiled = [];
    for (const r of rules) {
      try {
        const c = compile(r.selector);
        if (c) compiled.push({ c, kind: r.kind, style: r.style });
      } catch (e) { /* bad selector: skip */ }
    }
    if (!compiled.length) return { count: () => 0 };

    const hidden = new WeakSet();
    let hiddenCount = 0;
    let styleIdx = 0;
    const styleRules = [];
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-abd', 'procedural');
    styleEl.textContent = '[abd-h]{display:none!important}';
    const mountStyle = () => { if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl); };

    compiled.forEach((x) => { if (x.kind === 'style') { x.attr = 'abd-s' + (styleIdx++); styleRules.push(`[${x.attr}]{${x.style}}`); } });
    if (styleRules.length) styleEl.textContent += '\n' + styleRules.join('\n');

    const apply = () => {
      mountStyle();
      for (const x of compiled) {
        let nodes;
        try { nodes = exec(x.c, document); } catch (_) { continue; }
        for (const el of nodes) {
          if (x.c.action) {
            if (x.c.action.type === 'remove-attr') x.c.action.arg.split('|').forEach((a) => el.removeAttribute(a));
            else el.classList.remove(...x.c.action.arg.split('|'));
            continue;
          }
          if (x.kind === 'remove') { el.remove(); hiddenCount++; continue; }
          if (x.kind === 'style') { el.setAttribute(x.attr, ''); continue; }
          if (!hidden.has(el)) { hidden.add(el); hiddenCount++; el.setAttribute('abd-h', ''); }
        }
      }
    };

    let timer = 0;
    let last = 0;
    const schedule = () => {
      if (timer) return;
      const wait = Math.max(50, 200 - (Date.now() - last));
      timer = setTimeout(() => { timer = 0; last = Date.now(); apply(); if (opts.onChange) opts.onChange(); }, wait);
    };
    const begin = () => {
      apply();
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: false });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
    else begin();
    return { count: () => hiddenCount };
  }

  ABD.procedural = { compile, exec, start, isProcedural, tokenize };
})(globalThis);
