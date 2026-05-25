/**
 * The certificate detail card.
 *
 * The second host of `RiskHighlightDirective`. A table row and a card have
 * nothing structurally in common, which is exactly why composing the risk
 * treatment beats inheriting it or wrapping both in a shared element.
 *
 * The heading is focusable (`tabindex="-1"`) so opening a row can move focus
 * here. That is a user-initiated move, and it is the only focus move in the
 * app: background updates never take focus.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { TRIAGE_LABELS, type Alert, type TriageState } from '../domain/alert';
import { RiskBadgeComponent } from './risk-badge.component';
import { RiskHighlightDirective } from './risk-highlight.directive';
import { ScoreBreakdownComponent } from './score-breakdown.component';
import { TriageControlsComponent } from './triage-controls.component';

@Component({
  selector: 'wt-alert-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RiskBadgeComponent, ScoreBreakdownComponent, TriageControlsComponent],
  hostDirectives: [
    { directive: RiskHighlightDirective, inputs: ['riskLevel', 'riskScore', 'benign'] },
  ],
  template: `
    <header class="head">
      <div class="titles">
        <h2 tabindex="-1" id="alert-detail-heading" class="title wt-mono">
          {{ alert().assessment.candidateUnicode }}
        </h2>
        @if (showsPunycode()) {
          <p class="ascii wt-mono">
            Encoded as {{ alert().assessment.candidateAscii }}
          </p>
        }
      </div>
      <wt-risk-badge
        [level]="alert().assessment.level"
        [score]="alert().assessment.score"
        [benign]="alert().assessment.benign"
      />
    </header>

    <p class="summary">{{ alert().assessment.summary }}</p>

    <section class="section" aria-labelledby="breakdown-heading">
      <h3 id="breakdown-heading" class="section-title">Why it scored {{ score() }}</h3>
      <wt-score-breakdown [hits]="alert().assessment.hits" />
    </section>

    <section class="section" aria-labelledby="certificate-heading">
      <h3 id="certificate-heading" class="section-title">Certificate</h3>
      <dl class="facts">
        <div>
          <dt>Watched domain</dt>
          <dd class="wt-mono">{{ alert().watchedDomain }}</dd>
        </div>
        <div>
          <dt>Matched label</dt>
          <dd class="wt-mono">{{ alert().assessment.matchedLabel || 'None' }}</dd>
        </div>
        <div>
          <dt>Issuer</dt>
          <dd>{{ alert().certificate.issuer }}</dd>
        </div>
        <div>
          <dt>Serial</dt>
          <dd class="wt-mono">{{ alert().certificate.serialNumber || 'None' }}</dd>
        </div>
        <div>
          <dt>Logged</dt>
          <dd>{{ formatted(alert().certificate.loggedAt) }}</dd>
        </div>
        <div>
          <dt>Valid</dt>
          <dd>
            {{ formatted(alert().certificate.notBefore) }} –
            {{ formatted(alert().certificate.notAfter) }}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{{ alert().certificate.source }}</dd>
        </div>
      </dl>

      <h4 class="names-title">
        Names on this certificate ({{ alert().certificate.names.length }})
      </h4>
      <ul class="names">
        @for (name of alert().certificate.names; track name) {
          <li class="wt-mono">{{ name }}</li>
        }
      </ul>
    </section>

    <section class="section" aria-labelledby="triage-heading">
      <h3 id="triage-heading" class="section-title">Triage</h3>
      <wt-triage-controls
        [current]="alert().triage"
        [name]="'detail-triage-' + alert().id"
        legend="Triage state for this alert"
        [busy]="busy()"
        (stateChange)="triage.emit($event)"
      />

      <ol class="history">
        @for (event of alert().history; track event.at + event.state) {
          <li>
            <span class="state">{{ label(event.state) }}</span>
            <time [attr.datetime]="event.at">{{ formatted(event.at) }}</time>
            @if (event.note) {
              <p class="note">{{ event.note }}</p>
            }
          </li>
        }
      </ol>
    </section>

    <footer class="foot">
      <button type="button" class="wt-quiet" (click)="dismiss.emit()">Close details</button>
    </footer>
  `,
  styles: [
    `
      :host {
        display: block;
        padding: 1rem 1.15rem;
        border-top: var(--wt-risk-edge, 3px) solid var(--wt-risk-accent, transparent);
      }

      .head {
        display: flex;
        gap: 1rem;
        align-items: flex-start;
        justify-content: space-between;
        flex-wrap: wrap;
      }

      .title {
        font-size: 1.15rem;
        overflow-wrap: anywhere;
      }

      .title:focus-visible {
        outline: 3px solid var(--wt-accent-strong);
        outline-offset: 4px;
      }

      .ascii {
        margin: 0.15rem 0 0;
        font-size: 0.8125rem;
        color: var(--wt-text-muted);
        overflow-wrap: anywhere;
      }

      .summary {
        margin: 0.75rem 0 0;
        color: var(--wt-text-muted);
        overflow-wrap: anywhere;
      }

      .section {
        margin-top: 1.25rem;
      }

      .section-title {
        font-size: 0.8125rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--wt-accent-strong);
        margin-bottom: 0.6rem;
      }

      .facts {
        display: grid;
        gap: 0.5rem 1rem;
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
        margin: 0;
      }

      .facts dt {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--wt-text-muted);
      }

      .facts dd {
        margin: 0.1rem 0 0;
        overflow-wrap: anywhere;
        font-size: 0.9rem;
      }

      .names-title {
        margin: 1rem 0 0.4rem;
        font-size: 0.8125rem;
        color: var(--wt-text-muted);
        font-weight: 600;
      }

      .names {
        margin: 0;
        padding-left: 1.1rem;
        display: grid;
        gap: 0.15rem;
        font-size: 0.875rem;
        overflow-wrap: anywhere;
      }

      .history {
        list-style: none;
        margin: 0.85rem 0 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
        border-left: 2px solid var(--wt-border);
        padding-left: 0.85rem;
      }

      .history li {
        font-size: 0.875rem;
      }

      .state {
        font-weight: 650;
        margin-right: 0.5rem;
      }

      .history time {
        color: var(--wt-text-muted);
      }

      .note {
        margin: 0.15rem 0 0;
        color: var(--wt-text-muted);
        overflow-wrap: anywhere;
      }

      .foot {
        margin-top: 1.25rem;
        display: flex;
        justify-content: flex-end;
      }
    `,
  ],
})
export class AlertDetailComponent {
  readonly alert = input.required<Alert>();
  readonly busy = input(false);

  readonly triage = output<TriageState>();
  readonly dismiss = output<void>();

  protected readonly score = computed(() => this.alert().assessment.score);

  protected readonly showsPunycode = computed(
    () => this.alert().assessment.candidateAscii !== this.alert().assessment.candidateUnicode,
  );

  protected label(state: TriageState): string {
    return TRIAGE_LABELS[state];
  }

  protected formatted(iso: string): string {
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) return 'unknown';
    return new Date(parsed).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
