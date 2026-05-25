/**
 * Feed status: where the data came from, how old it is, and what went wrong.
 *
 * The staleness indicator is the honest part of the app. When a poll fails the
 * last good results stay on screen, which is the right call -- an empty table
 * would be worse -- but it means the display is quietly out of date. So the
 * age is always stated in words, the warning is text rather than a colour, and
 * the whole block is a `role="status"` region so a screen reader user learns
 * that the data went stale without having to go looking.
 *
 * Two rules about *checking*, both learned by watching it run:
 *
 *  - An automatic check must not look like something the user did. Flipping
 *    the button to "Checking…" every interval is a control changing under
 *    their hand for no reason; the button only responds to their own presses.
 *  - The indicator must never blank out mid-check. Dropping to grey while a
 *    request is in flight made the light appear to cycle green, blank, orange
 *    on its own. It now keeps the colour it earned and pulses instead, so the
 *    colour always means "the state of the data", not "the state of a request".
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { MAX_AUTO_RETRIES, type PollFrame } from '../data/ct/certificate-stream';
import type { Freshness } from '../data/ct/staleness';

/** "15 seconds", "2 minutes" -- for the cadence sentence. */
function humanInterval(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

@Component({
  selector: 'wt-feed-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar" role="status" [attr.data-level]="freshness().level">
      <span
        class="dot"
        aria-hidden="true"
        [attr.data-state]="indicatorState()"
        [attr.data-checking]="checking() ? '' : null"
      ></span>

      <span class="text">
        <span class="line">
          <strong>{{ sourceName() }}</strong>
          <span class="sep" aria-hidden="true">·</span>
          <span>{{ freshness().label }}</span>

          @if (cadence(); as cadenceText) {
            <span class="sep" aria-hidden="true">·</span>
            <span class="cadence">{{ cadenceText }}</span>
          }

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
        [disabled]="manualCheckRunning()"
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

      /* A check in progress modulates the light; it never changes its colour. */
      .dot[data-checking] {
        animation: wt-pulse 1.1s ease-in-out infinite;
      }

      @keyframes wt-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.45;
        }
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

      .sep,
      .cadence {
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
      .bar[data-level='stale'] .line > span:not(.sep):not(.cadence) {
        color: var(--wt-warning);
      }

      .refresh {
        margin-left: auto;
        font-size: 0.8125rem;
        padding: 0.3rem 0.7rem;
        white-space: nowrap;
      }
    `,
  ],
})
export class FeedStatusComponent {
  readonly frame = input<PollFrame | null>(null);
  readonly freshness = input.required<Freshness>();
  readonly sourceName = input('Certificate feed');
  /** Polling interval, so the bar can state the cadence rather than imply it. */
  readonly intervalMs = input(0);

  readonly refresh = output<void>();

  protected readonly checking = computed(() => this.frame()?.status === 'loading');
  protected readonly paused = computed(() => this.frame()?.autoRetryPaused === true);

  /** Only a check the user asked for is allowed to change the button. */
  protected readonly manualCheckRunning = computed(
    () => this.checking() && this.frame()?.trigger === 'manual',
  );

  protected readonly buttonLabel = computed(() => {
    if (this.manualCheckRunning()) return 'Checking…';
    return this.paused() ? 'Try again' : 'Check now';
  });

  /**
   * The colour reflects the data, not the request. Keeping it stable while a
   * check runs is what stopped the light flicking between states on its own.
   */
  protected readonly indicatorState = computed(() => {
    const frame = this.frame();
    if (frame === null) return 'idle';
    if (frame.autoRetryPaused || frame.error !== null) return 'error';
    if (this.freshness().stale || frame.partial) return 'warn';
    return frame.lastSuccessAt === null ? 'idle' : 'ok';
  });

  /** Says that checking is automatic, and whether one is happening right now. */
  protected readonly cadence = computed(() => {
    const frame = this.frame();
    if (frame === null) return '';

    if (this.checking()) {
      return frame.trigger === 'manual' ? 'checking now' : 'checking automatically…';
    }
    if (frame.autoRetryPaused) return 'automatic checks paused';

    const interval = this.intervalMs();
    return interval > 0 ? `checks every ${humanInterval(interval)}` : '';
  });

  /** The failure, in the user's terms, or nothing when all is well. */
  protected readonly statusMessage = computed(() => {
    const frame = this.frame();
    if (frame === null) return 'Connecting to the certificate feed…';

    if (frame.error !== null) {
      const attempts = frame.error.attempts > 1 ? ` after ${frame.error.attempts} attempts` : '';
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
