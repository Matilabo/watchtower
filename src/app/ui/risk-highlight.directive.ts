/**
 * The risk highlight, defined once.
 *
 * Two very different hosts need the same visual language for risk: a row in
 * the results table and the standalone detail card. Rather than duplicating
 * the host bindings in both components (or wrapping both in a third element
 * that exists only to carry a class), this directive is composed into both via
 * `hostDirectives` -- the Directive Composition API. The hosts declare what
 * they are; this decides what risk looks like.
 *
 * It contributes presentation only. The accessible name of a risk level is the
 * badge's job, because assistive technology must get the level as text, not as
 * a CSS custom property.
 */

import { Directive, computed, input } from '@angular/core';

import type { RiskLevel } from '../domain/models';

const ACCENTS: Readonly<Record<RiskLevel, string>> = {
  critical: 'var(--wt-risk-critical)',
  high: 'var(--wt-risk-high)',
  medium: 'var(--wt-risk-medium)',
  low: 'var(--wt-risk-low)',
  none: 'var(--wt-risk-none)',
};

/** Thicker rules for higher risk, so the level survives greyscale and zoom. */
const EDGES: Readonly<Record<RiskLevel, string>> = {
  critical: '6px',
  high: '5px',
  medium: '4px',
  low: '3px',
  none: '2px',
};

@Directive({
  selector: '[wtRiskHighlight]',
  host: {
    class: 'wt-risk',
    '[attr.data-risk-level]': 'level()',
    '[attr.data-risk-score]': 'riskScore()',
    '[class.wt-risk--benign]': 'benign()',
    '[style.--wt-risk-accent]': 'accent()',
    '[style.--wt-risk-edge]': 'edge()',
  },
})
export class RiskHighlightDirective {
  readonly riskLevel = input.required<RiskLevel>();
  readonly riskScore = input(0);
  /** One of the user's own certificates: shown as reassurance, not as risk. */
  readonly benign = input(false);

  protected readonly level = computed<RiskLevel>(() =>
    this.benign() ? 'none' : this.riskLevel(),
  );

  protected readonly accent = computed(() =>
    this.benign() ? 'var(--wt-risk-benign)' : ACCENTS[this.level()],
  );

  protected readonly edge = computed(() => EDGES[this.level()]);
}
