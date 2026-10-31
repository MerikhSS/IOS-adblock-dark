/*
 * filter-parser.js — parse Adblock Plus / uBlock Origin filter syntax into
 * normalized objects. Shared by the Node build pipeline (filters/) and by the
 * extension itself (custom user rules are parsed on-device with this file).
 *
 * Output shapes:
 *   {type:'comment'}
 *   {type:'network', exception, pattern, isRegex, options, raw}
 *   {type:'cosmetic', exception, domains, selector, kind:'hide'|'style'|'procedural'|'remove', style?, raw}
 *   {type:'scriptlet', exception, domains, name, args, raw}
 *   {type:'unsupported', reason, raw}
 *
 * `domains` = {include:[...], exclude:[...]}, both possibly containing
 * entity patterns like "google.*".
 */
(function (root) {
  'use strict';

  // ---------- domain helpers ----------

  function toASCIIHost(host) {
    host = String(host).trim().toLowerCase();
    if (!host) return '';
    if (/^[\x21-\x7e]+$/.test(host)) return host;
    try {
      return new URL('http://' + host + '/').hostname;
    } catch (_) {
      return '';
    }
  }

  const DOMAIN_RE = /^(?:\*\.)?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\.\*)?$/;

  /** Parse "a.com|~b.com" (sep '|') or "a.com,~b.com" (sep ',') */
  function parseDomainList(str, sep) {
    const include = [];
    const exclude = [];
    let invalid = 0;
    for (let d of String(str).split(sep)) {
      d = d.trim();
      if (!d) continue;
      let neg = false;
      if (d[0] === '~') { neg = true; d = d.slice(1); }
      if (d[0] === '/') { invalid++; continue; } // regex domains unsupported
      d = toASCIIHost(d.replace(/^\*\./, ''));
      if (!d || !DOMAIN_RE.test(d)) { invalid++; continue; }
      (neg ? exclude : include).push(d);
    }
    return { include, exclude, invalid };
  }

  function isEntity(d) { return d.endsWith('.*'); }

  // ---------- cosmetic separators ----------
  // Matches: ##  #@#  #?#  #@?#  #$#  #@$#  #$?#  #%#  #@%#
  const COSMETIC_RE = /^([^#\s/|"@!\[\]^$]*?)(#@?(?:\?|\$\??|%)?#)(.*)$/;
  const DOMAIN_PART_RE = /^[a-z0-9.*,~_\-\u0080-￿]*$/i;

  // Procedural operators supported by our content-script engine.
  const PROCEDURAL_OPS = [
    'has-text', 'contains', '-abp-contains', 'upward', 'xpath', 'matches-css',
    'matches-css-before', 'matches-css-after', 'min-text-length', 'matches-path',
    'matches-attr', '-abp-has', 'if', 'if-not', 'remove-attr', 'remove-class',
    'watch-attr', 'others', 'matches-media', 'matches-prop',
  ];
  const UNSUPPORTED_PROCEDURAL = ['watch-attr', 'others', 'matches-media', 'matches-prop'];
  const PROC_RE = new RegExp(':(' + PROCEDURAL_OPS.map((s) => s.replace(/[-]/g, '\\-')).join('|') + ')\\(');

  function parseCosmetic(line, m) {
    const domainPart = m[1];
    const sep = m[2];
    let body = m[3];
    if (!DOMAIN_PART_RE.test(domainPart)) return null;
    const exception = sep.includes('@');
    const domains = parseDomainList(domainPart, ',');
    if (domains.invalid && !domains.include.length && !domains.exclude.length) {
      return { type: 'unsupported', reason: 'bad domains', raw: line };
    }

    if (sep.includes('%')) return { type: 'unsupported', reason: 'adguard js', raw: line };
    if (body.startsWith('^')) return { type: 'unsupported', reason: 'html filtering', raw: line };

    // uBO scriptlet ##+js(...)
    if (body.startsWith('+js(')) {
      if (!body.endsWith(')')) return { type: 'unsupported', reason: 'bad scriptlet', raw: line };
      const inner = body.slice(4, -1);
      const parts = splitScriptletArgs(inner);
      const name = (parts.shift() || '').trim();
      if (!name && !exception) return { type: 'unsupported', reason: 'empty scriptlet', raw: line };
      return { type: 'scriptlet', exception, domains, name: normalizeScriptletName(name), args: parts, raw: line };
    }

    // AdGuard CSS injection: #$#selector { style }
    if (sep.includes('$')) {
      const cm = /^(.+?)\s*\{\s*(.*?)\s*\}\s*$/.exec(body);
      if (!cm) return { type: 'unsupported', reason: 'bad css injection', raw: line };
      body = cm[1] + ':style(' + cm[2] + ')';
    }

    if (!body.trim()) return { type: 'unsupported', reason: 'empty selector', raw: line };

    // :style(...) / :remove() suffix
    let kind = 'hide';
    let style = null;
    const styleM = /:style\((.*)\)\s*$/.exec(body);
    if (styleM) {
      kind = 'style';
      style = styleM[1];
      body = body.slice(0, styleM.index);
      if (/url\(|expression|javascript:/i.test(style)) {
        return { type: 'unsupported', reason: 'unsafe style', raw: line };
      }
    } else if (/:remove\(\)\s*$/.test(body)) {
      kind = 'remove';
      body = body.replace(/:remove\(\)\s*$/, '');
    }

    const procMatch = PROC_RE.exec(body);
    if (procMatch) {
      for (const op of UNSUPPORTED_PROCEDURAL) {
        if (body.includes(':' + op + '(')) return { type: 'unsupported', reason: 'procedural :' + op, raw: line };
      }
      return { type: 'cosmetic', exception, domains, selector: body.trim(), kind: kind === 'hide' ? 'procedural' : kind, procedural: true, style, raw: line };
    }

    return { type: 'cosmetic', exception, domains, selector: body.trim(), kind, procedural: false, style, raw: line };
  }

  // ---------- scriptlets ----------

  const SCRIPTLET_ALIASES = {
    'set': 'set-constant', 'set-constant.js': 'set-constant',
    'aopr': 'abort-on-property-read', 'abort-on-property-read.js': 'abort-on-property-read',
    'aopw': 'abort-on-property-write', 'abort-on-property-write.js': 'abort-on-property-write',
    'acs': 'abort-current-script', 'acis': 'abort-current-script',
    'abort-current-inline-script': 'abort-current-script', 'abort-current-script.js': 'abort-current-script',
    'abort-current-inline-script.js': 'abort-current-script',
    'nostif': 'no-setTimeout-if', 'prevent-setTimeout': 'no-setTimeout-if', 'setTimeout-defuser': 'no-setTimeout-if',
    'no-setTimeout-if.js': 'no-setTimeout-if',
    'nosiif': 'no-setInterval-if', 'prevent-setInterval': 'no-setInterval-if', 'setInterval-defuser': 'no-setInterval-if',
    'no-setInterval-if.js': 'no-setInterval-if',
    'prevent-fetch': 'no-fetch-if', 'no-fetch-if.js': 'no-fetch-if',
    'prevent-xhr': 'no-xhr-if', 'no-xhr-if.js': 'no-xhr-if',
    'aeld': 'addEventListener-defuser', 'prevent-addEventListener': 'addEventListener-defuser',
    'addEventListener-defuser.js': 'addEventListener-defuser',
    'ra': 'remove-attr', 'remove-attr.js': 'remove-attr',
    'rc': 'remove-class', 'remove-class.js': 'remove-class',
    'nowebrtc.js': 'nowebrtc',
    'nowoif': 'no-window-open-if', 'prevent-window-open': 'no-window-open-if', 'window.open-defuser': 'no-window-open-if',
    'no-window-open-if.js': 'no-window-open-if',
    'json-prune.js': 'json-prune',
    'noeval.js': 'noeval', 'silent-noeval.js': 'noeval', 'silent-noeval': 'noeval',
    'noeval-if.js': 'noeval-if', 'prevent-eval-if': 'noeval-if',
    'nano-stb': 'nano-setTimeout-booster', 'nano-setTimeout-booster.js': 'nano-setTimeout-booster',
    'adjust-setTimeout': 'nano-setTimeout-booster',
    'nano-sib': 'nano-setInterval-booster', 'nano-setInterval-booster.js': 'nano-setInterval-booster',
    'adjust-setInterval': 'nano-setInterval-booster',
    'rmnt': 'remove-node-text', 'remove-node-text.js': 'remove-node-text',
    'set-local-storage-item.js': 'set-local-storage-item',
    'set-session-storage-item.js': 'set-session-storage-item',
    'json-prune-fetch-response.js': 'json-prune-fetch-response',
    'json-prune-xhr-response.js': 'json-prune-xhr-response',
    'no-requestAnimationFrame-if.js': 'no-requestAnimationFrame-if', 'norafif': 'no-requestAnimationFrame-if',
    'prevent-requestAnimationFrame': 'no-requestAnimationFrame-if',
    'set-cookie.js': 'set-cookie', 'remove-cookie.js': 'remove-cookie', 'cookie-remover': 'remove-cookie',
    'cookie-remover.js': 'remove-cookie',
  };

  function normalizeScriptletName(name) {
    name = name.trim().replace(/^["']|["']$/g, '');
    if (SCRIPTLET_ALIASES[name]) return SCRIPTLET_ALIASES[name];
    if (name.endsWith('.js') && SCRIPTLET_ALIASES[name.slice(0, -3)]) return SCRIPTLET_ALIASES[name.slice(0, -3)];
    return name.replace(/\.js$/, '');
  }

  /** Split "a, b\,c, 'd, e'" -> ['a','b,c','d, e'] */
  function splitScriptletArgs(s) {
    const out = [];
    let cur = '';
    let quote = null;
    let atStart = true;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && (s[i + 1] === ',' || s[i + 1] === quote)) {
        cur += s[++i];
        atStart = false;
        continue;
      }
      if (quote) {
        if (c === quote) { quote = null; continue; }
        cur += c;
        continue;
      }
      if (atStart && (c === '"' || c === "'" || c === '`')) { quote = c; atStart = false; continue; }
      if (c === ',') { out.push(cur.trim()); cur = ''; atStart = true; continue; }
      if (atStart && c === ' ') continue;
      atStart = false;
      cur += c;
    }
    out.push(cur.trim());
    if (out.length === 1 && out[0] === '') return [];
    return out;
  }

  // ---------- network filters ----------

  const KNOWN_OPTIONS = new Set([
    'script', 'image', 'stylesheet', 'css', 'object', 'object-subrequest', 'xmlhttprequest', 'xhr',
    'subdocument', 'frame', 'ping', 'beacon', 'websocket', 'media', 'font', 'other', 'document', 'doc',
    'popup', 'popunder', 'webrtc', 'all', 'third-party', '3p', 'first-party', '1p', 'strict1p', 'strict3p',
    'domain', 'from', 'to', 'denyallow', 'method', 'important', 'match-case', 'badfilter',
    'redirect', 'redirect-rule', 'rewrite', 'empty', 'mp4', 'removeparam', 'queryprune', 'csp',
    'inline-script', 'inline-font', 'elemhide', 'ehide', 'generichide', 'ghide', 'specifichide', 'shide',
    'genericblock', 'content', 'cname', 'ipaddress', 'header', 'replace', 'urlskip', 'uritransform',
    'urltransform', 'permissions', 'stealth', 'cookie', 'network', 'app', 'reason', 'jsonprune',
    'xmlprune', 'hls', 'extension', '_', '__', 'redirect-url',
  ]);

  function findOptionsStart(text) {
    // Regex filter: /.../$opts
    if (text[0] === '/') {
      const end = text.lastIndexOf('/$');
      if (end > 0) return end + 1;
      return -1;
    }
    let idx = text.lastIndexOf('$');
    while (idx !== -1) {
      const rest = text.slice(idx + 1);
      // Treat as an options list if it looks like one and names at least one known option.
      const names = rest.split(',').map((o) => o.trim().replace(/^~/, '').split('=')[0].toLowerCase());
      const looksLikeOptions = names.every((n) => /^[a-z0-9_-]+$/.test(n));
      if (looksLikeOptions && names.some((n) => KNOWN_OPTIONS.has(n) || /^_+$/.test(n))) return idx;
      idx = text.lastIndexOf('$', idx - 1);
    }
    return -1;
  }

  /** Split options on ',' but not inside values that may contain commas (csp=, removeparam=/re/) */
  function splitOptions(s) {
    const out = [];
    let cur = '';
    let inRegex = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '/' && /(removeparam|queryprune|domain|from|to)=$/.test(cur) ) inRegex = true;
      else if (c === '/' && inRegex) inRegex = false;
      if (c === ',' && !inRegex) {
        // csp=... values may contain commas only rarely; uBO escapes them as \,
        if (cur.endsWith('\\')) { cur = cur.slice(0, -1) + ','; continue; }
        out.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }

  function parseNetwork(line) {
    let text = line;
    let exception = false;
    if (text.startsWith('@@')) { exception = true; text = text.slice(2); }

    let optionsText = '';
    const optIdx = findOptionsStart(text);
    if (optIdx !== -1) {
      optionsText = text.slice(optIdx + 1);
      text = text.slice(0, optIdx);
    }

    const options = {};
    if (optionsText) {
      for (let opt of splitOptions(optionsText)) {
        opt = opt.trim();
        if (!opt) continue;
        let neg = false;
        if (opt[0] === '~') { neg = true; opt = opt.slice(1); }
        const eq = opt.indexOf('=');
        const name = (eq === -1 ? opt : opt.slice(0, eq)).toLowerCase();
        const value = eq === -1 ? null : opt.slice(eq + 1);
        if (!KNOWN_OPTIONS.has(name) && !/^_+$/.test(name)) {
          return { type: 'unsupported', reason: 'unknown option ' + name, raw: line };
        }
        if (/^_+$/.test(name)) continue;
        options[name] = { neg, value };
      }
    }

    const isRegex = text.length > 2 && text[0] === '/' && text[text.length - 1] === '/';
    return { type: 'network', exception, pattern: text, isRegex, options, raw: line };
  }

  // ---------- entry point ----------

  function parseFilter(rawLine) {
    const line = String(rawLine).trim();
    if (!line || line[0] === '!' || (line[0] === '[' && line.endsWith(']'))) return { type: 'comment' };
    if (line.startsWith('#') && !line.startsWith('##') && !line.startsWith('#@#') &&
        !line.startsWith('#?#') && !line.startsWith('#$#') && !line.startsWith('#@?#')) {
      return { type: 'comment' }; // hosts-file style comment
    }

    // hosts-file format: "0.0.0.0 example.com"
    const hostsM = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+([^\s#]+)/.exec(line);
    if (hostsM) {
      const h = toASCIIHost(hostsM[1]);
      if (!h || h === 'localhost' || h === '0.0.0.0' || !h.includes('.')) return { type: 'comment' };
      return parseNetwork('||' + h + '^');
    }

    const m = COSMETIC_RE.exec(line);
    if (m && DOMAIN_PART_RE.test(m[1])) {
      const c = parseCosmetic(line, m);
      if (c) return c;
    }
    return parseNetwork(line);
  }

  function hostMatchesDomain(hostname, domain) {
    if (isEntity(domain)) {
      // "example.*" matches example.<anything up to 2 labels> and subdomains thereof
      const base = domain.slice(0, -2);
      const labels = hostname.split('.');
      for (let i = 0; i < labels.length; i++) {
        const rest = labels.slice(i).join('.');
        if (rest.startsWith(base + '.')) {
          const tld = rest.slice(base.length + 1);
          if (tld && tld.split('.').length <= 2) return true;
        }
      }
      return false;
    }
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  /** Candidate lookup keys for a hostname: suffixes + entity forms */
  function hostnameKeys(hostname) {
    const labels = hostname.split('.');
    const keys = [];
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      keys.push(suffix);
      // entity: drop the last 1 or 2 labels -> "base.*"
      const rest = labels.slice(i);
      for (const k of [1, 2]) {
        if (rest.length > k) keys.push(rest.slice(0, rest.length - k).join('.') + '.*');
      }
    }
    return Array.from(new Set(keys));
  }

  const api = {
    parseFilter,
    parseDomainList,
    toASCIIHost,
    isEntity,
    hostMatchesDomain,
    hostnameKeys,
    splitScriptletArgs,
    normalizeScriptletName,
  };
  const ABD = root.ABD || (root.ABD = {});
  ABD.filterParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
