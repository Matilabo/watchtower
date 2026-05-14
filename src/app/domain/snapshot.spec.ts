import { describe, expect, it } from 'vitest';

import { assess } from './scorer';

/**
 * A calibration table rather than a unit test.
 *
 * These are the cases an analyst will actually see, in the order the scorer
 * ranks them. Keeping them in one snapshot makes any weight change visible as
 * a diff: if a tweak to the homoglyph weight quietly demotes a Cyrillic
 * homograph below a hyphenation variant, this test says so.
 */
describe('score calibration', () => {
  const CYRILLIC_A = String.fromCodePoint(0x0430);
  const watched = 'paypal.com';

  const candidates = [
    `p${CYRILLIC_A}ypal.com`,
    'login-secure.paypa1.top',
    'paypa1.com',
    'rnypaypal.com',
    'papyal.com',
    'paypall.com',
    'paypa.com',
    'pay-pal.com',
    'paypal-secure.com',
    'paypal.zip',
    'paypal.info',
    'paypaq.com',
    'mail.paypal.com',
    'wikipedia.org',
  ];

  it('ranks candidates in a defensible order', () => {
    const ranked = candidates
      .map((candidate) => assess(candidate, watched))
      .sort((a, b) => b.score - a.score)
      .map((result) => `${String(result.score).padStart(3, ' ')}  ${result.level.padEnd(8, ' ')}  ${result.candidateUnicode}`);

    expect(ranked).toMatchInlineSnapshot(`
      [
        " 95  critical  pаypal.com",
        " 87  critical  login-secure.paypa1.top",
        " 78  high      paypa1.com",
        " 74  high      papyal.com",
        " 71  high      paypal-secure.com",
        " 70  high      paypa.com",
        " 64  high      paypall.com",
        " 64  high      pay-pal.com",
        " 62  high      rnypaypal.com",
        " 62  high      paypal.zip",
        " 55  medium    paypal.info",
        " 55  medium    paypaq.com",
        "  0  none      mail.paypal.com",
        "  0  none      wikipedia.org",
      ]
    `);
  });

  it('puts every alert above zero into a level a human can act on', () => {
    for (const candidate of candidates) {
      const result = assess(candidate, watched);
      if (result.score > 0) {
        expect(result.level).not.toBe('none');
        expect(result.hits.length).toBeGreaterThan(0);
      }
    }
  });
});
