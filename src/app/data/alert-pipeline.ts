/**
 * From certificates to alerts.
 *
 * The join between the two halves of the app: CT gives us certificates over
 * REST, the watchlist lives behind GraphQL, and this decides which pairs are
 * worth telling a human about. It is a pure function so the decision -- which
 * is where false positives come from -- is testable without either transport.
 */

import type { CertificateRecord } from '../domain/certificate';
import type { LookalikeAssessment, ScorerOptions, WatchlistEntry } from '../domain';
import { assess } from '../domain';
import type { RecordAlertRequest } from './graphql/store';

export interface AlertPipelineOptions {
  /**
   * Minimum score worth recording. Below this the evidence is a single weak
   * signal, and an alert nobody will act on is worse than no alert: it trains
   * the analyst to skim.
   */
  readonly minScore?: number;
  readonly scorer?: ScorerOptions;
}

export interface AlertPipelineResult {
  readonly requests: readonly RecordAlertRequest[];
  /** Certificate/entry pairs recognised as the user's own. */
  readonly benign: number;
  /** How many (certificate, name, entry) combinations were scored. */
  readonly scanned: number;
}

const DEFAULT_MIN_SCORE = 20;

/**
 * Scores every name on every certificate against every watchlist entry.
 *
 * A certificate carries many SANs and only one of them is usually the
 * interesting one, so each (certificate, entry) pair keeps its best-scoring
 * name -- otherwise a certificate with fifteen SANs becomes fifteen alerts
 * that all say the same thing.
 */
export function buildAlertRequests(
  certificates: readonly CertificateRecord[],
  watchlist: readonly WatchlistEntry[],
  observedAt: string,
  options: AlertPipelineOptions = {},
): AlertPipelineResult {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const scorerOptions = options.scorer ?? {};

  const requests: RecordAlertRequest[] = [];
  let benign = 0;
  let scanned = 0;

  for (const certificate of certificates) {
    for (const entry of watchlist) {
      let best: LookalikeAssessment | null = null;
      let ownCertificate = false;

      for (const name of certificate.names) {
        scanned++;
        const assessment = assess(name, entry.domain, scorerOptions);

        // One name being the watched domain itself means this certificate is
        // the user's, whatever else is on it. Alerting on your own wildcard
        // certificate is the fastest way to get an alert feed ignored.
        if (assessment.benign) {
          ownCertificate = true;
          break;
        }

        if (best === null || assessment.score > best.score) best = assessment;
      }

      if (ownCertificate) {
        benign++;
        continue;
      }

      if (best === null || best.score < minScore) continue;

      requests.push({
        certificate,
        watchEntryId: entry.id,
        assessment: best,
        observedAt,
      });
    }
  }

  return { requests, benign, scanned };
}
