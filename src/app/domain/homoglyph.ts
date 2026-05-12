/**
 * Confusable ("homoglyph") folding.
 *
 * The idea is Unicode TR39's skeleton algorithm, narrowed to what actually
 * shows up in certificate transparency abuse:
 *
 *   1. NFKC          -- collapses fullwidth, math-alphanumeric and ligature forms
 *   2. mark removal  -- an accented vowel and its plain form should fold together
 *   3. cross-script  -- Cyrillic, Greek and Armenian look-alikes -> Latin
 *   4. multi-char    -- `rn` -> `m`, `vv` -> `w`, `cl` -> `d`
 *   5. single-char   -- `0` -> `o`, `1`/`I` -> `l`, `5` -> `s`
 *
 * Two names whose skeletons are equal are visually interchangeable at a glance
 * in most sans-serif UI fonts, which is the entire point of the attack.
 *
 * Folding is deliberately lossy and is applied to *both* sides of a comparison,
 * so a false positive requires two genuinely different names to collapse onto
 * the same skeleton. The scorer always reports which substitutions fired, so a
 * human can dismiss that case in one glance.
 */

/**
 * Cross-script confusables. Comments give the code point because the source
 * character is, by construction, hard to tell from its Latin twin on screen.
 */
export const CROSS_SCRIPT_CONFUSABLES: ReadonlyMap<string, string> = new Map([
  // Cyrillic
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'b'],
  ['е', 'e'],
  ['ё', 'e'],
  ['з', '3'],
  ['и', 'u'],
  ['й', 'u'],
  ['к', 'k'],
  ['м', 'm'],
  ['н', 'h'],
  ['о', 'o'],
  ['п', 'n'],
  ['р', 'p'],
  ['с', 'c'],
  ['т', 't'],
  ['у', 'y'],
  ['х', 'x'],
  ['ь', 'b'],
  ['ѕ', 's'],
  ['і', 'i'],
  ['ј', 'j'],
  ['ԁ', 'd'],
  ['һ', 'h'],
  ['ӏ', 'l'],
  ['ԛ', 'q'],
  ['ԝ', 'w'],
  // Greek
  ['α', 'a'],
  ['β', 'b'],
  ['γ', 'y'],
  ['ε', 'e'],
  ['ι', 'i'],
  ['κ', 'k'],
  ['ν', 'v'],
  ['ο', 'o'],
  ['ρ', 'p'],
  ['τ', 't'],
  ['υ', 'u'],
  ['χ', 'x'],
  ['ϲ', 'c'],
  // Armenian
  ['ա', 'a'],
  ['գ', 'q'],
  ['հ', 'h'],
  ['ո', 'n'],
  ['ս', 'u'],
  ['օ', 'o'],
  ['ք', 'p'],
  // Latin extended that NFKC + mark stripping does not cover
  ['ø', 'o'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['ł', 'l'],
  ['ı', 'i'],
  ['ŀ', 'l'],
  ['þ', 'p'],
]);

/** Expansions applied alongside the single-character map. */
const EXPANSIONS: ReadonlyMap<string, string> = new Map([
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
]);

/**
 * Multi-character shapes. Order matters: these run before the single-character
 * map, so `rn` becomes `m` rather than being processed one letter at a time.
 */
export const MULTI_CHAR_HOMOGLYPHS: ReadonlyArray<readonly [string, string]> = [
  ['vv', 'w'],
  ['rn', 'm'],
  ['cl', 'd'],
  ['nn', 'm'],
];

/** Digits and punctuation that stand in for letters. */
export const ASCII_HOMOGLYPHS: ReadonlyMap<string, string> = new Map([
  ['0', 'o'],
  ['1', 'l'],
  ['i', 'l'],
  ['|', 'l'],
  ['!', 'l'],
  ['2', 'z'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['6', 'g'],
  ['7', 't'],
  ['8', 'b'],
  ['9', 'g'],
  ['$', 's'],
  ['@', 'a'],
]);

const COMBINING_MARKS = /\p{M}/gu;

/** Strips diacritics so accented and unaccented forms fold together. */
function stripMarks(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}

/** Maps cross-script confusables and expansions to their Latin skeleton. */
function foldCrossScript(text: string): string {
  let out = '';
  for (const ch of text) {
    const expansion = EXPANSIONS.get(ch);
    if (expansion !== undefined) {
      out += expansion;
      continue;
    }
    out += CROSS_SCRIPT_CONFUSABLES.get(ch) ?? ch;
  }
  return out;
}

function foldMultiChar(text: string): string {
  let out = text;
  for (const [from, to] of MULTI_CHAR_HOMOGLYPHS) {
    out = out.split(from).join(to);
  }
  return out;
}

function foldAscii(text: string): string {
  let out = '';
  for (const ch of text) out += ASCII_HOMOGLYPHS.get(ch) ?? ch;
  return out;
}

/**
 * Canonical visual skeleton of a label. Equal skeletons means "these look the
 * same to a human skim-reading a URL bar".
 */
export function skeleton(label: string): string {
  const base = stripMarks(label.normalize('NFKC').toLowerCase());
  return foldAscii(foldMultiChar(foldCrossScript(base)));
}

/** True when the two labels are visually interchangeable but not identical. */
export function isHomoglyphOf(candidate: string, target: string): boolean {
  return candidate !== target && skeleton(candidate) === skeleton(target);
}

export interface Substitution {
  /** The character (or pair) as it appears in the candidate. */
  readonly from: string;
  /** What it imitates. */
  readonly to: string;
  /** `U+0430`-style note, empty for plain ASCII tricks. */
  readonly codePoint: string;
  readonly crossScript: boolean;
}

function describeCodePoint(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return '';
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Which confusable substitutions are present in `candidate`.
 * Used to build the evidence string; an empty result means the skeleton match
 * came from something other than a look-alike character.
 */
export function describeSubstitutions(candidate: string): Substitution[] {
  const found: Substitution[] = [];
  const seen = new Set<string>();

  for (const [pair, to] of MULTI_CHAR_HOMOGLYPHS) {
    if (candidate.includes(pair) && !seen.has(pair)) {
      seen.add(pair);
      found.push({ from: pair, to, codePoint: '', crossScript: false });
    }
  }

  for (const ch of candidate.normalize('NFKC').toLowerCase()) {
    if (seen.has(ch)) continue;
    const cross = CROSS_SCRIPT_CONFUSABLES.get(ch);
    if (cross !== undefined) {
      seen.add(ch);
      found.push({ from: ch, to: cross, codePoint: describeCodePoint(ch), crossScript: true });
      continue;
    }
    const ascii = ASCII_HOMOGLYPHS.get(ch);
    if (ascii !== undefined) {
      seen.add(ch);
      found.push({ from: ch, to: ascii, codePoint: '', crossScript: false });
    }
  }

  return found;
}

/** True when the label contains at least one non-ASCII confusable. */
export function hasCrossScriptConfusable(label: string): boolean {
  for (const ch of label.normalize('NFKC').toLowerCase()) {
    if (CROSS_SCRIPT_CONFUSABLES.has(ch)) return true;
  }
  return false;
}
