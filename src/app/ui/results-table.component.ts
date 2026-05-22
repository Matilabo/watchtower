/**
 * The results table.
 *
 * The accessibility requirement that shaped this component: a keyboard user
 * reading row 12 must not be disrupted when new certificates arrive. Three
 * things follow from it.
 *
 *  1. While focus is inside this table, new alerts are held back. The store is
 *     told on focusin/focusout; it keeps serving the snapshot the user is
 *     reading and counts what is waiting.
 *  2. Held alerts are offered, never imposed: a button says how many are
 *     waiting, and pressing it is the only thing that inserts them.
 *  3. Triage updates a row in place. Re-sorting on triage would move a row out
 *     from under the focus that just triaged it.
 *
 * The table is not itself a live region -- announcing a whole table on every
 * poll would be unusable. A single polite sentence is announced by the shell.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';

import type { Alert, TriageState } from '../domain/alert';
import type { AlertFilterState } from '../state/watchtower.store';
import { AlertRowComponent } from './alert-row.component';

@Component({
  selector: 'wt-results-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertRowComponent],
  host: {
    '(focusin)': 'onFocusIn()',
    '(focusout)': 'onFocusOut($event)',
  },
  template: `
    <div class="toolbar">
      <div class="filter">
        <label for="triage-filter">Show</label>
        <select
          id="triage-filter"
          [value]="filter()"
          (change)="filterChange.emit(asFilter($event))"
        >
          <option value="all">All alerts</option>
          <option value="new">New</option>
          <option value="investigating">Investigating</option>
          <option value="benign">Benign</option>
          <option value="malicious">Malicious</option>
        </select>
      </div>

      <p class="count">
        {{ alerts().length }} shown
        @if (totalCount() !== alerts().length) {
          of {{ totalCount() }}
        }
      </p>
    </div>

    @if (pendingCount() > 0) {
      <div class="pending">
        <p>
          @if (pendingCount() === 1) {
            1 new alert has arrived. It is held back while you are reading the table.
          } @else {
            {{ pendingCount() }} new alerts have arrived. They are held back while you are
            reading the table.
          }
        </p>
        <button type="button" class="wt-primary" (click)="showPending.emit()">
          Show {{ pendingCount() }} new
          {{ pendingCount() === 1 ? 'alert' : 'alerts' }}
        </button>
      </div>
    }

    @if (loading()) {
      <p class="state" role="status">Loading alert history…</p>
    } @else if (alerts().length === 0) {
      <p class="state">
        @if (totalCount() === 0) {
          Nothing has matched your watchlist yet. Newly issued certificates are checked
          every polling cycle.
        } @else {
          No alerts match this filter. Choose “All alerts” to see the other
          {{ totalCount() }}.
        }
      </p>
    } @else {
      <div class="scroll">
        <table>
          <caption class="wt-visually-hidden">
            Certificates resembling your watched domains, highest risk first. Updates are
            held while this table has focus.
          </caption>
          <thead>
            <tr>
              <th scope="col">Risk</th>
              <th scope="col">Certificate name</th>
              <th scope="col">Resembles</th>
              <th scope="col">Issuer</th>
              <th scope="col">Logged</th>
              <th scope="col">Triage</th>
              <th scope="col"><span class="wt-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (alert of alerts(); track alert.id) {
              <tr
                wtAlertRow
                [alert]="alert"
                [riskLevel]="alert.assessment.level"
                [riskScore]="alert.assessment.score"
                [benign]="alert.assessment.benign"
                [selected]="alert.id === selectedId()"
                [busy]="busyIds().has(alert.id)"
                [detailPanelId]="detailPanelId()"
                (triage)="triage.emit({ alert, state: $event })"
                (inspect)="inspect.emit(alert)"
              ></tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .toolbar {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--wt-border);
      }

      .filter {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .filter select {
        width: auto;
      }

      .count {
        margin: 0 0 0 auto;
        color: var(--wt-text-muted);
        font-size: 0.875rem;
      }

      .pending {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
        padding: 0.75rem 1rem;
        background: color-mix(in srgb, var(--wt-accent) 14%, transparent);
        border-bottom: 1px solid var(--wt-border-strong);
      }

      .pending p {
        margin: 0;
        font-size: 0.9rem;
      }

      .pending button {
        margin-left: auto;
      }

      .state {
        margin: 0;
        padding: 2rem 1rem;
        color: var(--wt-text-muted);
        text-align: center;
      }

      .scroll {
        overflow-x: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        text-align: left;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--wt-text-muted);
        background: var(--wt-surface);
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--wt-border-strong);
        white-space: nowrap;
      }
    `,
  ],
})
export class ResultsTableComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly alerts = input.required<readonly Alert[]>();
  readonly totalCount = input(0);
  readonly pendingCount = input(0);
  readonly filter = input.required<AlertFilterState>();
  readonly selectedId = input<string | null>(null);
  readonly busyIds = input<ReadonlySet<string>>(new Set<string>());
  readonly loading = input(false);
  readonly detailPanelId = input('alert-detail');

  readonly filterChange = output<AlertFilterState>();
  readonly showPending = output<void>();
  readonly holdUpdatesChange = output<boolean>();
  readonly triage = output<{ alert: Alert; state: TriageState }>();
  readonly inspect = output<Alert>();

  protected onFocusIn(): void {
    this.holdUpdatesChange.emit(true);
  }

  protected onFocusOut(event: FocusEvent): void {
    // focusout fires when moving between cells too, so only release the hold
    // when focus has genuinely left the table.
    const next = event.relatedTarget;
    const element = this.host.nativeElement as HTMLElement;
    if (next instanceof Node && element.contains(next)) return;
    this.holdUpdatesChange.emit(false);
  }

  protected asFilter(event: Event): AlertFilterState {
    return (event.target as HTMLSelectElement).value as AlertFilterState;
  }
}
