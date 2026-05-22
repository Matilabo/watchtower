/**
 * The risk level, as text first.
 *
 * Colour is the last of four signals here, not the only one: the level is
 * spelled out, the score is a number, the glyph differs per level, and the
 * accent colour merely agrees with all three. That is what keeps the table
 * usable in greyscale, at 200% zoom, and for the ~8% of men with a colour
 * vision deficiency.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { RiskLevel } from '../domain/models';

const GLYPHS: Readonly<Record<RiskLevel, string>> = {
  critical: '▲▲',
  high: '▲',
  medium: '◆',
  low: '▪',
  none: '·',
};

const LABELS: Readonly<Record<RiskLevel, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None',
};

@Component({
  selector: 'wt-risk-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="badge" [attr.data-level]="benign() ? 'benign' : level()">
      <span class="glyph" aria-hidden="true">{{ benign() ? '✓' : glyph() }}</span>
      <span class="text">
        @if (benign()) {
          Your certificate
        } @else {
          {{ label() }}
          <span class="score">{{ score() }}<span class="denominator">/100</span></span>
        }
      </span>
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-block;
      }

      .badge {
        display: inline-flex;
        align-items: baseline;
        gap: 0.4rem;
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
        border: 1px solid var(--wt-risk-accent, var(--wt-border));
        background: color-mix(in srgb, var(--wt-risk-accent, #7f9ea3) 14%, transparent);
        font-size: 0.8125rem;
        font-weight: 700;
        white-space: nowrap;
      }

      .badge[data-level='critical'] {
        --wt-risk-accent: var(--wt-risk-critical);
      }
      .badge[data-level='high'] {
        --wt-risk-accent: var(--wt-risk-high);
      }
      .badge[data-level='medium'] {
        --wt-risk-accent: var(--wt-risk-medium);
      }
      .badge[data-level='low'] {
        --wt-risk-accent: var(--wt-risk-low);
      }
      .badge[data-level='none'] {
        --wt-risk-accent: var(--wt-risk-none);
      }
      .badge[data-level='benign'] {
        --wt-risk-accent: var(--wt-risk-benign);
      }

      .glyph {
        color: var(--wt-risk-accent);
        font-size: 0.7em;
        letter-spacing: -0.1em;
      }

      .text {
        color: var(--wt-text);
      }

      .score {
        font-family: var(--wt-mono);
        font-weight: 600;
        margin-left: 0.25rem;
      }

      .denominator {
        color: var(--wt-text-muted);
        font-weight: 400;
      }
    `,
  ],
})
export class RiskBadgeComponent {
  readonly level = input.required<RiskLevel>();
  readonly score = input(0);
  readonly benign = input(false);

  protected readonly glyph = computed(() => GLYPHS[this.level()]);
  protected readonly label = computed(() => LABELS[this.level()]);
}
