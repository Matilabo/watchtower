/**
 * The watchlist: add a domain, see what is watched, stop watching.
 *
 * The form is a real `<form>` with a submit button, so Enter works, and the
 * validation message is wired with `aria-describedby` + `aria-invalid` so a
 * screen reader user hears why the submission failed rather than wondering
 * whether anything happened.
 */

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

import type { WatchlistEntry } from '../domain/models';

@Component({
  selector: 'wt-watchlist-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="title">Watchlist</h2>
    <p class="hint">
      Domains you own. Certificate names are scored against every entry on every poll.
    </p>

    <form class="form" (submit)="submit($event)" novalidate>
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

    <h3 class="subtitle">
      Watching {{ entries().length }}
      {{ entries().length === 1 ? 'domain' : 'domains' }}
    </h3>

    @if (entries().length === 0) {
      <p class="empty">Nothing is being watched, so nothing will be flagged.</p>
    } @else {
      <ul class="entries">
        @for (entry of entries(); track entry.id) {
          <li class="entry">
            <div class="entry-text">
              <span class="domain wt-mono">{{ entry.domain }}</span>
              @if (entry.label) {
                <span class="label">{{ entry.label }}</span>
              }
              <span class="alerts">
                {{ alertCount(entry.id) }}
                {{ alertCount(entry.id) === 1 ? 'alert' : 'alerts' }}
              </span>
            </div>
            <button type="button" class="wt-quiet remove" (click)="remove.emit(entry)">
              Remove<span class="wt-visually-hidden"> {{ entry.domain }} from the watchlist</span>
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
        padding: 1rem 1.15rem;
      }

      .title {
        font-size: 1rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--wt-accent-strong);
      }

      .hint {
        margin: 0.35rem 0 1rem;
        font-size: 0.875rem;
        color: var(--wt-text-muted);
      }

      .form {
        display: grid;
        gap: 0.75rem;
      }

      .field {
        display: grid;
        gap: 0.3rem;
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

      .subtitle {
        margin: 1.5rem 0 0.5rem;
        font-size: 0.8125rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--wt-text-muted);
      }

      .empty {
        margin: 0;
        font-size: 0.875rem;
        color: var(--wt-text-muted);
      }

      .entries {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.4rem;
      }

      .entry {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.65rem;
        background: var(--wt-surface-sunken);
        border: 1px solid var(--wt-border);
        border-radius: var(--wt-radius-sm);
      }

      .entry-text {
        display: grid;
        min-width: 0;
      }

      .domain {
        font-weight: 650;
        overflow-wrap: anywhere;
      }

      .label,
      .alerts {
        font-size: 0.75rem;
        color: var(--wt-text-muted);
      }

      .remove {
        margin-left: auto;
        font-size: 0.8125rem;
        padding: 0.3rem 0.6rem;
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
  }
}
