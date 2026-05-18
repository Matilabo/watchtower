import { describe, expect, it } from 'vitest';

import { describeFreshness, formatAge } from './staleness';

const BASE = Date.parse('2026-05-18T12:00:00.000Z');
const OPTIONS = { pollIntervalMs: 60_000 };
const at = (msAgo: number): number => BASE + msAgo;

describe('formatAge', () => {
  it.each([
    [0, 'just now'],
    [4_000, 'just now'],
    [30_000, '30 seconds ago'],
    [60_000, '1 minute ago'],
    [120_000, '2 minutes ago'],
    [3_600_000, '1 hour ago'],
    [7_200_000, '2 hours ago'],
    [86_400_000, '1 day ago'],
    [172_800_000, '2 days ago'],
  ])('renders %ims as %s', (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });

  it('never renders a negative age', () => {
    expect(formatAge(-5_000)).toBe('just now');
  });
});

describe('describeFreshness', () => {
  it('reports that nothing has been fetched yet', () => {
    const freshness = describeFreshness(null, BASE, OPTIONS);
    expect(freshness).toMatchObject({ level: 'never', ageMs: null, stale: false });
    expect(freshness.label).toBe('No data yet');
  });

  it('treats an unparseable timestamp as no data rather than throwing', () => {
    expect(describeFreshness('not-a-date', BASE, OPTIONS).level).toBe('never');
  });

  it('is fresh inside the first two intervals', () => {
    const freshness = describeFreshness('2026-05-18T12:00:00.000Z', at(30_000), OPTIONS);
    expect(freshness.level).toBe('fresh');
    expect(freshness.stale).toBe(false);
    expect(freshness.label).toBe('Updated 30 seconds ago');
  });

  it('is aging once a poll has been missed', () => {
    const freshness = describeFreshness('2026-05-18T12:00:00.000Z', at(150_000), OPTIONS);
    expect(freshness.level).toBe('aging');
    expect(freshness.stale).toBe(false);
    expect(freshness.label).toContain('refresh overdue');
  });

  it('is stale after four intervals, and says so with the age', () => {
    const freshness = describeFreshness('2026-05-18T12:00:00.000Z', at(300_000), OPTIONS);
    expect(freshness.level).toBe('stale');
    expect(freshness.stale).toBe(true);
    expect(freshness.label).toBe('Data may be stale, updated 5 minutes ago');
  });

  it('spells the warning out for a screen reader instead of relying on colour', () => {
    const freshness = describeFreshness('2026-05-18T12:00:00.000Z', at(600_000), OPTIONS);
    expect(freshness.description).toContain('may be stale');
    expect(freshness.description).toContain('not shown');
  });

  it('scales its thresholds with the polling interval', () => {
    const slow = { pollIntervalMs: 600_000 };
    // Five minutes is stale at a one-minute interval and fresh at a ten-minute one.
    expect(describeFreshness('2026-05-18T12:00:00.000Z', at(300_000), OPTIONS).level).toBe('stale');
    expect(describeFreshness('2026-05-18T12:00:00.000Z', at(300_000), slow).level).toBe('fresh');
  });

  it('accepts custom thresholds', () => {
    const strict = { pollIntervalMs: 60_000, agingAfterIntervals: 1, staleAfterIntervals: 2 };
    expect(describeFreshness('2026-05-18T12:00:00.000Z', at(90_000), strict).level).toBe('aging');
    expect(describeFreshness('2026-05-18T12:00:00.000Z', at(130_000), strict).level).toBe('stale');
  });

  it('clamps a clock that runs backwards', () => {
    const freshness = describeFreshness('2026-05-18T12:00:00.000Z', at(-60_000), OPTIONS);
    expect(freshness.ageMs).toBe(0);
    expect(freshness.level).toBe('fresh');
  });

  it('survives a zero polling interval without dividing by it', () => {
    const freshness = describeFreshness('2026-05-18T12:00:00.000Z', at(5_000), {
      pollIntervalMs: 0,
    });
    expect(freshness.level).toBe('stale');
  });
});
