/**
 * The shell.
 *
 * Owns the page landmarks, the single polite live region, and the only piece
 * of focus management in the app: opening a row moves focus to the detail
 * heading, because that move is user-initiated. Nothing that happens in the
 * background ever takes focus.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import type { Alert, TriageState } from './domain/alert';
import type { WatchlistEntry } from './domain/models';
import { WatchtowerStore, type AlertFilterState } from './state/watchtower.store';
import { AlertDetailComponent } from './ui/alert-detail.component';
import { FeedStatusComponent } from './ui/feed-status.component';
import { ResultsTableComponent } from './ui/results-table.component';
import { WatchlistPanelComponent } from './ui/watchlist-panel.component';

const DETAIL_PANEL_ID = 'alert-detail';

@Component({
  selector: 'wt-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertDetailComponent,
    FeedStatusComponent,
    ResultsTableComponent,
    WatchlistPanelComponent,
  ],
  template: `
    <a class="wt-skip-link" href="#results">Skip to results</a>

    <div class="page">
      <header class="masthead">
        <div class="brand">
          <div>
            <h1>Watchtower</h1>
            <p class="tagline">
              Newly issued TLS certificates that resemble domains you own
            </p>
          </div>
        </div>

        <dl class="stats">
          <div>
            <dt>Open</dt>
            <dd>{{ store.summary().new + store.summary().investigating }}</dd>
          </div>
          <div>
            <dt>High risk</dt>
            <dd>{{ store.summary().unresolvedHighRisk }}</dd>
          </div>
          <div>
            <dt>Malicious</dt>
            <dd>{{ store.summary().malicious }}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{{ store.summary().total }}</dd>
          </div>
        </dl>
      </header>

      <!--
        One polite live region for the whole app. It carries a sentence, never
        a table: announcing every new row would make the app unusable with a
        screen reader, and announcing nothing would hide the point of it.
      -->
      <p class="wt-visually-hidden" aria-live="polite" aria-atomic="true">
        {{ store.announcement() }}
      </p>

      @if (store.apiError(); as error) {
        <p class="banner" role="alert">
          <span aria-hidden="true">⚠</span> {{ error }}
        </p>
      }

      @if (store.isLiveSource && liveSourceBlocked()) {
        <p class="banner" role="alert">
          <span aria-hidden="true">⚠</span> crt.sh sends no CORS headers, so a browser
          cannot call it directly from this origin. Live mode needs a same-origin proxy
          in front of it; the bundled fixtures need no network at all.
        </p>
      }

      @if (!store.isLiveSource) {
        <p class="banner banner--info">
          Bundled fixtures: no network, no API keys, with occasional timeouts injected
          on purpose so the retry and stale-data states stay visible. Add
          <code>?live=1</code> to poll crt.sh.
        </p>
      }

      <section class="wt-panel watchlist" aria-labelledby="watchlist-heading">
        <h2 id="watchlist-heading" class="wt-visually-hidden">Watchlist</h2>
        <wt-watchlist-panel
          [entries]="store.watchlist()"
          [alertCounts]="alertCounts()"
          [error]="store.formError()"
          [busy]="store.adding()"
          (add)="onAdd($event)"
          (remove)="onRemove($event)"
        />
      </section>

      <div class="workspace">
        <main id="results" class="wt-panel results" tabindex="-1" aria-labelledby="results-heading">
          <h2 id="results-heading" class="wt-visually-hidden">Certificate matches</h2>

          <wt-feed-status
            [frame]="store.frame()"
            [freshness]="store.freshness()"
            [sourceName]="store.sourceName()"
            [intervalMs]="store.pollIntervalMs"
            (refresh)="store.refresh()"
          />

          <wt-results-table
            [alerts]="store.alerts()"
            [totalCount]="store.totalRendered()"
            [pendingCount]="store.pendingAlerts().length"
            [filter]="store.filter()"
            [selectedId]="selectedId()"
            [busyIds]="busyIds()"
            [loading]="store.loading()"
            [detailPanelId]="detailPanelId"
            (filterChange)="onFilter($event)"
            (showPending)="store.showPending()"
            (holdUpdatesChange)="store.setHoldUpdates($event)"
            (triage)="onTriage($event.alert, $event.state)"
            (inspect)="onInspect($event)"
          />
        </main>

        <section
          [id]="detailPanelId"
          class="wt-panel detail"
          aria-labelledby="alert-detail-heading"
          #detailPanel
        >
          @if (store.selectedAlert(); as alert) {
            <wt-alert-detail
              [alert]="alert"
              [riskLevel]="alert.assessment.level"
              [riskScore]="alert.assessment.score"
              [benign]="alert.assessment.benign"
              [busy]="store.isTriaging(alert.id)"
              (triage)="onTriage(alert, $event)"
              (dismiss)="store.select(null)"
            />
          } @else {
            <div class="detail-empty">
              <h2 id="alert-detail-heading" class="detail-empty-title">Details</h2>
              <p>
                Choose <strong>Details</strong> on a row to see which rules fired, what
                they contributed, and the certificate behind the alert.
              </p>
            </div>
          }
        </section>
      </div>

      <footer class="footer">
        <p>
          Scores are explanations, not verdicts. Every alert lists the rules that fired
          and what each contributed, so a human can disagree with it.
        </p>
      </footer>
    </div>
  `,
  styles: [
    `
      .page {
        max-width: 1600px;
        margin: 0 auto;
        padding: 1rem 1.25rem 3rem;
        display: grid;
        gap: 0.75rem;
      }

      .masthead {
        display: flex;
        align-items: center;
        gap: 1.5rem;
        flex-wrap: wrap;
        padding: 0.25rem 0.25rem 0;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 0.85rem;
      }

      h1 {
        font-size: 1.6rem;
        letter-spacing: -0.02em;
      }

      .tagline {
        margin: 0.15rem 0 0;
        color: var(--wt-text-muted);
        font-size: 0.9rem;
      }

      .stats {
        display: flex;
        gap: 1.5rem;
        margin: 0 0 0 auto;
        flex-wrap: wrap;
      }

      .stats div {
        text-align: right;
      }

      .stats dt {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--wt-text-muted);
      }

      .stats dd {
        margin: 0;
        font-size: 1.3rem;
        font-weight: 700;
        font-family: var(--wt-mono);
      }

      .banner {
        margin: 0;
        padding: 0.6rem 1rem;
        border-radius: var(--wt-radius-sm);
        border: 1px solid var(--wt-danger);
        background: color-mix(in srgb, var(--wt-danger) 14%, transparent);
        font-size: 0.9rem;
      }

      .banner--info {
        border-color: var(--wt-border-strong);
        background: color-mix(in srgb, var(--wt-accent) 10%, transparent);
      }

      .banner code {
        background: var(--wt-surface-sunken);
        padding: 0.05rem 0.3rem;
        border-radius: 4px;
      }

      /*
       * The watchlist is a band across the top rather than a column.
       *
       * As a column it stole 20rem from the results table, which pushed the
       * table into horizontal scrolling on ordinary laptop widths -- and a
       * table you have to scroll sideways is a table you cannot scan. The
       * watchlist is short, edited rarely and reads fine as a horizontal strip.
       */
      .watchlist {
        padding: 0;
      }

      .workspace {
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
      }

      .results {
        overflow: hidden;
      }

      .results:focus-visible {
        outline: 3px solid var(--wt-accent-strong);
        outline-offset: 2px;
      }

      .detail {
        min-width: 0;
      }

      .detail-empty {
        padding: 1.15rem;
        color: var(--wt-text-muted);
      }

      .detail-empty-title {
        font-size: 0.8125rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--wt-accent-strong);
        margin-bottom: 0.4rem;
      }

      .detail-empty p {
        margin: 0;
        font-size: 0.9rem;
      }

      .footer {
        color: var(--wt-text-muted);
        font-size: 0.8125rem;
        text-align: center;
      }

      .footer p {
        margin: 0;
      }

      /*
       * Only put the detail card beside the table when there is genuinely room
       * for both; below this it goes underneath, at full width.
       */
      @media (min-width: 1500px) {
        .workspace {
          grid-template-columns: minmax(0, 1fr) minmax(21rem, 26rem);
        }

        .detail {
          position: sticky;
          top: 1rem;
          max-height: calc(100vh - 2rem);
          overflow-y: auto;
        }
      }

      @media (max-width: 700px) {
        .stats {
          gap: 1rem;
          margin-left: 0;
        }
      }
    `,
  ],
})
export class AppComponent {
  protected readonly store = inject(WatchtowerStore);
  protected readonly detailPanelId = DETAIL_PANEL_ID;

  private readonly injector = inject(Injector);
  private readonly watchlistPanel = viewChild(WatchlistPanelComponent);
  private readonly detailPanel = viewChild<ElementRef<HTMLElement>>('detailPanel');

  private readonly selectedIdSignal = signal<string | null>(null);
  protected readonly selectedId = this.selectedIdSignal.asReadonly();

  protected readonly alertCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const entry of this.store.watchlist()) {
      counts.set(entry.id, this.store.alertCountFor(entry.id));
    }
    return counts;
  });

  /**
   * Live mode failing at the network layer, from a browser, is almost always
   * the same thing: crt.sh answers without CORS headers, so the request never
   * reaches our code. Saying so beats letting someone conclude the deployment
   * is broken.
   */
  protected readonly liveSourceBlocked = computed(
    () => this.store.frame()?.error?.kind === 'network',
  );

  protected readonly busyIds = computed(() => {
    const ids = new Set<string>();
    for (const alert of this.store.alerts()) {
      if (this.store.isTriaging(alert.id)) ids.add(alert.id);
    }
    return ids;
  });

  constructor() {
    // Failure here is already surfaced through the store's error signals; the
    // catch exists so the promise is never left unhandled.
    void this.store.start().catch(() => undefined);
  }

  protected async onAdd(input: { domain: string; label: string }): Promise<void> {
    const added = await this.store.addWatchlistEntry(input.domain, input.label);
    if (added) this.watchlistPanel()?.reset();
  }

  protected async onRemove(entry: WatchlistEntry): Promise<void> {
    await this.store.removeWatchlistEntry(entry);
  }

  protected onFilter(state: AlertFilterState): void {
    this.store.setFilter(state);
  }

  protected async onTriage(alert: Alert, state: TriageState): Promise<void> {
    await this.store.setTriage(alert, state);
  }

  /**
   * Opening a row is a user action, so moving focus into the panel is correct:
   * it is where the content they asked for now is, and it keeps the keyboard
   * path forward rather than sending them back to the top of the table.
   */
  protected onInspect(alert: Alert): void {
    this.selectedIdSignal.set(alert.id);
    this.store.select(alert.id);

    // afterNextRender, not a microtask: the heading does not exist until the
    // panel has actually been rendered.
    afterNextRender(
      () => {
        this.detailPanel()
          ?.nativeElement.querySelector<HTMLElement>('#alert-detail-heading')
          ?.focus();
      },
      { injector: this.injector },
    );
  }
}
