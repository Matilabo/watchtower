/**
 * A certificate as observed in a transparency log.
 *
 * This is the app's own shape, not crt.sh's: the REST client maps into it, the
 * fixtures are written in it, and everything above the data layer only ever
 * sees this. When a second CT source is added (certstream, Google's logs) it
 * maps into the same type and nothing downstream changes.
 */

export interface CertificateRecord {
  /** Stable identifier from the source log. */
  readonly id: string;
  /** Subject CN plus every SAN, deduplicated and normalised to lower case. */
  readonly names: readonly string[];
  readonly commonName: string;
  readonly issuer: string;
  /** When the CT log recorded the entry (ISO 8601). */
  readonly loggedAt: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly serialNumber: string;
  /** Which source produced this record, so the UI can label offline data. */
  readonly source: 'crt.sh' | 'fixture';
}

/**
 * crt.sh returns every name of a certificate in one newline-separated string,
 * with duplicates, stray whitespace and mixed case. A certificate for
 * `*.example.com` also lists `example.com`, so the list is worth deduplicating
 * before it is scored: otherwise one certificate produces several identical
 * alerts.
 */
export function normaliseNames(raw: string, commonName = ''): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const candidate of [commonName, ...raw.split(/[\n,]/)]) {
    const name = candidate.trim().toLowerCase();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return names;
}

/**
 * Identity of a certificate for deduplication across polls.
 *
 * The log entry id is enough for a single source; the source is included so two
 * logs reporting the same certificate do not collide into one alert with an
 * ambiguous provenance.
 */
export function certificateKey(certificate: CertificateRecord): string {
  return `${certificate.source}:${certificate.id}`;
}
