import { describe, expect, it, vi } from 'vitest';

import {
  LocalSnapshotStorage,
  MemorySnapshotStorage,
  SNAPSHOT_VERSION,
  createDefaultStorage,
  type WatchtowerSnapshot,
} from './storage';

const SNAPSHOT: WatchtowerSnapshot = {
  version: SNAPSHOT_VERSION,
  watchlist: [{ id: 'watch-1', domain: 'northwindbank.com', createdAt: '2026-05-18T12:00:00.000Z' }],
  alerts: [],
};

/** A minimal in-memory Storage, so the failure modes can be scripted. */
function fakeStorage(overrides: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    ...overrides,
  } as Storage;
}

describe('MemorySnapshotStorage', () => {
  it('round-trips a snapshot', () => {
    const storage = new MemorySnapshotStorage();
    expect(storage.read()).toBeNull();

    storage.write(SNAPSHOT);
    expect(storage.read()).toEqual(SNAPSHOT);

    storage.clear();
    expect(storage.read()).toBeNull();
  });
});

describe('LocalSnapshotStorage', () => {
  it('round-trips through the backing store', () => {
    const backing = fakeStorage();
    const storage = new LocalSnapshotStorage(backing);

    storage.write(SNAPSHOT);
    expect(storage.read()).toEqual(SNAPSHOT);

    storage.clear();
    expect(storage.read()).toBeNull();
  });

  it('returns null when nothing has been stored', () => {
    expect(new LocalSnapshotStorage(fakeStorage()).read()).toBeNull();
  });

  it('discards corrupted JSON rather than throwing on start-up', () => {
    const backing = fakeStorage();
    backing.setItem('watchtower.snapshot.v1', '{ not json');
    expect(new LocalSnapshotStorage(backing).read()).toBeNull();
  });

  it('discards a snapshot written by an older version', () => {
    const backing = fakeStorage();
    backing.setItem('watchtower.snapshot.v1', JSON.stringify({ ...SNAPSHOT, version: 0 }));
    expect(new LocalSnapshotStorage(backing).read()).toBeNull();
  });

  it('discards a snapshot with the wrong shape', () => {
    const backing = fakeStorage();
    backing.setItem(
      'watchtower.snapshot.v1',
      JSON.stringify({ version: SNAPSHOT_VERSION, watchlist: 'nope', alerts: [] }),
    );
    expect(new LocalSnapshotStorage(backing).read()).toBeNull();
  });

  it('falls back to memory when the quota is exceeded, instead of rejecting', () => {
    const backing = fakeStorage({
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    });
    const storage = new LocalSnapshotStorage(backing);

    expect(() => storage.write(SNAPSHOT)).not.toThrow();
    // The session keeps working even though nothing was persisted.
    expect(storage.read()).toBeNull();
  });

  it('falls back to memory when reading throws', () => {
    const backing = fakeStorage({
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    });
    const storage = new LocalSnapshotStorage(backing);

    storage.write(SNAPSHOT);
    expect(storage.read()).toEqual(SNAPSHOT);
  });

  it('survives a backing store that throws on removal', () => {
    const backing = fakeStorage({
      removeItem: () => {
        throw new Error('nope');
      },
    });
    expect(() => new LocalSnapshotStorage(backing).clear()).not.toThrow();
  });

  it('honours a custom key', () => {
    const backing = fakeStorage();
    new LocalSnapshotStorage(backing, 'custom.key').write(SNAPSHOT);
    expect(backing.getItem('custom.key')).not.toBeNull();
  });
});

describe('createDefaultStorage', () => {
  it('uses localStorage when it works', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    try {
      expect(createDefaultStorage()).toBeInstanceOf(LocalSnapshotStorage);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to memory when localStorage is absent, as it is on a server', () => {
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(createDefaultStorage()).toBeInstanceOf(MemorySnapshotStorage);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to memory when localStorage exists but rejects writes', () => {
    // Safari private browsing: the API is present and every write throws.
    vi.stubGlobal(
      'localStorage',
      fakeStorage({
        setItem: () => {
          throw new DOMException('QuotaExceededError');
        },
      }),
    );
    try {
      expect(createDefaultStorage()).toBeInstanceOf(MemorySnapshotStorage);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
