import { describe, expect, it } from 'vitest';

import {
  describeSubstitutions,
  hasCrossScriptConfusable,
  isHomoglyphOf,
  skeleton,
} from './homoglyph';

const cp = (code: number) => String.fromCodePoint(code);
const CYRILLIC_A = cp(0x0430);
const CYRILLIC_O = cp(0x043e);
const CYRILLIC_E = cp(0x0435);
const CYRILLIC_P = cp(0x0440);
const CYRILLIC_C = cp(0x0441);
const GREEK_OMICRON = cp(0x03bf);
const ARMENIAN_O = cp(0x0585);

describe('skeleton', () => {
  it('leaves an ordinary name alone apart from case', () => {
    expect(skeleton('Example')).toBe('example');
  });

  it('is idempotent', () => {
    const once = skeleton('paypa1');
    expect(skeleton(once)).toBe(once);
  });

  describe('the substitutions the brief calls out', () => {
    it.each([
      ['rn -> m', 'rnicrosoft', 'microsoft'],
      ['0 -> O', 'g00gle', 'google'],
      ['l -> I', 'paypaI', 'paypal'],
      ['1 -> l', 'paypa1', 'paypal'],
      ['vv -> w', 'vvikipedia', 'wikipedia'],
    ])('folds %s', (_name, candidate, target) => {
      expect(skeleton(candidate)).toBe(skeleton(target));
      expect(isHomoglyphOf(candidate, target)).toBe(true);
    });
  });

  describe('cross-script confusables', () => {
    it.each([
      ['Cyrillic a', `p${CYRILLIC_A}ypal`, 'paypal'],
      ['Cyrillic o', `g${CYRILLIC_O}ogle`, 'google'],
      ['Cyrillic e', `${CYRILLIC_E}xample`, 'example'],
      ['Cyrillic p and c', `${CYRILLIC_P}ay${CYRILLIC_C}ard`, 'paycard'],
      ['Greek omicron', `g${GREEK_OMICRON}${GREEK_OMICRON}gle`, 'google'],
      ['Armenian o', `micr${ARMENIAN_O}soft`, 'microsoft'],
    ])('folds %s', (_name, candidate, target) => {
      expect(isHomoglyphOf(candidate, target)).toBe(true);
    });

    it('folds a whole-word Cyrillic impersonation', () => {
      const allCyrillic = CYRILLIC_C + CYRILLIC_O + CYRILLIC_P + CYRILLIC_E;
      expect(skeleton(allCyrillic)).toBe('cope');
    });
  });

  describe('unicode normalisation', () => {
    it('folds fullwidth forms', () => {
      expect(skeleton('ｐａｙｐａｌ')).toBe('paypal');
    });

    it('folds mathematical alphanumerics', () => {
      // Bold sans-serif 'paypal' from the Mathematical Alphanumeric Symbols block.
      const bold = [0x1d5c9, 0x1d5ba, 0x1d5d2, 0x1d5c9, 0x1d5ba, 0x1d5c5]
        .map((code) => String.fromCodePoint(code))
        .join('');
      expect(skeleton(bold)).toBe('paypal');
    });

    it('folds diacritics', () => {
      expect(skeleton('pàypál')).toBe('paypal');
      expect(skeleton('exâmple')).toBe('example');
    });

    it('folds decomposed and precomposed forms identically', () => {
      const precomposed = 'caf' + cp(0x00e9);
      const decomposed = 'cafe' + cp(0x0301);
      expect(skeleton(precomposed)).toBe(skeleton(decomposed));
    });

    it('expands ligatures and sharp s', () => {
      expect(skeleton('straße')).toBe('strasse');
      expect(skeleton('æther')).toBe('aether');
    });
  });

  it('does not collapse genuinely different names', () => {
    expect(isHomoglyphOf('google', 'gopher')).toBe(false);
    expect(isHomoglyphOf('example', 'examples')).toBe(false);
    expect(skeleton('shopify')).not.toBe(skeleton('spotify'));
  });

  it('reports identical strings as not being homoglyphs of each other', () => {
    expect(isHomoglyphOf('paypal', 'paypal')).toBe(false);
  });
});

describe('hasCrossScriptConfusable', () => {
  it('is true for a Cyrillic look-alike and false for an ASCII one', () => {
    expect(hasCrossScriptConfusable(`p${CYRILLIC_A}ypal`)).toBe(true);
    expect(hasCrossScriptConfusable('paypa1')).toBe(false);
  });
});

describe('describeSubstitutions', () => {
  it('names the code point of a cross-script substitution', () => {
    const subs = describeSubstitutions(`p${CYRILLIC_A}ypal`);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ to: 'a', codePoint: 'U+0430', crossScript: true });
  });

  it('reports multi-character shapes before single characters', () => {
    const subs = describeSubstitutions('rnicrosoft');
    expect(subs[0]).toMatchObject({ from: 'rn', to: 'm', crossScript: false });
  });

  it('reports ASCII digit substitutions without a code point note', () => {
    const subs = describeSubstitutions('paypa1');
    expect(subs).toEqual([{ from: '1', to: 'l', codePoint: '', crossScript: false }]);
  });

  it('returns nothing for a name with no confusable characters', () => {
    expect(describeSubstitutions('example')).toEqual([]);
  });

  it('does not repeat a substitution that occurs twice', () => {
    const subs = describeSubstitutions(`g${CYRILLIC_O}${CYRILLIC_O}gle`);
    expect(subs).toHaveLength(1);
  });
});
