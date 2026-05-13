/**
 * Structural typo patterns.
 *
 * These answer a sharper question than raw edit distance does. "Distance 1"
 * tells you the names are close; "a doubled `l` was inserted at index 5" tells
 * you *how*, which is what makes an alert actionable. Each detector therefore
 * returns the evidence, not a boolean.
 *
 * All detectors expect single labels that are already lowercased and free of
 * dots. They operate on code points so astral characters count as one edit.
 */

export type EditPatternKind = 'insertion' | 'omission' | 'transposition' | 'doubling';

export interface EditPattern {
  readonly kind: EditPatternKind;
  /** Index into the candidate (insertion/doubling/transposition) or target (omission). */
  readonly index: number;
  /** The character(s) involved, for the evidence string. */
  readonly chars: string;
}

/** Index of the first differing code point, or -1 when the prefixes are equal. */
function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: readonly string[], b: readonly string[], stopAt: number): number {
  let i = 0;
  while (
    i < a.length - stopAt &&
    i < b.length - stopAt &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i++;
  }
  return i;
}

/**
 * `candidate` is `target` with exactly one code point inserted.
 * Returns the inserted character and where it landed.
 */
export function detectInsertion(candidate: string, target: string): EditPattern | null {
  const c = Array.from(candidate);
  const t = Array.from(target);
  if (c.length !== t.length + 1) return null;

  const prefix = commonPrefixLength(c, t);
  const suffix = commonSuffixLength(c, t, prefix);
  if (prefix + suffix !== t.length) return null;

  const inserted = c[prefix]!;
  const neighbour = t[prefix - 1] ?? t[prefix] ?? '';
  const isDoubling = inserted === neighbour;
  return {
    kind: isDoubling ? 'doubling' : 'insertion',
    index: prefix,
    chars: inserted,
  };
}

/** `candidate` is `target` with exactly one code point removed. */
export function detectOmission(candidate: string, target: string): EditPattern | null {
  const inverse = detectInsertion(target, candidate);
  if (inverse === null) return null;
  return { kind: 'omission', index: inverse.index, chars: inverse.chars };
}

/** `candidate` is `target` with two adjacent code points swapped. */
export function detectTransposition(candidate: string, target: string): EditPattern | null {
  const c = Array.from(candidate);
  const t = Array.from(target);
  if (c.length !== t.length) return null;

  const diffs: number[] = [];
  for (let i = 0; i < c.length; i++) {
    if (c[i] !== t[i]) {
      diffs.push(i);
      if (diffs.length > 2) return null;
    }
  }
  if (diffs.length !== 2) return null;

  const [first, second] = diffs as [number, number];
  if (second !== first + 1) return null;
  if (c[first] !== t[second] || c[second] !== t[first]) return null;

  return { kind: 'transposition', index: first, chars: `${t[first]}${t[second]}` };
}

/**
 * Runs the structural detectors in priority order. Doubling is reported ahead
 * of generic insertion because it is the more specific explanation of the same
 * edit, and transposition ahead of both because it cannot be confused with them.
 */
export function detectEditPattern(candidate: string, target: string): EditPattern | null {
  if (candidate === target) return null;
  return (
    detectTransposition(candidate, target) ??
    detectInsertion(candidate, target) ??
    detectOmission(candidate, target)
  );
}

export interface HyphenationEvidence {
  /** 'added' when the candidate introduces hyphens, 'removed' when it drops them. */
  readonly direction: 'added' | 'removed';
  readonly hyphenCount: number;
}

/**
 * The candidate is the target with hyphens added or removed
 * (`pay-pal.com` vs `paypal.com`, or `my-bank.com` vs `mybank.com`).
 */
export function detectHyphenation(candidate: string, target: string): HyphenationEvidence | null {
  if (candidate === target) return null;
  const strippedCandidate = candidate.replace(/-/g, '');
  const strippedTarget = target.replace(/-/g, '');
  if (strippedCandidate !== strippedTarget) return null;

  const candidateHyphens = candidate.length - strippedCandidate.length;
  const targetHyphens = target.length - strippedTarget.length;
  if (candidateHyphens === targetHyphens) return null;

  return candidateHyphens > targetHyphens
    ? { direction: 'added', hyphenCount: candidateHyphens - targetHyphens }
    : { direction: 'removed', hyphenCount: targetHyphens - candidateHyphens };
}

/**
 * Words that turn a look-alike name into a credential-harvesting lure. Only
 * ever used as a modifier: on their own these describe an enormous number of
 * legitimate hostnames (`login.example.com` is not an attack).
 */
export const LURE_KEYWORDS: readonly string[] = [
  'login', 'signin', 'sign-in', 'account', 'accounts', 'verify', 'verification',
  'secure', 'security', 'update', 'confirm', 'auth', 'authenticate', 'wallet',
  'support', 'billing', 'payment', 'password', 'recovery', 'unlock', 'alert',
  'webscr', 'mfa', 'otp', 'portal', 'invoice',
];

/** Lure words present anywhere in the candidate's labels. */
export function findLureKeywords(labels: readonly string[]): string[] {
  const haystack = labels.join('.');
  return LURE_KEYWORDS.filter((word) => haystack.includes(word));
}

/**
 * The watched name appears inside a longer label, or as a label of a domain
 * registered by someone else -- `paypal-secure.com`, `login.paypal.evil.net`.
 * This is combosquatting, and it is the single most common shape in the wild.
 */
export interface CombosquatEvidence {
  /** The candidate label the watched name was found in. */
  readonly label: string;
  /** True when the label is exactly the watched name (a stronger signal). */
  readonly exactLabel: boolean;
}

export function detectCombosquat(
  candidateLabels: readonly string[],
  watchedCore: string,
): CombosquatEvidence | null {
  if (watchedCore.length < 3) return null;

  const exact = candidateLabels.find((label) => label === watchedCore);
  if (exact !== undefined) return { label: exact, exactLabel: true };

  const containing = candidateLabels.find(
    (label) => label.length > watchedCore.length && label.includes(watchedCore),
  );
  return containing === undefined ? null : { label: containing, exactLabel: false };
}
