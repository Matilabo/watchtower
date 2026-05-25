/**
 * The watchlist: add a domain, see what is watched, stop watching.
 *
 * Laid out as a band across the top of the page rather than a column beside
 * the results. As a column it took 20rem that the table needed, which forced
 * the table into horizontal scrolling at ordinary laptop widths -- and a table
 * you have to scroll sideways is a table you cannot scan.
 *
 * As a band, every line it occupies is a row of results the user does not see,
 * so the parts are ranked by how often they are used: what is watched stays
 * visible; the form to add something is one click away. With nothing watched
 * yet that ranking inverts and the form is shown open, because it is then the
 * only thing worth doing.
 *
 * The form is a real `<form>` with a submit button, so Enter works, and the
 * validation message is wired with `aria-describedby` + `aria-invalid` so a
 * screen reader user hears why the submission failed rather than wondering
 * whether anything happened.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

import type { WatchlistEntry } from '../domain/models';

@Component({
  selector: 'wt-watchlist-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <h2 class="title">Watchlist</h2>
      <p class="hint">Certificate names are scored against every entry on every check.</p>

      <p class="count">
        {{ entries().length }} {{ entries().length === 1 ? 'domain' : 'domains' }}
      </p>

      @if (entries().length > 0) {
        <button
          type="button"
          class="wt-quiet toggle"
          [attr.aria-expanded]="formOpen()"
          aria-controls="watchlist-form"
          (click)="toggle()"
        >
          {{ formOpen() ? 'Cancel' : 'Add domain' }}
        </button>
      }
    </div>

    @if (formOpen()) {
      <form id="watchlist-form" class="form" (submit)="submit($event)" novalidate>
        <div class="field">
          <label for="watch-domain">Domain</label>
          <input
            id="watch-domain"
            name="domain"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="example.com"
            [value]="domain()"
            (input)="domain.set(value($event))"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="error() ? 'watch-domain-error' : 'watch-domain-hint'"
            [disabled]="busy()"
          />
          <p id="watch-domain-hint" class="field-hint">
            Internationalised domains are accepted in either form.
          </p>
          @if (error()) {
            <p id="watch-domain-error" class="field-error">
              <span aria-hidden="true">⚠</span> {{ error() }}
            </p>
          }
        </div>

        <div class="field">
          <label for="watch-label">Label <span class="optional">(optional)</span></label>
          <input
            id="watch-label"
            name="label"
            type="text"
            autocomplete="off"
            placeholder="Retail banking portal"
            [value]="label()"
            (input)="label.set(value($event))"
            [disabled]="busy()"
          />
        </div>

        <button type="submit" class="wt-primary" [disabled]="busy()">
          {{ busy() ? 'Adding…' : 'Watch domain' }}
        </button>
      </form>
    }

    @if (entries().length === 0) {
      <p class="empty">Nothing is being watched, so nothing will be flagged.</p>
    } @else {
      <ul class="entries" aria-label="Watched domains">
        @for (entry of entries(); track entry.id) {
          <li class="entry">
            <span class="domain wt-mono">{{ entry.domain }}</span>
            @if (entry.label) {
              <span class="meta">{{ entry.label }}</span>
            }
            <span class="meta alerts">
              {{ alertCount(entry.id) }}
              {{ alertCount(entry.id) === 1 ? 'alert' : 'alerts' }}
            </span>
            <button type="button" class="wt-quiet remove" (click)="remove.emit(entry)">
              <span aria-hidden="true">×</span>
              <span class="wt-visually-hidden">Stop watching {{ entry.domain }}</span>
            </button>
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        padding: 0.75rem 1.15rem 0.85rem;
      }

      .head {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      .title {
        font-size: 0.875rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--wt-accent-strong);
      }

      .hint {
        margin: 0;
        font-size: 0.8125rem;
        color: var(--wt-text-muted);
      }

      .count {
        margin: 0 0 0 auto;
        font-size: 0.8125rem;
        color: var(--wt-text-muted);
      }

      .toggle {
        font-size: 0.8125rem;
        padding: 0.2rem 0.6rem;
        align-self: center;
      }

      .form {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-top: 0.75rem;
        padding: 0.75rem;
        background: var(--wt-surface-sunken);
        border: 1px solid var(--wt-border);
        border-radius: var(--wt-radius-sm);
      }

      .field {
        display: grid;
        gap: 0.3rem;
        flex: 1 1 16rem;
        min-width: 12rem;
      }

      .form > button {
        /* Aligns with the inputs rather than with their labels. */
        margin-top: 1.35rem;
      }

      .optional {
        font-weight: 400;
        color: var(--wt-text-muted);
      }

      .field-hint {
        margin: 0;
        font-size: 0.75rem;
        color: var(--wt-text-muted);
      }

      .field-error {
        margin: 0;
        font-size: 0.8125rem;
        color: var(--wt-danger);
        font-weight: 600;
      }

      .empty {
        margin: 0.6rem 0 0;
        font-size: 0.875rem;
        color: var(--wt-text-muted);
      }

      /* Entries wrap as single-line chips instead of stacking down a column. */
      .entries {
        list-style: none;
        margin: 0.6rem 0 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }

      .entry {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        padding: 0.2rem 0.2rem 0.2rem 0.6rem;
        background: var(--wt-surface-sunken);
        border: 1px solid var(--wt-border);
        border-radius: var(--wt-radius-sm);
        max-width: 100%;
        font-size: 0.8125rem;
      }

      .domain {
        font-weight: 650;
        overflow-wrap: anywhere;
      }

      .meta {
        color: var(--wt-text-muted);
        font-size: 0.75rem;
        white-space: nowrap;
      }

      .remove {
        padding: 0 0.35rem;
        font-size: 1rem;
        line-height: 1.2;
        border-color: transparent;
        background: transparent;
      }

      .remove:hover {
        border-color: var(--wt-border-strong);
        color: var(--wt-danger);
      }
    `,
  ],
})
export class WatchlistPanelComponent {
  readonly entries = input.required<readonly WatchlistEntry[]>();
  readonly alertCounts = input<ReadonlyMap<string, number>>(new Map<string, number>());
  readonly error = input<string | null>(null);
  readonly busy = input(false);

  readonly add = output<{ domain: string; label: string }>();
  readonly remove = output<WatchlistEntry>();

  protected readonly domain = signal('');
  protected readonly label = signal('');

  private readonly requestedOpen = signal(false);

  /** Open on request, and always open when there is nothing to collapse to. */
  protected readonly formOpen = computed(
    () => this.requestedOpen() || this.entries().length === 0,
  );

  protected toggle(): void {
    this.requestedOpen.update((open) => !open);
  }

  protected alertCount(entryId: string): number {
    return this.alertCounts().get(entryId) ?? 0;
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const domain = this.domain().trim();
    if (domain.length === 0 || this.busy()) return;

    this.add.emit({ domain, label: this.label() });
  }

  /** Called by the shell once the store has accepted the entry. */
  reset(): void {
    this.domain.set('');
    this.label.set('');
    this.requestedOpen.set(false);
  }
}
