/**
 * Turning the many shapes a "domain" arrives in (CT `name_value` entries,
 * user input, wildcard SANs, IDNs) into one canonical, comparable form.
 *
 * Everything downstream assumes it is looking at a `ParsedDomain`, so all the
 * awkward cases -- schemes, ports, trailing dots, `*.` wildcards, punycode,
 * invisible characters -- are dealt with exactly once, here.
 */

import { splitPublicSuffix, topLevelLabel } from './public-suffix';
import { toAsciiLabel, toUnicodeLabel } from './punycode';

/** Characters that render as nothing and exist in a hostname only to deceive. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/gu;

const SCRIPT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Han', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
];

export interface ParsedDomain {
  /** Exactly what was handed in, for display and for round-tripping. */
  readonly input: string;
  /** Canonical A-label form, e.g. `xn--pypal-4ve.com`. */
  readonly ascii: string;
  /** Canonical U-label form, e.g. `pаypal.com`. */
  readonly unicode: string;
  readonly asciiLabels: readonly string[];
  readonly unicodeLabels: readonly string[];
  /** Public suffix, e.g. `co.uk`. */
  readonly suffix: string;
  /** Right-most label of the suffix, e.g. `uk`. */
  readonly tld: string;
  /** Registrable name without suffix, e.g. `example`. */
  readonly core: string;
  /** eTLD+1, e.g. `example.co.uk`. */
  readonly registrable: string;
  /** Labels left of the registrable domain. */
  readonly subdomains: readonly string[];
  /** At least one label arrived (or had to be encoded) as `xn--`. */
  readonly hasPunycode: boolean;
  /** Unicode scripts present, excluding Common/digits. */
  readonly scripts: readonly string[];
  /** More than one script inside a single label -- the IDN homograph signature. */
  readonly mixedScript: boolean;
  /** The name was a `*.example.com` wildcard SAN. */
  readonly isWildcard: boolean;
  /** Invisible characters were removed during normalisation. */
  readonly hadInvisibleChars: boolean;
}

export class InvalidDomainError extends Error {
  constructor(readonly value: string, message: string) {
    super(message);
    this.name = 'InvalidDomainError';
  }
}

function stripSurroundings(raw: string): { host: string; isWildcard: boolean } {
  let host = raw.trim();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const at = host.indexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  host = host.split(/[/?#]/, 1)[0] ?? '';
  host = host.replace(/:\d+$/, '');

  let isWildcard = false;
  while (host.startsWith('*.')) {
    isWildcard = true;
    host = host.slice(2);
  }
  host = host.replace(/\.+$/, '');
  return { host, isWildcard };
}

function detectScripts(text: string): string[] {
  const found: string[] = [];
  for (const [name, pattern] of SCRIPT_PATTERNS) {
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

/**
 * Parses and canonicalises a hostname.
 * @throws InvalidDomainError when nothing usable is left after cleaning.
 */
export function parseDomain(raw: string): ParsedDomain {
  if (typeof raw !== 'string') {
    throw new InvalidDomainError(String(raw), 'domain must be a string');
  }

  const { host, isWildcard } = stripSurroundings(raw);
  const withoutInvisible = host.replace(INVISIBLE, '');
  const hadInvisibleChars = withoutInvisible.length !== host.length;

  const cleaned = withoutInvisible.normalize('NFC').toLowerCase();
  if (cleaned.length === 0) {
    throw new InvalidDomainError(raw, 'domain is empty after normalisation');
  }
  if (/[\s]/.test(cleaned)) {
    throw new InvalidDomainError(raw, 'domain contains whitespace');
  }

  const rawLabels = cleaned.split('.').filter((l) => l.length > 0);
  if (rawLabels.length === 0) {
    throw new InvalidDomainError(raw, 'domain has no labels');
  }

  const unicodeLabels = rawLabels.map((l) => toUnicodeLabel(l).normalize('NFC').toLowerCase());
  const asciiLabels = unicodeLabels.map((l) => toAsciiLabel(l).toLowerCase());
  const hasPunycode = asciiLabels.some((l, i) => l !== unicodeLabels[i]);

  const split = splitPublicSuffix(asciiLabels);
  const scripts = detectScripts(unicodeLabels.join(''));
  const mixedScript = unicodeLabels.some((label) => detectScripts(label).length > 1);

  return {
    input: raw,
    ascii: asciiLabels.join('.'),
    unicode: unicodeLabels.join('.'),
    asciiLabels,
    unicodeLabels,
    suffix: split.suffix,
    tld: topLevelLabel(split.suffix),
    core: split.core,
    registrable: split.registrable,
    subdomains: split.subdomains,
    hasPunycode,
    scripts,
    mixedScript,
    isWildcard,
    hadInvisibleChars,
  };
}

/** Non-throwing variant: CT logs contain plenty of malformed names. */
export function tryParseDomain(raw: string): ParsedDomain | null {
  try {
    return parseDomain(raw);
  } catch {
    return null;
  }
}

/**
 * The unicode label matching an ASCII label, for evidence strings: we want to
 * tell the user about `pаypal`, not about `xn--pypal-53d`.
 */
export function unicodeFor(parsed: ParsedDomain, asciiLabel: string): string {
  const index = parsed.asciiLabels.indexOf(asciiLabel);
  return index === -1 ? asciiLabel : parsed.unicodeLabels[index] ?? asciiLabel;
}
