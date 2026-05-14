import { describe, expect, it } from 'vitest';

import type { LookalikeAssessment, RuleId, WatchlistEntry } from './models';
import { assess, assessAgainstWatchlist, bestAssessment } from './scorer';

const cp = (code: number) => String.fromCodePoint(code);
const CYRILLIC_A = cp(0x0430);
const CYRILLIC_O = cp(0x043e);

const rules = (result: LookalikeAssessment): RuleId[] => result.hits.map((hit) => hit.rule);
const fired = (result: LookalikeAssessment, rule: RuleId): boolean => rules(result).includes(rule);

const entry = (domain: string, id = domain): WatchlistEntry => ({
  id,
  domain,
  createdAt: '2026-05-01T00:00:00.000Z',
});

describe('assess', () => {
  describe('the user own certificates', () => {
    it('treats an exact match as benign, not as a 100-score alert', () => {
      const result = assess('example.com', 'example.com');
      expect(result.benign).toBe(true);
      expect(result.score).toBe(0);
      expect(rules(result)).toEqual(['exact-match']);
    });

    it('treats a subdomain of a watched domain as benign', () => {
      const result = assess('mail.example.com', 'example.com');
      expect(result.benign).toBe(true);
      expect(rules(result)).toEqual(['registrable-identical']);
    });

    it('treats a wildcard SAN for the watched domain as benign', () => {
      expect(assess('*.example.com', 'example.com').benign).toBe(true);
    });

    it('says why it considers the certificate benign', () => {
      expect(assess('mail.example.com', 'example.com').summary).toContain('example.com');
      expect(assess('mail.example.com', 'example.com').hits[0]?.detail).toContain('Subdomain');
    });
  });

  describe('unrelated names', () => {
    it.each([
      ['wikipedia.org', 'paypal.com'],
      ['news.ycombinator.com', 'example.com'],
      ['cdn.jsdelivr.net', 'shopify.com'],
    ])('scores %s against %s as zero', (candidate, watched) => {
      const result = assess(candidate, watched);
      expect(result.score).toBe(0);
      expect(result.level).toBe('none');
      expect(result.hits).toEqual([]);
    });

    it('does not alert on a lure keyword and a bad TLD alone', () => {
      // `login-secure.zip` is nasty-looking, but it resembles nothing we watch.
      const result = assess('login-secure.zip', 'paypal.com');
      expect(result.score).toBe(0);
      expect(result.hits).toEqual([]);
    });
  });

  describe('rule coverage', () => {
    it.each<[RuleId, string, string]>([
      ['homoglyph-ascii', 'paypa1.com', 'paypal.com'],
      ['homoglyph-ascii', 'rnicrosoft.com', 'microsoft.com'],
      ['transposition', 'papyal.com', 'paypal.com'],
      ['omission', 'micrsoft.com', 'microsoft.com'],
      ['insertion', 'paypanl.com', 'paypal.com'],
      ['doubling', 'paypall.com', 'paypal.com'],
      ['hyphenation', 'pay-pal.com', 'paypal.com'],
      ['tld-swap', 'paypal.zip', 'paypal.com'],
      ['combosquat', 'paypal-secure.com', 'paypal.com'],
      ['levenshtein-near', 'paypaq.com', 'paypal.com'],
    ])('fires %s for %s vs %s', (rule, candidate, watched) => {
      const result = assess(candidate, watched);
      expect(fired(result, rule)).toBe(true);
      expect(result.score).toBeGreaterThan(0);
    });

    it('fires the cross-script homoglyph rule for a Cyrillic look-alike', () => {
      const result = assess(`p${CYRILLIC_A}ypal.com`, 'paypal.com');
      expect(fired(result, 'homoglyph-unicode')).toBe(true);
      expect(result.level).toBe('critical');
    });

    it('finds a look-alike hidden in a subdomain of an unrelated domain', () => {
      const result = assess('paypa1.cdn.attacker.tld', 'paypal.com');
      expect(fired(result, 'homoglyph-ascii')).toBe(true);
      expect(result.matchedLabel).toBe('paypa1');
    });

    it('suppresses the generic distance rule when a specific rule explains the edit', () => {
      const result = assess('paypall.com', 'paypal.com');
      expect(fired(result, 'doubling')).toBe(true);
      expect(fired(result, 'levenshtein-near')).toBe(false);
    });

    it('keeps the generic distance rule when no specific pattern matches', () => {
      const result = assess('paypaq.com', 'paypal.com');
      expect(fired(result, 'levenshtein-near')).toBe(true);
    });
  });

  describe('modifiers', () => {
    it('raises the score of a look-alike that also carries a lure keyword', () => {
      const plain = assess('paypa1.com', 'paypal.com');
      const lure = assess('login.paypa1.com', 'paypal.com');
      expect(fired(lure, 'lure-keyword')).toBe(true);
      expect(lure.score).toBeGreaterThan(plain.score);
    });

    it('raises the score of a look-alike on an abuse-heavy TLD', () => {
      const plain = assess('paypa1.com', 'paypal.com');
      const nasty = assess('paypa1.top', 'paypal.com');
      expect(fired(nasty, 'suspicious-tld')).toBe(true);
      expect(nasty.score).toBeGreaterThan(plain.score);
    });

    it('flags punycode and mixed scripts on an IDN homograph', () => {
      const result = assess(`g${CYRILLIC_O}ogle.com`, 'google.com');
      expect(fired(result, 'idn-punycode')).toBe(true);
      expect(fired(result, 'mixed-script')).toBe(true);
    });

    it('never lets modifiers alone produce a score', () => {
      const result = assess('login-verify-secure.zip', 'wikipedia.org');
      expect(result.score).toBe(0);
    });
  });

  describe('IDN and punycode input', () => {
    it('scores the A-label form exactly like the U-label form', () => {
      const unicodeForm = assess(`p${CYRILLIC_A}ypal.com`, 'paypal.com');
      const asciiForm = assess(unicodeForm.candidateAscii, 'paypal.com');
      expect(asciiForm.score).toBe(unicodeForm.score);
      expect(rules(asciiForm)).toEqual(rules(unicodeForm));
    });

    it('reports both forms so the UI can show the deceptive one', () => {
      const result = assess(`p${CYRILLIC_A}ypal.com`, 'paypal.com');
      expect(result.candidateAscii.startsWith('xn--')).toBe(true);
      expect(result.candidateUnicode).toContain(CYRILLIC_A);
    });

    it('scores a watched IDN against its own look-alike', () => {
      const result = assess('xn--bcher-kva.example', 'bucher.example');
      expect(result.score).toBeGreaterThan(0);
    });

    it('handles a name carrying invisible characters', () => {
      const zeroWidth = cp(0x200b);
      const result = assess(`paypa${zeroWidth}1.com`, 'paypal.com');
      expect(result.score).toBeGreaterThan(0);
      expect(fired(result, 'mixed-script')).toBe(true);
    });
  });

  describe('the explanation', () => {
    it('always explains a non-zero score', () => {
      const result = assess('paypa1.com', 'paypal.com');
      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(hit.detail.length).toBeGreaterThan(0);
        expect(hit.title.length).toBeGreaterThan(0);
      }
    });

    it('quotes the specific evidence, not just the rule name', () => {
      const cyrillic = assess(`p${CYRILLIC_A}ypal.com`, 'paypal.com');
      const homoglyphHit = cyrillic.hits.find((hit) => hit.rule === 'homoglyph-unicode');
      expect(homoglyphHit?.detail).toContain('U+0430');

      const doubled = assess('paypall.com', 'paypal.com');
      expect(doubled.hits.find((hit) => hit.rule === 'doubling')?.detail).toContain('position');
    });

    it.each([
      'paypa1.com',
      'papyal.com',
      'login.paypal-secure.top',
      'micrsoft.com',
      'pay-pal.com',
    ])('has contributions that sum to the score for %s', (candidate) => {
      const watched = candidate.includes('micr') ? 'microsoft.com' : 'paypal.com';
      const result = assess(candidate, watched);
      const total = result.hits.reduce((sum, hit) => sum + hit.contribution, 0);
      expect(total).toBe(result.score);
    });

    it('orders hits by contribution, strongest first', () => {
      const result = assess('login.paypa1.top', 'paypal.com');
      const contributions = result.hits.map((hit) => hit.contribution);
      expect([...contributions].sort((a, b) => b - a)).toEqual(contributions);
    });

    it('tags each hit with the kind that justifies its treatment', () => {
      const result = assess('login.paypa1.top', 'paypal.com');
      expect(result.hits.find((hit) => hit.rule === 'homoglyph-ascii')?.kind).toBe('base');
      expect(result.hits.find((hit) => hit.rule === 'lure-keyword')?.kind).toBe('modifier');
    });
  });

  describe('score shape', () => {
    it('stays inside 0-100 for a name that trips every rule it can', () => {
      const result = assess(`login-secure.p${CYRILLIC_A}ypa1-verify.top`, 'paypal.com');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('ranks a cross-script homograph above an ASCII typo', () => {
      const homograph = assess(`p${CYRILLIC_A}ypal.com`, 'paypal.com');
      const typo = assess('paypaq.com', 'paypal.com');
      expect(homograph.score).toBeGreaterThan(typo.score);
    });

    it('ranks a doubled character above a bare TLD swap', () => {
      expect(assess('paypall.com', 'paypal.com').score).toBeGreaterThan(
        assess('paypal.info', 'paypal.com').score,
      );
    });

    it('maps scores onto levels consistently', () => {
      expect(assess('wikipedia.org', 'paypal.com').level).toBe('none');
      expect(assess(`p${CYRILLIC_A}ypal.com`, 'paypal.com').level).toBe('critical');
    });

    it('returns integer scores', () => {
      const result = assess('paypa1.com', 'paypal.com');
      expect(Number.isInteger(result.score)).toBe(true);
      expect(result.hits.every((hit) => Number.isInteger(hit.contribution))).toBe(true);
    });
  });

  describe('robustness', () => {
    it.each(['', '...', 'not a domain', 'https://', '@@@'])(
      'returns a zero score instead of throwing for %j',
      (candidate) => {
        const result = assess(candidate, 'paypal.com');
        expect(result.score).toBe(0);
        expect(result.hits).toEqual([]);
      },
    );

    it('handles an unparseable watchlist entry', () => {
      expect(assess('paypa1.com', '').score).toBe(0);
    });

    it('refuses to fuzzy match a watched name that is too short', () => {
      const result = assess('bit.ly', 'bt.co');
      expect(result.score).toBe(0);
      expect(result.summary).toContain('too short');
    });

    it('normalises case and trailing dots before comparing', () => {
      expect(assess('PayPa1.COM.', 'paypal.com').score).toBe(
        assess('paypa1.com', 'paypal.com').score,
      );
    });
  });
});

describe('assessAgainstWatchlist', () => {
  const watchlist = [entry('paypal.com'), entry('microsoft.com'), entry('example.com')];

  it('returns only the entries that matched, strongest first', () => {
    const results = assessAgainstWatchlist('paypa1.com', watchlist);
    expect(results).toHaveLength(1);
    expect(results[0]?.watched).toBe('paypal.com');
  });

  it('keeps benign matches but ranks them last', () => {
    const results = assessAgainstWatchlist('mail.example.com', watchlist);
    expect(results[results.length - 1]?.benign).toBe(true);
  });

  it('returns an empty list when nothing resembles the watchlist', () => {
    expect(assessAgainstWatchlist('wikipedia.org', watchlist)).toEqual([]);
  });

  it('handles an empty watchlist', () => {
    expect(assessAgainstWatchlist('paypa1.com', [])).toEqual([]);
  });
});

describe('bestAssessment', () => {
  it('returns the strongest match', () => {
    const result = bestAssessment('paypa1.com', [entry('example.com'), entry('paypal.com')]);
    expect(result?.watched).toBe('paypal.com');
  });

  it('returns null when nothing matched', () => {
    expect(bestAssessment('wikipedia.org', [entry('paypal.com')])).toBeNull();
  });
});
