import { describe, expect, it } from 'vitest';

import { InvalidDomainError, parseDomain, tryParseDomain, unicodeFor } from './normalize';

const CYRILLIC_A = String.fromCodePoint(0x0430);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);

describe('parseDomain', () => {
  describe('cleaning', () => {
    it.each([
      ['https://example.com/login?next=1', 'example.com'],
      ['HTTP://Example.COM', 'example.com'],
      ['example.com.', 'example.com'],
      ['example.com:8443', 'example.com'],
      ['user@example.com', 'example.com'],
      ['  example.com  ', 'example.com'],
      ['example..com', 'example.com'],
    ])('normalises %s to %s', (input, expected) => {
      expect(parseDomain(input).ascii).toBe(expected);
    });

    it('records wildcard SANs without keeping the asterisk', () => {
      const parsed = parseDomain('*.example.com');
      expect(parsed.isWildcard).toBe(true);
      expect(parsed.ascii).toBe('example.com');
    });

    it('strips zero-width and bidi control characters and flags that it did', () => {
      const parsed = parseDomain(`exam${ZERO_WIDTH_SPACE}ple${RIGHT_TO_LEFT_OVERRIDE}.com`);
      expect(parsed.ascii).toBe('example.com');
      expect(parsed.hadInvisibleChars).toBe(true);
    });

    it('does not flag ordinary names as containing invisible characters', () => {
      expect(parseDomain('example.com').hadInvisibleChars).toBe(false);
    });
  });

  describe('public suffix handling', () => {
    it.each([
      ['example.com', 'com', 'example', 'example.com', []],
      ['shop.example.co.uk', 'co.uk', 'example', 'example.co.uk', ['shop']],
      ['a.b.example.com.br', 'com.br', 'example', 'example.com.br', ['a', 'b']],
      ['pages.dev', 'pages.dev', '', 'pages.dev', []],
      ['victim.pages.dev', 'pages.dev', 'victim', 'victim.pages.dev', []],
      ['localhost', 'localhost', '', 'localhost', []],
    ])('splits %s', (input, suffix, core, registrable, subdomains) => {
      const parsed = parseDomain(input);
      expect(parsed.suffix).toBe(suffix);
      expect(parsed.core).toBe(core);
      expect(parsed.registrable).toBe(registrable);
      expect(parsed.subdomains).toEqual(subdomains);
    });

    it('exposes the right-most label as the TLD', () => {
      expect(parseDomain('example.co.uk').tld).toBe('uk');
      expect(parseDomain('example.zip').tld).toBe('zip');
    });
  });

  describe('internationalised names', () => {
    it('decodes A-labels to their unicode form', () => {
      const parsed = parseDomain('xn--bcher-kva.example');
      expect(parsed.unicode).toBe('bücher.example');
      expect(parsed.ascii).toBe('xn--bcher-kva.example');
      expect(parsed.hasPunycode).toBe(true);
    });

    it('encodes unicode input to its A-label form', () => {
      const parsed = parseDomain('bücher.example');
      expect(parsed.ascii).toBe('xn--bcher-kva.example');
      expect(parsed.unicode).toBe('bücher.example');
      expect(parsed.hasPunycode).toBe(true);
    });

    it('round-trips a Cyrillic look-alike to the same ASCII form either way', () => {
      const fromUnicode = parseDomain(`p${CYRILLIC_A}ypal.com`);
      const fromPunycode = parseDomain(fromUnicode.ascii);
      expect(fromPunycode.unicode).toBe(fromUnicode.unicode);
      expect(fromPunycode.ascii).toBe(fromUnicode.ascii);
    });

    it('does not mark plain ASCII names as punycode', () => {
      expect(parseDomain('example.com').hasPunycode).toBe(false);
    });

    it('detects the scripts in use', () => {
      expect(parseDomain('example.com').scripts).toEqual(['Latin']);
      expect(parseDomain(`p${CYRILLIC_A}ypal.com`).scripts).toEqual(['Latin', 'Cyrillic']);
    });

    it('flags mixed scripts only when they share a label', () => {
      expect(parseDomain(`p${CYRILLIC_A}ypal.com`).mixedScript).toBe(true);
      // Separate labels in separate scripts is normal for real multilingual sites.
      expect(parseDomain(`${CYRILLIC_A}.example.com`).mixedScript).toBe(false);
    });

    it('is idempotent: parsing the ASCII form again yields the same result', () => {
      const once = parseDomain('münchen.example.de');
      const twice = parseDomain(once.ascii);
      expect(twice.ascii).toBe(once.ascii);
      expect(twice.unicode).toBe(once.unicode);
    });
  });

  describe('invalid input', () => {
    it.each(['', '   ', '.', '...', 'https://', 'has space.com'])(
      'rejects %j',
      (input) => {
        expect(() => parseDomain(input)).toThrow(InvalidDomainError);
        expect(tryParseDomain(input)).toBeNull();
      },
    );

    it('rejects non-string input without throwing a TypeError', () => {
      expect(() => parseDomain(null as unknown as string)).toThrow(InvalidDomainError);
    });
  });

  it('maps an ASCII label back to its display form', () => {
    const parsed = parseDomain('xn--bcher-kva.example');
    expect(unicodeFor(parsed, 'xn--bcher-kva')).toBe('bücher');
    expect(unicodeFor(parsed, 'nope')).toBe('nope');
  });
});
