import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BACKOFF, backoffDelay, delay } from './backoff';

describe('backoffDelay', () => {
  const deterministic = { ...DEFAULT_BACKOFF, jitter: 'none' } as const;

  it('grows exponentially', () => {
    expect(backoffDelay(0, deterministic)).toBe(1_000);
    expect(backoffDelay(1, deterministic)).toBe(2_000);
    expect(backoffDelay(2, deterministic)).toBe(4_000);
    expect(backoffDelay(3, deterministic)).toBe(8_000);
  });

  it('stops growing at the cap', () => {
    expect(backoffDelay(20, deterministic)).toBe(DEFAULT_BACKOFF.maxDelayMs);
  });

  it('treats negative and fractional attempts as attempt zero', () => {
    expect(backoffDelay(-5, deterministic)).toBe(1_000);
    expect(backoffDelay(0.7, deterministic)).toBe(1_000);
  });

  describe('full jitter', () => {
    it('picks a point inside [0, computed]', () => {
      expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0)).toBe(0);
      expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0.5)).toBe(2_000);
      expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0.999)).toBeLessThanOrEqual(4_000);
    });

    it('never exceeds the un-jittered delay', () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const ceiling = backoffDelay(attempt, deterministic);
        for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
          expect(backoffDelay(attempt, DEFAULT_BACKOFF, () => r)).toBeLessThanOrEqual(ceiling);
        }
      }
    });

    it('spreads a herd of clients out instead of moving it', () => {
      // The point of full jitter: retries must not stay synchronised.
      const values = new Set<number>();
      let seed = 0;
      const random = (): number => {
        seed += 0.037;
        return seed % 1;
      };
      for (let client = 0; client < 20; client++) {
        values.add(backoffDelay(3, DEFAULT_BACKOFF, random));
      }
      expect(values.size).toBeGreaterThan(10);
    });

    it('clamps a misbehaving random source', () => {
      expect(backoffDelay(1, DEFAULT_BACKOFF, () => 5)).toBe(2_000);
      expect(backoffDelay(1, DEFAULT_BACKOFF, () => -5)).toBe(0);
    });
  });
});

describe('delay', () => {
  it('resolves after the given time', async () => {
    vi.useFakeTimers();
    try {
      const promise = delay(1_000);
      let resolved = false;
      void promise.then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(1_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects and clears its timer when aborted while waiting', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const promise = delay(10_000, controller.signal);
      const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

      controller.abort();
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
