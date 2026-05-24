import { describe, expect, it } from 'vitest';

import { seedCertificates } from '../fixtures/seed-data';
import { FixtureCtSource, matchesIdentity } from './fixture-ct-source';

const QUERY = { identity: '%northwindbank%', watchEntryId: 'watch-northwind' };
const instant = { latencyMs: 0, now: () => Date.parse('2026-05-18T12:00:00.000Z') };

describe('matchesIdentity', () => {
  it.each([
    ['northwindbank.com', '%northwind%', true],
    ['northwindbank.com', '%bank.com', true],
    ['northwindbank.com', 'northwind%', true],
    ['northwindbank.com', 'northwindbank.com', true],
    ['northwindbank.com', '%atlaspay%', false],
    ['northwindbank.com', 'bank%', false],
    ['NorthwindBank.com', '%NORTHWIND%', true],
  ])('%s against %s is %s', (name, identity, expected) => {
    expect(matchesIdentity(name, identity)).toBe(expected);
  });

  it('treats a bare wildcard as matching everything', () => {
    expect(matchesIdentity('anything.example', '%')).toBe(true);
  });
});

describe('FixtureCtSource', () => {
  it('returns the whole simulated feed by default', async () => {
    const source = new FixtureCtSource(instant);
    const certificates = await source.fetchCertificates(QUERY);
    expect(certificates.length).toBeGreaterThan(5);
  });

  it('honours crt.sh query semantics in query mode', async () => {
    const source = new FixtureCtSource({ ...instant, mode: 'query' });
    const certificates = await source.fetchCertificates(QUERY);

    expect(certificates.length).toBeGreaterThan(0);
    for (const certificate of certificates) {
      expect(certificate.names.some((name) => name.includes('northwindbank'))).toBe(true);
    }
  });

  it('drips new certificates in as the session goes on', async () => {
    const source = new FixtureCtSource(instant);
    const first = await source.fetchCertificates(QUERY);

    source.advance();
    const second = await source.fetchCertificates(QUERY);

    expect(second.length).toBeGreaterThan(first.length);
    // Everything from the first poll is still there: the log only grows.
    for (const certificate of first) {
      expect(second.some((candidate) => candidate.id === certificate.id)).toBe(true);
    }
  });

  it('fails on demand so the retry and staleness paths can be seen offline', async () => {
    const source = new FixtureCtSource({ ...instant, failEvery: 2 });

    await expect(source.fetchCertificates(QUERY)).resolves.toBeInstanceOf(Array);
    await expect(source.fetchCertificates(QUERY)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('respects an abort signal', async () => {
    const source = new FixtureCtSource(instant);
    const controller = new AbortController();
    controller.abort();

    await expect(source.fetchCertificates(QUERY, controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
    });
  });

  it('identifies itself so the UI can label offline data', () => {
    expect(new FixtureCtSource(instant).name).toBe('Offline fixtures');
  });

  describe('fault injection', () => {
    it('fails one query in N, not the whole cycle', async () => {
      const source = new FixtureCtSource({ ...instant, failEvery: 3 });
      const results = await Promise.allSettled(
        Array.from({ length: 9 }, () => source.fetchCertificates(QUERY)),
      );

      const failed = results.filter((result) => result.status === 'rejected');
      expect(failed).toHaveLength(3);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(6);
    });

    it('counts requests without racing when a cycle runs its queries in parallel', async () => {
      // Regression: the counter used to be read *after* the simulated latency,
      // so every parallel query in a cycle saw the same value and the cycle
      // failed all-or-nothing. A partial cycle must stay partial.
      const source = new FixtureCtSource({ ...instant, latencyMs: 5, failEvery: 4 });
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () => source.fetchCertificates(QUERY)),
      );

      const failures = settled.filter((result) => result.status === 'rejected').length;
      expect(failures).toBe(2);
      expect(failures).toBeLessThan(8);
    });

    it('fails an entire cycle only when asked to', async () => {
      const source = new FixtureCtSource({ ...instant, failCycleEvery: 2 });

      source.advance();
      await expect(source.fetchCertificates(QUERY)).resolves.toBeInstanceOf(Array);

      source.advance();
      const settled = await Promise.allSettled([
        source.fetchCertificates(QUERY),
        source.fetchCertificates(QUERY),
        source.fetchCertificates(QUERY),
      ]);
      expect(settled.every((result) => result.status === 'rejected')).toBe(true);
      expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({ kind: 'timeout' });
    });

    it('injects nothing by default', async () => {
      const source = new FixtureCtSource(instant);
      for (let i = 0; i < 25; i++) {
        await expect(source.fetchCertificates(QUERY)).resolves.toBeInstanceOf(Array);
      }
    });
  });
});

describe('seed data', () => {
  const now = Date.parse('2026-05-18T12:00:00.000Z');

  it('records internationalised names in the A-label form a CT log would store', () => {
    const punycoded = seedCertificates(now).filter((certificate) =>
      certificate.names.some((name) => name.includes('xn--')),
    );
    expect(punycoded.length).toBeGreaterThan(0);
  });

  it('keeps every name lower case and non-empty', () => {
    for (const certificate of seedCertificates(now)) {
      expect(certificate.names.length).toBeGreaterThan(0);
      for (const name of certificate.names) {
        expect(name).toBe(name.toLowerCase());
        expect(name.trim()).toBe(name);
      }
    }
  });

  it('produces timestamps relative to the supplied clock', () => {
    const certificates = seedCertificates(now);
    for (const certificate of certificates) {
      expect(Date.parse(certificate.loggedAt)).toBeLessThanOrEqual(now);
      expect(Date.parse(certificate.notBefore)).toBeLessThan(Date.parse(certificate.loggedAt) + 1);
      expect(Date.parse(certificate.notAfter)).toBeGreaterThan(now);
    }
  });

  it('gives every certificate a unique id', () => {
    const ids = seedCertificates(now).map((certificate) => certificate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
