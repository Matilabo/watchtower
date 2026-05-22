/**
 * Triage as a radio group.
 *
 * A radio group, not a set of toggle buttons: the four states are mutually
 * exclusive and exactly one is always current, which is what a radio group
 * means. Screen readers then announce "Investigating, radio button, 2 of 4",
 * and arrow keys move between options -- both for free, and both wrong if this
 * were four buttons.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { TRIAGE_LABELS, TRIAGE_STATES, type TriageState } from '../domain/alert';

@Component({
  selector: 'wt-triage-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="group" [disabled]="busy()">
      <legend class="wt-visually-hidden">{{ legend() }}</legend>
      @for (state of states; track state) {
        <label class="option" [class.selected]="state === current()">
          <input
            type="radio"
            [name]="name()"
            [value]="state"
            [checked]="state === current()"
            (change)="stateChange.emit(state)"
          />
          <span>{{ labels[state] }}</span>
        </label>
      }
      @if (busy()) {
        <span class="busy" role="status">Saving…</span>
      }
    </fieldset>
  `,
  styles: [
    `
      .group {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        border: 0;
        margin: 0;
        padding: 0;
        align-items: center;
      }

      .option {
        position: relative;
        display: inline-flex;
        align-items: center;
        padding: 0.25rem 0.6rem;
        border: 1px solid var(--wt-border);
        border-radius: 999px;
        font-size: 0.8125rem;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }

      /* The native control stays in the accessibility tree and keeps keyboard
         behaviour; it is only visually replaced by the pill. */
      .option input {
        position: absolute;
        opacity: 0;
        inset: 0;
        margin: 0;
        cursor: pointer;
      }

      .option:hover {
        border-color: var(--wt-border-strong);
      }

      .option.selected {
        background: var(--wt-accent);
        border-color: var(--wt-accent);
        color: var(--wt-accent-contrast);
      }

      .option:has(input:focus-visible) {
        outline: 3px solid var(--wt-accent-strong);
        outline-offset: 2px;
      }

      .group:disabled .option {
        opacity: 0.6;
        cursor: progress;
      }

      .busy {
        font-size: 0.8125rem;
        color: var(--wt-text-muted);
      }
    `,
  ],
})
export class TriageControlsComponent {
  readonly current = input.required<TriageState>();
  /** Unique per alert: radio groups are keyed by name. */
  readonly name = input.required<string>();
  readonly legend = input('Triage state');
  readonly busy = input(false);

  readonly stateChange = output<TriageState>();

  protected readonly states = TRIAGE_STATES;
  protected readonly labels = TRIAGE_LABELS;
}
