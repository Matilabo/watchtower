/**
 * The contract every certificate source implements.
 *
 * Keeping this separate from the crt.sh client is what lets the app run with
 * no network at all: the fixture-backed source below the same interface is not
 * a test double bolted on, it is a first-class source the app ships with.
 */

import type { CertificateRecord } from '../../domain/certificate';

export interface CtQuery {
  /**
   * The crt.sh `identity` term. `%` is the wildcard, so `%paypal%` matches any
   * name containing `paypal`.
   */
  readonly identity: string;
  /** Which watchlist entry this query was derived from, for attribution. */
  readonly watchEntryId: string;
  /** Skip certificates that have already expired. */
  readonly excludeExpired?: boolean;
}

export type CtErrorKind =
  /** The request exceeded the per-attempt timeout. */
  | 'timeout'
  /** DNS failure, connection reset, offline. */
  | 'network'
  /** A non-2xx response. */
  | 'http'
  /** 429, or a 503 with a Retry-After: worth backing off harder. */
  | 'rate-limit'
  /** 200 with something that is not the JSON we expect (crt.sh does this). */
  | 'parse'
  /** The caller cancelled. Not an error condition to report to the user. */
  | 'aborted';

/**
 * A failure the UI can render honestly. The message is user-facing: "crt.sh
 * did not respond within 8 seconds" beats "TypeError: Failed to fetch".
 */
export class CtSourceError extends Error {
  constructor(
    readonly kind: CtErrorKind,
    message: string,
    readonly options: {
      readonly status?: number;
      readonly attempts?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'CtSourceError';
  }

  /** Whether another attempt could plausibly succeed. */
  get retryable(): boolean {
    switch (this.kind) {
      case 'timeout':
      case 'network':
      case 'rate-limit':
      case 'parse':
        return true;
      case 'http':
        // 5xx is worth retrying; a 4xx means the query itself is wrong.
        return (this.options.status ?? 0) >= 500;
      case 'aborted':
        return false;
    }
  }

  get attempts(): number {
    return this.options.attempts ?? 1;
  }
}

export interface CtSource {
  /** Human name for the UI, e.g. `crt.sh` or `Offline fixtures`. */
  readonly name: string;
  /**
   * Fetches every certificate matching the query.
   * Rejects with a {@link CtSourceError}; never with a raw fetch error.
   */
  fetchCertificates(query: CtQuery, signal?: AbortSignal): Promise<CertificateRecord[]>;
}
