#!/usr/bin/env node
/*
 * fetch.js — download every list in lists.json into filters/cache/<id>.txt,
 * resolving uBO `!#include` directives (same-origin only). Uses conditional
 * requests (ETag/Last-Modified) so re-runs are cheap.
 *
 *   node scripts/fetch.js            # all lists
 *   node scripts/fetch.js easylist   # one list
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'lists.json'), 'utf8'));

async function get(url, meta) {
  const headers = { 'user-agent': 'AdBlockDark-filter-builder/1.0' };
  if (meta && meta.etag) headers['if-none-match'] = meta.etag;
  if (meta && meta.lastModified) headers['if-modified-since'] = meta.lastModified;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow' });
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { text: await res.text(), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

async function resolveIncludes(text, baseURL, depth) {
  if (depth > 3) return text;
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^!#include\s+(\S+)/.exec(line);
    if (!m) { out.push(line); continue; }
    const url = new URL(m[1], baseURL);
    if (url.origin !== new URL(baseURL).origin) { out.push('! (skipped cross-origin include ' + m[1] + ')'); continue; }
    const sub = await get(url.href);
    out.push('! >>> include ' + m[1]);
    out.push(await resolveIncludes(sub.text, url.href, depth + 1));
    out.push('! <<< include ' + m[1]);
  }
  return out.join('\n');
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const only = process.argv.slice(2);
  const lists = catalog.lists.filter((l) => !only.length || only.includes(l.id));
  let failed = 0;
  for (const l of lists) {
    const file = path.join(CACHE, l.id + '.txt');
    const metaFile = path.join(CACHE, l.id + '.meta.json');
    const meta = fs.existsSync(metaFile) && fs.existsSync(file) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
    try {
      const r = await get(l.url, meta);
      if (r.notModified) { console.log(`= ${l.id} (not modified)`); continue; }
      const text = await resolveIncludes(r.text, l.url, 0);
      fs.writeFileSync(file, text);
      fs.writeFileSync(metaFile, JSON.stringify({ etag: r.etag, lastModified: r.lastModified, fetched: new Date().toISOString() }, null, 2));
      console.log(`✓ ${l.id} ${(text.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      failed++;
      console.error(`✗ ${l.id}: ${e.message}` + (fs.existsSync(file) ? ' (keeping cached copy)' : ''));
    }
  }
  if (failed) process.exitCode = 1;
}

main();
