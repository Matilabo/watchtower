import { describe, expect, it } from 'vitest';

import { punycodeDecode, punycodeEncode, toAsciiLabel, toUnicodeLabel } from './punycode';

describe('punycode', () => {
  // Test vectors from RFC 3492 section 7.1 plus real-world IDN labels.
  const vectors: ReadonlyArray<readonly [unicode: string, ace: string]> = [
    ['bücher', 'bcher-kva'],
    ['münchen', 'mnchen-3ya'],
    ['españa', 'espaa-rta'],
    ['日本語', 'wgv71a119e'],
    ['你好', '6qq79v'],
    ['δοκιμή', 'jxalpdlp'],
    ['мойдомен', 'd1acklchcc'],
  ];

  it.each(vectors)('encodes %s', (unicode, ace) => {
    expect(punycodeEncode(unicode)).toBe(ace);
  });

  it.each(vectors)('decodes back to %s', (unicode, ace) => {
    expect(punycodeDecode(ace)).toBe(unicode);
  });

  it('round-trips labels containing astral characters', () => {
    const label = 'a\u{1F600}b';
    expect(punycodeDecode(punycodeEncode(label))).toBe(label);
  });

  it('leaves pure-ASCII labels untouched in both directions', () => {
    expect(toAsciiLabel('example')).toBe('example');
    expect(toUnicodeLabel('example')).toBe('example');
  });

  it('adds and strips the xn-- prefix', () => {
    const ace = toAsciiLabel('bücher');
    expect(ace).toBe('xn--bcher-kva');
    expect(toUnicodeLabel(ace)).toBe('bücher');
  });

  it('returns malformed A-labels unchanged instead of throwing', () => {
    // A lone hyphen payload is not decodable; the scorer still needs a string.
    expect(toUnicodeLabel('xn--')).toBe('xn--');
    expect(toUnicodeLabel('xn--!!!')).toBe('xn--!!!');
  });

  it('rejects punycode payloads containing non-ASCII', () => {
    expect(() => punycodeDecode('bü-cher')).toThrow(/non-ASCII/);
  });

  it('rejects truncated payloads', () => {
    expect(() => punycodeDecode('bcher-kv')).toThrow();
  });
});
