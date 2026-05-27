import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadLegacy, resetState } from './_loadLegacy.js';

beforeAll(loadLegacy);
beforeEach(resetState);

// Pull window-attached refs into module scope for terse test code.
// loadLegacy() puts function decls on jsdom's window automatically;
// the few `let`-declared constants are mirrored onto globalThis by
// the loader's epilogue.
const w = globalThis;

describe('factories', () => {
  it('mkComps returns N "not-run" cells numbered 1..N', () => {
    const cells = w.mkComps(5);
    expect(cells).toHaveLength(5);
    expect(cells[0]).toMatchObject({ num: 1, status: w.ST.NR, note: '' });
    expect(cells[4].num).toBe(5);
  });

  it('mkSampleEntity stamps a unique id and createdAt', () => {
    const a = w.mkSampleEntity('KCP-1');
    const b = w.mkSampleEntity('KCP-2');
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('S')).toBe(true);
    expect(a.name).toBe('KCP-1');
    expect(new Date(a.createdAt).toString()).not.toBe('Invalid Date');
    expect(a.wholeRock).toEqual({ headers: [], values: {} });
  });

  it('mkSimset uses DEFAULT_SIM_TOTAL when total omitted', () => {
    const ss = w.mkSimset('S123', 'Run-A');
    expect(ss.total).toBe(w.DEFAULT_SIM_TOTAL);
    expect(ss.compositions).toHaveLength(w.DEFAULT_SIM_TOTAL);
    expect(ss.sampleId).toBe('S123');
    expect(ss.thresholds).toEqual([]);
  });

  it('mkThreshold preserves FAIL status from parent comps, resets others to NR', () => {
    const parent = [
      { num: 1, status: w.ST.OK },
      { num: 2, status: w.ST.FAIL },
      { num: 3, status: w.ST.NR },
    ];
    const t = w.mkThreshold('SS1', 'T-1', '4.0', 'MPa', '', parent);
    expect(t.compositions[0].status).toBe(w.ST.NR);   // OK → NR
    expect(t.compositions[1].status).toBe(w.ST.FAIL); // preserved
    expect(t.compositions[2].status).toBe(w.ST.NR);
    expect(t.simsetId).toBe('SS1');
    expect(t.cutoff).toBe('4.0');
    expect(t.unit).toBe('MPa');
  });
});

describe('id-keyed lookup caches', () => {
  it('getSample returns the matching sample', () => {
    w.S.samples.push(w.mkSampleEntity('A'), w.mkSampleEntity('B'));
    const target = w.S.samples[1];
    expect(w.getSample(target.id)).toBe(target);
  });

  it('cache invalidates when a new sample is pushed (length changes)', () => {
    const a = w.mkSampleEntity('A');
    w.S.samples.push(a);
    expect(w.getSample(a.id)).toBe(a);
    const b = w.mkSampleEntity('B');
    w.S.samples.push(b);
    expect(w.getSample(b.id)).toBe(b);
    expect(w.getSample(a.id)).toBe(a);
  });

  it('cache invalidates when S.samples is replaced (reference changes)', () => {
    w.S.samples.push(w.mkSampleEntity('A'));
    w.getSample('whatever');
    const fresh = w.mkSampleEntity('FRESH');
    w.S.samples = [fresh];
    expect(w.getSample(fresh.id)).toBe(fresh);
  });

  it('getSimset follows the same invalidation rules', () => {
    const s1 = w.mkSimset('Sx', 'Run1', 50);
    w.S.simsets.push(s1);
    expect(w.getSimset(s1.id)).toBe(s1);
    const s2 = w.mkSimset('Sy', 'Run2', 50);
    w.S.simsets.push(s2);
    expect(w.getSimset(s2.id)).toBe(s2);
  });
});

describe('migrate', () => {
  it('returns null for non-object input', () => {
    expect(w.migrate(null)).toBe(null);
    expect(w.migrate('garbage')).toBe(null);
    expect(w.migrate(undefined)).toBe(null);
  });

  it('passes through v4-stamped data via the fast path', () => {
    const fixture = {
      _migrated: true,
      _schemaVersion: w.SCHEMA_VERSION,
      samples: [w.mkSampleEntity('Z')],
      simsets: [w.mkSimset('Sx', 'Run', 10)],
      activeSimsetId: null, activeSampleId: null, activeThreshSid: null,
      activePage: 'runs', units: [], settings: { owner: '' },
      batches: [], sampleCategories: [],
    };
    expect(w.migrate(fixture)).toBe(fixture);
  });

  it('rebuilds when stamp is missing (slow path)', () => {
    const sample = w.mkSampleEntity('NoStamp');
    const fixture = {
      _migrated: true,
      samples: [sample],
      simsets: [w.mkSimset(sample.id, 'r', 10)],
    };
    const out = w.migrate(fixture);
    expect(out).not.toBe(fixture);
    expect(out.samples[0].id).toBe(sample.id);
  });

  it('handles the legacy combined format (sims under .samples, activeSid)', () => {
    const old = {
      samples: [{ id: 'OLD1', name: 'OldSample', total: 5,
                  compositions: w.mkComps(5), thresholds: [] }],
      activeSid: 'OLD1',
    };
    const out = w.migrate(old);
    expect(out).not.toBe(null);
    expect(out._migrated).toBe(true);
    expect(out.samples.length).toBe(1);
    expect(out.simsets.length).toBe(1);
    expect(out.activeSimsetId).toBe(out.simsets[0].id);
  });
});

describe('debounced save', () => {
  it('save() returns true and schedules; flushSave() persists immediately', () => {
    w.S.samples.push(w.mkSampleEntity('Persisted'));
    expect(w.save()).toBe(true);
    expect(window.localStorage.getItem(w.STORAGE_KEY)).toBe(null);
    w.flushSave();
    const raw = window.localStorage.getItem(w.STORAGE_KEY);
    expect(raw).not.toBe(null);
    const parsed = JSON.parse(raw);
    expect(parsed._schemaVersion).toBe(w.SCHEMA_VERSION);
    expect(parsed.samples[0].name).toBe('Persisted');
  });

  it('multiple save() calls collapse to one write', () => {
    w.S.samples.push(w.mkSampleEntity('A'));
    w.save(); w.save(); w.save();
    expect(window.localStorage.getItem(w.STORAGE_KEY)).toBe(null);
    w.flushSave();
    expect(window.localStorage.getItem(w.STORAGE_KEY)).not.toBe(null);
  });
});
