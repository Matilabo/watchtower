/**
 * Persistence for the mock backend.
 *
 * Triage state is the one thing in this app a user would be genuinely annoyed
 * to lose, so it survives a reload even in the offline demo. `localStorage` is
 * the right size of tool for that, but it throws in more situations than people
 * expect -- private browsing, quota, disabled storage, SSR where it does not
 * exist at all -- so every access is guarded and a failure degrades to
 * in-memory rather than taking the app down.
 */

import type { Alert } from '../../domain/alert';
import type { WatchlistEntry } from '../../domain/models';

export interface WatchtowerSnapshot {
  readonly version: number;
  readonly watchlist: readonly WatchlistEntry[];
  readonly alerts: readonly Alert[];
}

export const SNAPSHOT_VERSION = 1;

export interface SnapshotStorage {
  read(): WatchtowerSnapshot | null;
  write(snapshot: WatchtowerSnapshot): void;
  clear(): void;
}

export class MemorySnapshotStorage implements SnapshotStorage {
  private snapshot: WatchtowerSnapshot | null = null;

  read(): WatchtowerSnapshot | null {
    return this.snapshot;
  }

  write(snapshot: WatchtowerSnapshot): void {
    this.snapshot = snapshot;
  }

  clear(): void {
    this.snapshot = null;
  }
}

export const STORAGE_KEY = 'watchtower.snapshot.v1';

export class LocalSnapshotStorage implements SnapshotStorage {
  private readonly fallback = new MemorySnapshotStorage();

  constructor(
    private readonly backing: Storage,
    private readonly key: string = STORAGE_KEY,
  ) {}

  read(): WatchtowerSnapshot | null {
    let raw: string | null;
    try {
      raw = this.backing.getItem(this.key);
    } catch {
      return this.fallback.read();
    }
    if (raw === null) return null;

    try {
      const parsed = JSON.parse(raw) as WatchtowerSnapshot;
      // A snapshot from an older shape is discarded rather than migrated:
      // it is a cache of public data, not something worth a migration path.
      if (parsed.version !== SNAPSHOT_VERSION) return null;
      if (!Array.isArray(parsed.watchlist) || !Array.isArray(parsed.alerts)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  write(snapshot: WatchtowerSnapshot): void {
    try {
      this.backing.setItem(this.key, JSON.stringify(snapshot));
    } catch {
      // Quota exceeded, or storage disabled mid-session. Keeping the data in
      // memory means the current session still works; the next reload starts
      // from the seed, which is a better outcome than an unhandled rejection.
      this.fallback.write(snapshot);
    }
  }

  clear(): void {
    try {
      this.backing.removeItem(this.key);
    } catch {
      this.fallback.clear();
    }
  }
}

/** localStorage when it is usable, memory otherwise. Never throws. */
export function createDefaultStorage(): SnapshotStorage {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined || storage === null) return new MemorySnapshotStorage();

    // Availability is not the same as usability: Safari private mode has the
    // API and rejects every write.
    const probe = `${STORAGE_KEY}.probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return new LocalSnapshotStorage(storage);
  } catch {
    return new MemorySnapshotStorage();
  }
}
