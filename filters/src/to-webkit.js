/*
 * to-webkit.js — translate DNR rules into classic Safari Content Blocker JSON
 * (for the optional "overflow" Content Blocker extension). This mirrors
 * WebKit's own DNR→content-rule translation (_WKWebExtensionDeclarativeNetRequestRule.mm,
 * `ruleInWebKitFormat`), restricted to what Content Blocker extensions accept:
 * block / ignore-previous-rules / css-display-none / make-https.
 *
 * Rule order matters in content blockers: later `ignore-previous-rules` rules
 * cancel earlier matches. So we emit blocks first (lowest priority first),
 * then exceptions, then (at runtime) the user allowlist.
 */
'use strict';

const TYPE_MAP = {
  font: 'font', image: 'image', main_frame: 'document', media: 'media', other: 'other', ping: 'ping',
  script: 'script', stylesheet: 'style-sheet', sub_frame: 'document', websocket: 'websocket', xmlhttprequest: 'fetch',
};
const DEFAULT_TYPES = ['font', 'image', 'media', 'other', 'ping', 'script', 'stylesheet', 'sub_frame', 'websocket', 'xmlhttprequest'];

function escapeRegex(s, chars) {
  let out = '';
  for (const c of s) out += chars.includes(c) ? '\\' + c : c;
  return out;
}

function urlFilterToRegex(f) {
  if (!f) return null;
  let p = f;
  const domainAnchor = p.startsWith('||');
  if (domainAnchor) p = p.slice(2);
  const startAnchor = !domainAnchor && p.startsWith('|');
  if (startAnchor) p = p.slice(1);
  const endAnchor = p.endsWith('|');
  if (endAnchor) p = p.slice(0, -1);
  let r = escapeRegex(p, '?+[(){}$|\\.');
  r = r.replace(/\*/g, '.*').replace(/\^/g, '[^a-zA-Z0-9_.%-]');
  if (domainAnchor) r = '^[^:]+://+([^:/]+\\.)?' + r;
  if (startAnchor) r = '^' + r;
  if (endAnchor) r += '$';
  return r;
}

function domainToFrameRegex(d) {
  return '^[^:]+://+([^:/]+\\.)?' + escapeRegex(d, '*?+[(){}^$|\\.') + '[:/]';
}

function types(cond) {
  let list;
  if (cond.resourceTypes) list = cond.resourceTypes;
  else if (cond.excludedResourceTypes) list = DEFAULT_TYPES.concat(['main_frame']).filter((t) => !cond.excludedResourceTypes.includes(t));
  else list = DEFAULT_TYPES;
  return Array.from(new Set(list.map((t) => TYPE_MAP[t]).filter(Boolean)));
}

function oneRule(cond, actionType, urlRegex) {
  const trigger = { 'url-filter': urlRegex || '.*' };
  if (cond.isUrlFilterCaseSensitive) trigger['url-filter-is-case-sensitive'] = true;
  const t = types(cond);
  if (t.length) trigger['resource-type'] = t;
  if (cond.domainType) trigger['load-type'] = [cond.domainType === 'thirdParty' ? 'third-party' : 'first-party'];
  if (cond.initiatorDomains) trigger['if-frame-url'] = cond.initiatorDomains.map(domainToFrameRegex);
  else if (cond.excludedInitiatorDomains) trigger['unless-frame-url'] = cond.excludedInitiatorDomains.map(domainToFrameRegex);
  return { trigger, action: { type: actionType } };
}

/** @returns WebKit rules for one DNR rule (may be empty if unsupported) */
function dnrToWebKit(rule) {
  const a = rule.action.type;
  let actionType;
  if (a === 'block') actionType = 'block';
  else if (a === 'allow') actionType = 'ignore-previous-rules';
  else if (a === 'upgradeScheme') actionType = 'make-https';
  else return []; // redirect/modifyHeaders/allowAllRequests not representable in classic content blockers
  const c = rule.condition;
  if (c.requestMethods || c.excludedRequestMethods) return [];
  const out = [];
  const base = c.regexFilter || urlFilterToRegex(c.urlFilter);
  let bases = [base];
  if (c.requestDomains && !c.regexFilter) {
    if (c.urlFilter) return []; // rare (to= combined with a path); not worth approximating
    bases = c.requestDomains.map((d) => urlFilterToRegex('||' + d + '^'));
  }
  for (const b of bases) {
    const cond = Object.assign({}, c);
    if (c.initiatorDomains && c.excludedInitiatorDomains) {
      // WebKit can't express both: emit include-only (stricter = safer).
      delete cond.excludedInitiatorDomains;
    }
    out.push(oneRule(cond, actionType, b));
  }
  if (c.excludedRequestDomains && actionType === 'block') {
    for (const d of c.excludedRequestDomains) out.push(oneRule(c, 'ignore-previous-rules', urlFilterToRegex('||' + d + '^')));
  }
  return out;
}

function buildContentBlockerJSON(dnrRules) {
  const sorted = dnrRules.slice().sort((x, y) => x.priority - y.priority);
  const blocks = [];
  const allows = [];
  for (const r of sorted) {
    for (const w of dnrToWebKit(r)) (w.action.type === 'ignore-previous-rules' ? allows : blocks).push(w);
  }
  return blocks.concat(allows);
}

module.exports = { dnrToWebKit, buildContentBlockerJSON, urlFilterToRegex };
