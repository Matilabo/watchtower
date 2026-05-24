/**
 * Feed status: where the data came from, how old it is, and what went wrong.
 *
 * The staleness indicator is the honest part of the app. When a poll fails the
 * last good results stay on screen, which is the right call -- an empty table
 * would be worse -- but it means the display is quietly out of date. So the
 * age is always stated in words, the warning is text rather than a colour, and
 * the whole block is a `role="status"` region so a screen reader user learns
 * that the data went stale without having to go looking.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { MAX_AUTO_RETRIES, type PollFrame } from '../data/ct/certificate-stream';
import type { Freshness } from '../data/ct/staleness';

@Component({
  selector: 'wt-feed-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar" role="status" [attr.data-level]="freshness().level">
      <span class="dot" aria-hidden="true" [attr.data-state]="indicatorState()"></span>

      <span class="text">
        <span class="line">
          <strong>{{ sourceName() }}</strong>
          <span class="sep" aria-hidden="true">·</span>
          <span>{{ freshness().label }}</span>
          @if (frame()?.partial) {
            <span class="sep" aria-hidden="true">·</span>
            <span class="warn">Some queries failed, results may be incomplete</span>
          }
        </span>

        @if (statusMessage(); as message) {
          <span class="line detail">{{ message }}</span>
        }
      </span>

      <button
        type="button"
        class="refresh"
        [class.wt-quiet]="!paused()"
        [class.wt-primary]="paused()"
        [disabled]="polling()"
        (click)="refresh.emit()"
      >
        {{ buttonLabel() }}
      </button>
    </div>

    <!-- Spelled out for assistive technology; the visible text above is terse. -->
    <p class="wt-visually-hidden">{{ freshness().description }}</p>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .bar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.6rem 1rem;
        border-bottom: 1px solid var(--wt-border);
        font-size: 0.875rem;
        flex-wrap: wrap;
      }

      .dot {
        width: 0.7rem;
        height: 0.7rem;
        border-radius: 50%;
        flex: none;
        background: var(--wt-text-muted);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--wt-text-muted) 25%, transparent);
      }

      .dot[data-state='ok'] {
        background: var(--wt-success);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--wt-success) 25%, transparent);
      }

      .dot[data-state='warn'] {
        background: var(--wt-warning);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--wt-warning) 25%, transparent);
      }

      .dot[data-state='error'] {
        background: var(--wt-danger);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--wt-danger) 25%, transparent);
      }

      .text {
        display: grid;
        gap: 0.1rem;
        min-width: 0;
      }

      .line {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }

      .sep {
        color: var(--wt-text-muted);
      }

      .detail {
        color: var(--wt-text-muted);
        font-size: 0.8125rem;
        overflow-wrap: anywhere;
      }

      .warn {
        color: var(--wt-warning);
        font-weight: 600;
      }

      .bar[data-level='stale'] .detail,
      .bar[data-level='stale'] .line > span:not(.sep) {
        color: var(--wt-warning);
      }

      .refresh {
        margin-left: auto;
        font-size: 0.8125rem;
        padding: 0.3rem 0.7rem;
      }
    `,
  ],
})
export class FeedStatusComponent {
  readonly frame = input<PollFrame | null>(null);
  readonly freshness = input.required<Freshness>();
  readonly sourceName = input('Certificate feed');

  readonly refresh = output<void>();

  protected readonly polling = computed(() => this.frame()?.status === 'loading');
  protected readonly paused = computed(() => this.frame()?.autoRetryPaused === true);

  protected readonly buttonLabel = computed(() => {
    if (this.polling()) return 'Checking…';
    return this.paused() ? 'Try again' : 'Check now';
  });

  protected readonly indicatorState = computed(() => {
    const frame = this.frame();
    if (frame === null) return 'idle';
    if (frame.status === 'error') return 'error';
    if (this.freshness().stale || frame.partial) return 'warn';
    return frame.status === 'loading' ? 'idle' : 'ok';
  });

  /** The failure, in the user's terms, or nothing when all is well. */
  protected readonly statusMessage = computed(() => {
    const frame = this.frame();
    if (frame === null) return 'Connecting to the certificate feed…';

    if (frame.status === 'error' && frame.error !== null) {
      const attempts =
        frame.error.attempts > 1 ? ` after ${frame.error.attempts} attempts` : '';
      const base = `${frame.error.message}${attempts}. Showing the last results that came back`;

      // Say which it is: still trying, or waiting for you. "Retrying
      // automatically" while nothing is being retried is the kind of small lie
      // that makes people stop believing the rest of the status bar.
      return frame.autoRetryPaused
        ? `${base}. Automatic checks stopped after ${frame.consecutiveFailures} failed attempts — choose “Try again” to resume.`
        : `${base}; retrying automatically (attempt ${frame.consecutiveFailures} of ${MAX_AUTO_RETRIES}).`;
    }

    if (this.freshness().stale) {
      return 'Nothing new has been fetched for a while. What you see below may be out of date.';
    }

    return '';
  });
}
