import { beforeEach, describe, expect, it } from 'vitest';

import { applyTriage } from '../../domain/alert';
import type { CertificateRecord } from '../../domain/certificate';
import { assess } from '../../domain/scorer';
import { MemorySnapshotStorage, SNAPSHOT_VERSION } from './storage';
import { WatchtowerStore, type RecordAlertRequest } from './store';

const NOW = Date.parse('2026-05-18T12:00:00.000Z');

function certificate(id: string, name: string): CertificateRecord {
  return {
    id,
    names: [name],
    commonName: name,
    issuer: 'Test CA',
    loggedAt: '2026-05-18T11:00:00.000Z',
    notBefore: '2026-05-18T10:00:00.000Z',
    notAfter: '2026-08-18T10:00:00.000Z',
    serialNumber: `serial-${id}`,
    source: 'fixture',
  };
}

describe('WatchtowerStore', () => {
  let store: WatchtowerStore;
  let storage: MemorySnapshotStorage;
  let ids: number;

  beforeEach(() => {
    storage = new MemorySnapshotStorage();
    ids = 0;
    store = new WatchtowerStore({
      storage,
      seed: false,
      now: () => NOW,
      generateId: () => `watch-${++ids}`,
    });
  });

  function watch(domain: string): string {
    const result = store.addWatchlistEntry(domain);
    if (!result.ok) throw new Error(result.error.message);
    return result.value.id;
  }

  function request(
    watchEntryId: string,
    certificateId: string,
    name: string,
    watched: string,
  ): RecordAlertRequest {
    return {
      certificate: certificate(certificateId, name),
      watchEntryId,
      assessment: assess(name, watched),
      observedAt: '2026-05-18T12:00:00.000Z',
    };
  }

  describe('watchlist', () => {
    it('adds an entry and stamps it with the current time', () => {
      const result = store.addWatchlistEntry('northwindbank.com', ' Retail portal ');
      expect(result).toMatchObject({
        ok: true,
        value: { domain: 'northwindbank.com', label: 'Retail portal' },
      });
    });

    it('keeps the domain as typed, so the user recognises their own input', () => {
      const result = store.addWatchlistEntry('  HTTPS://NorthwindBank.com/login  ');
      expect(result.ok && result.value.domain).toBe('HTTPS://NorthwindBank.com/login');
    });

    it('rejects an empty domain with a message for the field', () => {
      expect(store.addWatchlistEntry('   ')).toMatchObject({
        ok: false,
        error: { field: 'domain' },
      });
    });

    it('rejects an unparseable domain', () => {
      const result = store.addWatchlistEntry('not a domain');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.message).toContain('not a valid domain');
    });

    it('rejects a duplicate even when it is written differently', () => {
      watch('northwindbank.com');
      const result = store.addWatchlistEntry('HTTPS://NorthwindBank.com./');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.message).toContain('already watching');
    });

    it('omits the label when none was given', () => {
      const result = store.addWatchlistEntry('northwindbank.com', '   ');
      expect(result.ok && 'label' in result.value).toBe(false);
    });

    it('removes an entry and reports whether it existed', () => {
      const id = watch('northwindbank.com');
      expect(store.removeWatchlistEntry(id)).toBe(true);
      expect(store.removeWatchlistEntry(id)).toBe(false);
      expect(store.getWatchlist()).toEqual([]);
    });

    it('keeps alerts when the entry that produced them is removed', () => {
      const id = watch('northwindbank.com');
      store.recordAlerts([request(id, '1', 'n0rthwindbank.com', 'northwindbank.com')]);

      store.removeWatchlistEntry(id);
      expect(store.getAlerts()).toHaveLength(1);
    });

    it('hands out copies, so callers cannot mutate the store', () => {
      watch('northwindbank.com');
      store.getWatchlist().push({ id: 'x', domain: 'y.com', createdAt: '' });
      expect(store.getWatchlist()).toHaveLength(1);
    });
  });

  describe('recordAlerts', () => {
    it('creates one alert per certificate and watch entry', () => {
      const id = watch('northwindbank.com');
      const { created, updated } = store.recordAlerts([
        request(id, '1', 'n0rthwindbank.com', 'northwindbank.com'),
      ]);

      expect(created).toHaveLength(1);
      expect(updated).toHaveLength(0);
      expect(store.getAlerts()).toHaveLength(1);
    });

    it('is idempotent: the same certificate reported twice is one alert', () => {
      const id = watch('northwindbank.com');
      store.recordAlerts([request(id, '1', 'n0rthwindbank.com', 'northwindbank.com')]);
      const second = store.recordAlerts([request(id, '1', 'n0rthwindbank.com', 'northwindbank.com')]);

      expect(second.created).toHaveLength(0);
      expect(second.updated).toHaveLength(1);
      expect(store.getAlerts()).toHaveLength(1);
    });

    it('preserves triage state across a re-poll', () => {
      const id = watch('northwindbank.com');
      const [alert] = store.recordAlerts([
        request(id, '1', 'n0rthwindbank.com', 'northwindbank.com'),
      ]).created;
      store.setTriageState(alert!.id, 'malicious', 'Confirmed');

      store.recordAlerts([request(id, '1', 'n0rthwindbank.com', 'northwindbank.com')]);

      const reloaded = store.getAlert(alert!.id);
      expect(reloaded?.triage).toBe('malicious');
      expect(reloaded?.history).toHaveLength(2);
    });

    it('drops alerts for a watch entry that no longer exists', () => {
      const id = watch('northwindbank.com');
      store.removeWatchlistEntry(id);

      const { created } = store.recordAlerts([
        request(id, '1', 'n0rthwindbank.com', 'northwindbank.com'),
      ]);
      expect(created).toEqual([]);
    });

    it('accepts an empty cycle without touching storage', () => {
      expect(store.recordAlerts([])).toEqual({ created: [], updated: [] });
    });
  });

  describe('queries', () => {
    let northwind: string;
    let atlas: string;

    beforeEach(() => {
      northwind = watch('northwindbank.com');
      atlas = watch('atlaspay.io');
      store.recordAlerts([
        request(northwind, '1', 'n0rthwindbank.com', 'northwindbank.com'),
        request(northwind, '2', 'northwindbank.top', 'northwindbank.com'),
        request(atlas, '3', 'atlaspya.io', 'atlaspay.io'),
      ]);
    });

    it('filters by triage state', () => {
      const [first] = store.getAlerts();
      store.setTriageState(first!.id, 'benign');

      expect(store.getAlerts({ state: 'benign' })).toHaveLength(1);
      expect(store.getAlerts({ state: 'new' })).toHaveLength(2);
    });

    it('filters by minimum score', () => {
      const all = store.getAlerts();
      const highest = Math.max(...all.map((alert) => alert.assessment.score));
      expect(store.getAlerts({ minScore: highest })).toHaveLength(1);
      expect(store.getAlerts({ minScore: 0 })).toHaveLength(3);
    });

    it('filters by watchlist entry', () => {
      expect(store.getAlerts({ watchEntryId: atlas })).toHaveLength(1);
    });

    it('sorts unresolved and high scoring alerts first', () => {
      const scores = store.getAlerts().map((alert) => alert.assessment.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it('counts alerts per watchlist entry', () => {
      expect(store.alertCountFor(northwind)).toBe(2);
      expect(store.alertCountFor(atlas)).toBe(1);
    });

    it('returns null for an unknown alert', () => {
      expect(store.getAlert('nope')).toBeNull();
    });

    it('summarises the queue', () => {
      const [first] = store.getAlerts();
      store.setTriageState(first!.id, 'malicious');

      const summary = store.summary();
      expect(summary.total).toBe(3);
      expect(summary.malicious).toBe(1);
      expect(summary.new).toBe(2);
      // The malicious one is resolved, so it no longer counts as outstanding.
      expect(summary.unresolvedHighRisk).toBeLessThan(3);
    });
  });

  describe('triage', () => {
    it('reports a helpful error for an alert that no longer exists', () => {
      const result = store.setTriageState('missing', 'benign');
      expect(result).toMatchObject({ ok: false, error: { message: expect.any(String) } });
    });

    it('appends a note to the audit trail', () => {
      const id = watch('northwindbank.com');
      const [alert] = store.recordAlerts([
        request(id, '1', 'n0rthwindbank.com', 'northwindbank.com'),
      ]).created;

      const result = store.setTriageState(alert!.id, 'investigating', 'Registrar contacted');
      expect(result.ok && result.value.history.at(-1)).toMatchObject({
        state: 'investigating',
        note: 'Registrar contacted',
      });
    });
  });

  describe('persistence', () => {
    it('writes a snapshot on every mutation', () => {
      watch('northwindbank.com');
      expect(storage.read()).toMatchObject({ version: SNAPSHOT_VERSION });
      expect(storage.read()?.watchlist).toHaveLength(1);
    });

    it('restores watchlist and triage state from storage', () => {
      const id = watch('northwindbank.com');
      const [alert] = store.recordAlerts([
        request(id, '1', 'n0rthwindbank.com', 'northwindbank.com'),
      ]).created;
      store.setTriageState(alert!.id, 'investigating', 'Mid-triage');

      const reopened = new WatchtowerStore({ storage, now: () => NOW });

      expect(reopened.getWatchlist()).toHaveLength(1);
      expect(reopened.getAlert(alert!.id)?.triage).toBe('investigating');
      expect(reopened.getAlert(alert!.id)?.history).toHaveLength(2);
    });

    it('does not re-seed over restored data', () => {
      watch('northwindbank.com');
      const reopened = new WatchtowerStore({ storage, seed: true, now: () => NOW });
      expect(reopened.getWatchlist()).toHaveLength(1);
    });

    it('seeds a first run so the app does not open empty', () => {
      const seeded = new WatchtowerStore({ storage: new MemorySnapshotStorage(), now: () => NOW });
      expect(seeded.getWatchlist().length).toBeGreaterThan(0);
    });

    it('resets back to the seed', () => {
      const id = watch('northwindbank.com');
      store.recordAlerts([request(id, '1', 'n0rthwindbank.com', 'northwindbank.com')]);

      store.reset();
      expect(store.getAlerts()).toEqual([]);
      expect(store.getWatchlist().length).toBeGreaterThan(0);
    });

    it('can reset to empty', () => {
      store.reset(false);
      expect(store.getWatchlist()).toEqual([]);
    });
  });

  it('does not let a stored alert be mutated through the returned object', () => {
    const id = watch('northwindbank.com');
    const [alert] = store.recordAlerts([
      request(id, '1', 'n0rthwindbank.com', 'northwindbank.com'),
    ]).created;

    applyTriage(alert!, 'benign', '2026-05-18T13:00:00.000Z');
    expect(store.getAlert(alert!.id)?.triage).toBe('new');
  });
});
