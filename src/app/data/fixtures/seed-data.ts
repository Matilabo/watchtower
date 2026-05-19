/**
 * Seed data so the app is useful with no network and no API keys.
 *
 * The domains are fictional on purpose: this file describes attack *shapes*,
 * not real registrations, and a fixture that names a real bank would be both
 * misleading and unkind to that bank. Every rule in the scorer has at least one
 * certificate here that triggers it, plus benign and unrelated traffic so the
 * demo shows the signal-to-noise ratio honestly rather than a wall of red.
 *
 * Timestamps are generated relative to a supplied clock so the fixture always
 * looks like it was logged recently; pass a fixed `now` for deterministic runs
 * (the Playwright suite does exactly that).
 */

import type { CertificateRecord } from '../../domain/certificate';
import type { WatchlistEntry } from '../../domain/models';
import { tryParseDomain } from '../../domain/normalize';

const CYRILLIC_A = String.fromCodePoint(0x0430);
const CYRILLIC_O = String.fromCodePoint(0x043e);

export const SEED_WATCHLIST: readonly WatchlistEntry[] = [
  {
    id: 'watch-northwind',
    domain: 'northwindbank.com',
    label: 'Retail banking portal',
    createdAt: '2026-05-01T09:00:00.000Z',
  },
  {
    id: 'watch-atlaspay',
    domain: 'atlaspay.io',
    label: 'Payments API and dashboard',
    createdAt: '2026-05-01T09:05:00.000Z',
  },
  {
    id: 'watch-vertex',
    domain: 'vertexhealth.org',
    label: 'Patient records',
    createdAt: '2026-05-02T14:20:00.000Z',
  },
];

interface SeedSpec {
  readonly id: string;
  readonly names: readonly string[];
  readonly issuer: string;
  /** Minutes before `now` that the log entry was made. */
  readonly loggedMinutesAgo: number;
  /**
   * Which poll first returns this certificate. Anything above 0 arrives while
   * the user is watching, which is what exercises the live region, the
   * de-duplication and the "do not steal focus" requirement.
   */
  readonly appearsOnPoll: number;
  /** Why this row is in the fixture, for whoever reads it next. */
  readonly demonstrates: string;
}

const LETS_ENCRYPT = 'C=US, O=Let’s Encrypt, CN=R11';
const ZEROSSL = 'C=AT, O=ZeroSSL, CN=ZeroSSL RSA Domain Secure Site CA';
const GOOGLE_TRUST = 'C=US, O=Google Trust Services, CN=WE1';

const SEEDS: readonly SeedSpec[] = [
  // --- the user's own certificates: must be recognised as benign ------------
  {
    id: '9000001',
    names: ['northwindbank.com', 'www.northwindbank.com'],
    issuer: GOOGLE_TRUST,
    loggedMinutesAgo: 260,
    appearsOnPoll: 0,
    demonstrates: 'exact match: the watched domain itself',
  },
  {
    id: '9000002',
    names: ['*.northwindbank.com', 'api.northwindbank.com'],
    issuer: GOOGLE_TRUST,
    loggedMinutesAgo: 250,
    appearsOnPoll: 0,
    demonstrates: 'wildcard SAN for a watched domain',
  },
  {
    id: '9000003',
    names: ['dashboard.atlaspay.io'],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 180,
    appearsOnPoll: 0,
    demonstrates: 'subdomain of a watched domain',
  },

  // --- unrelated traffic: the majority of any real CT feed ------------------
  {
    id: '9000010',
    names: ['blog.unrelated-startup.dev'],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 240,
    appearsOnPoll: 0,
    demonstrates: 'noise: scores zero against everything',
  },
  {
    id: '9000011',
    names: ['cdn.assets-delivery.net', 'static.assets-delivery.net'],
    issuer: ZEROSSL,
    loggedMinutesAgo: 200,
    appearsOnPoll: 0,
    demonstrates: 'noise: multi-SAN certificate, no resemblance',
  },
  {
    id: '9000012',
    names: ['login.some-other-company.com'],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 150,
    appearsOnPoll: 0,
    demonstrates: 'noise: lure keyword with no watched name (must not alert)',
  },
  {
    id: '9000013',
    names: ['secure-verify-account.zip'],
    issuer: ZEROSSL,
    loggedMinutesAgo: 95,
    appearsOnPoll: 1,
    demonstrates: 'noise: lures plus an abuse-heavy TLD, still no resemblance',
  },

  // --- the attacks ---------------------------------------------------------
  {
    id: '9000020',
    names: ['n0rthwindbank.com', 'www.n0rthwindbank.com'],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 140,
    appearsOnPoll: 0,
    demonstrates: 'ASCII homoglyph: 0 for o',
  },
  {
    id: '9000021',
    names: [`northwindb${CYRILLIC_A}nk.com`],
    issuer: ZEROSSL,
    loggedMinutesAgo: 120,
    appearsOnPoll: 0,
    demonstrates: 'IDN homograph: Cyrillic a, mixed script, punycode',
  },
  {
    id: '9000022',
    names: ['northwind-bank.com', 'login.northwind-bank.com'],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 110,
    appearsOnPoll: 0,
    demonstrates: 'hyphenation variant plus a credential lure',
  },
  {
    id: '9000023',
    names: ['northwindbank.top'],
    issuer: ZEROSSL,
    loggedMinutesAgo: 90,
    appearsOnPoll: 0,
    demonstrates: 'TLD swap onto an abuse-heavy TLD',
  },
  {
    id: '9000024',
    names: ['secure.northwindbank-verify.com'],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 75,
    appearsOnPoll: 0,
    demonstrates: 'combosquat: watched name embedded in a longer registrable name',
  },
  {
    id: '9000025',
    names: ['atlaspya.io'],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 60,
    appearsOnPoll: 0,
    demonstrates: 'transposition',
  },
  {
    id: '9000026',
    names: ['atlaspayy.io', 'www.atlaspayy.io'],
    issuer: ZEROSSL,
    loggedMinutesAgo: 45,
    appearsOnPoll: 1,
    demonstrates: 'doubled character, arrives mid-session',
  },
  {
    id: '9000027',
    names: ['vertexhealth.org.patient-portal.help'],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 30,
    appearsOnPoll: 1,
    demonstrates: 'the watched name as a subdomain of somebody else, arrives mid-session',
  },
  {
    id: '9000028',
    names: ['vertexheaith.org'],
    issuer: ZEROSSL,
    loggedMinutesAgo: 20,
    appearsOnPoll: 2,
    demonstrates: 'rn/l style ASCII confusable, arrives mid-session',
  },
  {
    id: '9000029',
    names: [`atl${CYRILLIC_A}sp${CYRILLIC_A}y.io`, `www.atl${CYRILLIC_A}sp${CYRILLIC_A}y.io`],
    issuer: LETS_ENCRYPT,
    loggedMinutesAgo: 8,
    appearsOnPoll: 2,
    demonstrates: 'critical: double Cyrillic substitution, arrives mid-session',
  },
  {
    id: '9000030',
    names: [`g${CYRILLIC_O}vertexhealth.org`],
    issuer: ZEROSSL,
    loggedMinutesAgo: 4,
    appearsOnPoll: 3,
    demonstrates: 'prefix plus confusable, arrives late in the session',
  },
];

/**
 * CT logs store A-labels, so the fixtures do too: an internationalised name is
 * written above in its readable form and recorded here as `xn--...`, exactly
 * as crt.sh would return it. Decoding it back for display is the scorer's job,
 * and this is what keeps that path exercised offline.
 */
function toLogForm(name: string): string {
  const isWildcard = name.startsWith('*.');
  const bare = isWildcard ? name.slice(2) : name;
  const ascii = tryParseDomain(bare)?.ascii ?? bare.toLowerCase();
  return isWildcard ? `*.${ascii}` : ascii;
}

function toRecord(spec: SeedSpec, now: number): CertificateRecord {
  const loggedAt = new Date(now - spec.loggedMinutesAgo * 60_000);
  const notBefore = new Date(loggedAt.getTime() - 5 * 60_000);
  const notAfter = new Date(loggedAt.getTime() + 90 * 24 * 60 * 60_000);
  const names = spec.names.map(toLogForm);

  return {
    id: spec.id,
    names,
    commonName: names[0] ?? '',
    issuer: spec.issuer,
    loggedAt: loggedAt.toISOString(),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    serialNumber: `04:${spec.id}:fixture`,
    source: 'fixture',
  };
}

/** Every seeded certificate, regardless of which poll it belongs to. */
export function seedCertificates(now: number = Date.now()): CertificateRecord[] {
  return SEEDS.map((spec) => toRecord(spec, now));
}

/**
 * The certificates a given poll should return: everything scheduled for that
 * poll or an earlier one, so a source can simulate a log that keeps growing.
 */
export function seedCertificatesForPoll(poll: number, now: number = Date.now()): CertificateRecord[] {
  return SEEDS.filter((spec) => spec.appearsOnPoll <= poll).map((spec) => toRecord(spec, now));
}

/** Documentation for the fixture, surfaced in the offline banner and the README. */
export function seedManifest(): ReadonlyArray<{ id: string; name: string; demonstrates: string }> {
  return SEEDS.map((spec) => ({
    id: spec.id,
    name: spec.names[0] ?? '',
    demonstrates: spec.demonstrates,
  }));
}
