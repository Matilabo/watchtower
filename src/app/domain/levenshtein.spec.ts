import { describe, expect, it } from 'vitest';

import { levenshtein, similarity } from './levenshtein';

describe('levenshtein', () => {
  it('is zero for identical strings', () => {
    expect(levenshtein('paypal', 'paypal')).toBe(0);
  });

  it('handles empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it.each([
    ['paypal', 'paypa1', 1],
    ['paypal', 'paypall', 1],
    ['paypal', 'papyal', 2],
    ['microsoft', 'micrsoft', 1],
    ['kitten', 'sitting', 3],
    ['example', 'samples', 3],
  ])('%s -> %s is %i edits', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected);
  });

  it('is symmetric', () => {
    expect(levenshtein('github', 'gtihub')).toBe(levenshtein('gtihub', 'github'));
  });

  it('counts an astral character as a single edit', () => {
    // Naive UTF-16 implementations report 2 here because the emoji is a surrogate pair.
    expect(levenshtein('ab', 'a\u{1F600}b')).toBe(1);
  });

  it('counts a combining sequence as written, without normalising', () => {
    // Normalisation is the normaliser's job; distance must stay a pure function.
    const precomposed = String.fromCodePoint(0x00e9); // e-acute, one code point
    const decomposed = 'e' + String.fromCodePoint(0x0301); // e + combining acute
    expect(precomposed).not.toBe(decomposed);
    expect(levenshtein(precomposed, decomposed)).toBe(2);
  });

  describe('early exit', () => {
    it('returns a value above the budget rather than the true distance', () => {
      const result = levenshtein('completely-different', 'nothing-alike', 2);
      expect(result).toBeGreaterThan(2);
    });

    it('still returns exact distances at or below the budget', () => {
      expect(levenshtein('paypal', 'paypa1', 2)).toBe(1);
      expect(levenshtein('paypal', 'papyal', 2)).toBe(2);
    });

    it('bails out on a length gap without walking the matrix', () => {
      expect(levenshtein('ab', 'abcdefghij', 3)).toBeGreaterThan(3);
    });
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and 0 for fully different ones', () => {
    expect(similarity('paypal', 'paypal')).toBe(1);
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('penalises an edit more in a short name than in a long one', () => {
    const short = similarity('acme', 'acne');
    const long = similarity('acmecorporation', 'acnecorporation');
    expect(short).toBeLessThan(long);
  });

  it('treats two empty strings as identical', () => {
    expect(similarity('', '')).toBe(1);
  });
});
