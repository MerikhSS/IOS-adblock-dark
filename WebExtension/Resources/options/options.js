/* options.js — full management UI inside the extension (works without App Groups). */
(async function () {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const $ = (id) => document.getElementById(id);
  const send = (msg) => api.runtime.sendMessage(msg);
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const k of kids) e.append(k);
    return e;
  };
  let state;
  let lastProbe = null;

  function status(t) { $('status').textContent = t || ''; if (t) setTimeout(() => { if ($('status').textContent === t) $('status').textContent = ''; }, 4000); }
  function setSeg(container, v) { for (const b of container.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === v)); }

  // ---------- tabs ----------
  $('tabs').addEventListener('click', (e) => {
    const t = e.target.dataset && e.target.dataset.tab;
    if (!t) return;
    for (const b of $('tabs').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.tab === t));
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t;
    if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
  });
  if (location.hash) { const b = document.querySelector(`[data-tab="${location.hash.slice(1)}"]`); if (b) b.click(); }

  // ---------- render ----------
  function renderLists() {
    const s = state.settings;
    $('paused').checked = !!s.blockingPaused;
    const b = state.budget;
    const pct = Math.min(100, Math.round((b.cost / b.hardCap) * 100));
    const bar = $('budget-bar');
    bar.style.width = pct + '%';
    bar.className = b.cost > b.budget ? (b.ok ? 'warn' : 'bad') : '';
    $('budget-text').textContent = `${b.cost.toLocaleString()} converted Safari rules (soft budget ${b.budget.toLocaleString()}, hard cap ${b.hardCap.toLocaleString()} incl. your rules). Over the cap Safari blocks nothing at all, so lists that don't fit can't be enabled.`;
    const box = $('lists');
    box.textContent = '';
    const groups = {};
    for (const l of state.index.lists) (groups[l.group] || (groups[l.group] = [])).push(l);
    for (const [g, lists] of Object.entries(groups)) {
      box.append(el('div', { class: 'row' }, el('small', {}, g.toUpperCase())));
      for (const l of lists) {
        const cb = el('input', { type: 'checkbox', class: 'switch' });
        cb.checked = state.enabled.includes(l.id);
        cb.disabled = l.engine !== 'dnr';
        cb.addEventListener('change', async () => {
          const ids = state.enabled.filter((x) => x !== l.id).concat(cb.checked ? [l.id] : []);
          const r = await send({ type: 'setEnabledLists', ids });
          if (!r.ok) { cb.checked = !cb.checked; alert(r.error); return; }
          status('Lists updated — Safari is recompiling rules (a few seconds)');
          await load();
        });
        const info = `${l.dnrRules.toLocaleString()} rules → ${l.webkitCost.toLocaleString()} Safari rules · ${l.genericSelectors.toLocaleString()} generic + ${l.specificHosts.toLocaleString()} site cosmetic` + (l.engine !== 'dnr' ? ' · overflow Content Blocker (toggle in iOS Settings)' : '');
        box.append(el('label', { class: 'row list-row' }, el('span', {}, el('strong', {}, l.name), el('small', {}, info)), cb));
      }
    }
    $('built').textContent = new Date(state.index.builtAt).toLocaleString();
  }

  function renderRules() {
    if (document.activeElement !== $('custom')) $('custom').value = state.settings.customRules || '';
    renderErrors(state.customRuleErrors);
  }
  function renderErrors(errors) {
    $('custom-errors').textContent = (errors || []).map((e) => (e.line ? `Line ${e.line}: ` : '') + `${e.reason}${e.text ? ' — ' + e.text : ''}`).join('\n');
  }

  function renderAllow() {
    const box = $('allow-list');
    box.textContent = '';
    for (const h of state.settings.allowlist) {
      box.append(el('div', { class: 'item' }, el('span', {}, h), el('button', { onclick: async () => {
        await send({ type: 'setAllowlist', hosts: state.settings.allowlist.filter((x) => x !== h) });
        await load();
      } }, 'Remove')));
    }
    if (!state.settings.allowlist.length) box.append(el('div', { class: 'item' }, el('small', {}, 'No sites yet.')));
  }

  function renderDark() {
    const d = state.settings.dark;
    $('dark-default').checked = !!d.defaultOn;
    $('dark-auto').checked = d.autoNative !== false;
    setSeg($('dark-engine'), d.engine);
    $('dark-br').value = d.brightness; $('br-v').textContent = d.brightness + '%';
    $('dark-ct').value = d.contrast; $('ct-v').textContent = d.contrast + '%';
    $('dark-sp').value = d.sepia; $('sp-v').textContent = d.sepia + '%';
    $('native-count').textContent = `${state.settings.nativeDark.length} site(s) auto-detected as already dark`;
    const box = $('dark-sites');
    box.textContent = '';
    const sites = Object.entries(state.settings.sites);
    for (const [h, v] of sites.sort()) {
      box.append(el('div', { class: 'item' }, el('span', {}, `${h} — dark ${v.dark || 'default'}${v.engine ? ', ' + v.engine : ''}`), el('button', { onclick: async () => {
        const next = Object.assign({}, state.settings.sites); delete next[h];
        await send({ type: 'setSites', sites: next });
        await load();
      } }, 'Reset')));
    }
    if (!sites.length) box.append(el('div', { class: 'item' }, el('small', {}, 'No per-site settings yet.')));
  }

  function renderStats() {
    const st = state.stats || { days: {}, sites: {} };
    const days = Object.entries(st.days).sort().slice(-30);
    const max = Math.max(1, ...days.map(([, v]) => v.network + v.cosmetic));
    const db = $('stats-days');
    db.textContent = '';
    for (const [d, v] of days.reverse()) {
      db.append(el('div', { class: 'bar' }, el('span', {}, d), el('div', { class: 'fill', style: `width:${Math.max(2, ((v.network + v.cosmetic) / max) * 60)}%` }), el('span', {}, `${v.network} req · ${v.cosmetic} el`)));
    }
    if (!days.length) db.append(el('small', {}, 'Nothing yet — browse a little.'));
    const sb = $('stats-sites');
    sb.textContent = '';
    for (const [h, v] of Object.entries(st.sites).slice(0, 25)) sb.append(el('div', { class: 'bar' }, el('span', {}, h), el('span', {}, `${v.network} req · ${v.cosmetic} el`)));
  }

  function renderDiag() {
    $('sync').textContent = JSON.stringify(state.lastNativeSync, null, 2) || 'never';
    $('diag-status').textContent = [
      `Extension ${state.version}`,
      `Filters built ${state.index.builtAt}`,
      `Enabled lists: ${state.enabled.join(', ') || 'none'}`,
      `Cosmetic data loaded: ${state.cosmeticReady ? 'yes' : 'loading…'}`,
      `Last apply: ${state.lastApply ? state.lastApply.at + ' (' + state.lastApply.reason + ')' : 'never'}`,
      state.lastApplyError ? 'Last apply error: ' + state.lastApplyError : '',
      state.registrationErrors.length ? 'Registration errors:\n  ' + state.registrationErrors.join('\n  ') : 'Registration errors: none',
    ].filter(Boolean).join('\n');
  }

  async function load() {
    state = await send({ type: 'getOptionsState' });
    renderLists(); renderRules(); renderAllow(); renderDark(); renderStats(); renderDiag();
  }

  // ---------- events ----------
  $('paused').addEventListener('change', async (e) => { await send({ type: 'setPaused', paused: e.target.checked }); status(e.target.checked ? 'Blocking paused' : 'Blocking resumed'); await load(); });

  $('save-custom').addEventListener('click', async () => {
    status('Applying…');
    const r = await send({ type: 'setCustomRules', text: $('custom').value });
    renderErrors(r.errors);
    status(r.errors && r.errors.length ? `Saved with ${r.errors.length} problem(s)` : 'Saved');
    await load();
  });

  $('allow-add').addEventListener('click', async () => {
    const v = $('allow-input').value.trim();
    if (!v) return;
    await send({ type: 'setAllowlist', hosts: state.settings.allowlist.concat([v]) });
    $('allow-input').value = '';
    await load();
  });

  const saveDark = async (patch) => { await send({ type: 'setDarkDefaults', dark: patch }); await load(); status('Saved — reload pages to see changes'); };
  $('dark-default').addEventListener('change', (e) => saveDark({ defaultOn: e.target.checked }));
  $('dark-auto').addEventListener('change', (e) => saveDark({ autoNative: e.target.checked }));
  $('dark-engine').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (v) saveDark({ engine: v }); });
  for (const [id, key, label] of [['dark-br', 'brightness', 'br-v'], ['dark-ct', 'contrast', 'ct-v'], ['dark-sp', 'sepia', 'sp-v']]) {
    $(id).addEventListener('input', (e) => { $(label).textContent = e.target.value + '%'; });
    $(id).addEventListener('change', (e) => saveDark({ [key]: parseInt(e.target.value, 10) }));
  }
  $('clear-native').addEventListener('click', async () => { await send({ type: 'clearNativeDark' }); await load(); });
  $('reset-stats').addEventListener('click', async () => { await send({ type: 'resetStats' }); await load(); });

  $('run-probe').addEventListener('click', async () => {
    $('probe').textContent = 'Running…';
    lastProbe = await send({ type: 'probe' });
    const box = $('probe');
    box.textContent = '';
    for (const r of lastProbe.results) {
      box.append(el('div', { class: 'probe-row' }, el('span', { class: r.ok ? 'ok' : 'no' }, r.ok ? '✓' : '✗'), el('span', {}, r.name, ' ', el('small', {}, r.detail))));
    }
    box.append(el('small', {}, lastProbe.userAgent));
  });
  $('copy-probe').addEventListener('click', async () => {
    if (!lastProbe) return;
    const text = lastProbe.results.map((r) => `${r.ok ? 'OK ' : 'NO '} ${r.name}: ${r.detail}`).join('\n') + '\n' + lastProbe.userAgent;
    try { await navigator.clipboard.writeText(text); status('Copied'); } catch (_) { prompt('Copy this:', text); }
  });
  $('sync-now').addEventListener('click', async () => { const r = await send({ type: 'syncNow' }); $('sync').textContent = JSON.stringify(r, null, 2); });
  $('reapply').addEventListener('click', async () => { status('Re-applying…'); const r = await send({ type: 'reapply' }); status(r.error ? 'Error: ' + r.error : 'Done'); await load(); });

  await load();
})();
