/**
 * "How old is what I am looking at?"
 *
 * When a poll fails the app keeps showing the last good data, which is the
 * right call -- an empty table would be worse -- but it makes the display
 * silently lie. This module turns "last success at T" into something the UI
 * can state out loud, including for a screen reader, and it is pure so the
 * thresholds are testable without a clock.
 */

export type FreshnessLevel = 'fresh' | 'aging' | 'stale' | 'never';

export interface Freshness {
  readonly level: FreshnessLevel;
  /** Milliseconds since the last successful fetch, or null if there never was one. */
  readonly ageMs: number | null;
  /** e.g. `Updated 4 minutes ago`, or `Never updated`. */
  readonly label: string;
  /**
   * Spelled-out sentence for `aria-describedby` / the status region. Screen
   * reader users get the same warning as sighted users, not just a colour.
   */
  readonly description: string;
  /** True once the data is old enough that decisions should not rely on it. */
  readonly stale: boolean;
}

export interface FreshnessOptions {
  /** The polling interval; the thresholds are expressed in multiples of it. */
  readonly pollIntervalMs: number;
  /** Multiple of the interval after which data is "aging". */
  readonly agingAfterIntervals?: number;
  /** Multiple of the interval after which data is "stale". */
  readonly staleAfterIntervals?: number;
}

/*
 * Thresholds in multiples of the polling interval.
 *
 * A single missed beat is not news: with the old 2x/4x the indicator went
 * amber every time one cycle failed and green again on the next, which read as
 * the light changing on its own. Three intervals means two consecutive misses
 * before anything is claimed, which is the point at which the data on screen
 * really is behind.
 */
const DEFAULT_AGING_INTERVALS = 3;
const DEFAULT_STALE_INTERVALS = 6;

/** Rounded, human-facing age. Deliberately coarse: precision here is noise. */
export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function describeFreshness(
  lastSuccessAt: string | null,
  now: number,
  options: FreshnessOptions,
): Freshness {
  if (lastSuccessAt === null) {
    return {
      level: 'never',
      ageMs: null,
      label: 'No data yet',
      description: 'No certificate data has been fetched yet in this session.',
      stale: false,
    };
  }

  const timestamp = Date.parse(lastSuccessAt);
  if (Number.isNaN(timestamp)) {
    return {
      level: 'never',
      ageMs: null,
      label: 'No data yet',
      description: 'The time of the last successful fetch could not be determined.',
      stale: false,
    };
  }

  const ageMs = Math.max(0, now - timestamp);
  const interval = Math.max(1, options.pollIntervalMs);
  const aging = interval * (options.agingAfterIntervals ?? DEFAULT_AGING_INTERVALS);
  const stale = interval * (options.staleAfterIntervals ?? DEFAULT_STALE_INTERVALS);

  const age = formatAge(ageMs);
  if (ageMs >= stale) {
    return {
      level: 'stale',
      ageMs,
      label: `Data may be stale, updated ${age}`,
      description: `Certificate data may be stale. The last successful fetch was ${age}; new certificates issued since then are not shown.`,
      stale: true,
    };
  }

  if (ageMs >= aging) {
    return {
      level: 'aging',
      ageMs,
      label: `Updated ${age}, refresh overdue`,
      description: `The last successful fetch was ${age}, which is later than expected for the current polling interval.`,
      stale: false,
    };
  }

  return {
    level: 'fresh',
    ageMs,
    label: `Updated ${age}`,
    description: `Certificate data is current. Last successful fetch ${age}.`,
    stale: false,
  };
}
