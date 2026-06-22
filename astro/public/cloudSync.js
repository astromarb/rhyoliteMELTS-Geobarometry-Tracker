// Optional cloud-sync adapter. Layered on top of legacy.js without modifying
// its semantics: localStorage stays the local source of truth. Manual sync
// only — no automatic push or pull.
//
// Disabled entirely on file:// or when /api/* isn't deployed.
(function () {
  'use strict';

  const isFile = location.protocol === 'file:';
  const Cloud = {
    available: !isFile,    // best-guess; confirmed by first fetch
    admin: false,
    lastError: null,
    lastSyncedAt: null,
  };
  window.Cloud = Cloud;

  // ── helpers ────────────────────────────────────────────────────────────
  async function jfetch(url, opts) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(opts?.headers || {}) },
      ...opts,
    });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : null;
    if (!res.ok) {
      const err = new Error((body && body.error) || `http_${res.status}`);
      err.status = res.status; err.body = body;
      throw err;
    }
    return body;
  }
  const toast = (m) => (window.toast ? window.toast(m) : console.log('[cloud]', m));

  // ── status / auth ──────────────────────────────────────────────────────
  Cloud.checkStatus = async function () {
    if (isFile) return { available: false, admin: false };
    try {
      const r = await jfetch('/api/auth');
      Cloud.available = true;
      Cloud.admin = Boolean(r.admin);
      return { available: true, admin: Cloud.admin };
    } catch (e) {
      Cloud.available = e.status !== 404 && e.status !== undefined;
      Cloud.admin = false;
      return { available: Cloud.available, admin: false };
    }
  };

  Cloud.login = async function (token) {
    await jfetch('/api/auth', { method: 'POST', body: JSON.stringify({ token }) });
    Cloud.admin = true;
    return true;
  };

  Cloud.logout = async function () {
    await jfetch('/api/auth', { method: 'DELETE' });
    Cloud.admin = false;
  };

  // ── snapshot pull/push ────────────────────────────────────────────────
  Cloud.pull = async function () {
    const r = await jfetch('/api/snapshot');
    Cloud.lastSyncedAt = r.updated_at;
    return r;  // { data, updated_at, updated_by }
  };

  // Replace local state with a remote payload. Goes through the same migrate
  // path as a fresh load so schema upgrades apply.
  Cloud.applySnapshot = function (remoteData) {
    if (!remoteData || typeof remoteData !== 'object') throw new Error('bad_snapshot');
    const migrated = window.migrate ? window.migrate(remoteData) : remoteData;
    if (!migrated) throw new Error('migrate_failed');
    const S = window.S;
    for (const k of Object.keys(S)) delete S[k];
    Object.assign(S, migrated);
    if (window.flushSave) window.flushSave();
    if (window.renderAll)  window.renderAll();
  };

  Cloud.push = async function (note) {
    if (!window.S) throw new Error('no_state');
    const payload = JSON.parse(JSON.stringify(window.S));
    payload._schemaVersion = window.SCHEMA_VERSION;
    payload._migrated = true;
    const r = await jfetch('/api/snapshot', {
      method: 'PUT',
      body: JSON.stringify({ data: payload, note: note || '' }),
    });
    return r;
  };

  // ── history / restore ─────────────────────────────────────────────────
  Cloud.history = async function (limit = 50) {
    const r = await jfetch(`/api/snapshot/history?limit=${limit}`);
    return r.history || [];
  };

  Cloud.restore = async function (historyId) {
    return jfetch('/api/snapshot/restore', {
      method: 'POST', body: JSON.stringify({ id: historyId }),
    });
  };

  // ── boot: read ?admin=<token> from URL, exchange for cookie, then check ─
  async function boot() {
    if (isFile) return;
    try {
      const url = new URL(location.href);
      const tok = url.searchParams.get('admin');
      if (tok) {
        try { await Cloud.login(tok); toast('Admin mode enabled'); }
        catch { toast('Invalid admin token'); }
        url.searchParams.delete('admin');
        history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
      }
      await Cloud.checkStatus();
      window.dispatchEvent(new CustomEvent('cloud:ready', { detail: { ...Cloud } }));
    } catch (e) {
      Cloud.lastError = e.message;
    }
  }
  // Defer until legacy.js has finished its initial render.
  if (document.readyState === 'complete') queueMicrotask(boot);
  else window.addEventListener('load', boot, { once: true });
})();
