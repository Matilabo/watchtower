/**
 * Why this domain scored what it scored.
 *
 * The contributions sum to exactly the score, so this renders as a list that
 * adds up rather than a set of unrelated numbers. Each bar is decorative --
 * the number next to it is the real content -- so the bars are aria-hidden and
 * the list itself reads as text.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { RuleHit } from '../domain/models';

@Component({
  selector: 'wt-score-breakdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (hits().length === 0) {
      <p class="empty">No rules fired for this pair.</p>
    } @else {
      <ul class="hits">
        @for (hit of hits(); track hit.rule + hit.detail) {
          <li class="hit">
            <div class="head">
              <span class="title">{{ hit.title }}</span>
              <span class="kind" [attr.data-kind]="hit.kind">{{ kindLabel(hit.kind) }}</span>
              <span class="points">
                <span class="value">+{{ hit.contribution }}</span>
                <span class="wt-visually-hidden">points of the total score</span>
              </span>
            </div>
            <p class="detail">{{ hit.detail }}</p>
            <div
              class="bar"
              aria-hidden="true"
              [style.--fill.%]="percentOf(hit.contribution)"
            ></div>
          </li>
        }
      </ul>
      <p class="total">
        Total <strong>{{ total() }}</strong> of 100
      </p>
    }
  `,
  styles: [
    `
      .hits {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.75rem;
      }

      .hit {
        background: var(--wt-surface-sunken);
        border: 1px solid var(--wt-border);
        border-radius: var(--wt-radius-sm);
        padding: 0.6rem 0.75rem;
      }

      .head {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .title {
        font-weight: 650;
      }

      .kind {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        border: 1px solid var(--wt-border);
        color: var(--wt-text-muted);
      }

      .kind[data-kind='base'] {
        color: var(--wt-accent-strong);
        border-color: var(--wt-border-strong);
      }

      .points {
        margin-left: auto;
        font-family: var(--wt-mono);
        font-weight: 700;
        color: var(--wt-accent-strong);
      }

      .detail {
        margin: 0.35rem 0 0.5rem;
        color: var(--wt-text-muted);
        font-size: 0.9rem;
        overflow-wrap: anywhere;
      }

      .bar {
        height: 6px;
        border-radius: 999px;
        background: var(--wt-surface-raised);
        overflow: hidden;
        position: relative;
      }

      .bar::after {
        content: '';
        position: absolute;
        inset: 0 auto 0 0;
        width: var(--fill, 0%);
        background: linear-gradient(90deg, var(--wt-accent-deep), var(--wt-accent));
      }

      .total {
        margin: 0.75rem 0 0;
        font-size: 0.9rem;
        color: var(--wt-text-muted);
      }

      .total strong {
        color: var(--wt-text);
        font-family: var(--wt-mono);
      }

      .empty {
        margin: 0;
        color: var(--wt-text-muted);
      }
    `,
  ],
})
export class ScoreBreakdownComponent {
  readonly hits = input.required<readonly RuleHit[]>();

  protected readonly total = computed(() =>
    this.hits().reduce((sum, hit) => sum + hit.contribution, 0),
  );

  protected percentOf(contribution: number): number {
    const max = Math.max(...this.hits().map((hit) => hit.contribution), 1);
    return Math.round((contribution / max) * 100);
  }

  protected kindLabel(kind: RuleHit['kind']): string {
    return kind === 'base' ? 'signal' : kind === 'modifier' ? 'amplifier' : 'suppressor';
  }
}
