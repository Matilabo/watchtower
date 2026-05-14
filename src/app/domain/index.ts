/**
 * Public surface of the domain layer.
 *
 * Nothing outside `domain/` should import the individual rule modules: the
 * scorer is the contract, the rules are implementation detail that will change
 * as new abuse patterns show up.
 */

export type {
  LookalikeAssessment,
  RiskLevel,
  RuleHit,
  RuleId,
  RuleKind,
  WatchlistEntry,
} from './models';
export { RISK_THRESHOLDS, riskLevelFor } from './models';

export type { ParsedDomain } from './normalize';
export { InvalidDomainError, parseDomain, tryParseDomain } from './normalize';

export type { ScorerOptions } from './scorer';
export { assess, assessAgainstWatchlist, bestAssessment } from './scorer';

// Exported for tooling and tests; not part of the day-to-day API.
export { levenshtein, similarity } from './levenshtein';
export { isHomoglyphOf, skeleton } from './homoglyph';
export { punycodeDecode, punycodeEncode, toAsciiLabel, toUnicodeLabel } from './punycode';
