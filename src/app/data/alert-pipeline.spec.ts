import { describe, expect, it } from 'vitest';

import type { CertificateRecord } from '../domain/certificate';
import type { WatchlistEntry } from '../domain/models';
import { buildAlertRequests } from './alert-pipeline';

const OBSERVED_AT = '2026-05-18T12:00:00.000Z';

const watchlist: WatchlistEntry[] = [
  { id: 'watch-1', domain: 'northwindbank.com', createdAt: OBSERVED_AT },
  { id: 'watch-2', domain: 'atlaspay.io', createdAt: OBSERVED_AT },
];

function certificate(id: string, names: string[]): CertificateRecord {
  return {
    id,
    names,
    commonName: names[0] ?? '',
    issuer: 'Test CA',
    loggedAt: '2026-05-18T11:00:00.000Z',
    notBefore: '2026-05-18T10:00:00.000Z',
    notAfter: '2026-08-18T10:00:00.000Z',
    serialNumber: `serial-${id}`,
    source: 'fixture',
  };
}

describe('buildAlertRequests', () => {
  it('produces a request for a name that resembles a watched domain', () => {
    const result = buildAlertRequests(
      [certificate('1', ['n0rthwindbank.com'])],
      watchlist,
      OBSERVED_AT,
    );

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ watchEntryId: 'watch-1', observedAt: OBSERVED_AT });
    expect(result.requests[0]?.assessment.hits.length).toBeGreaterThan(0);
  });

  it('ignores certificates that resemble nothing on the watchlist', () => {
    const result = buildAlertRequests(
      [certificate('1', ['blog.unrelated-startup.dev'])],
      watchlist,
      OBSERVED_AT,
    );
    expect(result.requests).toEqual([]);
  });

  it('does not alert on the user own certificate', () => {
    const result = buildAlertRequests(
      [certificate('1', ['northwindbank.com', 'www.northwindbank.com'])],
      watchlist,
      OBSERVED_AT,
    );

    expect(result.requests).toEqual([]);
    expect(result.benign).toBe(1);
  });

  it('does not alert on a wildcard certificate for a watched domain', () => {
    const result = buildAlertRequests(
      [certificate('1', ['*.northwindbank.com', 'northwindbank.com'])],
      watchlist,
      OBSERVED_AT,
    );
    expect(result.requests).toEqual([]);
  });

  it('treats a certificate as the user own even when a suspicious SAN is listed first', () => {
    // A real certificate of yours that also covers a legacy look-alike domain
    // you own should not become an alert about yourself.
    const result = buildAlertRequests(
      [certificate('1', ['n0rthwindbank.com', 'northwindbank.com'])],
      watchlist,
      OBSERVED_AT,
    );
    expect(result.requests).toEqual([]);
    expect(result.benign).toBe(1);
  });

  it('keeps only the strongest name per certificate and watch entry', () => {
    const result = buildAlertRequests(
      [certificate('1', ['unrelated.example', 'n0rthwindbank.com', 'northwindbank.top'])],
      watchlist,
      OBSERVED_AT,
    );

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.assessment.candidate).toBe('n0rthwindbank.com');
  });

  it('produces one request per watched domain a certificate resembles', () => {
    const result = buildAlertRequests(
      [certificate('1', ['n0rthwindbank.com', 'atlaspya.io'])],
      watchlist,
      OBSERVED_AT,
    );

    expect(result.requests.map((request) => request.watchEntryId).sort()).toEqual([
      'watch-1',
      'watch-2',
    ]);
  });

  it('honours the minimum score', () => {
    const certificates = [certificate('1', ['northwindbank.info'])];

    const permissive = buildAlertRequests(certificates, watchlist, OBSERVED_AT, { minScore: 1 });
    const strict = buildAlertRequests(certificates, watchlist, OBSERVED_AT, { minScore: 99 });

    expect(permissive.requests).toHaveLength(1);
    expect(strict.requests).toEqual([]);
  });

  it('passes scorer options through', () => {
    const certificates = [certificate('1', ['acne.com'])];
    const shortWatch: WatchlistEntry[] = [
      { id: 'watch-3', domain: 'acme.com', createdAt: OBSERVED_AT },
    ];

    expect(buildAlertRequests(certificates, shortWatch, OBSERVED_AT).requests).toHaveLength(1);
    expect(
      buildAlertRequests(certificates, shortWatch, OBSERVED_AT, { scorer: { minCoreLength: 8 } })
        .requests,
    ).toEqual([]);
  });

  it('reports how much work it did, for the status line', () => {
    const result = buildAlertRequests(
      [certificate('1', ['a.example', 'b.example'])],
      watchlist,
      OBSERVED_AT,
    );
    expect(result.scanned).toBe(4);
  });

  it('handles empty inputs', () => {
    expect(buildAlertRequests([], watchlist, OBSERVED_AT).requests).toEqual([]);
    expect(buildAlertRequests([certificate('1', ['x.example'])], [], OBSERVED_AT).requests).toEqual(
      [],
    );
  });

  it('does not throw on malformed names in the log', () => {
    expect(() =>
      buildAlertRequests([certificate('1', ['', '...', 'not a domain'])], watchlist, OBSERVED_AT),
    ).not.toThrow();
  });
});
