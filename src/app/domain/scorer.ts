/**
 * The lookalike scorer.
 *
 * Design notes, because the numbers are the arguable part:
 *
 * 1. Rules are split into `base` (can raise suspicion alone), `modifier`
 *    (only amplifies existing suspicion) and `suppressor` (this is your own
 *    certificate). Without that split, "uses .zip" and "contains 'login'"
 *    would light up half of the CT firehose.
 *
 * 2. Weights are combined with a noisy-OR rather than a sum. Two independent
 *    weak signals should push the score up, but ten of them must not overflow
 *    past a single strong one. In log space that is a plain addition:
 *      score = 1 - exp(-sum(-ln(1 - w_i)))
 *
 * 3. Each hit is then given an *attributed* contribution, proportional to its
 *    share of that log-space sum, adjusted so the contributions sum to exactly
 *    the final score. The UI can therefore render a breakdown that adds up. A
 *    score with no reason is not actionable, so the explanation is part of the
 *    return type, not a debug aid.
 *
 * 4. When a specific structural rule fires (transposition, homoglyph, ...) the
 *    generic edit-distance rule is suppressed. They are the same evidence, and
 *    counting it twice would inflate the score while telling the user less.
 */

import { describeSubstitutions, hasCrossScriptConfusable, skeleton } from './homoglyph';
import { levenshtein, similarity } from './levenshtein';
import type { LookalikeAssessment, RuleHit, RuleId, RuleKind, WatchlistEntry } from './models';
import { riskLevelFor } from './models';
import { parseDomain, tryParseDomain, type ParsedDomain } from './normalize';
import { SUSPICIOUS_TLDS } from './public-suffix';
import {
  detectCombosquat,
  detectEditPattern,
  detectHyphenation,
  findLureKeywords,
} from './typosquat';

export interface ScorerOptions {
  /**
   * Names shorter than this are not fuzzy-matched at all. Every three-letter
   * string is within one edit of some other three-letter string, so fuzzy
   * matching short names produces noise and nothing else.
   */
  readonly minCoreLength?: number;
  /** Hard ceiling on the edit distance considered "near". */
  readonly maxEditDistance?: number;
}

const DEFAULTS: Required<ScorerOptions> = {
  minCoreLength: 4,
  maxEditDistance: 3,
};

/** Standalone strength of each rule, 0-100. */
const WEIGHTS: Readonly<Record<RuleId, number>> = {
  'exact-match': 0,
  'registrable-identical': 0,
  'homoglyph-unicode': 92,
  'homoglyph-ascii': 78,
  transposition: 74,
  omission: 70,
  insertion: 68,
  doubling: 64,
  hyphenation: 64,
  'tld-swap': 55,
  combosquat: 62,
  'levenshtein-near': 66,
  'idn-punycode': 18,
  'mixed-script': 30,
  'lure-keyword': 24,
  'suspicious-tld': 16,
};

const KINDS: Readonly<Record<RuleId, RuleKind>> = {
  'exact-match': 'suppressor',
  'registrable-identical': 'suppressor',
  'homoglyph-unicode': 'base',
  'homoglyph-ascii': 'base',
  transposition: 'base',
  omission: 'base',
  insertion: 'base',
  doubling: 'base',
  hyphenation: 'base',
  'tld-swap': 'base',
  combosquat: 'base',
  'levenshtein-near': 'base',
  'idn-punycode': 'modifier',
  'mixed-script': 'modifier',
  'lure-keyword': 'modifier',
  'suspicious-tld': 'modifier',
};

const TITLES: Readonly<Record<RuleId, string>> = {
  'exact-match': 'Exact match',
  'registrable-identical': 'Same registrable domain',
  'homoglyph-unicode': 'Look-alike characters from another script',
  'homoglyph-ascii': 'Look-alike ASCII characters',
  transposition: 'Transposed characters',
  omission: 'Omitted character',
  insertion: 'Inserted character',
  doubling: 'Doubled character',
  hyphenation: 'Hyphenation variant',
  'tld-swap': 'Same name, different TLD',
  combosquat: 'Watched name embedded in a longer name',
  'levenshtein-near': 'Small edit distance',
  'idn-punycode': 'Internationalised (punycode) name',
  'mixed-script': 'Mixed scripts in one label',
  'lure-keyword': 'Credential-lure keyword',
  'suspicious-tld': 'TLD with elevated abuse rate',
};

/** A candidate hit before attribution: weight is known, contribution is not. */
interface DraftHit {
  readonly rule: RuleId;
  readonly detail: string;
  readonly weight: number;
  /** Which candidate label produced it, for `matchedLabel`. */
  readonly label?: string;
}

/** Rules whose evidence is also, implicitly, "the edit distance is small". */
const SUPPRESSES_GENERIC_DISTANCE: ReadonlySet<RuleId> = new Set<RuleId>([
  'homoglyph-unicode',
  'homoglyph-ascii',
  'transposition',
  'omission',
  'insertion',
  'doubling',
  'hyphenation',
  'tld-swap',
]);

function distanceBudget(length: number, max: number): number {
  if (length <= 5) return Math.min(1, max);
  if (length <= 8) return Math.min(2, max);
  return Math.min(3, max);
}

/** Labels of the candidate that are not part of its public suffix. */
function comparableLabels(parsed: ParsedDomain): string[] {
  const suffixLabelCount = parsed.suffix === '' ? 0 : parsed.suffix.split('.').length;
  const end = Math.max(0, parsed.unicodeLabels.length - suffixLabelCount);
  return parsed.unicodeLabels.slice(0, end);
}

/** The registrable name of a parsed domain, in its unicode (display) form. */
function unicodeCore(parsed: ParsedDomain): string {
  const labels = comparableLabels(parsed);
  return labels.length === 0 ? '' : labels[labels.length - 1]!;
}

function formatSubstitutions(label: string): string {
  const subs = describeSubstitutions(label).slice(0, 4);
  if (subs.length === 0) return '';
  return subs
    .map((s) =>
      s.codePoint ? `'${s.from}' (${s.codePoint}) for '${s.to}'` : `'${s.from}' for '${s.to}'`,
    )
    .join(', ');
}

/** Structural rules for one candidate label against the watched core name. */
function evaluateLabel(
  label: string,
  watchedCore: string,
  candidate: ParsedDomain,
  watched: ParsedDomain,
  options: Required<ScorerOptions>,
): DraftHit[] {
  const hits: DraftHit[] = [];

  if (label === watchedCore) {
    // Same name, so the interesting question is what is around it.
    if (candidate.core === watchedCore && candidate.suffix !== watched.suffix) {
      hits.push({
        rule: 'tld-swap',
        detail: `Registered as '${watchedCore}' under .${candidate.tld} instead of .${watched.tld}`,
        weight: WEIGHTS['tld-swap'],
        label,
      });
    } else if (candidate.registrable !== watched.registrable) {
      hits.push({
        rule: 'combosquat',
        detail: `'${label}' appears as a label of '${candidate.registrable}', which you do not own`,
        weight: WEIGHTS.combosquat + 6,
        label,
      });
    }
    return hits;
  }

  if (skeleton(label) === skeleton(watchedCore)) {
    const rule: RuleId = hasCrossScriptConfusable(label) ? 'homoglyph-unicode' : 'homoglyph-ascii';
    const evidence = formatSubstitutions(label);
    hits.push({
      rule,
      detail: evidence
        ? `'${label}' renders like '${watchedCore}' using ${evidence}`
        : `'${label}' renders like '${watchedCore}'`,
      weight: WEIGHTS[rule],
      label,
    });
  }

  const hyphen = detectHyphenation(label, watchedCore);
  if (hyphen !== null) {
    hits.push({
      rule: 'hyphenation',
      detail:
        hyphen.direction === 'added'
          ? `'${label}' is '${watchedCore}' with ${hyphen.hyphenCount} hyphen(s) added`
          : `'${label}' is '${watchedCore}' with ${hyphen.hyphenCount} hyphen(s) removed`,
      weight: WEIGHTS.hyphenation,
      label,
    });
  }

  // A hyphenation variant is also, mechanically, an insertion or an omission.
  // Reporting both would count one edit twice and explain it worse.
  const edit = hyphen === null ? detectEditPattern(label, watchedCore) : null;
  if (edit !== null) {
    const position = edit.index + 1;
    const detail =
      edit.kind === 'omission'
        ? `'${label}' is '${watchedCore}' with '${edit.chars}' removed at position ${position}`
        : edit.kind === 'transposition'
          ? `'${label}' swaps '${edit.chars}' at position ${position} of '${watchedCore}'`
          : edit.kind === 'doubling'
            ? `'${label}' doubles '${edit.chars}' at position ${position} of '${watchedCore}'`
            : `'${label}' inserts '${edit.chars}' at position ${position} of '${watchedCore}'`;
    hits.push({ rule: edit.kind, detail, weight: WEIGHTS[edit.kind], label });
  }

  const budget = distanceBudget(watchedCore.length, options.maxEditDistance);
  const distance = levenshtein(label, watchedCore, budget);
  if (distance > 0 && distance <= budget) {
    const ratio = similarity(label, watchedCore);
    const decay = distance === 1 ? 1 : 0.72 / distance;
    const scaled = Math.round(WEIGHTS['levenshtein-near'] * ratio * decay);
    hits.push({
      rule: 'levenshtein-near',
      detail: `'${label}' is ${distance} edit(s) from '${watchedCore}' (${Math.round(ratio * 100)}% similar)`,
      weight: Math.max(scaled, 12),
      label,
    });
  }

  return hits;
}

/** Combosquatting is orthogonal to the per-label rules, so it runs separately. */
function combosquatHits(candidate: ParsedDomain, watchedCore: string): DraftHit[] {
  const combo = detectCombosquat(comparableLabels(candidate), watchedCore);
  if (combo === null || combo.exactLabel) return [];
  return [
    {
      rule: 'combosquat',
      detail: `Label '${combo.label}' contains the watched name '${watchedCore}'`,
      weight: WEIGHTS.combosquat,
      label: combo.label,
    },
  ];
}

function modifierHits(candidate: ParsedDomain): DraftHit[] {
  const hits: DraftHit[] = [];

  if (candidate.hasPunycode) {
    hits.push({
      rule: 'idn-punycode',
      detail: `Encoded as '${candidate.ascii}', displays as '${candidate.unicode}'`,
      weight: WEIGHTS['idn-punycode'],
    });
  }

  if (candidate.mixedScript) {
    hits.push({
      rule: 'mixed-script',
      detail: `A single label mixes ${candidate.scripts.join(' + ')}${
        candidate.hadInvisibleChars ? ' and contained invisible characters' : ''
      }`,
      weight: WEIGHTS['mixed-script'] + (candidate.hadInvisibleChars ? 10 : 0),
    });
  } else if (candidate.hadInvisibleChars) {
    hits.push({
      rule: 'mixed-script',
      detail: 'Name contained zero-width or bidi control characters',
      weight: WEIGHTS['mixed-script'],
    });
  }

  const lures = findLureKeywords(comparableLabels(candidate));
  if (lures.length > 0) {
    hits.push({
      rule: 'lure-keyword',
      detail: `Contains ${lures.map((word) => `'${word}'`).join(', ')}`,
      weight: Math.min(WEIGHTS['lure-keyword'] + (lures.length - 1) * 6, 40),
    });
  }

  if (SUSPICIOUS_TLDS.has(candidate.tld)) {
    hits.push({
      rule: 'suspicious-tld',
      detail: `.${candidate.tld} has a well above average abuse rate`,
      weight: WEIGHTS['suspicious-tld'],
    });
  }

  return hits;
}

/** Noisy-OR in log space; returns the combined score and each hit's share of it. */
function combine(drafts: readonly DraftHit[]): { score: number; hits: RuleHit[] } {
  if (drafts.length === 0) return { score: 0, hits: [] };

  const informations = drafts.map((draft) => {
    const clamped = Math.min(Math.max(draft.weight, 0), 99);
    return -Math.log(1 - clamped / 100);
  });
  const total = informations.reduce((sum, value) => sum + value, 0);
  if (total === 0) return { score: 0, hits: [] };

  const score = Math.round(100 * (1 - Math.exp(-total)));

  // Largest-remainder apportionment, so the parts sum to exactly `score`.
  const exact = informations.map((info) => (score * info) / total);
  const shares = exact.map((value) => Math.floor(value));
  let remaining = score - shares.reduce((sum, value) => sum + value, 0);
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const { index } of byFraction) {
    if (remaining <= 0) break;
    shares[index] = shares[index]! + 1;
    remaining--;
  }

  const hits: RuleHit[] = drafts.map((draft, index) => ({
    rule: draft.rule,
    kind: KINDS[draft.rule],
    title: TITLES[draft.rule],
    detail: draft.detail,
    weight: draft.weight,
    contribution: shares[index]!,
  }));

  hits.sort((a, b) => b.contribution - a.contribution || b.weight - a.weight);
  return { score, hits };
}

function summarise(
  candidateDisplay: string,
  watchedDisplay: string,
  score: number,
  hits: readonly RuleHit[],
  benign: boolean,
): string {
  if (benign) return `${candidateDisplay} belongs to ${watchedDisplay}`;
  if (hits.length === 0) return `${candidateDisplay} does not resemble ${watchedDisplay}`;
  const reasons = hits
    .slice(0, 2)
    .map((hit) => hit.title.toLowerCase())
    .join('; ');
  return `${candidateDisplay} scores ${score}/100 against ${watchedDisplay}: ${reasons}`;
}

function noMatch(
  candidate: string,
  candidateAscii: string,
  candidateUnicode: string,
  watched: string,
  summary: string,
): LookalikeAssessment {
  return {
    candidate,
    candidateAscii,
    candidateUnicode,
    watched,
    matchedLabel: null,
    score: 0,
    level: 'none',
    hits: [],
    benign: false,
    summary,
  };
}

/**
 * Compares one candidate name against one watched name.
 *
 * Never throws: certificate transparency logs contain malformed names, and one
 * unparseable entry must not take down a polling cycle.
 */
export function assess(
  candidateInput: string,
  watchedInput: string,
  options: ScorerOptions = {},
): LookalikeAssessment {
  const settings = { ...DEFAULTS, ...options };

  const candidate = tryParseDomain(candidateInput);
  if (candidate === null) {
    return noMatch(
      candidateInput,
      candidateInput,
      candidateInput,
      watchedInput,
      'Candidate name could not be parsed',
    );
  }
  const watched = tryParseDomain(watchedInput);
  if (watched === null) {
    return noMatch(
      candidateInput,
      candidate.ascii,
      candidate.unicode,
      watchedInput,
      'Watched name could not be parsed',
    );
  }

  const watchedCore = unicodeCore(watched);
  const base = {
    candidate: candidateInput,
    candidateAscii: candidate.ascii,
    candidateUnicode: candidate.unicode,
    watched: watched.ascii,
  };

  // Your own certificate: the strongest possible signal that this is not an attack.
  if (candidate.ascii === watched.ascii || candidate.registrable === watched.registrable) {
    const rule: RuleId = candidate.ascii === watched.ascii ? 'exact-match' : 'registrable-identical';
    const hit: RuleHit = {
      rule,
      kind: 'suppressor',
      title: TITLES[rule],
      detail:
        rule === 'exact-match'
          ? 'Identical to the watched domain'
          : `Subdomain of '${watched.registrable}', which you watch`,
      weight: 0,
      contribution: 0,
    };
    return {
      ...base,
      matchedLabel: candidate.core,
      score: 0,
      level: 'none',
      hits: [hit],
      benign: true,
      summary: summarise(candidate.unicode, watched.unicode, 0, [hit], true),
    };
  }

  if (watchedCore.length < settings.minCoreLength) {
    return noMatch(
      candidateInput,
      candidate.ascii,
      candidate.unicode,
      watched.ascii,
      `Watched name '${watchedCore}' is too short to fuzzy match`,
    );
  }

  // Every non-suffix label is a candidate for impersonation: attackers hide the
  // look-alike in a subdomain (`paypa1.cdn.attacker.tld`) as often as in the
  // registrable name itself. Keep the strongest label.
  let bestLabel: string | null = null;
  let bestHits: DraftHit[] = [];
  let bestWeight = -1;
  for (const label of comparableLabels(candidate)) {
    const hits = evaluateLabel(label, watchedCore, candidate, watched, settings);
    if (hits.length === 0) continue;
    const weight = Math.max(...hits.map((hit) => hit.weight));
    if (weight > bestWeight) {
      bestWeight = weight;
      bestHits = hits;
      bestLabel = label;
    }
  }

  // `paypall` both doubles a character and contains `paypal`. That is one piece
  // of evidence, not two, so combosquatting only counts when it points at a
  // different label than the structural rules did.
  const combo = combosquatHits(candidate, watchedCore).filter(
    (hit) => bestHits.length === 0 || hit.label !== bestLabel,
  );
  const structural = [...bestHits, ...combo];
  const hasSpecific = structural.some((hit) => SUPPRESSES_GENERIC_DISTANCE.has(hit.rule));
  const baseHits = hasSpecific
    ? structural.filter((hit) => hit.rule !== 'levenshtein-near')
    : structural;

  if (baseHits.length === 0) {
    return noMatch(
      candidateInput,
      candidate.ascii,
      candidate.unicode,
      watched.ascii,
      summarise(candidate.unicode, watched.unicode, 0, [], false),
    );
  }

  const { score, hits } = combine([...baseHits, ...modifierHits(candidate)]);
  const matchedLabel = bestLabel ?? baseHits.find((hit) => hit.label !== undefined)?.label ?? null;

  return {
    ...base,
    matchedLabel,
    score,
    level: riskLevelFor(score),
    hits,
    benign: false,
    summary: summarise(candidate.unicode, watched.unicode, score, hits, false),
  };
}

/**
 * Scores a candidate against every watchlist entry and returns the matches,
 * strongest first. Benign (own-certificate) results are kept so the UI can say
 * "this one is yours" rather than silently dropping the row.
 */
export function assessAgainstWatchlist(
  candidateInput: string,
  entries: readonly WatchlistEntry[],
  options: ScorerOptions = {},
): LookalikeAssessment[] {
  return entries
    .map((entry) => assess(candidateInput, entry.domain, options))
    .filter((result) => result.score > 0 || result.benign)
    .sort((a, b) => Number(a.benign) - Number(b.benign) || b.score - a.score);
}

/** The single strongest assessment, or null when nothing matched. */
export function bestAssessment(
  candidateInput: string,
  entries: readonly WatchlistEntry[],
  options: ScorerOptions = {},
): LookalikeAssessment | null {
  return assessAgainstWatchlist(candidateInput, entries, options)[0] ?? null;
}

/** Re-exported so callers can validate user input before adding a watch entry. */
export { parseDomain };
