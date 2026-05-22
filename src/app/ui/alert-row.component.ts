/**
 * One row of the results table.
 *
 * The selector is `tr[wtAlertRow]` so the component *is* the table row: no
 * wrapper element, no `display: contents` workaround, and the table keeps its
 * semantics for assistive technology.
 *
 * The risk treatment comes from `RiskHighlightDirective` through
 * `hostDirectives` -- the same directive the detail card composes, so the two
 * cannot drift apart.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { Alert, TriageState } from '../domain/alert';
import { RiskBadgeComponent } from './risk-badge.component';
import { RiskHighlightDirective } from './risk-highlight.directive';
import { TriageControlsComponent } from './triage-controls.component';

@Component({
  selector: 'tr[wtAlertRow]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RiskBadgeComponent, TriageControlsComponent],
  hostDirectives: [
    { directive: RiskHighlightDirective, inputs: ['riskLevel', 'riskScore', 'benign'] },
  ],
  host: {
    '[class.selected]': 'selected()',
    '[attr.aria-selected]': 'selected()',
  },
  template: `
    <td class="risk">
      <wt-risk-badge
        [level]="alert().assessment.level"
        [score]="alert().assessment.score"
        [benign]="alert().assessment.benign"
      />
    </td>

    <th scope="row" class="name">
      <span class="candidate wt-mono">{{ alert().assessment.candidateUnicode }}</span>
      @if (showsPunycode()) {
        <span class="ascii wt-mono">
          <span class="wt-visually-hidden">Punycode form:</span>
          {{ alert().assessment.candidateAscii }}
        </span>
      }
      <span class="reason">{{ topReason() }}</span>
    </th>

    <td class="watched wt-mono">{{ alert().watchedDomain }}</td>

    <td class="issuer">
      <span class="truncate" [title]="alert().certificate.issuer">{{ issuerName() }}</span>
    </td>

    <td class="seen">
      <time [attr.datetime]="alert().certificate.loggedAt">{{ loggedAt() }}</time>
    </td>

    <td class="triage">
      <wt-triage-controls
        [current]="alert().triage"
        [name]="'triage-' + alert().id"
        [legend]="'Triage state for ' + alert().assessment.candidateUnicode"
        [busy]="busy()"
        (stateChange)="triage.emit($event)"
      />
    </td>

    <td class="actions">
      <button
        type="button"
        class="wt-quiet"
        [attr.aria-expanded]="selected()"
        [attr.aria-controls]="detailPanelId()"
        (click)="inspect.emit()"
      >
        Details
        <span class="wt-visually-hidden">for {{ alert().assessment.candidateUnicode }}</span>
      </button>
    </td>
  `,
  styles: [
    `
      :host {
        border-left: var(--wt-risk-edge, 3px) solid var(--wt-risk-accent, transparent);
      }

      :host(.selected) {
        background: color-mix(in srgb, var(--wt-accent) 12%, transparent);
      }

      td,
      th {
        padding: 0.6rem 0.75rem;
        border-bottom: 1px solid var(--wt-border);
        text-align: left;
        vertical-align: top;
        font-weight: 400;
      }

      .name {
        min-width: 16rem;
      }

      .candidate {
        display: block;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .ascii,
      .reason {
        display: block;
        font-size: 0.8125rem;
        color: var(--wt-text-muted);
        overflow-wrap: anywhere;
      }

      .reason {
        font-family: var(--wt-font);
        margin-top: 0.15rem;
      }

      .watched,
      .issuer,
      .seen {
        color: var(--wt-text-muted);
        font-size: 0.875rem;
        white-space: nowrap;
      }

      .truncate {
        display: inline-block;
        max-width: 12rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: bottom;
      }
    `,
  ],
})
export class AlertRowComponent {
  readonly alert = input.required<Alert>();
  readonly selected = input(false);
  readonly busy = input(false);
  readonly detailPanelId = input('alert-detail');

  readonly triage = output<TriageState>();
  readonly inspect = output<void>();

  protected readonly showsPunycode = computed(
    () => this.alert().assessment.candidateAscii !== this.alert().assessment.candidateUnicode,
  );

  /** The strongest rule, so the row explains itself without being opened. */
  protected readonly topReason = computed(
    () => this.alert().assessment.hits[0]?.title ?? 'No rules fired',
  );

  /** Issuer DNs are long; the CN is the part anyone reads. */
  protected readonly issuerName = computed(() => {
    const issuer = this.alert().certificate.issuer;
    const cn = /CN=([^,]+)/.exec(issuer)?.[1];
    const org = /O=([^,]+)/.exec(issuer)?.[1];
    return org ?? cn ?? issuer;
  });

  protected readonly loggedAt = computed(() => {
    const parsed = Date.parse(this.alert().certificate.loggedAt);
    if (Number.isNaN(parsed)) return 'unknown';
    return new Date(parsed).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  });
}
