/*
 * preprocess.js — evaluate uBO/AdGuard `!#if … !#else … !#endif` directives.
 * Tokens that are true for this project: we behave like uBO Lite on Safari
 * (MV3, mobile-capable, native :has(), no HTML filtering).
 */
'use strict';

const TRUE_TOKENS = new Set([
  'env_safari', 'env_mv3', 'env_mobile', 'ext_ublock', 'ext_ubol', 'cap_user_stylesheet',
  'native_css_has', 'true',
]);

function evalExpr(expr) {
  // Supports !, &&, ||, parentheses and identifiers.
  const tokens = expr.match(/!|&&|\|\||\(|\)|[A-Za-z0-9_]+/g) || [];
  let i = 0;
  function parseOr() {
    let v = parseAnd();
    while (tokens[i] === '||') { i++; const r = parseAnd(); v = v || r; }
    return v;
  }
  function parseAnd() {
    let v = parseNot();
    while (tokens[i] === '&&') { i++; const r = parseNot(); v = v && r; }
    return v;
  }
  function parseNot() {
    if (tokens[i] === '!') { i++; return !parseNot(); }
    if (tokens[i] === '(') { i++; const v = parseOr(); if (tokens[i] === ')') i++; return v; }
    const t = tokens[i++];
    return TRUE_TOKENS.has(t);
  }
  return tokens.length ? parseOr() : false;
}

function preprocess(text) {
  const out = [];
  const stack = []; // each: {active, parentActive, taken}
  let active = true;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('!#if ')) {
      const cond = evalExpr(t.slice(5));
      stack.push({ parentActive: active, cond });
      active = active && cond;
      continue;
    }
    if (t === '!#else') {
      const top = stack[stack.length - 1];
      if (top) active = top.parentActive && !top.cond;
      continue;
    }
    if (t === '!#endif') {
      const top = stack.pop();
      active = top ? top.parentActive : true;
      continue;
    }
    if (active) out.push(line);
  }
  return out;
}

module.exports = { preprocess, evalExpr, TRUE_TOKENS };
