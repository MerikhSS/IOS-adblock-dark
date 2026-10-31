/*
 * scriptlet-runner.js — a small, self-contained re-implementation of the most
 * commonly used uBlock Origin scriptlets. Written from scratch for this
 * project (uBO's own scriptlets are GPL; these are not copies).
 *
 * `abdScriptletRunner(calls)` MUST stay self-contained: it is serialized with
 * Function.prototype.toString() and executed in the page's MAIN world, either
 *   - baked into the generated scriptlets/bundle.js (registered with
 *     scripting.registerContentScripts({world:'MAIN', runAt:'document_start'})), or
 *   - via scripting.executeScript({world:'MAIN', func, args}) for custom rules.
 *
 * calls: Array<[name, args[]]>
 */
(function (root) {
  'use strict';

  function abdScriptletRunner(calls) {
    if (!calls || !calls.length) return;
    const win = window;
    const log = function () { /* console.debug('[ABD scriptlet]', ...arguments) */ };

    // ---------- helpers ----------
    function patternToRegex(p, flags) {
      if (p === undefined || p === null || p === '' || p === '*') return /^/;
      const m = /^\/(.+)\/([gimsuy]*)$/.exec(p);
      if (m) { try { return new RegExp(m[1], m[2] || flags || ''); } catch (_) { return /(?!)/; } }
      return new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags || '');
    }
    function notPattern(p) {
      // uBO: leading "!" negates
      if (typeof p === 'string' && p.startsWith('!')) return { neg: true, re: patternToRegex(p.slice(1)) };
      return { neg: false, re: patternToRegex(p) };
    }
    function testNot(np, s) { const r = np.re.test(s); return np.neg ? !r : r; }
    function constantValue(v) {
      switch (v) {
        case 'undefined': return undefined;
        case 'false': return false;
        case 'true': return true;
        case 'null': return null;
        case "''": case '""': case 'emptyStr': return '';
        case 'noopFunc': return function () {};
        case 'trueFunc': return function () { return true; };
        case 'falseFunc': return function () { return false; };
        case 'throwFunc': return function () { throw new Error(); };
        case 'emptyObj': case '{}': return {};
        case 'emptyArr': case '[]': return [];
        case 'noopPromiseResolve': return function () { return Promise.resolve(); };
        case 'noopPromiseReject': return function () { return Promise.reject(); };
        case 'yes': return 'yes';
        case 'no': return 'no';
        default:
          if (/^-?\d+(\.\d+)?$/.test(v) && Math.abs(parseFloat(v)) <= 0x7fff) return parseFloat(v);
          return undefined;
      }
    }
    function uid() { return 'abd' + Math.random().toString(36).slice(2); }

    // Define a property along a dotted chain, waiting for intermediate objects.
    function trapChain(owner, chain, handlers) {
      const dot = chain.indexOf('.');
      if (dot === -1) { handlers.leaf(owner, chain); return; }
      const prop = chain.slice(0, dot);
      const rest = chain.slice(dot + 1);
      let v = owner[prop];
      if (v instanceof Object || (typeof v === 'object' && v !== null)) { trapChain(v, rest, handlers); return; }
      const desc = Object.getOwnPropertyDescriptor(owner, prop);
      if (desc && desc.configurable === false) return;
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          get() { return v; },
          set(a) { v = a; if (a instanceof Object) trapChain(a, rest, handlers); },
        });
      } catch (_) { /* ignore */ }
    }

    // ---------- scriptlets ----------
    const S = {};

    S['set-constant'] = function (chain, value) {
      if (!chain) return;
      const cv = constantValue(value);
      if (cv === undefined && value !== 'undefined') return;
      trapChain(win, chain, {
        leaf(owner, prop) {
          const desc = Object.getOwnPropertyDescriptor(owner, prop);
          if (desc && desc.configurable === false) return;
          try {
            Object.defineProperty(owner, prop, { configurable: false, get() { return cv; }, set() {} });
          } catch (_) { /* ignore */ }
        },
      });
    };

    function abortOnAccess(chain, onSet) {
      const id = uid();
      const thrower = function () { throw new ReferenceError(id); };
      trapChain(win, chain, {
        leaf(owner, prop) {
          let value = owner[prop];
          try {
            Object.defineProperty(owner, prop, {
              configurable: true,
              get() { if (!onSet) thrower(); return value; },
              set(a) { if (onSet) thrower(); value = a; },
            });
          } catch (_) { /* ignore */ }
        },
      });
      const prevOnError = win.onerror;
      win.onerror = function (msg) {
        if (typeof msg === 'string' && msg.includes(id)) return true;
        if (prevOnError instanceof Function) return prevOnError.apply(this, arguments);
      };
    }
    S['abort-on-property-read'] = function (chain) { if (chain) abortOnAccess(chain, false); };
    S['abort-on-property-write'] = function (chain) { if (chain) abortOnAccess(chain, true); };

    S['abort-current-script'] = function (chain, needle, context) {
      if (!chain) return;
      const reNeedle = patternToRegex(needle);
      const reContext = patternToRegex(context);
      const id = uid();
      const thisScript = document.currentScript;
      const check = function () {
        const e = document.currentScript;
        if (!(e instanceof HTMLScriptElement) || e === thisScript) return;
        if (context && !reContext.test(e.src || '')) return;
        const text = e.src ? e.src + '\n' + (e.textContent || '') : e.textContent || '';
        if (!reNeedle.test(text)) return;
        throw new ReferenceError(id);
      };
      trapChain(win, chain, {
        leaf(owner, prop) {
          let value = owner[prop];
          const desc = Object.getOwnPropertyDescriptor(owner, prop);
          if (desc && desc.configurable === false) return;
          const getter = desc && desc.get;
          const setter = desc && desc.set;
          try {
            Object.defineProperty(owner, prop, {
              configurable: true,
              get() { check(); return getter ? getter.call(owner) : value; },
              set(a) { check(); if (setter) setter.call(owner, a); else value = a; },
            });
          } catch (_) { /* ignore */ }
        },
      });
      const prevOnError = win.onerror;
      win.onerror = function (msg) {
        if (typeof msg === 'string' && msg.includes(id)) return true;
        if (prevOnError instanceof Function) return prevOnError.apply(this, arguments);
      };
    };

    function timerDefuser(timerName) {
      return function (needle, delay) {
        const np = notPattern(needle);
        let delayNeg = false;
        let delayVal = null;
        if (delay !== undefined && delay !== '') {
          delayNeg = String(delay).startsWith('!');
          delayVal = parseInt(String(delay).replace(/^!/, ''), 10);
        }
        const orig = win[timerName];
        win[timerName] = new Proxy(orig, {
          apply(target, thisArg, args) {
            const a = String(args[0]);
            const d = args[1];
            let match = needle === undefined || needle === '' ? true : testNot(np, a);
            if (delayVal !== null && !isNaN(delayVal)) {
              const dm = d === delayVal;
              match = match && (delayNeg ? !dm : dm);
            }
            if (match) { args[0] = function () {}; }
            return Reflect.apply(target, thisArg, args);
          },
        });
      };
    }
    S['no-setTimeout-if'] = timerDefuser('setTimeout');
    S['no-setInterval-if'] = timerDefuser('setInterval');

    S['no-requestAnimationFrame-if'] = function (needle) {
      const np = notPattern(needle);
      win.requestAnimationFrame = new Proxy(win.requestAnimationFrame, {
        apply(target, thisArg, args) {
          if (testNot(np, String(args[0]))) args[0] = function () {};
          return Reflect.apply(target, thisArg, args);
        },
      });
    };

    function boost(timerName) {
      return function (needle, delay, factor) {
        const re = patternToRegex(needle);
        const d = delay === undefined || delay === '' ? 1000 : (delay === '*' ? null : parseInt(delay, 10));
        let boostF = factor === undefined || factor === '' ? 0.05 : parseFloat(factor);
        if (isNaN(boostF) || boostF < 0.001 || boostF > 50) boostF = 0.05;
        win[timerName] = new Proxy(win[timerName], {
          apply(target, thisArg, args) {
            if ((d === null || args[1] === d) && re.test(String(args[0]))) args[1] = args[1] * boostF;
            return Reflect.apply(target, thisArg, args);
          },
        });
      };
    }
    S['nano-setTimeout-booster'] = boost('setTimeout');
    S['nano-setInterval-booster'] = boost('setInterval');

    function propsMatch(propsToMatch, getProp) {
      // "url:/ads/ method:POST" or plain needle (matched against url)
      if (!propsToMatch || propsToMatch === '*') return true;
      const parts = propsToMatch.split(/\s+/);
      for (const part of parts) {
        const i = part.indexOf(':');
        let key = 'url';
        let val = part;
        if (i > 0 && /^[a-zA-Z]+$/.test(part.slice(0, i))) { key = part.slice(0, i); val = part.slice(i + 1); }
        const v = getProp(key);
        if (v === undefined || !patternToRegex(val).test(String(v))) return false;
      }
      return true;
    }

    S['no-fetch-if'] = function (propsToMatch, responseBody) {
      if (propsToMatch === undefined) return;
      const origFetch = win.fetch;
      win.fetch = new Proxy(origFetch, {
        apply(target, thisArg, args) {
          let details = {};
          try {
            const r = args[0];
            if (r instanceof Request) details = { url: r.url, method: r.method };
            else details = Object.assign({ url: String(r) }, args[1] || {});
          } catch (_) { /* ignore */ }
          if (propsMatch(propsToMatch, (k) => details[k])) {
            let body = '';
            if (responseBody === 'emptyObj') body = '{}';
            else if (responseBody === 'emptyArr') body = '[]';
            return Promise.resolve(new Response(body, { status: 200, statusText: 'OK' }));
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    };

    S['no-xhr-if'] = function (propsToMatch) {
      if (propsToMatch === undefined) return;
      const XHR = win.XMLHttpRequest;
      const blocked = new WeakSet();
      const open = XHR.prototype.open;
      const send = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        if (propsMatch(propsToMatch, (k) => (k === 'url' ? String(url) : k === 'method' ? method : undefined))) blocked.add(this);
        return open.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        if (!blocked.has(this)) return send.apply(this, arguments);
        const xhr = this;
        try {
          Object.defineProperties(xhr, {
            readyState: { value: 4 }, status: { value: 200 }, statusText: { value: 'OK' },
            responseText: { value: '' }, response: { value: '' },
          });
        } catch (_) { /* ignore */ }
        setTimeout(function () {
          xhr.dispatchEvent(new Event('readystatechange'));
          xhr.dispatchEvent(new Event('load'));
          xhr.dispatchEvent(new Event('loadend'));
        }, 1);
      };
    };

    S['addEventListener-defuser'] = function (type, needle) {
      const reType = patternToRegex(type);
      const reNeedle = patternToRegex(needle);
      const proto = win.EventTarget.prototype;
      proto.addEventListener = new Proxy(proto.addEventListener, {
        apply(target, thisArg, args) {
          let h = '';
          try { h = String(args[1] instanceof Function ? args[1] : (args[1] && args[1].handleEvent) || ''); } catch (_) { /* ignore */ }
          if (reType.test(String(args[0])) && reNeedle.test(h)) return undefined;
          return Reflect.apply(target, thisArg, args);
        },
      });
    };

    S['no-window-open-if'] = function (needle) {
      const np = notPattern(needle);
      win.open = new Proxy(win.open, {
        apply(target, thisArg, args) {
          if (testNot(np, String(args[0] || ''))) return null;
          return Reflect.apply(target, thisArg, args);
        },
      });
    };

    S['nowebrtc'] = function () {
      const names = ['RTCPeerConnection', 'webkitRTCPeerConnection'];
      for (const n of names) {
        if (!(n in win)) continue;
        const Fake = function () { /* noop */ };
        Fake.prototype = { close() {}, createDataChannel() {}, createOffer() { return Promise.reject(); }, setRemoteDescription() { return Promise.reject(); } };
        win[n] = Fake;
      }
    };

    S['noeval'] = function () {
      win.eval = new Proxy(win.eval, { apply() { return undefined; } });
    };
    S['noeval-if'] = function (needle) {
      const re = patternToRegex(needle);
      win.eval = new Proxy(win.eval, {
        apply(target, thisArg, args) { if (re.test(String(args[0]))) return undefined; return Reflect.apply(target, thisArg, args); },
      });
    };

    function pruneObject(obj, prunePaths, requiredPaths) {
      if (!obj || typeof obj !== 'object') return obj;
      const has = function (o, path) {
        const parts = path.split('.');
        let cur = o;
        for (const p of parts) {
          if (cur === null || typeof cur !== 'object') return false;
          if (p === '[]' && Array.isArray(cur)) return cur.some((x) => has(x, parts.slice(parts.indexOf(p) + 1).join('.')));
          if (!(p in cur)) return false;
          cur = cur[p];
        }
        return true;
      };
      const del = function (o, parts) {
        if (o === null || typeof o !== 'object') return;
        const [head, ...rest] = parts;
        if (head === '[]' || head === '*') {
          for (const k of Object.keys(o)) { if (rest.length) del(o[k], rest); else delete o[k]; }
          return;
        }
        if (!(head in o)) return;
        if (!rest.length) delete o[head];
        else del(o[head], rest);
      };
      for (const r of requiredPaths) if (r && !has(obj, r)) return obj;
      for (const p of prunePaths) if (p) del(obj, p.split('.'));
      return obj;
    }
    S['json-prune'] = function (prune, required) {
      const prunePaths = (prune || '').split(/\s+/).filter(Boolean);
      const requiredPaths = (required || '').split(/\s+/).filter(Boolean);
      if (!prunePaths.length) return;
      win.JSON.parse = new Proxy(win.JSON.parse, {
        apply(target, thisArg, args) {
          return pruneObject(Reflect.apply(target, thisArg, args), prunePaths, requiredPaths);
        },
      });
      if (win.Response && win.Response.prototype.json) {
        win.Response.prototype.json = new Proxy(win.Response.prototype.json, {
          apply(target, thisArg, args) {
            return Reflect.apply(target, thisArg, args).then((o) => pruneObject(o, prunePaths, requiredPaths));
          },
        });
      }
    };
    S['json-prune-fetch-response'] = function (prune, required, ...rest) {
      const prunePaths = (prune || '').split(/\s+/).filter(Boolean);
      const requiredPaths = (required || '').split(/\s+/).filter(Boolean);
      let propsToMatch = '';
      for (let i = 0; i + 1 < rest.length; i += 2) if (rest[i] === 'propsToMatch') propsToMatch = rest[i + 1];
      win.fetch = new Proxy(win.fetch, {
        apply(target, thisArg, args) {
          const url = args[0] instanceof Request ? args[0].url : String(args[0]);
          const p = Reflect.apply(target, thisArg, args);
          if (!propsMatch(propsToMatch, (k) => (k === 'url' ? url : undefined))) return p;
          return p.then((resp) => resp.clone().json().then((o) => {
            const pruned = pruneObject(o, prunePaths, requiredPaths);
            return new Response(JSON.stringify(pruned), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
          }).catch(() => resp));
        },
      });
    };
    S['json-prune-xhr-response'] = function (prune, required) {
      const prunePaths = (prune || '').split(/\s+/).filter(Boolean);
      const requiredPaths = (required || '').split(/\s+/).filter(Boolean);
      const proto = win.XMLHttpRequest.prototype;
      for (const prop of ['response', 'responseText']) {
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || !desc.get) continue;
        Object.defineProperty(proto, prop, {
          configurable: true,
          get() {
            const v = desc.get.call(this);
            if (this.readyState !== 4) return v;
            try {
              const o = typeof v === 'string' ? JSON.parse(v) : v;
              if (!o || typeof o !== 'object') return v;
              const pr = pruneObject(o, prunePaths, requiredPaths);
              return typeof v === 'string' ? JSON.stringify(pr) : pr;
            } catch (_) { return v; }
          },
        });
      }
    };

    function onDomReady(fn) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
      else fn();
    }
    function observe(fn) {
      onDomReady(function () {
        fn();
        let t = 0;
        new MutationObserver(function () {
          if (t) return;
          t = setTimeout(function () { t = 0; fn(); }, 100);
        }).observe(document.documentElement, { childList: true, subtree: true, attributes: false });
      });
    }

    S['remove-attr'] = function (attrs, selector) {
      const list = (attrs || '').split('|').filter(Boolean);
      if (!list.length) return;
      const sel = selector || list.map((a) => '[' + CSS.escape(a) + ']').join(',');
      observe(function () {
        try { document.querySelectorAll(sel).forEach((el) => list.forEach((a) => el.removeAttribute(a))); } catch (_) { /* ignore */ }
      });
    };
    S['remove-class'] = function (classes, selector) {
      const list = (classes || '').split('|').filter(Boolean);
      if (!list.length) return;
      const sel = selector || list.map((c) => '.' + CSS.escape(c)).join(',');
      observe(function () {
        try { document.querySelectorAll(sel).forEach((el) => el.classList.remove(...list)); } catch (_) { /* ignore */ }
      });
    };
    S['remove-node-text'] = function (nodeName, needle) {
      const reName = patternToRegex(nodeName);
      const reText = patternToRegex(needle);
      const clean = function (node) {
        if (reName.test(node.nodeName.toLowerCase()) && reText.test(node.textContent || '')) node.textContent = '';
      };
      new MutationObserver(function (records) {
        for (const r of records) for (const n of r.addedNodes) {
          if (n.nodeType === 1 || n.nodeType === 3) clean(n);
        }
      }).observe(document, { childList: true, subtree: true });
    };

    function setStorageItem(storage, key, value) {
      const allowed = { undefined: undefined, false: 'false', true: 'true', null: 'null', '': '', emptyObj: '{}', emptyArr: '[]', yes: 'yes', no: 'no', on: 'on', off: 'off', '$remove$': null };
      if (!key) return;
      let v;
      if (Object.prototype.hasOwnProperty.call(allowed, value)) v = allowed[value];
      else if (/^\d+$/.test(value) && value.length < 6) v = value;
      else return;
      try {
        if (v === null) storage.removeItem(key);
        else if (v !== undefined) storage.setItem(key, v);
      } catch (_) { /* ignore */ }
    }
    S['set-local-storage-item'] = function (key, value) { setStorageItem(win.localStorage, key, value); };
    S['set-session-storage-item'] = function (key, value) { setStorageItem(win.sessionStorage, key, value); };


    S['set-cookie'] = function (name, value, path) {
      if (!name) return;
      const ok = ['true', 'false', 'yes', 'no', 'y', 'n', 'on', 'off', 'ok', 'accept', 'accepted', 'reject', 'rejected',
        'allow', 'allowed', 'deny', 'denied', 'necessary', 'required', 'hide', 'hidden', 'essential', 'nonessential',
        'checked', 'unchecked', 'forbidden', 'forever', ''];
      let v = value === undefined ? '' : String(value);
      if (!ok.includes(v.toLowerCase()) && !/^-?\d{1,5}$/.test(v)) return;
      const p = path === 'none' ? '' : '; path=' + (path && path.startsWith('/') ? path : '/');
      try { document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(v) + p + '; max-age=31536000; samesite=lax'; } catch (_) { /* ignore */ }
    };
    S['remove-cookie'] = function (needle) {
      const re = patternToRegex(needle);
      const run = function () {
        try {
          document.cookie.split(';').forEach(function (c) {
            const n = c.split('=')[0].trim();
            if (!n || !re.test(n)) return;
            const host = location.hostname;
            const parts = host.split('.');
            for (let i = 0; i < parts.length - 1; i++) {
              const d = parts.slice(i).join('.');
              document.cookie = n + '=; max-age=0; path=/; domain=' + d;
            }
            document.cookie = n + '=; max-age=0; path=/';
          });
        } catch (_) { /* ignore */ }
      };
      run();
      window.addEventListener('beforeunload', run);
    };

    // ---------- run ----------
    for (const call of calls) {
      const fn = S[call[0]];
      if (!fn) { log('unknown scriptlet', call[0]); continue; }
      try { fn.apply(null, call[1] || []); } catch (e) { log('scriptlet error', call[0], e); }
    }
  }

  const SUPPORTED = [
    'set-constant', 'abort-on-property-read', 'abort-on-property-write', 'abort-current-script',
    'no-setTimeout-if', 'no-setInterval-if', 'no-requestAnimationFrame-if', 'nano-setTimeout-booster',
    'nano-setInterval-booster', 'no-fetch-if', 'no-xhr-if', 'addEventListener-defuser', 'no-window-open-if',
    'nowebrtc', 'noeval', 'noeval-if', 'json-prune', 'json-prune-fetch-response', 'json-prune-xhr-response',
    'remove-attr', 'remove-class', 'remove-node-text', 'set-local-storage-item', 'set-session-storage-item',
    'set-cookie', 'remove-cookie',
  ];

  const api = { abdScriptletRunner, SUPPORTED };
  const ABD = root.ABD || (root.ABD = {});
  ABD.scriptletRunner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
