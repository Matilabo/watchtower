import { describe, expect, it, vi } from 'vitest';

import { GraphQLRequestError, HttpGraphQLClient, InProcessGraphQLClient } from './graphql-client';
import { MockGraphQLServer } from './mock-server';
import { MemorySnapshotStorage } from './storage';

const QUERY = '{ watchlist { id } }';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('InProcessGraphQLClient', () => {
  it('returns data for a valid document', async () => {
    const client = new InProcessGraphQLClient(
      new MockGraphQLServer({ storage: new MemorySnapshotStorage(), seed: false }),
    );
    await expect(client.request(QUERY)).resolves.toEqual({ watchlist: [] });
  });

  it('turns GraphQL errors into a typed rejection with a readable message', async () => {
    const client = new InProcessGraphQLClient(
      new MockGraphQLServer({ storage: new MemorySnapshotStorage(), seed: false }),
    );

    const error = await client.request('{ nope }').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphQLRequestError);
    expect((error as GraphQLRequestError).message).toContain('nope');
    expect((error as GraphQLRequestError).errors.length).toBeGreaterThan(0);
  });
});

describe('HttpGraphQLClient', () => {
  function client(fetchImpl: typeof fetch, overrides = {}): HttpGraphQLClient {
    return new HttpGraphQLClient({
      endpoint: 'https://api.example/graphql',
      fetchImpl,
      ...overrides,
    });
  }

  it('posts the document and variables as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { watchlist: [] } }));
    await client(fetchImpl as unknown as typeof fetch).request(QUERY, { a: 1 });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example/graphql');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ query: QUERY, variables: { a: 1 } });
  });

  it('sends an empty variables object when none are given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    await client(fetchImpl as unknown as typeof fetch).request(QUERY);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).variables).toEqual({});
  });

  it('merges custom headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
    await client(fetchImpl as unknown as typeof fetch, {
      headers: { authorization: 'Bearer token' },
    }).request(QUERY);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer token');
  });

  it('reports a non-2xx response with its status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(client(fetchImpl as unknown as typeof fetch).request(QUERY)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('surfaces GraphQL errors carried in a 200 response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: 'Field does not exist' }] }));

    await expect(client(fetchImpl as unknown as typeof fetch).request(QUERY)).rejects.toThrow(
      'Field does not exist',
    );
  });

  it('rejects a response with neither data nor errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    await expect(client(fetchImpl as unknown as typeof fetch).request(QUERY)).rejects.toThrow(
      /no data/,
    );
  });

  it('reports a network failure without leaking the raw fetch error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await client(fetchImpl as unknown as typeof fetch)
      .request(QUERY)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphQLRequestError);
    expect((error as Error).message).toBe('Could not reach the API.');
    expect((error as GraphQLRequestError).cause).toBeInstanceOf(TypeError);
  });

  it('times out a hung request', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ) as unknown as typeof fetch;

      const promise = client(fetchImpl, { timeoutMs: 2_000 }).request(QUERY);
      const assertion = expect(promise).rejects.toThrow(/did not respond in time/);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its timeout after a successful request', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
      await client(fetchImpl as unknown as typeof fetch).request(QUERY);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to construct without a fetch implementation', () => {
    expect(
      () =>
        new HttpGraphQLClient({
          endpoint: 'https://api.example/graphql',
          fetchImpl: 'nope' as unknown as typeof fetch,
        }),
    ).toThrow(TypeError);
  });
});
