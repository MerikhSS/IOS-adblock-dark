#!/usr/bin/env node
/*
 * validate.js — re-check generated output against the constraints Safari's
 * DNR implementation enforces (_WKWebExtensionDeclarativeNetRequestRule.mm),
 * so a bad rule is caught on the Mac instead of silently breaking a ruleset
 * on the phone. Also syntax-checks generated scriptlet bundles.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RS = require('../../WebExtension/Resources/lib/regex-subset.js');

const RES = path.resolve(__dirname, '../../WebExtension/Resources');
const manifest = JSON.parse(fs.readFileSync(path.join(RES, 'manifest.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(RES, 'rules/index.json'), 'utf8'));

const ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme', 'redirect', 'modifyHeaders']);
const TYPES = new Set(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'media', 'ping', 'websocket', 'xmlhttprequest', 'other']);
const METHODS = new Set(['get', 'head', 'options', 'trace', 'put', 'delete', 'post', 'patch', 'connect']);
const ascii = (s) => /^[\x00-\x7f]*$/.test(s);
const token = (s) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(s);

let errors = 0;
let rulesChecked = 0;
function err(where, msg) {
  errors++;
  if (errors <= 50) console.error(`✗ ${where}: ${msg}`);
}

function checkDomains(where, arr, key, allowEmpty) {
  if (arr === undefined) return;
  if (!Array.isArray(arr) || (!allowEmpty && !arr.length)) return err(where, `${key} must be a non-empty array`);
  for (const d of arr) if (typeof d !== 'string' || !ascii(d) || !d) err(where, `${key} has invalid entry ${JSON.stringify(d)}`);
}

function checkRule(r, where) {
  rulesChecked++;
  if (!Number.isInteger(r.id) || r.id < 1) err(where, 'bad id');
  if (!Number.isInteger(r.priority) || r.priority < 1) err(where, 'bad priority');
  const a = r.action || {};
  const c = r.condition || {};
  if (!ACTIONS.has(a.type)) err(where, 'unsupported action ' + a.type);
  if ('domains' in c || 'excludedDomains' in c) err(where, 'legacy domains/excludedDomains key (mixes if-domain with if-top-url)');
  if (c.regexFilter && c.urlFilter) err(where, 'both regexFilter and urlFilter');
  if (c.urlFilter !== undefined && (!ascii(c.urlFilter) || !c.urlFilter)) err(where, 'urlFilter empty/non-ASCII');
  if (c.regexFilter !== undefined) {
    if (!ascii(c.regexFilter)) err(where, 'regexFilter non-ASCII');
    try { new RegExp(c.regexFilter); } catch (e) { err(where, 'regexFilter invalid JS regex ' + c.regexFilter); }
    const again = RS.toWebKitRegexes(c.regexFilter);
    if (!again.ok || again.regexes.length !== 1) err(where, `regexFilter outside WebKit subset (${again.reason || 'expands'}): ${c.regexFilter}`);
  }
  if (c.resourceTypes && c.excludedResourceTypes) err(where, 'both resourceTypes and excludedResourceTypes');
  if (c.resourceTypes !== undefined) {
    if (!c.resourceTypes.length) err(where, 'empty resourceTypes');
    for (const t of c.resourceTypes) if (!TYPES.has(t)) err(where, 'resource type WebKit ignores: ' + t);
  }
  for (const t of c.excludedResourceTypes || []) if (!TYPES.has(t)) err(where, 'excluded type unknown: ' + t);
  if (a.type === 'allowAllRequests') {
    if (!c.resourceTypes) err(where, 'allowAllRequests needs resourceTypes');
    for (const t of c.resourceTypes || []) if (t !== 'main_frame' && t !== 'sub_frame') err(where, 'allowAllRequests with ' + t);
  }
  if (c.domainType && c.domainType !== 'firstParty' && c.domainType !== 'thirdParty') err(where, 'bad domainType');
  checkDomains(where, c.requestDomains, 'requestDomains');
  checkDomains(where, c.initiatorDomains, 'initiatorDomains');
  checkDomains(where, c.excludedRequestDomains, 'excludedRequestDomains', true);
  checkDomains(where, c.excludedInitiatorDomains, 'excludedInitiatorDomains', true);
  for (const k of ['requestMethods', 'excludedRequestMethods']) {
    if (c[k] === undefined) continue;
    if (!c[k].length) err(where, k + ' empty');
    for (const m of c[k]) if (!METHODS.has(m)) err(where, 'bad method ' + m);
  }
  if (a.type === 'redirect') {
    const rd = a.redirect || {};
    if (!rd.url && !rd.extensionPath && !rd.regexSubstitution && !rd.transform) err(where, 'redirect without target');
    if (rd.extensionPath && !fs.existsSync(path.join(RES, rd.extensionPath))) err(where, 'missing surrogate ' + rd.extensionPath);
  }
  if (a.type === 'modifyHeaders') {
    const hs = (a.requestHeaders || []).concat(a.responseHeaders || []);
    if (!hs.length) err(where, 'modifyHeaders without headers');
    for (const h of hs) {
      if (!token(h.header)) err(where, 'invalid header name ' + h.header);
      if (!['append', 'set', 'remove'].includes(h.operation)) err(where, 'bad header operation');
      if (h.operation !== 'remove' && (!h.value || /[\r\n\0]/.test(h.value))) err(where, 'bad header value');
    }
  }
}

// ---- rulesets ----
const resources = (manifest.declarative_net_request || {}).rule_resources || [];
if (resources.length > 100) err('manifest', 'more than 100 static rulesets');
if (resources.filter((r) => r.enabled).length > 50) err('manifest', 'more than 50 rulesets enabled');
for (const res of resources) {
  const file = path.join(RES, res.path);
  if (!fs.existsSync(file)) { err(res.id, 'missing ' + res.path); continue; }
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = new Set();
  for (const r of rules) {
    if (ids.has(r.id)) err(res.id, 'duplicate id ' + r.id);
    ids.add(r.id);
    checkRule(r, `${res.id}#${r.id}`);
  }
}

// ---- budget ----
const enabledCost = index.lists.filter((l) => l.engine === 'dnr' && l.defaultEnabled).reduce((n, l) => n + l.webkitCost, 0);
if (enabledCost > 149000) err('budget', `default-enabled lists need ${enabledCost} WebKit rules (> 150k cap)`);

// ---- scriptlet bundles ----
let bundles = 0;
const slDir = path.join(RES, 'scriptlets');
for (const f of fs.existsSync(slDir) ? fs.readdirSync(slDir) : []) {
  if (!f.endsWith('.js')) continue;
  bundles++;
  try { new Function(fs.readFileSync(path.join(slDir, f), 'utf8')); } catch (e) { err('scriptlets/' + f, 'syntax error: ' + e.message); }
}
for (const f of fs.existsSync(slDir) ? fs.readdirSync(slDir) : []) {
  if (!f.endsWith('.index.json')) continue;
  for (const s of JSON.parse(fs.readFileSync(path.join(slDir, f), 'utf8'))) {
    if (!fs.existsSync(path.join(RES, s.file))) err(f, 'missing ' + s.file);
    for (const m of s.matches) if (m !== '<all_urls>' && !/^\*:\/\/(\*\.)?[a-z0-9.-]+\/\*$/.test(m)) err(f, 'odd match pattern ' + m);
  }
}

// ---- overflow content blocker ----
const overflow = path.resolve(RES, '../../ContentBlockerOverflow1/blockerList.json');
if (fs.existsSync(overflow)) {
  const rules = JSON.parse(fs.readFileSync(overflow, 'utf8'));
  if (rules.length > 150000) err('overflow', 'more than 150000 rules');
  const json = JSON.stringify(rules);
  if (json.includes('"if-domain"') && json.includes('"if-top-url"')) err('overflow', 'mixes if-domain and if-top-url');
}

console.log(`${errors ? '✗' : '✓'} ${rulesChecked} DNR rules in ${resources.length} rulesets, ${bundles} scriptlet bundles checked; default-enabled cost ${enabledCost}`);
process.exit(errors ? 1 : 0);
