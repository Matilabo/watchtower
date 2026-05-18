/**
 * crt.sh REST client.
 *
 * The endpoint is free, public, frequently overloaded and has no SLA, so the
 * failure handling is not an afterthought here -- it is most of the file:
 *
 *   - every attempt has its own timeout (a hung socket must not hang a poll)
 *   - failures are classified, because a 404 and a 502 deserve different
 *     treatment and the user deserves a message that says which happened
 *   - retries are capped and exponentially backed off with full jitter
 *   - a 200 carrying an HTML error page is treated as a retryable parse error,
 *     because that is a thing crt.sh actually does under load
 *
 * Everything injectable (fetch, clock, sleep, randomness) is a constructor
 * option so the tests can drive it deterministically with no network and no
 * real waiting.
 */

import type { CertificateRecord } from '../../domain/certificate';
import { normaliseNames } from '../../domain/certificate';
import { backoffDelay, DEFAULT_BACKOFF, delay, type BackoffOptions } from './backoff';
import { CtSourceError, type CtQuery, type CtSource } from './ct-source';

/** The subset of a crt.sh row we rely on. Everything is treated as optional. */
interface CrtShRow {
  id?: number | string;
  issuer_name?: string;
  common_name?: string;
  name_value?: string;
  entry_timestamp?: string;
  not_before?: string;
  not_after?: string;
  serial_number?: string;
}

export interface CrtShClientOptions {
  readonly baseUrl?: string;
  /** Per-attempt timeout. crt.sh can take many seconds when healthy. */
  readonly timeoutMs?: number;
  /** Retries *after* the first attempt. 3 means at most 4 requests. */
  readonly maxRetries?: number;
  readonly backoff?: BackoffOptions;
  /** Cap on rows accepted from one response, to bound memory and scoring cost. */
  readonly maxRows?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

const DEFAULTS = {
  baseUrl: 'https://crt.sh/',
  timeoutMs: 8_000,
  maxRetries: 3,
  maxRows: 500,
} as const;

/** crt.sh timestamps have no timezone; they are UTC. */
function toIsoTimestamp(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return '';
  const normalised = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(normalised);
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString();
}

function mapRow(row: CrtShRow): CertificateRecord | null {
  if (row.id === undefined || row.id === null) return null;

  const names = normaliseNames(row.name_value ?? '', row.common_name ?? '');
  if (names.length === 0) return null;

  return {
    id: String(row.id),
    names,
    commonName: (row.common_name ?? names[0] ?? '').toLowerCase(),
    issuer: row.issuer_name ?? 'Unknown issuer',
    loggedAt: toIsoTimestamp(row.entry_timestamp),
    notBefore: toIsoTimestamp(row.not_before),
    notAfter: toIsoTimestamp(row.not_after),
    serialNumber: row.serial_number ?? '',
    source: 'crt.sh',
  };
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export class CrtShClient implements CtSource {
  readonly name = 'crt.sh';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoff: BackoffOptions;
  private readonly maxRows: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(options: CrtShClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULTS.baseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULTS.maxRetries);
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.maxRows = options.maxRows ?? DEFAULTS.maxRows;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? delay;
    this.random = options.random ?? Math.random;

    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('CrtShClient requires a fetch implementation');
    }
  }

  buildUrl(query: CtQuery): string {
    const url = new URL(this.baseUrl);
    url.searchParams.set('q', query.identity);
    url.searchParams.set('output', 'json');
    if (query.excludeExpired === true) url.searchParams.set('exclude', 'expired');
    return url.toString();
  }

  async fetchCertificates(query: CtQuery, signal?: AbortSignal): Promise<CertificateRecord[]> {
    let attempt = 0;

    for (;;) {
      try {
        return await this.attemptFetch(query, attempt + 1, signal);
      } catch (error) {
        const failure =
          error instanceof CtSourceError
            ? error
            : new CtSourceError('network', 'Unexpected certificate source failure', {
                cause: error,
                attempts: attempt + 1,
              });

        const attempts = attempt + 1;
        const outOfRetries = attempt >= this.maxRetries;
        if (!failure.retryable || outOfRetries) {
          // Only mention giving up if we actually tried more than once;
          // "gave up after 1 attempts" reads like a bug, and is one.
          throw outOfRetries && failure.retryable && attempts > 1
            ? new CtSourceError(failure.kind, `${failure.message} (gave up after ${attempts} attempts)`, {
                ...failure.options,
                attempts,
              })
            : failure;
        }

        // Rate limiting deserves a harder back-off than a transient 502.
        const penalty = failure.kind === 'rate-limit' ? 1 : 0;
        await this.sleepImpl(backoffDelay(attempt + penalty, this.backoff, this.random), signal);
        attempt++;
      }
    }
  }

  private async attemptFetch(
    query: CtQuery,
    attempts: number,
    signal?: AbortSignal,
  ): Promise<CertificateRecord[]> {
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.buildUrl(query), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });

      if (!response.ok) {
        const kind = response.status === 429 || response.status === 503 ? 'rate-limit' : 'http';
        throw new CtSourceError(
          kind,
          kind === 'rate-limit'
            ? `crt.sh is rate limiting requests (HTTP ${response.status})`
            : `crt.sh responded with HTTP ${response.status}`,
          { status: response.status, attempts },
        );
      }

      return this.parse(await response.text(), attempts);
    } catch (error) {
      if (error instanceof CtSourceError) throw error;

      if (isAbort(error)) {
        if (timedOut) {
          throw new CtSourceError(
            'timeout',
            `crt.sh did not respond within ${Math.round(this.timeoutMs / 1000)} seconds`,
            { attempts, cause: error },
          );
        }
        throw new CtSourceError('aborted', 'Certificate fetch was cancelled', {
          attempts,
          cause: error,
        });
      }

      throw new CtSourceError('network', 'Could not reach crt.sh', { attempts, cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private parse(body: string, attempts: number): CertificateRecord[] {
    // crt.sh answers an empty result set with an empty body rather than `[]`.
    if (body.trim().length === 0) return [];

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new CtSourceError(
        'parse',
        'crt.sh returned a response that was not JSON (it serves an HTML error page under load)',
        { attempts, cause: error },
      );
    }

    if (!Array.isArray(payload)) {
      throw new CtSourceError('parse', 'crt.sh returned JSON that was not a list of certificates', {
        attempts,
      });
    }

    const records: CertificateRecord[] = [];
    for (const row of payload.slice(0, this.maxRows)) {
      const record = mapRow(row as CrtShRow);
      // A single malformed row must not fail the whole poll.
      if (record !== null) records.push(record);
    }
    return records;
  }
}

/** The shortest fragment worth querying; below this the result set is noise. */
const MIN_FRAGMENT_LENGTH = 4;

/**
 * The crt.sh queries for one watched domain.
 *
 * crt.sh matches substrings, not similarity, so a single `%northwindbank%`
 * query finds combosquats, hyphenations, doublings, TLD swaps and subdomain
 * embeddings -- but never a homoglyph, because `n0rthwindbank` contains no
 * `northwindbank` at all.
 *
 * The fix is cheap: any single-character substitution leaves one half of the
 * name intact, so querying both halves catches every one-character homoglyph
 * as well. It works on internationalised names too, because an A-label keeps
 * its untouched ASCII characters in order: a Cyrillic-a variant of
 * `northwindbank.com` is logged as `xn--northwindbnk-69j.com`, which still
 * contains `northw`.
 *
 * Three queries per watched domain is the whole budget. What this deliberately
 * does not catch is a name with substitutions in *both* halves; that needs the
 * CT firehose rather than a search endpoint, and the README says so.
 */
export function queriesForDomain(entryId: string, domainCore: string): CtQuery[] {
  const core = domainCore.toLowerCase();
  const queries: CtQuery[] = [
    { identity: `%${core}%`, watchEntryId: entryId, excludeExpired: true },
  ];

  const half = Math.ceil(core.length / 2);
  const fragments = [core.slice(0, half), core.slice(half)];
  for (const fragment of fragments) {
    if (fragment.length < MIN_FRAGMENT_LENGTH) continue;
    queries.push({ identity: `%${fragment}%`, watchEntryId: entryId, excludeExpired: true });
  }

  return queries;
}
