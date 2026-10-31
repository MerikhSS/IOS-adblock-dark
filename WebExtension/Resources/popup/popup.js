/* popup.js — per-site controls for the current tab. */
(async function () {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const $ = (id) => document.getElementById(id);
  const send = (msg) => api.runtime.sendMessage(msg);

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  let state;

  function setSegmented(el, value) {
    for (const b of el.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === value));
  }

  function status(text) { $('status').textContent = text || ''; }

  async function refresh() {
    state = await send({ type: 'getPopupState', tabId: tab.id, url: tab.url });
    if (!state || !state.supported) {
      $('host').textContent = 'AdBlock Dark';
      $('unsupported').hidden = false;
      $('controls').hidden = true;
      $('pick').disabled = true;
      return;
    }
    $('host').textContent = state.host;
    const c = state.counts;
    const parts = [];
    if (c && c.network !== null && c.network !== undefined) parts.push(`${c.network} request${c.network === 1 ? '' : 's'} blocked`);
    if (c && c.cosmetic) parts.push(`${c.cosmetic} element${c.cosmetic === 1 ? '' : 's'} hidden`);
    $('counts').textContent = state.paused ? 'Blocking is paused (all sites)' : (parts.join(' · ') || ' ');

    $('blocking').checked = !state.allowlisted && !state.paused;
    $('blocking').disabled = state.paused;
    $('block-note').textContent = state.allowlisted
      ? (state.allowlistEntry && state.allowlistEntry !== state.host ? `Allowlisted via ${state.allowlistEntry}` : 'Ads are allowed on this site')
      : `${state.enabledLists} filter lists active`;

    setSegmented($('dark-mode'), state.siteDark);
    setSegmented($('engine'), state.siteEngine || '');
    const d = state.dark;
    const src = d.source === 'native' ? ' (site is already dark)' : d.source === 'default' ? ` (default: ${state.darkDefaults.defaultOn ? 'on' : 'off'})` : '';
    $('dark-note').textContent = `Currently ${d.on ? 'ON' : 'off'} using the ${d.engine} engine${src}`;
  }

  async function reloadTab() {
    await send({ type: 'reloadTab', tabId: tab.id });
  }

  $('blocking').addEventListener('change', async (e) => {
    status('Updating rules…');
    await send({ type: 'setAllowlisted', host: state.host, allowlisted: !e.target.checked });
    status('Saved. Reloading…');
    await refresh();
    await reloadTab();
  });

  $('dark-mode').addEventListener('click', async (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v) return;
    setSegmented($('dark-mode'), v);
    await send({ type: 'setSiteDark', host: state.host, mode: v });
    await refresh();
    await reloadTab();
  });

  $('engine').addEventListener('click', async (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (v === undefined) return;
    setSegmented($('engine'), v);
    await send({ type: 'setSiteDark', host: state.host, engine: v || null });
    await refresh();
    await reloadTab();
  });

  $('pick').addEventListener('click', async () => {
    await send({ type: 'startPicker', tabId: tab.id });
    window.close();
  });
  $('reload').addEventListener('click', async () => { await reloadTab(); window.close(); });
  $('options').addEventListener('click', () => { api.runtime.openOptionsPage(); window.close(); });

  await refresh();
  send({ type: 'syncNow' }).catch(() => {});
})();
