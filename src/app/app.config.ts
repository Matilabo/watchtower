/**
 * Composition root.
 *
 * The only place that knows whether the app is talking to crt.sh or to
 * fixtures, and to a real API or to the in-process GraphQL server. Everything
 * else depends on the interfaces, which is what keeps "runs offline" from
 * turning into a mock-mode branch threaded through the services.
 */

import {
  InjectionToken,
  provideZonelessChangeDetection,
  type ApplicationConfig,
} from '@angular/core';

import { CrtShClient } from './data/ct/crtsh-client';
import { FixtureCtSource } from './data/ct/fixture-ct-source';
import type { CtSource } from './data/ct/ct-source';
import {
  InProcessGraphQLClient,
  type GraphQLClient,
} from './data/graphql/graphql-client';
import { MockGraphQLServer } from './data/graphql/mock-server';
import { createDefaultStorage } from './data/graphql/storage';

export interface WatchtowerConfig {
  /** How often to poll the certificate source. */
  readonly pollIntervalMs: number;
  /** Minimum score worth recording as an alert. */
  readonly minScore: number;
  /** Talk to the real crt.sh endpoint instead of the bundled fixtures. */
  readonly liveSource: boolean;
}

export const WATCHTOWER_CONFIG = new InjectionToken<WatchtowerConfig>('WATCHTOWER_CONFIG');
export const CT_SOURCE = new InjectionToken<CtSource>('CT_SOURCE');
export const GRAPHQL_CLIENT = new InjectionToken<GraphQLClient>('GRAPHQL_CLIENT');

/**
 * Offline by default. `?live=1` switches to the real crt.sh endpoint for a
 * demo -- an explicit, user-initiated choice, so the app never reaches out to
 * a third-party service just because someone opened it.
 */
function readConfig(): WatchtowerConfig {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(globalThis.location?.search ?? '');
  } catch {
    params = new URLSearchParams();
  }

  const liveSource = params.get('live') === '1';

  // `?poll=` shortens the cycle for demos and for the end-to-end suite, which
  // would otherwise spend most of its time waiting. Floored at one second so
  // it cannot be turned into a way to hammer crt.sh.
  const requested = Number.parseInt(params.get('poll') ?? '', 10);
  const override = Number.isFinite(requested) ? Math.max(requested, 1_000) : null;

  return {
    pollIntervalMs: override ?? (liveSource ? 120_000 : 15_000),
    minScore: 20,
    liveSource,
  };
}

export function createCtSource(config: WatchtowerConfig): CtSource {
  if (config.liveSource) {
    return new CrtShClient({ timeoutMs: 8_000, maxRetries: 3 });
  }

  // A little latency and an occasional failure, so loading states, the retry
  // path and the stale banner are all visible while developing.
  return new FixtureCtSource({ latencyMs: 320, failEvery: 11 });
}

export function createGraphQLClient(): GraphQLClient {
  return new InProcessGraphQLClient(
    new MockGraphQLServer({ storage: createDefaultStorage(), latencyMs: 60 }),
  );
}

export const appConfig: ApplicationConfig = {
  providers: [
    // No zone.js: state is signals, and the RxJS polling stream writes into
    // signals, so there is nothing left for zone patching to do.
    provideZonelessChangeDetection(),
    { provide: WATCHTOWER_CONFIG, useFactory: readConfig },
    { provide: CT_SOURCE, useFactory: createCtSource, deps: [WATCHTOWER_CONFIG] },
    { provide: GRAPHQL_CLIENT, useFactory: createGraphQLClient },
  ],
};
