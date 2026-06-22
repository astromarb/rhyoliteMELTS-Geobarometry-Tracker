import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_PATH = resolve(__dirname, '..', 'public', 'legacy.js');

/**
 * Inject legacy.js into jsdom. The BOOT block in legacy.js is gated on
 * `window.__TEST_MODE__` — we set the flag before evaluation so the
 * synchronous load() + render cascade is skipped. Everything else (all
 * function declarations + the final Object.assign(window, ...) export)
 * still runs, putting the surface area onto window for tests to use.
 */
export function loadLegacy() {
  if (globalThis.__LEGACY_LOADED__) return;
  window.__TEST_MODE__ = true;
  const code = readFileSync(LEGACY_PATH, 'utf8') + `
    // Expose script-scoped lets that legacy.js doesn't already attach to window.
    window.S = S;
    window.activeTab = activeTab;
    window.activeThreshTab = activeThreshTab;
  `;
  new Function('window', 'document', 'localStorage', code)(
    globalThis.window, globalThis.document, globalThis.localStorage,
  );
  globalThis.__LEGACY_LOADED__ = true;
}

/** Reset state by mutating in place — preserves closure refs. */
export function resetState() {
  if (!globalThis.__LEGACY_LOADED__) return;
  const S = window.S, aT = window.activeTab, aTT = window.activeThreshTab;
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, {
    samples: [], simsets: [], activeSimsetId: null,
    activeSampleId: null, activeThreshSid: null, activePage: 'runs',
  });
  for (const k of Object.keys(aT)) delete aT[k];
  for (const k of Object.keys(aTT)) delete aTT[k];
  window.localStorage.clear();
}
