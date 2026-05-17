/**
 * Alerts and triage.
 *
 * An alert is the join of "a certificate was issued" and "it resembles
 * something you watch", plus the analyst's verdict on it. The verdict is the
 * only mutable part, and it is the part that must survive a reload -- so the
 * transitions live here as pure functions and are unit tested, rather than
 * being spread across a component and a resolver.
 */

import type { CertificateRecord } from './certificate';
import { certificateKey } from './certificate';
import type { LookalikeAssessment, WatchlistEntry } from './models';

/** Where an alert sits in the analyst's workflow. */
export type TriageState = 'new' | 'investigating' | 'benign' | 'malicious';

export const TRIAGE_STATES: readonly TriageState[] = [
  'new',
  'investigating',
  'benign',
  'malicious',
];

/** Human labels, defined once so the UI and the GraphQL layer cannot disagree. */
export const TRIAGE_LABELS: Readonly<Record<TriageState, string>> = {
  new: 'New',
  investigating: 'Investigating',
  benign: 'Benign',
  malicious: 'Malicious',
};

export interface TriageEvent {
  readonly state: TriageState;
  readonly at: string;
  readonly note: string;
}

export interface Alert {
  /** Stable across polls: the same certificate/watch pair is always one alert. */
  readonly id: string;
  readonly certificate: CertificateRecord;
  readonly watchEntryId: string;
  /** The watched domain, denormalised so an alert renders without a lookup. */
  readonly watchedDomain: string;
  readonly assessment: LookalikeAssessment;
  readonly triage: TriageState;
  /** Append-only audit trail; the first entry is always the initial sighting. */
  readonly history: readonly TriageEvent[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/**
 * One alert per (certificate, watchlist entry). A certificate that resembles
 * two different watched domains is two alerts, because they can be triaged
 * differently and by different people.
 */
export function alertId(certificate: CertificateRecord, watchEntryId: string): string {
  return `${certificateKey(certificate)}|${watchEntryId}`;
}

export function buildAlert(
  certificate: CertificateRecord,
  entry: WatchlistEntry,
  assessment: LookalikeAssessment,
  now: string,
): Alert {
  return {
    id: alertId(certificate, entry.id),
    certificate,
    watchEntryId: entry.id,
    watchedDomain: entry.domain,
    assessment,
    triage: 'new',
    history: [{ state: 'new', at: now, note: 'First seen in certificate transparency log' }],
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

/**
 * Records a triage decision.
 *
 * Re-selecting the current state with no note is a no-op and returns the same
 * object: an analyst clicking "investigating" twice should not produce two
 * audit entries, and reference equality keeps signal-driven change detection
 * from re-rendering the row.
 */
export function applyTriage(alert: Alert, state: TriageState, now: string, note = ''): Alert {
  if (alert.triage === state && note.length === 0) return alert;

  return {
    ...alert,
    triage: state,
    history: [...alert.history, { state, at: now, note }],
  };
}

/**
 * Folds a freshly observed alert into the one already held.
 *
 * CT polling re-reports the same certificate for as long as it stays in the
 * query window, so this keeps the analyst's verdict and audit trail while
 * refreshing the observation. Losing triage state on a re-poll would be the
 * single most annoying bug this app could have.
 */
export function mergeAlert(existing: Alert, incoming: Alert): Alert {
  return {
    ...existing,
    certificate: incoming.certificate,
    assessment: incoming.assessment,
    watchedDomain: incoming.watchedDomain,
    lastSeenAt: incoming.lastSeenAt,
  };
}

/** Sort key for the results table: unresolved first, then risk, then recency. */
export function compareAlerts(a: Alert, b: Alert): number {
  const resolved = (alert: Alert): number =>
    alert.triage === 'benign' || alert.triage === 'malicious' ? 1 : 0;

  return (
    resolved(a) - resolved(b) ||
    b.assessment.score - a.assessment.score ||
    b.certificate.loggedAt.localeCompare(a.certificate.loggedAt) ||
    a.id.localeCompare(b.id)
  );
}

/** True once an analyst has reached a verdict, for the "N open" counter. */
export function isResolved(alert: Alert): boolean {
  return alert.triage === 'benign' || alert.triage === 'malicious';
}
