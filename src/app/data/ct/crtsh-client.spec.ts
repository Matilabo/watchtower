import { describe, expect, it, vi } from 'vitest';

import { CrtShClient, queriesForDomain } from './crtsh-client';
import { CtSourceError, type CtQuery } from './ct-source';

const QUERY: CtQuery = { identity: '%northwindbank%', watchEntryId: 'watch-1' };

const ROW = {
  id: 12345678,
  issuer_name: 'C=US, O=Let’s Encrypt, CN=R11',
  common_name: 'N0rthwindbank.com',
  name_value: 'n0rthwindbank.com\nwww.n0rthwindbank.com\nn0rthwindbank.com',
  entry_timestamp: '2026-05-18T09:12:31.418',
  not_before: '2026-05-18T08:12:30',
  not_after: '2026-08-16T08:12:29',
  serial_number: '04aabbcc',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A client whose sleeps are instant, so retry paths are testable in real time. */
function makeClient(fetchImpl: typeof fetch, overrides = {}): CrtShClient {
  return new CrtShClient({
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
    random: () => 0.5,
    ...overrides,
  });
}

describe('CrtShClient', () => {
  describe('request construction', () => {
    it('asks for JSON and passes the identity through', () => {
      const client = makeClient(vi.fn());
      const url = new URL(client.buildUrl(QUERY));
      expect(url.origin + url.pathname).toBe('https://crt.sh/');
      expect(url.searchParams.get('q')).toBe('%northwindbank%');
      expect(url.searchParams.get('output')).toBe('json');
      expect(url.searchParams.get('exclude')).toBeNull();
    });

    it('excludes expired certificates when asked', () => {
      const client = makeClient(vi.fn());
      const url = new URL(client.buildUrl({ ...QUERY, excludeExpired: true }));
      expect(url.searchParams.get('exclude')).toBe('expired');
    });

    it('honours a custom base URL', () => {
      const client = makeClient(vi.fn(), { baseUrl: 'http://localhost:8080/search' });
      expect(client.buildUrl(QUERY).startsWith('http://localhost:8080/search?')).toBe(true);
    });
  });

  describe('mapping', () => {
    it('maps a row into the app own certificate shape', async () => {
      const client = makeClient(vi.fn().mockResolvedValue(jsonResponse([ROW])));
      const [certificate] = await client.fetchCertificates(QUERY);

      expect(certificate).toMatchObject({
        id: '12345678',
        commonName: 'n0rthwindbank.com',
        serialNumber: '04aabbcc',
        source: 'crt.sh',
      });
      // Deduplicated and lower-cased; the CN is not repeated as a SAN.
      expect(certificate?.names).toEqual(['n0rthwindbank.com', 'www.n0rthwindbank.com']);
    });

    it('reads crt.sh timestamps as UTC', async () => {
      const client = makeClient(vi.fn().mockResolvedValue(jsonResponse([ROW])));
      const [certificate] = await client.fetchCertificates(QUERY);
      expect(certificate?.loggedAt).toBe('2026-05-18T09:12:31.418Z');
    });

    it('skips malformed rows instead of failing the whole poll', async () => {
      const client = makeClient(
        vi.fn().mockResolvedValue(
          jsonResponse([{ ...ROW }, { name_value: 'no-id.example' }, { id: 9, name_value: '' }]),
        ),
      );
      const certificates = await client.fetchCertificates(QUERY);
      expect(certificates).toHaveLength(1);
    });

    it('tolerates missing optional fields', async () => {
      const client = makeClient(
        vi.fn().mockResolvedValue(jsonResponse([{ id: 1, name_value: 'bare.example' }])),
      );
      const [certificate] = await client.fetchCertificates(QUERY);
      expect(certificate).toMatchObject({
        issuer: 'Unknown issuer',
        loggedAt: '',
        serialNumber: '',
        commonName: 'bare.example',
      });
    });

    it('caps the number of rows it accepts', async () => {
      const rows = Array.from({ length: 50 }, (_unused, index) => ({
        ...ROW,
        id: index,
      }));
      const client = makeClient(vi.fn().mockResolvedValue(jsonResponse(rows)), { maxRows: 10 });
      expect(await client.fetchCertificates(QUERY)).toHaveLength(10);
    });

    it('treats an empty body as an empty result set, which crt.sh does return', async () => {
      const client = makeClient(vi.fn().mockResolvedValue(new Response('', { status: 200 })));
      expect(await client.fetchCertificates(QUERY)).toEqual([]);
    });
  });

  describe('failure handling', () => {
    it('classifies a 404 as a non-retryable http error', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
      const client = makeClient(fetchImpl);

      await expect(client.fetchCertificates(QUERY)).rejects.toMatchObject({
        kind: 'http',
        options: { status: 404 },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retries a 502 and succeeds', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
        .mockResolvedValueOnce(jsonResponse([ROW]));
      const client = makeClient(fetchImpl);

      expect(await client.fetchCertificates(QUERY)).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('classifies a 429 as rate limiting', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }));
      const client = makeClient(fetchImpl, { maxRetries: 0 });

      await expect(client.fetchCertificates(QUERY)).rejects.toMatchObject({ kind: 'rate-limit' });
    });

    it('backs off harder for rate limiting than for a transient error', async () => {
      const sleeps: number[] = [];
      const sleepImpl = (ms: number): Promise<void> => {
        sleeps.push(ms);
        return Promise.resolve();
      };

      const rateLimited = new CrtShClient({
        fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 429 })),
        sleepImpl,
        random: () => 1,
        maxRetries: 1,
      });
      await expect(rateLimited.fetchCertificates(QUERY)).rejects.toThrow();
      const rateLimitDelay = sleeps[0];

      sleeps.length = 0;
      const transient = new CrtShClient({
        fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 502 })),
        sleepImpl,
        random: () => 1,
        maxRetries: 1,
      });
      await expect(transient.fetchCertificates(QUERY)).rejects.toThrow();

      expect(rateLimitDelay).toBeGreaterThan(sleeps[0] as number);
    });

    it('treats an HTML error page served with a 200 as a retryable parse failure', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 200 }))
        .mockResolvedValueOnce(jsonResponse([ROW]));
      const client = makeClient(fetchImpl);

      expect(await client.fetchCertificates(QUERY)).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects JSON that is not a list', async () => {
      const client = makeClient(vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' })), {
        maxRetries: 0,
      });
      await expect(client.fetchCertificates(QUERY)).rejects.toMatchObject({ kind: 'parse' });
    });

    it('gives up after the retry cap and says how many attempts it made', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
      const client = makeClient(fetchImpl, { maxRetries: 2 });

      await expect(client.fetchCertificates(QUERY)).rejects.toMatchObject({
        message: expect.stringContaining('gave up after 3 attempts'),
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('reports a network failure as a network error, not a raw TypeError', async () => {
      const client = makeClient(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), {
        maxRetries: 0,
      });

      const error = await client.fetchCertificates(QUERY).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CtSourceError);
      expect((error as CtSourceError).kind).toBe('network');
      expect((error as CtSourceError).message).toBe('Could not reach crt.sh');
    });

    it('times out a hung request and calls it a timeout', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              });
            }),
        ) as unknown as typeof fetch;

        const client = new CrtShClient({
          fetchImpl,
          sleepImpl: () => Promise.resolve(),
          timeoutMs: 5_000,
          maxRetries: 0,
        });

        const promise = client.fetchCertificates(QUERY);
        const assertion = expect(promise).rejects.toMatchObject({
          kind: 'timeout',
          message: expect.stringContaining('5 seconds'),
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports caller cancellation as aborted, not as a timeout', async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      ) as unknown as typeof fetch;

      const client = makeClient(fetchImpl);
      const promise = client.fetchCertificates(QUERY, controller.signal);
      controller.abort();

      await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    });

    it('does not retry after the caller cancels', async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      ) as unknown as typeof fetch;

      const client = makeClient(fetchImpl);
      const promise = client.fetchCertificates(QUERY, controller.signal);
      controller.abort();
      await promise.catch(() => undefined);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('refuses to construct without a fetch implementation', () => {
      expect(() => new CrtShClient({ fetchImpl: 'not-a-function' as unknown as typeof fetch })).toThrow(
        TypeError,
      );
    });
  });

  describe('CtSourceError.retryable', () => {
    it.each([
      ['timeout', true],
      ['network', true],
      ['rate-limit', true],
      ['parse', true],
      ['aborted', false],
    ] as const)('%s is retryable: %s', (kind, expected) => {
      expect(new CtSourceError(kind, 'x').retryable).toBe(expected);
    });

    it('retries 5xx but not 4xx', () => {
      expect(new CtSourceError('http', 'x', { status: 503 }).retryable).toBe(true);
      expect(new CtSourceError('http', 'x', { status: 400 }).retryable).toBe(false);
    });
  });
});

describe('queriesForDomain', () => {
  it('queries the whole name plus both halves', () => {
    const queries = queriesForDomain('watch-1', 'northwindbank');
    expect(queries.map((query) => query.identity)).toEqual([
      '%northwindbank%',
      '%northwi%',
      '%ndbank%',
    ]);
  });

  it('catches a homoglyph that the whole-name query cannot', () => {
    const [, firstHalf] = queriesForDomain('watch-1', 'northwindbank');
    // The A-label of a Cyrillic-a variant keeps its untouched ASCII in order.
    const logged = 'xn--northwindbnk-69j.com';
    expect(logged.includes('northwindbank')).toBe(false);
    expect(logged.includes((firstHalf as { identity: string }).identity.replace(/%/g, ''))).toBe(
      true,
    );
  });

  it('drops fragments too short to be worth querying', () => {
    expect(queriesForDomain('watch-1', 'acme').map((query) => query.identity)).toEqual(['%acme%']);
  });

  it('tags every query with the entry it came from', () => {
    for (const query of queriesForDomain('watch-42', 'northwindbank')) {
      expect(query.watchEntryId).toBe('watch-42');
      expect(query.excludeExpired).toBe(true);
    }
  });
});
