import { describe, expect, it } from 'vitest';

import {
  applyTriage,
  buildAlert,
  compareAlerts,
  isResolved,
  mergeAlert,
  preserveOrder,
  type Alert,
} from './alert';
import { certificateKey, normaliseNames, type CertificateRecord } from './certificate';
import type { WatchlistEntry } from './models';
import { assess } from './scorer';

const NOW = '2026-05-18T12:00:00.000Z';
const LATER = '2026-05-18T12:05:00.000Z';

const entry: WatchlistEntry = {
  id: 'watch-1',
  domain: 'northwindbank.com',
  createdAt: '2026-05-01T00:00:00.000Z',
};

function certificate(overrides: Partial<CertificateRecord> = {}): CertificateRecord {
  return {
    id: '1001',
    names: ['n0rthwindbank.com'],
    commonName: 'n0rthwindbank.com',
    issuer: 'Test CA',
    loggedAt: '2026-05-18T11:00:00.000Z',
    notBefore: '2026-05-18T10:00:00.000Z',
    notAfter: '2026-08-18T10:00:00.000Z',
    serialNumber: 'aa:bb',
    source: 'fixture',
    ...overrides,
  };
}

function alert(overrides: Partial<Alert> = {}): Alert {
  const cert = overrides.certificate ?? certificate();
  const base = buildAlert(cert, entry, assess(cert.names[0] ?? '', entry.domain), NOW);
  return { ...base, ...overrides };
}

describe('normaliseNames', () => {
  it('splits the newline-separated name_value crt.sh returns', () => {
    expect(normaliseNames('a.example\nb.example')).toEqual(['a.example', 'b.example']);
  });

  it('puts the common name first and does not repeat it', () => {
    expect(normaliseNames('b.example\na.example', 'a.example')).toEqual([
      'a.example',
      'b.example',
    ]);
  });

  it('lower-cases, trims and drops empties', () => {
    expect(normaliseNames(' A.Example \n\n  b.example  ')).toEqual(['a.example', 'b.example']);
  });

  it('deduplicates, so one certificate does not become several identical alerts', () => {
    expect(normaliseNames('a.example\na.example\nA.EXAMPLE')).toEqual(['a.example']);
  });

  it('returns nothing for an empty value', () => {
    expect(normaliseNames('')).toEqual([]);
  });
});

describe('certificateKey', () => {
  it('includes the source, so two logs reporting one certificate do not collide', () => {
    expect(certificateKey(certificate())).toBe('fixture:1001');
    expect(certificateKey(certificate({ source: 'crt.sh' }))).toBe('crt.sh:1001');
  });
});

describe('buildAlert', () => {
  it('starts in the new state with the sighting already in the history', () => {
    const created = alert();
    expect(created.triage).toBe('new');
    expect(created.history).toHaveLength(1);
    expect(created.history[0]).toMatchObject({ state: 'new', at: NOW });
    expect(created.firstSeenAt).toBe(NOW);
    expect(created.lastSeenAt).toBe(NOW);
  });

  it('denormalises the watched domain so a row renders without a lookup', () => {
    expect(alert().watchedDomain).toBe('northwindbank.com');
  });

  it('gives the same certificate and entry the same id every time', () => {
    expect(alert().id).toBe(alert().id);
  });

  it('gives different watchlist entries different alerts for one certificate', () => {
    const other: WatchlistEntry = { ...entry, id: 'watch-2', domain: 'northwind-bank.com' };
    const first = buildAlert(certificate(), entry, assess('n0rthwindbank.com', entry.domain), NOW);
    const second = buildAlert(certificate(), other, assess('n0rthwindbank.com', other.domain), NOW);
    expect(first.id).not.toBe(second.id);
  });
});

describe('applyTriage', () => {
  it('records the new state and appends to the audit trail', () => {
    const triaged = applyTriage(alert(), 'investigating', LATER, 'Checking the hosting');

    expect(triaged.triage).toBe('investigating');
    expect(triaged.history).toHaveLength(2);
    expect(triaged.history[1]).toEqual({
      state: 'investigating',
      at: LATER,
      note: 'Checking the hosting',
    });
  });

  it('never mutates the alert it was given', () => {
    const original = alert();
    applyTriage(original, 'malicious', LATER);
    expect(original.triage).toBe('new');
    expect(original.history).toHaveLength(1);
  });

  it('is a no-op when the state is unchanged and there is no note', () => {
    const investigating = applyTriage(alert(), 'investigating', LATER);
    expect(applyTriage(investigating, 'investigating', LATER)).toBe(investigating);
  });

  it('still records a note added without a state change', () => {
    const investigating = applyTriage(alert(), 'investigating', LATER);
    const noted = applyTriage(investigating, 'investigating', LATER, 'Registrar notified');
    expect(noted).not.toBe(investigating);
    expect(noted.history).toHaveLength(3);
  });

  it('allows re-opening a resolved alert', () => {
    const resolved = applyTriage(alert(), 'benign', LATER);
    const reopened = applyTriage(resolved, 'investigating', LATER, 'Second look');
    expect(reopened.triage).toBe('investigating');
    expect(reopened.history.map((event) => event.state)).toEqual([
      'new',
      'benign',
      'investigating',
    ]);
  });
});

describe('mergeAlert', () => {
  it('keeps the analyst verdict when the certificate is seen again', () => {
    const triaged = applyTriage(alert(), 'malicious', LATER, 'Confirmed phishing');
    const reobserved = { ...alert(), lastSeenAt: '2026-05-18T13:00:00.000Z' };

    const merged = mergeAlert(triaged, reobserved);
    expect(merged.triage).toBe('malicious');
    expect(merged.history).toHaveLength(2);
    expect(merged.lastSeenAt).toBe('2026-05-18T13:00:00.000Z');
    expect(merged.firstSeenAt).toBe(NOW);
  });

  it('refreshes the certificate and assessment from the new observation', () => {
    const updatedCertificate = certificate({ issuer: 'Another CA' });
    const merged = mergeAlert(alert(), { ...alert(), certificate: updatedCertificate });
    expect(merged.certificate.issuer).toBe('Another CA');
  });
});

describe('compareAlerts', () => {
  const highRisk = (score: number, id: string): Alert => ({
    ...alert({ id }),
    assessment: { ...alert().assessment, score },
  });

  it('puts unresolved alerts before resolved ones', () => {
    const open = highRisk(40, 'open');
    const closed = applyTriage(highRisk(95, 'closed'), 'benign', LATER);
    expect([closed, open].sort(compareAlerts)[0]).toBe(open);
  });

  it('orders unresolved alerts by score', () => {
    const low = highRisk(30, 'low');
    const high = highRisk(90, 'high');
    expect([low, high].sort(compareAlerts)[0]).toBe(high);
  });

  it('breaks score ties with recency and then id, so the order is stable', () => {
    const older = { ...highRisk(50, 'a'), certificate: certificate({ loggedAt: '2026-05-01T00:00:00.000Z' }) };
    const newer = { ...highRisk(50, 'b'), certificate: certificate({ loggedAt: '2026-05-18T00:00:00.000Z' }) };
    expect([older, newer].sort(compareAlerts)[0]).toBe(newer);
    expect([newer, older].sort(compareAlerts)[0]).toBe(newer);
  });
});

describe('isResolved', () => {
  it.each([
    ['new', false],
    ['investigating', false],
    ['benign', true],
    ['malicious', true],
  ] as const)('%s is resolved: %s', (state, expected) => {
    expect(isResolved(applyTriage(alert(), state, LATER))).toBe(expected);
  });
});

describe('preserveOrder', () => {
  const withId = (id: string, triage: Alert['triage'] = 'new'): Alert => ({
    ...alert({ id }),
    triage,
  });

  it('keeps the order on screen when only contents changed', () => {
    const current = [withId('a'), withId('b'), withId('c')];
    const next = [withId('c', 'benign'), withId('a'), withId('b')];

    const result = preserveOrder(current, next);
    expect(result.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    // The contents are the new ones, only the order is the old one.
    expect(result[2]?.triage).toBe('benign');
  });

  it('takes the ranked order when an alert is added', () => {
    const current = [withId('a')];
    const next = [withId('b'), withId('a')];
    expect(preserveOrder(current, next).map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('takes the ranked order when the set changes without changing size', () => {
    const current = [withId('a'), withId('b')];
    const next = [withId('a'), withId('c')];
    expect(preserveOrder(current, next).map((entry) => entry.id)).toEqual(['a', 'c']);
  });

  it('handles empty lists', () => {
    expect(preserveOrder([], [])).toEqual([]);
  });
});
