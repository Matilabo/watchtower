/**
 * Retry timing for the CT source.
 *
 * crt.sh is a free, heavily loaded public service. It times out, it 502s, and
 * it occasionally answers with an HTML error page and a 200. Retrying it on a
 * fixed schedule from many clients is how a struggling service is kept down,
 * so the delay grows exponentially and is fully jittered: every client picks a
 * uniformly random point in [0, cap), which spreads a synchronised herd out
 * instead of moving it to a later instant intact.
 */

export interface BackoffOptions {
  /** Delay for the first retry, before jitter. */
  readonly baseDelayMs: number;
  /** Ceiling for the exponential growth. */
  readonly maxDelayMs: number;
  /** Growth per attempt. */
  readonly factor: number;
  /**
   * `full` picks uniformly from [0, computed]; `none` is deterministic and
   * exists for tests and for documenting the un-jittered curve.
   */
  readonly jitter: 'full' | 'none';
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 'full',
};

/**
 * Delay before retry number `attempt` (0-based: attempt 0 is the first retry).
 *
 * @param random injected for deterministic tests; must return [0, 1).
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = options.baseDelayMs * Math.pow(options.factor, safeAttempt);
  const capped = Math.min(exponential, options.maxDelayMs);
  if (options.jitter === 'none') return Math.round(capped);
  return Math.round(capped * Math.min(Math.max(random(), 0), 1));
}

/** A sleep that can be cut short by an abort signal, injectable for tests. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): DOMException | Error {
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted', 'AbortError')
    : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}
