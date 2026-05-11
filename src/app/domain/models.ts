/**
 * Domain model for the lookalike scorer.
 *
 * This file (and every other file under `domain/`) is deliberately free of
 * Angular, RxJS and DOM imports: the scoring logic is the part of this app
 * that is worth testing exhaustively, so it must be runnable in a bare Node
 * process with no framework harness.
 */

/** Coarse bucket derived from the numeric score. Never rendered as colour alone. */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Identifier of a single scoring rule. Kept as a string union rather than an
 * enum so hits survive JSON round-trips (GraphQL, localStorage) unchanged.
 */
export type RuleId =
  // --- benign / suppressing -------------------------------------------------
  | 'exact-match'
  | 'registrable-identical'
  // --- structural similarity ("base" rules) ---------------------------------
  | 'homoglyph-unicode'
  | 'homoglyph-ascii'
  | 'transposition'
  | 'insertion'
  | 'omission'
  | 'doubling'
  | 'hyphenation'
  | 'tld-swap'
  | 'combosquat'
  | 'levenshtein-near'
  // --- modifiers (only counted when a base rule already fired) --------------
  | 'idn-punycode'
  | 'mixed-script'
  | 'lure-keyword'
  | 'suspicious-tld';

/**
 * Whether a rule can create suspicion on its own (`base`), only amplify
 * existing suspicion (`modifier`), or cancel it entirely (`suppressor`).
 *
 * The split exists because signals like "uses a .zip TLD" or "contains the
 * word 'login'" describe millions of perfectly innocent certificates. They are
 * only interesting once the name already resembles something on the watchlist.
 */
export type RuleKind = 'base' | 'modifier' | 'suppressor';

/** One fired rule, with the evidence that made it fire. */
export interface RuleHit {
  readonly rule: RuleId;
  readonly kind: RuleKind;
  /** Short human-readable name, safe to render directly. */
  readonly title: string;
  /** The specific evidence: which characters, which label, which distance. */
  readonly detail: string;
  /** Standalone strength of this signal, 0-100, independent of other rules. */
  readonly weight: number;
  /**
   * This rule's attributed share of the final score. Across all hits these sum
   * to exactly `score`, so the explanation can be rendered as a breakdown that
   * adds up rather than a list of numbers that mysteriously do not.
   */
  readonly contribution: number;
}

/** An entry the user is watching for impersonation. */
export interface WatchlistEntry {
  readonly id: string;
  /** Domain exactly as typed by the user (may be unicode, may have a scheme). */
  readonly domain: string;
  /** Optional human label, e.g. "corporate marketing site". */
  readonly label?: string;
  readonly createdAt: string;
}

/** Result of comparing one candidate domain against one watchlist entry. */
export interface LookalikeAssessment {
  /** Candidate exactly as supplied (typically a CT `name_value` entry). */
  readonly candidate: string;
  /** Candidate in A-label (punycode/ASCII) form. */
  readonly candidateAscii: string;
  /** Candidate in U-label (unicode) form; equal to ascii for plain names. */
  readonly candidateUnicode: string;
  /** The watched domain this candidate was compared against, ASCII form. */
  readonly watched: string;
  /** The candidate label that actually triggered the match, e.g. `paypa1`. */
  readonly matchedLabel: string | null;
  /** Integer 0-100. */
  readonly score: number;
  readonly level: RiskLevel;
  /** Fired rules, highest contribution first. Empty iff `score` is 0. */
  readonly hits: readonly RuleHit[];
  /**
   * True when the candidate is the watched domain (or a subdomain of it).
   * These are the user's own certificates, not impersonation.
   */
  readonly benign: boolean;
  /** One-line summary suitable for an aria-label or a table cell. */
  readonly summary: string;
}

/** Thresholds are exported so tests and the UI legend cannot drift apart. */
export const RISK_THRESHOLDS: ReadonlyArray<{ min: number; level: RiskLevel }> = [
  { min: 80, level: 'critical' },
  { min: 60, level: 'high' },
  { min: 35, level: 'medium' },
  { min: 1, level: 'low' },
  { min: 0, level: 'none' },
];

export function riskLevelFor(score: number): RiskLevel {
  for (const t of RISK_THRESHOLDS) {
    if (score >= t.min) return t.level;
  }
  return 'none';
}
