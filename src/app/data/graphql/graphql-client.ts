/**
 * The GraphQL client seam.
 *
 * Two implementations, one interface: the in-process mock the app ships with,
 * and an HTTP client for a real deployment. Nothing above this file knows
 * which one it has, so "run offline" is a composition-root decision rather
 * than a conditional threaded through the services.
 */

import type { ExecutionResult, GraphQLFormattedError } from 'graphql';

import type { MockGraphQLServer } from './mock-server';

/**
 * A failed GraphQL request.
 *
 * GraphQL can return data *and* errors in the same response, so this
 * distinguishes "the request failed" from "some fields resolved to null".
 * `message` is safe to render; the raw errors are kept for logging.
 */
export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly errors: readonly GraphQLFormattedError[] = [],
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GraphQLRequestError';
  }
}

export interface GraphQLClient {
  request<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

function unwrap<T>(result: ExecutionResult): T {
  if (result.errors !== undefined && result.errors.length > 0) {
    const formatted = result.errors.map((error) =>
      typeof (error as { toJSON?: () => GraphQLFormattedError }).toJSON === 'function'
        ? (error as unknown as { toJSON: () => GraphQLFormattedError }).toJSON()
        : (error as unknown as GraphQLFormattedError),
    );
    throw new GraphQLRequestError(
      formatted[0]?.message ?? 'The request failed.',
      formatted,
    );
  }

  if (result.data === null || result.data === undefined) {
    throw new GraphQLRequestError('The request returned no data.');
  }

  return result.data as T;
}

/** Talks to the in-process server. No network, no ports, no fixtures server. */
export class InProcessGraphQLClient implements GraphQLClient {
  constructor(private readonly server: MockGraphQLServer) {}

  async request<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
    return unwrap<T>(await this.server.execute(document, variables));
  }
}

export interface HttpGraphQLClientOptions {
  readonly endpoint: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/** For a real backend. Same failure vocabulary as the in-process client. */
export class HttpGraphQLClient implements GraphQLClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpGraphQLClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 10_000;

    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('HttpGraphQLClient requires a fetch implementation');
    }
  }

  async request<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify({ query: document, variables: variables ?? {} }),
      });

      if (!response.ok) {
        throw new GraphQLRequestError(`The API responded with HTTP ${response.status}.`);
      }

      return unwrap<T>((await response.json()) as ExecutionResult);
    } catch (error) {
      if (error instanceof GraphQLRequestError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GraphQLRequestError('The API did not respond in time.', [], error);
      }
      throw new GraphQLRequestError('Could not reach the API.', [], error);
    } finally {
      clearTimeout(timer);
    }
  }
}
