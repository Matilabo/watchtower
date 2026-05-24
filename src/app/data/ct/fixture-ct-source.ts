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
   * Fail every Nth individual query (0 disables). One query failing while the
   * others succeed is the *partial* cycle path.
   */
  readonly failEvery?: number;
  /**
   * Fail every Nth cycle outright (0 disables): every query in it rejects.
   * This is the path that produces an error frame, the stale banner and the
   * automatic-retry copy, so the offline demo can show them.
   */
  readonly failCycleEvery?: number;
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
  private readonly failCycleEvery: number;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  /** How many times the app has polled; drives the drip-feed of new rows. */
  private pollCount = 0;
  private requestCount = 0;

  constructor(options: FixtureCtSourceOptions = {}) {
    this.mode = options.mode ?? 'firehose';
    this.latencyMs = options.latencyMs ?? 250;
    this.failEvery = options.failEvery ?? 0;
    this.failCycleEvery = options.failCycleEvery ?? 0;
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
    // Claim this request's number *before* awaiting. The poller runs a cycle's
    // queries in parallel, so reading the shared counter after the await gave
    // every query in the cycle the same value: instead of one request in N
    // failing, either all of them failed or none did, which turned a partial
    // cycle into a total outage several times a minute.
    const requestNumber = ++this.requestCount;

    if (this.latencyMs > 0) await this.sleepImpl(this.latencyMs);

    if (signal?.aborted === true) {
      throw new CtSourceError('aborted', 'Certificate fetch was cancelled');
    }

    // A whole cycle failing is worth demonstrating too -- it is what drives the
    // stale banner and the retry copy -- but it should happen because the
    // fixture was asked to do it, not as a side effect of a race.
    if (this.failCycleEvery > 0 && this.pollCount > 0 && this.pollCount % this.failCycleEvery === 0) {
      throw new CtSourceError('timeout', 'Simulated feed outage (fixture fault injection)', {
        attempts: 1,
      });
    }

    if (this.failEvery > 0 && requestNumber % this.failEvery === 0) {
      throw new CtSourceError('timeout', 'Simulated slow query (fixture fault injection)', {
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
