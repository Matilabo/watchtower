/**
 * Application state.
 *
 * Plain signals in one injectable service, deliberately not a store library.
 * The reasoning is in the README, but in short: there is one writer, the state
 * is a few lists, and the interesting logic already lives in tested pure
 * functions. A reducer/action/effect layer here would add indirection without
 * removing any.
 *
 * The one genuinely subtle thing this service does is decide *when* new alerts
 * are allowed to appear in the table. A results list that reorders itself
 * under a keyboard user reading row 12 is hostile, so while focus is inside
 * the table new alerts are held back and offered instead.
 */

import {
  DestroyRef,
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Subject, distinctUntilChanged, map } from 'rxjs';

import { CT_SOURCE, GRAPHQL_CLIENT, WATCHTOWER_CONFIG } from '../app.config';
import { buildAlertRequests } from '../data/alert-pipeline';
import { createCertificateStream, type PollFrame } from '../data/ct/certificate-stream';
import { queriesForDomain } from '../data/ct/crtsh-client';
import type { CtQuery } from '../data/ct/ct-source';
import { describeFreshness, type Freshness } from '../data/ct/staleness';
import {
  ADD_WATCHLIST_ENTRY_MUTATION,
  ALERTS_QUERY,
  RECORD_ALERTS_MUTATION,
  REMOVE_WATCHLIST_ENTRY_MUTATION,
  SET_TRIAGE_STATE_MUTATION,
  WATCHLIST_QUERY,
} from '../data/graphql/documents';
import type { Alert, TriageState } from '../domain/alert';
import { TRIAGE_LABELS, isResolved, preserveOrder } from '../domain/alert';
import type { RiskLevel, WatchlistEntry } from '../domain/models';
import { tryParseDomain } from '../domain/normalize';

/** What the GraphQL layer sends back, before triage enums are lowered. */
interface WireAlert extends Omit<Alert, 'triage' | 'history'> {
  readonly triage: string;
  readonly history: ReadonlyArray<{ state: string; at: string; note: string }>;
}

interface WireWatchlistEntry {
  readonly id: string;
  readonly domain: string;
  readonly canonicalDomain: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly alertCount: number;
}

function toAlert(wire: WireAlert): Alert {
  return {
    ...wire,
    triage: wire.triage.toLowerCase() as TriageState,
    history: wire.history.map((event) => ({
      ...event,
      state: event.state.toLowerCase() as TriageState,
    })),
  };
}

/** How often the "updated N minutes ago" label recomputes. */
const FRESHNESS_TICK_MS = 15_000;

export type AlertFilterState = TriageState | 'all';

@Injectable({ providedIn: 'root' })
export class WatchtowerStore {
  private readonly config = inject(WATCHTOWER_CONFIG);
  private readonly source = inject(CT_SOURCE);
  private readonly api = inject(GRAPHQL_CLIENT);
  private readonly destroyRef = inject(DestroyRef);
  /** Kept because polling starts after an await, outside the injection context. */
  private readonly injector = inject(Injector);

  // --- raw state ----------------------------------------------------------

  private readonly watchlistSignal = signal<readonly WatchlistEntry[]>([]);
  private readonly alertCountsSignal = signal<ReadonlyMap<string, number>>(new Map());
  /** Server truth. */
  private readonly alertsSignal = signal<readonly Alert[]>([]);
  /** What the table is currently rendering; only ever changed deliberately. */
  private readonly renderedAlertsSignal = signal<readonly Alert[]>([]);
  private readonly frameSignal = signal<PollFrame | null>(null);
  private readonly nowSignal = signal(Date.now());

  private readonly loadingSignal = signal(true);
  private readonly addingSignal = signal(false);
  private readonly triagingSignal = signal<ReadonlySet<string>>(new Set());
  private readonly formErrorSignal = signal<string | null>(null);
  private readonly apiErrorSignal = signal<string | null>(null);
  private readonly announcementSignal = signal('');
  private readonly filterSignal = signal<AlertFilterState>('all');
  private readonly selectedIdSignal = signal<string | null>(null);
  /** True while focus is inside the results table. */
  private readonly holdUpdatesSignal = signal(false);

  private readonly refresh$ = new Subject<void>();
  private started = false;

  // --- public reads -------------------------------------------------------

  readonly watchlist = this.watchlistSignal.asReadonly();
  readonly frame = this.frameSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();
  readonly adding = this.addingSignal.asReadonly();
  readonly formError = this.formErrorSignal.asReadonly();
  readonly apiError = this.apiErrorSignal.asReadonly();
  readonly announcement = this.announcementSignal.asReadonly();
  readonly filter = this.filterSignal.asReadonly();
  readonly sourceName = computed(() => this.frameSignal()?.sourceName ?? 'Starting up');
  readonly isLiveSource = this.config.liveSource;
  readonly pollIntervalMs = this.config.pollIntervalMs;

  readonly alerts = computed(() => {
    const state = this.filterSignal();
    const rendered = this.renderedAlertsSignal();
    return state === 'all' ? rendered : rendered.filter((alert) => alert.triage === state);
  });

  readonly totalRendered = computed(() => this.renderedAlertsSignal().length);

  readonly selectedAlert = computed(() => {
    const id = this.selectedIdSignal();
    if (id === null) return null;
    return this.renderedAlertsSignal().find((alert) => alert.id === id) ?? null;
  });

  /** Alerts the server knows about that the table is deliberately not showing yet. */
  readonly pendingAlerts = computed(() => {
    const rendered = new Set(this.renderedAlertsSignal().map((alert) => alert.id));
    return this.alertsSignal().filter((alert) => !rendered.has(alert.id));
  });

  readonly summary = computed(() => {
    const alerts = this.renderedAlertsSignal();
    const counts: Record<TriageState, number> = {
      new: 0,
      investigating: 0,
      benign: 0,
      malicious: 0,
    };
    let unresolvedHighRisk = 0;

    for (const alert of alerts) {
      counts[alert.triage]++;
      const level = alert.assessment.level;
      if (!isResolved(alert) && (level === 'high' || level === 'critical')) unresolvedHighRisk++;
    }

    return { total: alerts.length, ...counts, unresolvedHighRisk };
  });

  readonly freshness = computed<Freshness>(() =>
    describeFreshness(this.frameSignal()?.lastSuccessAt ?? null, this.nowSignal(), {
      pollIntervalMs: this.config.pollIntervalMs,
    }),
  );

  readonly alertCountFor = (entryId: string): number =>
    this.alertCountsSignal().get(entryId) ?? 0;

  constructor() {
    const ticker = setInterval(() => this.nowSignal.set(Date.now()), FRESHNESS_TICK_MS);
    this.destroyRef.onDestroy(() => clearInterval(ticker));

    // The single place that decides what the table shows. While the table is
    // being read it shows nothing new; otherwise it takes the latest alerts,
    // but keeps the order already on screen when only contents changed.
    effect(() => {
      if (this.holdUpdatesSignal()) return;
      const latest = this.alertsSignal();

      untracked(() => {
        const current = this.renderedAlertsSignal();
        if (current === latest) return;
        this.renderedAlertsSignal.set(preserveOrder(current, latest));
      });
    });
  }

  /** Loads persisted state and starts polling. Safe to call more than once. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.loadWatchlist();
    await this.loadAlerts();
    this.loadingSignal.set(false);

    try {
      this.startPolling();
    } catch {
      // A polling stream that fails to start would otherwise leave the app
      // looking merely quiet, which is the worst possible failure mode here.
      this.apiErrorSignal.set(
        'Certificate polling could not be started. Reload to try again.',
      );
    }
  }

  private startPolling(): void {
    const queries$ = toObservable(this.watchlistSignal, { injector: this.injector }).pipe(
      map((entries): CtQuery[] =>
        entries.flatMap((entry) => {
          const core = tryParseDomain(entry.domain)?.core ?? '';
          return core.length === 0 ? [] : queriesForDomain(entry.id, core);
        }),
      ),
      // Reloading the watchlist after a poll hands back an equal-but-new array,
      // and a query set is only *different* if the queries differ. Without this
      // the stream sees a change, polls again, reloads the watchlist, and the
      // app polls in a tight loop instead of on its interval.
      distinctUntilChanged(
        (a, b) =>
          a.length === b.length &&
          a.every(
            (query, index) =>
              query.identity === b[index]?.identity &&
              query.watchEntryId === b[index]?.watchEntryId,
          ),
      ),
    );

    const stream = createCertificateStream({
      source: this.source,
      queries$,
      intervalMs: this.config.pollIntervalMs,
      refresh$: this.refresh$,
      onCycleStart: () => {
        // The fixture source uses this to advance its simulated log.
        (this.source as { advance?: () => void }).advance?.();
      },
    });

    stream.frames$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (frame) => {
        this.frameSignal.set(frame);
        this.nowSignal.set(Date.now());
        if (frame.status === 'ok') void this.ingest(frame);
      },
      // The stream handles fetch failures as frames; this only fires for a
      // genuinely unexpected error, and must not leave the UI claiming to poll.
      error: () => this.apiErrorSignal.set('Certificate polling stopped unexpectedly.'),
    });
  }

  /** Manual refresh, from the toolbar button. */
  refresh(): void {
    this.refresh$.next();
  }

  // --- watchlist ----------------------------------------------------------

  async addWatchlistEntry(domain: string, label: string): Promise<boolean> {
    this.formErrorSignal.set(null);
    this.addingSignal.set(true);

    try {
      const data = await this.api.request<{
        addWatchlistEntry: {
          entry: WireWatchlistEntry | null;
          error: { message: string; field: string | null } | null;
        };
      }>(ADD_WATCHLIST_ENTRY_MUTATION, { input: { domain, label: label.trim() || null } });

      const { entry, error } = data.addWatchlistEntry;
      if (entry === null) {
        this.formErrorSignal.set(error?.message ?? 'That domain could not be added.');
        return false;
      }

      await this.loadWatchlist();
      this.announce(`Now watching ${entry.canonicalDomain}. Checking certificate logs.`);
      return true;
    } catch {
      this.formErrorSignal.set('Could not reach the watchlist service. Please try again.');
      return false;
    } finally {
      this.addingSignal.set(false);
    }
  }

  async removeWatchlistEntry(entry: WatchlistEntry): Promise<void> {
    this.apiErrorSignal.set(null);
    try {
      await this.api.request(REMOVE_WATCHLIST_ENTRY_MUTATION, { id: entry.id });
      await this.loadWatchlist();
      this.announce(`Stopped watching ${entry.domain}. Its alerts are kept.`);
    } catch {
      this.apiErrorSignal.set(`Could not stop watching ${entry.domain}.`);
    }
  }

  // --- alerts -------------------------------------------------------------

  setFilter(state: AlertFilterState): void {
    this.filterSignal.set(state);
  }

  select(alertId: string | null): void {
    this.selectedIdSignal.set(alertId);
  }

  /** Called by the results table on focusin/focusout. */
  setHoldUpdates(hold: boolean): void {
    this.holdUpdatesSignal.set(hold);
  }

  /** Applies alerts that were held back, at the user's request. */
  showPending(): void {
    this.renderedAlertsSignal.set(this.alertsSignal());
  }

  async setTriage(alert: Alert, state: TriageState, note = ''): Promise<void> {
    if (alert.triage === state && note.length === 0) return;

    this.apiErrorSignal.set(null);
    this.markTriaging(alert.id, true);

    try {
      const data = await this.api.request<{
        setTriageState: { alert: WireAlert | null; error: { message: string } | null };
      }>(SET_TRIAGE_STATE_MUTATION, {
        input: { alertId: alert.id, state: state.toUpperCase(), note: note || null },
      });

      const updated = data.setTriageState.alert;
      if (updated === null) {
        this.apiErrorSignal.set(data.setTriageState.error?.message ?? 'Could not save that.');
        return;
      }

      // Replace in place. Re-sorting here would move the row out from under
      // the pointer or the keyboard focus that just triaged it.
      const next = toAlert(updated);
      this.alertsSignal.update((alerts) =>
        alerts.map((candidate) => (candidate.id === next.id ? next : candidate)),
      );
      this.renderedAlertsSignal.update((alerts) =>
        alerts.map((candidate) => (candidate.id === next.id ? next : candidate)),
      );
      this.announce(`${next.assessment.candidateUnicode} marked ${TRIAGE_LABELS[state]}.`);
    } catch {
      this.apiErrorSignal.set('Could not save that triage decision.');
    } finally {
      this.markTriaging(alert.id, false);
    }
  }

  isTriaging(alertId: string): boolean {
    return this.triagingSignal().has(alertId);
  }

  // --- internals ----------------------------------------------------------

  private markTriaging(alertId: string, busy: boolean): void {
    this.triagingSignal.update((current) => {
      const next = new Set(current);
      if (busy) next.add(alertId);
      else next.delete(alertId);
      return next;
    });
  }

  private async loadWatchlist(): Promise<void> {
    try {
      const data = await this.api.request<{ watchlist: WireWatchlistEntry[] }>(WATCHLIST_QUERY);

      this.watchlistSignal.set(
        data.watchlist.map((entry) => ({
          id: entry.id,
          domain: entry.domain,
          createdAt: entry.createdAt,
          ...(entry.label === null ? {} : { label: entry.label }),
        })),
      );
      this.alertCountsSignal.set(
        new Map(data.watchlist.map((entry) => [entry.id, entry.alertCount])),
      );
      this.apiErrorSignal.set(null);
    } catch {
      this.apiErrorSignal.set('Could not load your watchlist.');
    }
  }

  private async loadAlerts(): Promise<void> {
    try {
      const data = await this.api.request<{ alerts: WireAlert[] }>(ALERTS_QUERY, {});
      const alerts = data.alerts.map(toAlert);
      this.alertsSignal.set(alerts);
    } catch {
      this.apiErrorSignal.set('Could not load alert history.');
    }
  }

  /**
   * Scores a polling cycle and records what it found.
   *
   * Every certificate is re-scored, not only the new ones: a watchlist entry
   * added after a fetch still has to be checked against what is already on
   * screen. `recordAlerts` is idempotent, so this is cheap and safe.
   */
  private async ingest(frame: PollFrame): Promise<void> {
    const watchlist = this.watchlistSignal();
    if (watchlist.length === 0 || frame.certificates.length === 0) return;

    const { requests } = buildAlertRequests(
      frame.certificates,
      watchlist,
      frame.polledAt,
      { minScore: this.config.minScore },
    );
    if (requests.length === 0) return;

    try {
      const data = await this.api.request<{
        recordAlerts: { created: WireAlert[]; updated: WireAlert[] };
      }>(RECORD_ALERTS_MUTATION, { input: requests });

      const created = data.recordAlerts.created.map(toAlert);
      if (created.length === 0 && data.recordAlerts.updated.length === 0) return;

      await this.loadAlerts();
      await this.loadWatchlist();
      if (created.length > 0) this.announceNewAlerts(created);
    } catch {
      this.apiErrorSignal.set('Certificates were fetched but could not be recorded.');
    }
  }

  /**
   * One sentence, in the polite live region.
   *
   * Announcing every row would be unusable, and announcing nothing would hide
   * the whole point of the app, so this says how many arrived and how bad the
   * worst one is -- enough to decide whether to look now.
   */
  private announceNewAlerts(created: readonly Alert[]): void {
    const worst = created.reduce<RiskLevel>((level, alert) => {
      const order: RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];
      return order.indexOf(alert.assessment.level) > order.indexOf(level)
        ? alert.assessment.level
        : level;
    }, 'none');

    const count = created.length;
    const noun = count === 1 ? 'certificate' : 'certificates';
    const held = this.holdUpdatesSignal()
      ? ' Not added to the table yet, because you are reading it.'
      : '';

    this.announce(
      `${count} new ${noun} matched your watchlist. Highest risk: ${worst}.${held}`,
    );
  }

  private announce(message: string): void {
    // Clearing first guarantees the region is seen to change even when the
    // same message repeats.
    this.announcementSignal.set('');
    queueMicrotask(() => this.announcementSignal.set(message));
  }
}
