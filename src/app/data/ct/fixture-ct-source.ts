/**
 * A CT source backed by the seed fixtures.
 *
 * This is what makes `npm start` work on a plane. It implements the same
 * interface as the crt.sh client, matches the same `%wildcard%` query syntax,
 * and can be told to fail on demand -- because the stale-data banner and the
 * retry path are features, and a feature you cannot see offline is a feature
 * nobody reviews.
 */

import type { CertificateRecord } from '../../domain/certificate';
import { seedCertificatesForPoll } from '../fixtures/seed-data';
import { CtSourceError, type CtQuery, type CtSource } from './ct-source';

export interface FixtureCtSourceOptions {
  /**
   * `firehose` returns every seeded certificate and lets the scorer decide,
   * which is how a certstream-style feed behaves. `query` honours the crt.sh
   * `%term%` semantics instead.
   *
   * The default is `firehose` because the offline demo should show what the
   * scorer can do, including the multi-substitution homographs that a
   * substring search endpoint structurally cannot find. The UI labels the
   * active source so this never reads as a capability crt.sh also has.
   */
  readonly mode?: 'firehose' | 'query';
  /** Simulated round-trip time, so loading states are visible. */
  readonly latencyMs?: number;
  /**
   * Fail every Nth request (0 disables). The default exercises the retry and
   * staleness paths without making the demo unusable.
   */
  readonly failEvery?: number;
  /** Fixed clock for deterministic runs (Playwright passes one). */
  readonly now?: () => number;
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

/** Turns a crt.sh style `%term%` identity into a matcher. */
export function matchesIdentity(name: string, identity: string): boolean {
  const term = identity.toLowerCase();
  const bare = term.replace(/%/g, '');
  if (bare.length === 0) return true;

  const startsWildcard = term.startsWith('%');
  const endsWildcard = term.endsWith('%');
  const target = name.toLowerCase();

  if (startsWildcard && endsWildcard) return target.includes(bare);
  if (endsWildcard) return target.startsWith(bare);
  if (startsWildcard) return target.endsWith(bare);
  return target === bare;
}

export class FixtureCtSource implements CtSource {
  readonly name = 'Offline fixtures';

  private readonly mode: 'firehose' | 'query';
  private readonly latencyMs: number;
  private readonly failEvery: number;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  /** How many times the app has polled; drives the drip-feed of new rows. */
  private pollCount = 0;
  private requestCount = 0;

  constructor(options: FixtureCtSourceOptions = {}) {
    this.mode = options.mode ?? 'firehose';
    this.latencyMs = options.latencyMs ?? 250;
    this.failEvery = options.failEvery ?? 0;
    this.now = options.now ?? Date.now;
    this.sleepImpl =
      options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Advances the simulated log. The poller calls this once per cycle rather
   * than once per query, so all queries in a cycle see the same snapshot.
   */
  advance(): void {
    this.pollCount++;
  }

  async fetchCertificates(query: CtQuery, signal?: AbortSignal): Promise<CertificateRecord[]> {
    this.requestCount++;

    if (this.latencyMs > 0) await this.sleepImpl(this.latencyMs);

    if (signal?.aborted === true) {
      throw new CtSourceError('aborted', 'Certificate fetch was cancelled');
    }

    if (this.failEvery > 0 && this.requestCount % this.failEvery === 0) {
      throw new CtSourceError('timeout', 'Simulated offline-source timeout', {
        attempts: 1,
      });
    }

    const all = seedCertificatesForPoll(this.pollCount, this.now());
    if (this.mode === 'firehose') return all;

    return all.filter((certificate) =>
      certificate.names.some((name) => matchesIdentity(name, query.identity)),
    );
  }
}
