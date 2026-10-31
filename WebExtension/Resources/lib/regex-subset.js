/*
 * regex-subset.js — translate JavaScript regular expressions (as used in
 * ABP/uBO `/regex/` filters) into the restricted dialect that WebKit content
 * rule lists accept (and therefore what Safari's declarativeNetRequest accepts,
 * because Safari compiles DNR rules into a WebKit content rule list).
 *
 * WebKit's URLFilterParser (Source/WebCore/contentextensions/URLFilterParser.cpp)
 * supports ONLY:
 *   - ASCII literal characters and escaped punctuation
 *   - `.` (any char), character classes `[...]` / `[^...]` (no \d \w inside)
 *   - groups `( )` (non-capturing `(?: )` is fine)
 *   - quantifiers `?`, `*`, `+` (no {n,m})
 *   - `^` only at the very beginning, `$` only at the very end
 * and rejects: disjunction `|`, \d \w \s \b, lookarounds, back-references,
 * {n,m} quantifiers, non-ASCII, and patterns that match everything.
 *
 * We rewrite what we can:
 *   \d -> [0-9], \w -> [A-Za-z0-9_], {n}/{n,m}/{n,} -> repetition,
 *   lazy quantifiers -> greedy, (?:x) -> (x), and expand small disjunctions
 *   into several regexes (one DNR rule each).
 *
 * Works in Node (module.exports) and in the extension (globalThis.ABD.regexSubset).
 */
(function (root) {
  'use strict';

  const MAX_ALTERNATIVES = 8;
  const MAX_REPEAT = 12;

  class Unsupported extends Error {}

  function fail(reason) { throw new Unsupported(reason); }

  function isAscii(ch) { return ch.charCodeAt(0) < 128; }

  // ---------- Parser: JS regex source -> small AST ----------
  // Node types:
  //  {t:'alt', options:[seq]}   {t:'seq', items:[item]}
  //  {t:'atom', text, min}      (min = minimum match length, 0/1)
  //  {t:'group', body:alt}      {t:'bol'} {t:'eol'}
  //  item: {node, q}            q = null | '?' | '*' | '+' | {min,max}

  function parse(src) {
    let i = 0;

    function peek() { return src[i]; }

    function parseAlt() {
      const options = [parseSeq()];
      while (src[i] === '|') { i++; options.push(parseSeq()); }
      return { t: 'alt', options };
    }

    function parseSeq() {
      const items = [];
      while (i < src.length && src[i] !== '|' && src[i] !== ')') {
        const node = parseAtom();
        const q = parseQuantifier();
        if (q && (node.t === 'bol' || node.t === 'eol')) fail('quantified anchor');
        items.push({ node, q });
      }
      return { t: 'seq', items };
    }

    function parseQuantifier() {
      const c = src[i];
      let q = null;
      if (c === '?' || c === '*' || c === '+') { q = c; i++; }
      else if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
        if (!m) return null; // literal '{' — handled by atom on next loop (escaped below)
        i += m[0].length;
        const min = parseInt(m[1], 10);
        const max = m[2] === undefined ? min : (m[3] === '' ? Infinity : parseInt(m[3], 10));
        if (max < min) fail('bad quantifier');
        q = { min, max };
      }
      if (q && src[i] === '?') i++; // lazy -> greedy (same match set for a filter)
      return q;
    }

    function parseClass() {
      // src[i] === '['
      i++;
      let out = '[';
      if (src[i] === '^') { out += '^'; i++; }
      if (src[i] === ']') { out += '\\]'; i++; }
      while (i < src.length && src[i] !== ']') {
        let c = src[i];
        if (c === '\\') {
          const n = src[i + 1];
          i += 2;
          if (n === undefined) fail('dangling escape');
          if (n === 'd') { out += '0-9'; continue; }
          if (n === 'w') { out += 'A-Za-z0-9_'; continue; }
          if ('DWsSbB'.includes(n)) fail('class escape \\' + n);
          if (n === 'x') { const h = src.substr(i, 2); i += 2; out += escClassChar(String.fromCharCode(parseInt(h, 16))); continue; }
          if (n === 'u') { const h = src.substr(i, 4); i += 4; out += escClassChar(String.fromCharCode(parseInt(h, 16))); continue; }
          if (!isAscii(n)) fail('non-ascii');
          out += '\\' + n;
          continue;
        }
        if (!isAscii(c)) fail('non-ascii');
        out += c;
        i++;
      }
      if (src[i] !== ']') fail('unterminated class');
      i++;
      return out + ']';
    }

    function escClassChar(ch) {
      if (!ch || !isAscii(ch)) fail('non-ascii');
      return /[\]\\^-]/.test(ch) ? '\\' + ch : ch;
    }

    function escChar(ch) {
      if (!ch || !isAscii(ch)) fail('non-ascii');
      return /[\\^$.*+?()[\]{}|]/.test(ch) ? '\\' + ch : ch;
    }

    function parseAtom() {
      const c = src[i];
      if (c === '(') {
        i++;
        if (src[i] === '?') {
          if (src[i + 1] === ':') i += 2;
          else fail('lookaround or named group');
        }
        const body = parseAlt();
        if (src[i] !== ')') fail('unterminated group');
        i++;
        return { t: 'group', body };
      }
      if (c === '[') return { t: 'atom', text: parseClass(), min: 1 };
      if (c === '.') { i++; return { t: 'atom', text: '.', min: 1 }; }
      if (c === '^') { i++; return { t: 'bol' }; }
      if (c === '$') { i++; return { t: 'eol' }; }
      if (c === '\\') {
        const n = src[i + 1];
        i += 2;
        if (n === undefined) fail('dangling escape');
        if (n === 'd') return { t: 'atom', text: '[0-9]', min: 1 };
        if (n === 'w') return { t: 'atom', text: '[A-Za-z0-9_]', min: 1 };
        if ('DWsSbB'.includes(n)) fail('escape \\' + n);
        if (/[1-9]/.test(n)) fail('back-reference');
        if (n === 'x') { const h = src.substr(i, 2); i += 2; return { t: 'atom', text: escChar(String.fromCharCode(parseInt(h, 16))), min: 1 }; }
        if (n === 'u') { const h = src.substr(i, 4); i += 4; return { t: 'atom', text: escChar(String.fromCharCode(parseInt(h, 16))), min: 1 }; }
        if (n === 'n' || n === 'r' || n === 't' || n === 'f' || n === 'v' || n === '0') fail('control escape');
        if (!isAscii(n)) fail('non-ascii');
        return { t: 'atom', text: escChar(n), min: 1 };
      }
      if (c === ')' ) fail('unbalanced )');
      if (c === '*' || c === '+' || c === '?') fail('nothing to quantify');
      if (!isAscii(c)) fail('non-ascii');
      i++;
      return { t: 'atom', text: c === '{' || c === '}' ? '\\' + c : c, min: 1 };
    }

    const ast = parseAlt();
    if (i !== src.length) fail('trailing input');
    return ast;
  }

  // ---------- Expansion: AST -> list of {s, min} strings ----------
  // Each expansion is a WebKit-compatible regex fragment plus its minimum length.

  function cartesian(lists) {
    let acc = [{ s: '', min: 0 }];
    for (const list of lists) {
      const next = [];
      for (const a of acc) for (const b of list) next.push({ s: a.s + b.s, min: a.min + b.min });
      if (next.length > MAX_ALTERNATIVES) fail('too many alternatives');
      acc = next;
    }
    return acc;
  }

  function expandAlt(node) {
    const out = [];
    for (const seq of node.options) out.push(...expandSeq(seq));
    if (out.length > MAX_ALTERNATIVES) fail('too many alternatives');
    return out;
  }

  function expandSeq(seq) {
    return cartesian(seq.items.map(expandItem));
  }

  function wrapGroup(s) {
    // Single atoms don't need grouping.
    if (/^(\\.|\[(\\.|[^\]])*\]|.)$/.test(s)) return s;
    return '(' + s + ')';
  }

  function expandItem({ node, q }) {
    if (node.t === 'bol') return [{ s: '^', min: 0, bol: true }];
    if (node.t === 'eol') return [{ s: '$', min: 0, eol: true }];

    let bases;
    if (node.t === 'atom') bases = [{ s: node.text, min: node.min }];
    else bases = expandAlt(node.body).map((e) => ({ s: wrapGroup(e.s), min: e.min }));

    if (!q) return bases;

    if (typeof q === 'string') {
      if (bases.length > 1) {
        if (q === '?') return [{ s: '', min: 0 }, ...bases];
        fail('quantified disjunction');
      }
      const b = bases[0];
      return [{ s: wrapGroup(b.s) + q, min: q === '+' ? b.min : 0 }];
    }

    // {min,max}
    const { min, max } = q;
    if (bases.length > 1) fail('quantified disjunction');
    const b = bases[0];
    const unit = wrapGroup(b.s);
    if (min === 0 && max === 1) return [{ s: unit + '?', min: 0 }];
    if (min === 0 && max === Infinity) return [{ s: unit + '*', min: 0 }];
    if (min === 1 && max === Infinity) return [{ s: unit + '+', min: b.min }];
    if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) fail('repeat too large');
    let s = unit.repeat(min);
    if (max === Infinity) s += unit + '*';
    else s += (unit + '?').repeat(max - min);
    return [{ s, min: b.min * min }];
  }

  /**
   * @param {string} source  JS regex source, without the surrounding slashes
   * @returns {{ok:true, regexes:string[]} | {ok:false, reason:string}}
   */
  function toWebKitRegexes(source) {
    try {
      const ast = parse(source);
      const exps = expandAlt(ast);
      const regexes = [];
      for (const e of exps) {
        let s = e.s;
        // `^` only allowed at very start, `$` only at very end.
        const inner = s.replace(/^\^/, '').replace(/\$$/, '');
        if (/(^|[^\\])(\\\\)*\^/.test(inner.replace(/\[[^\]]*\]/g, ''))) fail('misplaced ^');
        if (/(^|[^\\])(\\\\)*\$/.test(inner.replace(/\[[^\]]*\]/g, ''))) fail('misplaced $');
        if (e.min === 0) fail('matches everything');
        regexes.push(s);
      }
      return { ok: true, regexes: Array.from(new Set(regexes)) };
    } catch (err) {
      if (err instanceof Unsupported) return { ok: false, reason: err.message };
      throw err;
    }
  }

  const api = { toWebKitRegexes, MAX_ALTERNATIVES };
  const ABD = root.ABD || (root.ABD = {});
  ABD.regexSubset = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
