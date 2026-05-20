/**
 * The data behind the GraphQL layer.
 *
 * Kept separate from the resolvers so the rules -- what counts as a duplicate
 * watchlist entry, what happens when the same certificate is reported twice,
 * how triage history accumulates -- can be tested directly, without a GraphQL
 * document in the way. The resolvers are then a thin, boring adapter.
 */

import {
  applyTriage,
  buildAlert,
  compareAlerts,
  isResolved,
  mergeAlert,
  type Alert,
  type TriageState,
} from '../../domain/alert';
import type { CertificateRecord } from '../../domain/certificate';
import type { LookalikeAssessment, WatchlistEntry } from '../../domain/models';
import { tryParseDomain } from '../../domain/normalize';
import { SEED_WATCHLIST } from '../fixtures/seed-data';
import {
  MemorySnapshotStorage,
  SNAPSHOT_VERSION,
  type SnapshotStorage,
  type WatchtowerSnapshot,
} from './storage';

export interface UserError {
  readonly message: string;
  readonly field: string | null;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: UserError };

export interface AlertFilter {
  readonly state?: TriageState;
  readonly minScore?: number;
  readonly watchEntryId?: string;
}

export interface AlertSummary {
  readonly total: number;
  readonly new: number;
  readonly investigating: number;
  readonly benign: number;
  readonly malicious: number;
  readonly unresolvedHighRisk: number;
}

export interface RecordAlertRequest {
  readonly certificate: CertificateRecord;
  readonly watchEntryId: string;
  readonly assessment: LookalikeAssessment;
  readonly observedAt: string;
}

export interface WatchtowerStoreOptions {
  readonly storage?: SnapshotStorage;
  /** Seed the watchlist on first run so the app is not empty on open. */
  readonly seed?: boolean;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

/** Watchlist entries are compared by canonical form, not by what was typed. */
function canonicalise(domain: string): string | null {
  return tryParseDomain(domain)?.ascii ?? null;
}

let idCounter = 0;

function defaultId(): string {
  idCounter += 1;
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${idCounter}`;
  return `watch-${random}`;
}

export class WatchtowerStore {
  private watchlist: WatchlistEntry[] = [];
  private alerts = new Map<string, Alert>();

  private readonly storage: SnapshotStorage;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(options: WatchtowerStoreOptions = {}) {
    this.storage = options.storage ?? new MemorySnapshotStorage();
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? defaultId;

    const restored = this.storage.read();
    if (restored !== null) {
      this.watchlist = [...restored.watchlist];
      this.alerts = new Map(restored.alerts.map((alert) => [alert.id, alert]));
    } else if (options.seed !== false) {
      this.watchlist = [...SEED_WATCHLIST];
      this.persist();
    }
  }

  getWatchlist(): WatchlistEntry[] {
    return [...this.watchlist];
  }

  /**
   * Adds a domain.
   *
   * Invalid input and duplicates are expected outcomes rather than exceptions:
   * they come back as a message the form can render next to the field.
   */
  addWatchlistEntry(domain: string, label?: string): Result<WatchlistEntry> {
    const trimmed = domain.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: { message: 'Enter a domain to watch.', field: 'domain' } };
    }

    const canonical = canonicalise(trimmed);
    if (canonical === null) {
      return {
        ok: false,
        error: { message: `'${trimmed}' is not a valid domain name.`, field: 'domain' },
      };
    }

    const existing = this.watchlist.find((entry) => canonicalise(entry.domain) === canonical);
    if (existing !== undefined) {
      return {
        ok: false,
        error: {
          message: `You are already watching ${existing.domain}.`,
          field: 'domain',
        },
      };
    }

    const entry: WatchlistEntry = {
      id: this.generateId(),
      domain: trimmed,
      createdAt: new Date(this.now()).toISOString(),
      ...(label !== undefined && label.trim().length > 0 ? { label: label.trim() } : {}),
    };

    this.watchlist = [...this.watchlist, entry];
    this.persist();
    return { ok: true, value: entry };
  }

  /**
   * Removes an entry but keeps its alerts: "we stopped watching this" should
   * not quietly erase the record of what was found while we were.
   */
  removeWatchlistEntry(id: string): boolean {
    const before = this.watchlist.length;
    this.watchlist = this.watchlist.filter((entry) => entry.id !== id);
    const removed = this.watchlist.length !== before;
    if (removed) this.persist();
    return removed;
  }

  getAlerts(filter: AlertFilter = {}): Alert[] {
    let alerts = [...this.alerts.values()];

    if (filter.state !== undefined) {
      alerts = alerts.filter((alert) => alert.triage === filter.state);
    }
    if (filter.minScore !== undefined) {
      const min = filter.minScore;
      alerts = alerts.filter((alert) => alert.assessment.score >= min);
    }
    if (filter.watchEntryId !== undefined) {
      alerts = alerts.filter((alert) => alert.watchEntryId === filter.watchEntryId);
    }

    return alerts.sort(compareAlerts);
  }

  getAlert(id: string): Alert | null {
    return this.alerts.get(id) ?? null;
  }

  alertCountFor(watchEntryId: string): number {
    let count = 0;
    for (const alert of this.alerts.values()) {
      if (alert.watchEntryId === watchEntryId) count++;
    }
    return count;
  }

  /**
   * Folds a polling cycle into the store.
   *
   * Idempotent by alert id: CT queries keep returning the same certificate for
   * as long as it is in the window, and re-reporting it must never reset the
   * analyst's verdict. Returns what was genuinely new so the UI can announce
   * exactly that and nothing more.
   */
  recordAlerts(requests: readonly RecordAlertRequest[]): { created: Alert[]; updated: Alert[] } {
    const created: Alert[] = [];
    const updated: Alert[] = [];

    for (const request of requests) {
      const entry = this.watchlist.find((candidate) => candidate.id === request.watchEntryId);
      // An alert for an entry that has since been deleted is dropped rather
      // than orphaned; the polling cycle that produced it is already stale.
      if (entry === undefined) continue;

      const incoming = buildAlert(request.certificate, entry, request.assessment, request.observedAt);
      const existing = this.alerts.get(incoming.id);

      if (existing === undefined) {
        this.alerts.set(incoming.id, incoming);
        created.push(incoming);
      } else {
        const merged = mergeAlert(existing, incoming);
        this.alerts.set(merged.id, merged);
        updated.push(merged);
      }
    }

    if (created.length > 0 || updated.length > 0) this.persist();
    return { created, updated };
  }

  setTriageState(alertId: string, state: TriageState, note?: string): Result<Alert> {
    const alert = this.alerts.get(alertId);
    if (alert === undefined) {
      return { ok: false, error: { message: 'That alert no longer exists.', field: null } };
    }

    const next = applyTriage(alert, state, new Date(this.now()).toISOString(), note ?? '');
    this.alerts.set(next.id, next);
    this.persist();
    return { ok: true, value: next };
  }

  summary(): AlertSummary {
    const summary = {
      total: 0,
      new: 0,
      investigating: 0,
      benign: 0,
      malicious: 0,
      unresolvedHighRisk: 0,
    };

    for (const alert of this.alerts.values()) {
      summary.total++;
      summary[alert.triage]++;
      const level = alert.assessment.level;
      if (!isResolved(alert) && (level === 'high' || level === 'critical')) {
        summary.unresolvedHighRisk++;
      }
    }

    return summary;
  }

  /** Wipes everything, including persisted state. Used by tests and the UI reset. */
  reset(seed = true): void {
    this.watchlist = seed ? [...SEED_WATCHLIST] : [];
    this.alerts.clear();
    this.storage.clear();
    if (seed) this.persist();
  }

  snapshot(): WatchtowerSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      watchlist: this.getWatchlist(),
      alerts: [...this.alerts.values()],
    };
  }

  private persist(): void {
    this.storage.write(this.snapshot());
  }
}
