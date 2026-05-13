import { describe, expect, it } from 'vitest';

import {
  detectCombosquat,
  detectEditPattern,
  detectHyphenation,
  detectInsertion,
  detectOmission,
  detectTransposition,
  findLureKeywords,
} from './typosquat';

describe('detectInsertion', () => {
  it('finds a single inserted character and its position', () => {
    expect(detectInsertion('paypaal', 'paypal')).toMatchObject({ index: 5, chars: 'a' });
  });

  it('classifies an insertion next to an identical character as doubling', () => {
    expect(detectInsertion('paypall', 'paypal')).toMatchObject({ kind: 'doubling', chars: 'l' });
    expect(detectInsertion('gooogle', 'google')).toMatchObject({ kind: 'doubling', chars: 'o' });
  });

  it('classifies an insertion of a new character as insertion', () => {
    expect(detectInsertion('paypaln', 'paypal')).toMatchObject({ kind: 'insertion', chars: 'n' });
    expect(detectInsertion('xpaypal', 'paypal')).toMatchObject({ kind: 'insertion', index: 0 });
  });

  it('returns null when more than one character was added', () => {
    expect(detectInsertion('paypalxx', 'paypal')).toBeNull();
  });

  it('returns null when the change is a substitution, not an insertion', () => {
    expect(detectInsertion('paypa1', 'paypal')).toBeNull();
  });

  it('treats an astral character as one insertion', () => {
    expect(detectInsertion('a\u{1F600}b', 'ab')).toMatchObject({ index: 1 });
  });
});

describe('detectOmission', () => {
  it('finds the dropped character', () => {
    expect(detectOmission('paypl', 'paypal')).toMatchObject({ kind: 'omission', chars: 'a' });
    expect(detectOmission('micrsoft', 'microsoft')).toMatchObject({ chars: 'o' });
  });

  it('returns null when nothing was dropped', () => {
    expect(detectOmission('paypal', 'paypal')).toBeNull();
    expect(detectOmission('paypall', 'paypal')).toBeNull();
  });
});

describe('detectTransposition', () => {
  it('finds an adjacent swap', () => {
    expect(detectTransposition('papyal', 'paypal')).toMatchObject({ index: 2, chars: 'yp' });
    expect(detectTransposition('gtihub', 'github')).toMatchObject({ index: 1 });
  });

  it('ignores non-adjacent differences', () => {
    expect(detectTransposition('laypap', 'paypal')).toBeNull();
  });

  it('ignores substitutions', () => {
    expect(detectTransposition('paypa1', 'paypal')).toBeNull();
  });

  it('ignores different lengths', () => {
    expect(detectTransposition('paypa', 'paypal')).toBeNull();
  });
});

describe('detectEditPattern', () => {
  it('prefers the specific explanation over the generic one', () => {
    expect(detectEditPattern('paypall', 'paypal')?.kind).toBe('doubling');
    expect(detectEditPattern('papyal', 'paypal')?.kind).toBe('transposition');
    expect(detectEditPattern('paypl', 'paypal')?.kind).toBe('omission');
  });

  it('returns null for identical strings', () => {
    expect(detectEditPattern('paypal', 'paypal')).toBeNull();
  });

  it('returns null when the names are too far apart', () => {
    expect(detectEditPattern('completely-other', 'paypal')).toBeNull();
  });
});

describe('detectHyphenation', () => {
  it('detects added hyphens', () => {
    expect(detectHyphenation('pay-pal', 'paypal')).toEqual({ direction: 'added', hyphenCount: 1 });
    expect(detectHyphenation('p-a-y-pal', 'paypal')).toMatchObject({ hyphenCount: 3 });
  });

  it('detects removed hyphens', () => {
    expect(detectHyphenation('mybank', 'my-bank')).toEqual({
      direction: 'removed',
      hyphenCount: 1,
    });
  });

  it('returns null when the letters differ, not just the hyphens', () => {
    expect(detectHyphenation('pay-pa1', 'paypal')).toBeNull();
  });

  it('returns null for identical names', () => {
    expect(detectHyphenation('my-bank', 'my-bank')).toBeNull();
  });
});

describe('detectCombosquat', () => {
  it('reports an exact label match as the stronger signal', () => {
    expect(detectCombosquat(['login', 'paypal'], 'paypal')).toEqual({
      label: 'paypal',
      exactLabel: true,
    });
  });

  it('reports the watched name embedded in a longer label', () => {
    expect(detectCombosquat(['paypal-secure'], 'paypal')).toEqual({
      label: 'paypal-secure',
      exactLabel: false,
    });
  });

  it('returns null when the watched name is absent', () => {
    expect(detectCombosquat(['login', 'example'], 'paypal')).toBeNull();
  });

  it('refuses to match very short watched names, which would match everything', () => {
    expect(detectCombosquat(['about'], 'ab')).toBeNull();
  });
});

describe('findLureKeywords', () => {
  it('finds lure words across labels', () => {
    expect(findLureKeywords(['secure', 'login-paypal'])).toEqual(
      expect.arrayContaining(['login', 'secure']),
    );
  });

  it('returns nothing for a neutral name', () => {
    expect(findLureKeywords(['docs', 'example'])).toEqual([]);
  });
});
