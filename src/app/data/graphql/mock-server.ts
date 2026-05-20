/**
 * An in-process GraphQL server.
 *
 * This is a real GraphQL execution -- the shipped SDL is parsed, queries are
 * validated against it, unknown fields are rejected -- it just happens to run
 * in the same process instead of over the network. That matters: it means the
 * app can be developed and demonstrated offline without the client code
 * growing a "mock mode" branch, and it means a typo in a query fails here
 * exactly as it would against a server.
 *
 * Swapping in a real backend is a one-line change at the composition root:
 * both clients implement the same interface.
 */

import { type ExecutionResult, buildSchema, graphql } from 'graphql';

import type { Alert, TriageEvent, TriageState } from '../../domain/alert';
import { TRIAGE_STATES } from '../../domain/alert';
import type { CertificateRecord } from '../../domain/certificate';
import type { LookalikeAssessment } from '../../domain/models';
import { tryParseDomain } from '../../domain/normalize';
import { WATCHTOWER_SCHEMA_SDL } from './schema';
import {
  WatchtowerStore,
  type RecordAlertRequest,
  type UserError,
  type WatchtowerStoreOptions,
} from './store';

const schema = buildSchema(WATCHTOWER_SCHEMA_SDL);

/** `new` <-> `NEW`. The enum names are the upper-cased domain values. */
function toGqlTriage(state: TriageState): string {
  return state.toUpperCase();
}

function fromGqlTriage(value: unknown): TriageState | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase() as TriageState;
  return TRIAGE_STATES.includes(lowered) ? lowered : null;
}

function toGqlEvent(event: TriageEvent): Record<string, unknown> {
  return { state: toGqlTriage(event.state), at: event.at, note: event.note };
}

function toGqlAlert(alert: Alert): Record<string, unknown> {
  return {
    ...alert,
    triage: toGqlTriage(alert.triage),
    history: alert.history.map(toGqlEvent),
    assessment: { ...alert.assessment, hits: [...alert.assessment.hits] },
    certificate: { ...alert.certificate, names: [...alert.certificate.names] },
  };
}

export interface MockGraphQLServerOptions extends WatchtowerStoreOptions {
  /**
   * Simulated round-trip latency. Defaults to 0 so tests stay fast; the app
   * sets a small value so loading states are exercised during development.
   */
  readonly latencyMs?: number;
}

export class MockGraphQLServer {
  readonly store: WatchtowerStore;
  private readonly latencyMs: number;
  private readonly root: Record<string, unknown>;

  constructor(options: MockGraphQLServerOptions = {}) {
    this.store = new WatchtowerStore(options);
    this.latencyMs = options.latencyMs ?? 0;
    this.root = this.buildRoot();
  }

  async execute(
    source: string,
    variableValues?: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    if (this.latencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
    }

    return graphql({
      schema,
      source,
      rootValue: this.root,
      ...(variableValues === undefined ? {} : { variableValues }),
    });
  }

  private buildRoot(): Record<string, unknown> {
    const store = this.store;

    const watchlistEntry = (entry: { id: string; domain: string }): Record<string, unknown> => ({
      ...entry,
      canonicalDomain: tryParseDomain(entry.domain)?.ascii ?? entry.domain,
      alertCount: store.alertCountFor(entry.id),
    });

    const userError = (error: UserError): Record<string, unknown> => ({
      message: error.message,
      field: error.field,
    });

    return {
      watchlist: () => store.getWatchlist().map(watchlistEntry),

      alerts: (args: { state?: unknown; minScore?: number; watchEntryId?: string }) => {
        const state = args.state === undefined ? undefined : fromGqlTriage(args.state);
        return store
          .getAlerts({
            ...(state === null || state === undefined ? {} : { state }),
            ...(args.minScore === undefined ? {} : { minScore: args.minScore }),
            ...(args.watchEntryId === undefined ? {} : { watchEntryId: args.watchEntryId }),
          })
          .map(toGqlAlert);
      },

      alert: (args: { id: string }) => {
        const found = store.getAlert(args.id);
        return found === null ? null : toGqlAlert(found);
      },

      alertSummary: () => store.summary(),

      addWatchlistEntry: (args: { input: { domain: string; label?: string | null } }) => {
        const result = store.addWatchlistEntry(
          args.input.domain,
          args.input.label ?? undefined,
        );
        return result.ok
          ? { entry: watchlistEntry(result.value), error: null }
          : { entry: null, error: userError(result.error) };
      },

      removeWatchlistEntry: (args: { id: string }) => store.removeWatchlistEntry(args.id),

      recordAlerts: (args: { input: readonly RawRecordAlertInput[] }) => {
        const requests: RecordAlertRequest[] = args.input.map((item) => ({
          certificate: item.certificate as CertificateRecord,
          watchEntryId: item.watchEntryId,
          assessment: item.assessment as LookalikeAssessment,
          observedAt: item.observedAt,
        }));

        const { created, updated } = store.recordAlerts(requests);
        return {
          created: created.map(toGqlAlert),
          updated: updated.map(toGqlAlert),
          error: null,
        };
      },

      setTriageState: (args: {
        input: { alertId: string; state: unknown; note?: string | null };
      }) => {
        const state = fromGqlTriage(args.input.state);
        if (state === null) {
          return {
            alert: null,
            error: userError({ message: 'Unknown triage state.', field: 'state' }),
          };
        }

        const result = store.setTriageState(
          args.input.alertId,
          state,
          args.input.note ?? undefined,
        );
        return result.ok
          ? { alert: toGqlAlert(result.value), error: null }
          : { alert: null, error: userError(result.error) };
      },
    };
  }
}

interface RawRecordAlertInput {
  readonly certificate: unknown;
  readonly watchEntryId: string;
  readonly assessment: unknown;
  readonly observedAt: string;
}
