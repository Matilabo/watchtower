import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSchema, validate, parse } from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CertificateRecord } from '../../domain/certificate';
import { assess } from '../../domain/scorer';
import {
  ADD_WATCHLIST_ENTRY_MUTATION,
  ALERTS_QUERY,
  ALERT_SUMMARY_QUERY,
  RECORD_ALERTS_MUTATION,
  REMOVE_WATCHLIST_ENTRY_MUTATION,
  SET_TRIAGE_STATE_MUTATION,
  WATCHLIST_QUERY,
} from './documents';
import { GraphQLRequestError, InProcessGraphQLClient } from './graphql-client';
import { MockGraphQLServer } from './mock-server';
import { WATCHTOWER_SCHEMA_SDL } from './schema';
import { MemorySnapshotStorage } from './storage';

const NOW = Date.parse('2026-05-18T12:00:00.000Z');

function certificate(id: string, name: string): CertificateRecord {
  return {
    id,
    names: [name],
    commonName: name,
    issuer: 'Test CA',
    loggedAt: '2026-05-18T11:00:00.000Z',
    notBefore: '2026-05-18T10:00:00.000Z',
    notAfter: '2026-08-18T10:00:00.000Z',
    serialNumber: `serial-${id}`,
    source: 'fixture',
  };
}

describe('the shipped SDL', () => {
  it('matches schema.graphql, so the readable copy cannot drift', () => {
    const onDisk = readFileSync(
      join(process.cwd(), 'src/app/data/graphql/schema.graphql'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(WATCHTOWER_SCHEMA_SDL).toBe(onDisk);
  });

  it('is a valid schema', () => {
    expect(() => buildSchema(WATCHTOWER_SCHEMA_SDL)).not.toThrow();
  });

  it.each([
    ['WATCHLIST_QUERY', WATCHLIST_QUERY],
    ['ALERTS_QUERY', ALERTS_QUERY],
    ['ALERT_SUMMARY_QUERY', ALERT_SUMMARY_QUERY],
    ['ADD_WATCHLIST_ENTRY_MUTATION', ADD_WATCHLIST_ENTRY_MUTATION],
    ['REMOVE_WATCHLIST_ENTRY_MUTATION', REMOVE_WATCHLIST_ENTRY_MUTATION],
    ['RECORD_ALERTS_MUTATION', RECORD_ALERTS_MUTATION],
    ['SET_TRIAGE_STATE_MUTATION', SET_TRIAGE_STATE_MUTATION],
  ])('validates %s against the schema', (_name, document) => {
    expect(validate(buildSchema(WATCHTOWER_SCHEMA_SDL), parse(document))).toEqual([]);
  });
});

describe('MockGraphQLServer', () => {
  let server: MockGraphQLServer;
  let client: InProcessGraphQLClient;

  beforeEach(() => {
    server = new MockGraphQLServer({
      storage: new MemorySnapshotStorage(),
      seed: false,
      now: () => NOW,
    });
    client = new InProcessGraphQLClient(server);
  });

  async function addEntry(domain: string, label?: string): Promise<string> {
    const data = await client.request<{
      addWatchlistEntry: { entry: { id: string } | null; error: { message: string } | null };
    }>(ADD_WATCHLIST_ENTRY_MUTATION, { input: { domain, label: label ?? null } });

    const entry = data.addWatchlistEntry.entry;
    if (entry === null) throw new Error(data.addWatchlistEntry.error?.message);
    return entry.id;
  }

  async function recordAlert(watchEntryId: string, name: string, watched: string) {
    return client.request<{
      recordAlerts: { created: Array<{ id: string; triage: string }>; updated: unknown[] };
    }>(RECORD_ALERTS_MUTATION, {
      input: [
        {
          certificate: certificate('1001', name),
          watchEntryId,
          assessment: assess(name, watched),
          observedAt: '2026-05-18T12:00:00.000Z',
        },
      ],
    });
  }

  it('really executes GraphQL: an unknown field is rejected', async () => {
    await expect(client.request('{ watchlist { nonsense } }')).rejects.toBeInstanceOf(
      GraphQLRequestError,
    );
  });

  it('rejects a malformed document', async () => {
    await expect(client.request('{ watchlist')).rejects.toBeInstanceOf(GraphQLRequestError);
  });

  describe('watchlist', () => {
    it('adds an entry and returns its canonical form', async () => {
      const data = await client.request<{
        addWatchlistEntry: {
          entry: { domain: string; canonicalDomain: string; alertCount: number };
        };
      }>(ADD_WATCHLIST_ENTRY_MUTATION, {
        input: { domain: 'HTTPS://NorthwindBank.com/', label: 'Portal' },
      });

      expect(data.addWatchlistEntry.entry).toMatchObject({
        domain: 'HTTPS://NorthwindBank.com/',
        canonicalDomain: 'northwindbank.com',
        alertCount: 0,
      });
    });

    it('returns invalid input as data, not as a GraphQL error', async () => {
      const data = await client.request<{
        addWatchlistEntry: { entry: null; error: { message: string; field: string } };
      }>(ADD_WATCHLIST_ENTRY_MUTATION, { input: { domain: 'not a domain', label: null } });

      expect(data.addWatchlistEntry.entry).toBeNull();
      expect(data.addWatchlistEntry.error.field).toBe('domain');
    });

    it('lists the watchlist with its alert counts', async () => {
      const id = await addEntry('northwindbank.com');
      await recordAlert(id, 'n0rthwindbank.com', 'northwindbank.com');

      const data = await client.request<{ watchlist: Array<{ alertCount: number }> }>(
        WATCHLIST_QUERY,
      );
      expect(data.watchlist[0]?.alertCount).toBe(1);
    });

    it('removes an entry', async () => {
      const id = await addEntry('northwindbank.com');
      const data = await client.request<{ removeWatchlistEntry: boolean }>(
        REMOVE_WATCHLIST_ENTRY_MUTATION,
        { id },
      );
      expect(data.removeWatchlistEntry).toBe(true);
    });
  });

  describe('alerts', () => {
    it('records an alert and returns it with its full explanation', async () => {
      const id = await addEntry('northwindbank.com');
      const data = await recordAlert(id, 'n0rthwindbank.com', 'northwindbank.com');

      expect(data.recordAlerts.created).toHaveLength(1);

      const alerts = await client.request<{
        alerts: Array<{
          triage: string;
          assessment: { score: number; hits: Array<{ rule: string; contribution: number }> };
        }>;
      }>(ALERTS_QUERY, {});

      const alert = alerts.alerts[0];
      expect(alert?.triage).toBe('NEW');
      expect(alert?.assessment.hits.length).toBeGreaterThan(0);
      // The breakdown adds up to the score across the wire, too.
      const total = alert?.assessment.hits.reduce((sum, hit) => sum + hit.contribution, 0);
      expect(total).toBe(alert?.assessment.score);
    });

    it('exposes triage state as a GraphQL enum', async () => {
      const id = await addEntry('northwindbank.com');
      const { recordAlerts } = await recordAlert(id, 'n0rthwindbank.com', 'northwindbank.com');
      const alertId = recordAlerts.created[0]?.id;

      const data = await client.request<{
        setTriageState: { alert: { triage: string; history: Array<{ state: string }> } };
      }>(SET_TRIAGE_STATE_MUTATION, {
        input: { alertId, state: 'INVESTIGATING', note: 'Checking' },
      });

      expect(data.setTriageState.alert.triage).toBe('INVESTIGATING');
      expect(data.setTriageState.alert.history.map((event) => event.state)).toEqual([
        'NEW',
        'INVESTIGATING',
      ]);
    });

    it('rejects an unknown enum value at the schema level', async () => {
      await expect(
        client.request(SET_TRIAGE_STATE_MUTATION, {
          input: { alertId: 'x', state: 'NONSENSE', note: null },
        }),
      ).rejects.toBeInstanceOf(GraphQLRequestError);
    });

    it('returns a user error for triaging an alert that is gone', async () => {
      const data = await client.request<{
        setTriageState: { alert: null; error: { message: string } };
      }>(SET_TRIAGE_STATE_MUTATION, {
        input: { alertId: 'missing', state: 'BENIGN', note: null },
      });

      expect(data.setTriageState.alert).toBeNull();
      expect(data.setTriageState.error.message).toContain('no longer exists');
    });

    it('filters alerts by state', async () => {
      const id = await addEntry('northwindbank.com');
      const { recordAlerts } = await recordAlert(id, 'n0rthwindbank.com', 'northwindbank.com');
      await client.request(SET_TRIAGE_STATE_MUTATION, {
        input: { alertId: recordAlerts.created[0]?.id, state: 'BENIGN', note: null },
      });

      const benign = await client.request<{ alerts: unknown[] }>(ALERTS_QUERY, {
        state: 'BENIGN',
      });
      const outstanding = await client.request<{ alerts: unknown[] }>(ALERTS_QUERY, {
        state: 'NEW',
      });

      expect(benign.alerts).toHaveLength(1);
      expect(outstanding.alerts).toHaveLength(0);
    });

    it('summarises the queue server-side', async () => {
      const id = await addEntry('northwindbank.com');
      await recordAlert(id, 'n0rthwindbank.com', 'northwindbank.com');

      const data = await client.request<{
        alertSummary: { total: number; new: number; unresolvedHighRisk: number };
      }>(ALERT_SUMMARY_QUERY);

      expect(data.alertSummary).toMatchObject({ total: 1, new: 1 });
      expect(data.alertSummary.unresolvedHighRisk).toBeGreaterThan(0);
    });

    it('fetches a single alert by id', async () => {
      const id = await addEntry('northwindbank.com');
      const { recordAlerts } = await recordAlert(id, 'n0rthwindbank.com', 'northwindbank.com');

      const data = await client.request<{ alert: { id: string } | null }>(
        'query One($id: ID!) { alert(id: $id) { id } }',
        { id: recordAlerts.created[0]?.id },
      );
      expect(data.alert?.id).toBe(recordAlerts.created[0]?.id);
    });

    it('returns null for an unknown alert rather than erroring', async () => {
      const data = await client.request<{ alert: null }>(
        'query One($id: ID!) { alert(id: $id) { id } }',
        { id: 'missing' },
      );
      expect(data.alert).toBeNull();
    });
  });

  it('survives a round trip through the storage layer', async () => {
    const storage = new MemorySnapshotStorage();
    const first = new MockGraphQLServer({ storage, seed: false, now: () => NOW });
    const firstClient = new InProcessGraphQLClient(first);

    const created = await firstClient.request<{
      addWatchlistEntry: { entry: { id: string } };
    }>(ADD_WATCHLIST_ENTRY_MUTATION, { input: { domain: 'northwindbank.com', label: null } });

    const second = new MockGraphQLServer({ storage, now: () => NOW });
    const data = await new InProcessGraphQLClient(second).request<{
      watchlist: Array<{ id: string }>;
    }>(WATCHLIST_QUERY);

    expect(data.watchlist[0]?.id).toBe(created.addWatchlistEntry.entry.id);
  });
});
