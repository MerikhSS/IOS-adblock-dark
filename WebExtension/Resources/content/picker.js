/*
 * picker.js — element picker (injected on demand from the popup).
 * Tap an element, adjust with "Wider"/"Narrower", then "Hide" to save a
 * custom rule "host##selector".
 */
(function () {
  'use strict';
  if (window.__abdPicker) { window.__abdPicker.cancel(); }
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const host = location.hostname.replace(/^www\./, '');

  const box = document.createElement('div');
  const panel = document.createElement('div');
  const css = document.createElement('style');
  css.textContent = `
    #abd-pick-box{position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #ff3b30;background:rgba(255,59,48,.18);border-radius:3px;transition:all .08s}
    #abd-pick-panel{position:fixed;left:8px;right:8px;bottom:max(8px,env(safe-area-inset-bottom));z-index:2147483647;background:#1c1c1e;color:#fff;
      font:14px -apple-system,system-ui,sans-serif;border-radius:14px;padding:12px;box-shadow:0 6px 30px rgba(0,0,0,.45)}
    #abd-pick-panel code{display:block;background:#2c2c2e;padding:8px;border-radius:8px;word-break:break-all;font:12px ui-monospace,Menlo,monospace;margin:6px 0 10px;max-height:5.5em;overflow:auto}
    #abd-pick-panel .row{display:flex;gap:8px}
    #abd-pick-panel button{flex:1;font:inherit;border:0;border-radius:10px;padding:10px 6px;background:#3a3a3c;color:#fff}
    #abd-pick-panel button.primary{background:#ff3b30;font-weight:600}
    #abd-pick-panel .hint{opacity:.7;font-size:12px}`;
  box.id = 'abd-pick-box';
  panel.id = 'abd-pick-panel';
  panel.innerHTML = '<div class="hint">Tap the element to hide</div><code>—</code><div class="row">' +
    '<button data-a="wider">Wider</button><button data-a="narrower">Narrower</button>' +
    '<button data-a="cancel">Cancel</button><button data-a="hide" class="primary">Hide</button></div>';
  document.documentElement.append(css, box, panel);
  const code = panel.querySelector('code');

  let chain = []; // [target, parent, grandparent...]
  let level = 0;

  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

  function selectorFor(el) {
    if (el.id && !/\d{3,}/.test(el.id)) return '#' + cssEscape(el.id);
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
      let part = cur.localName;
      const classes = Array.from(cur.classList).filter((c) => !/\d{3,}|^(active|hover|open|show|visible|selected)$/.test(c)).slice(0, 2);
      if (cur.id && !/\d{3,}/.test(cur.id)) { parts.unshift('#' + cssEscape(cur.id) + (depth === 0 ? '' : '')); break; }
      if (classes.length) part += '.' + classes.map(cssEscape).join('.');
      else if (cur.parentElement) {
        const sibs = Array.from(cur.parentElement.children).filter((c) => c.localName === cur.localName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch (_) { /* ignore */ }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function current() { return chain[level]; }
  function update() {
    const el = current();
    if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    code.textContent = host + '##' + selectorFor(el);
  }

  function onTap(e) {
    if (panel.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || t === box) return;
    chain = [];
    for (let c = t; c && c !== document.body && c !== document.documentElement; c = c.parentElement) chain.push(c);
    level = 0;
    update();
  }

  function cancel() {
    document.removeEventListener('click', onTap, true);
    css.remove(); box.remove(); panel.remove();
    delete window.__abdPicker;
  }

  panel.addEventListener('click', (e) => {
    const a = e.target && e.target.getAttribute('data-a');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (a === 'wider' && level < chain.length - 1) { level++; update(); }
    if (a === 'narrower' && level > 0) { level--; update(); }
    if (a === 'cancel') cancel();
    if (a === 'hide' && current()) {
      const rule = host + '##' + selectorFor(current());
      try { document.querySelectorAll(rule.split('##')[1]).forEach((el) => { el.style.setProperty('display', 'none', 'important'); }); } catch (_) { /* ignore */ }
      api.runtime.sendMessage({ type: 'addCustomRule', rule }).catch(() => {});
      cancel();
    }
  }, true);

  document.addEventListener('click', onTap, true);
  window.__abdPicker = { cancel };
})();
