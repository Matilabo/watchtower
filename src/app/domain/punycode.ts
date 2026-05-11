/**
 * Minimal RFC 3492 (Punycode) + RFC 5891 (IDNA A-label/U-label) conversion.
 *
 * Node's built-in `punycode` module is deprecated and is not available in the
 * browser bundle, and pulling a dependency in for ~120 lines of well-specified
 * arithmetic is not worth the supply-chain surface for a security tool. So it
 * lives here, fully unit tested.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = '-';
const MAX_INT = 0x7fffffff;

export const ACE_PREFIX = 'xn--';

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

/** `a`-`z` -> 0..25, `0`-`9` -> 26..35. Returns -1 for anything else. */
function basicToDigit(cp: number): number {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30 + 26;
  if (cp >= 0x41 && cp <= 0x5a) return cp - 0x41;
  if (cp >= 0x61 && cp <= 0x7a) return cp - 0x61;
  return -1;
}

function digitToBasic(digit: number): number {
  // 0..25 -> 'a'..'z', 26..35 -> '0'..'9'
  return digit + 22 + (digit < 26 ? 75 : 0);
}

export class PunycodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PunycodeError';
  }
}

/** Decodes the payload of an A-label (everything after `xn--`). */
export function punycodeDecode(input: string): string {
  if (input.length === 0) throw new PunycodeError('empty punycode payload');

  const output: number[] = [];
  const basicEnd = input.lastIndexOf(DELIMITER);

  if (basicEnd > 0) {
    for (let i = 0; i < basicEnd; i++) {
      const cp = input.charCodeAt(i);
      if (cp >= 0x80) throw new PunycodeError('non-ASCII character in punycode input');
      output.push(cp);
    }
  }

  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  let index = basicEnd > 0 ? basicEnd + 1 : 0;

  while (index < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) throw new PunycodeError('truncated punycode input');
      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit < 0) throw new PunycodeError('invalid punycode digit');
      if (digit > Math.floor((MAX_INT - i) / w)) throw new PunycodeError('punycode overflow');
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) throw new PunycodeError('punycode overflow');
      w *= BASE - t;
    }
    const outLength = output.length + 1;
    bias = adapt(i - oldi, outLength, oldi === 0);
    if (Math.floor(i / outLength) > MAX_INT - n) throw new PunycodeError('punycode overflow');
    n += Math.floor(i / outLength);
    i %= outLength;
    output.splice(i++, 0, n);
  }

  return String.fromCodePoint(...output);
}

/** Encodes a unicode label into an A-label payload (without the `xn--`). */
export function punycodeEncode(input: string): string {
  const codePoints = Array.from(input, (c) => c.codePointAt(0) as number);
  const output: string[] = [];

  for (const cp of codePoints) {
    if (cp < 0x80) output.push(String.fromCharCode(cp));
  }

  const basicLength = output.length;
  let handled = basicLength;
  if (basicLength > 0) output.push(DELIMITER);

  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let delta = 0;

  while (handled < codePoints.length) {
    let m = MAX_INT;
    for (const cp of codePoints) {
      if (cp >= n && cp < m) m = cp;
    }
    if (m - n > Math.floor((MAX_INT - delta) / (handled + 1))) {
      throw new PunycodeError('punycode overflow');
    }
    delta += (m - n) * (handled + 1);
    n = m;

    for (const cp of codePoints) {
      if (cp < n && ++delta > MAX_INT) throw new PunycodeError('punycode overflow');
      if (cp !== n) continue;

      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
        if (q < t) break;
        output.push(String.fromCharCode(digitToBasic(t + ((q - t) % (BASE - t)))));
        q = Math.floor((q - t) / (BASE - t));
      }
      output.push(String.fromCharCode(digitToBasic(q)));
      bias = adapt(delta, handled + 1, handled === basicLength);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }

  return output.join('');
}

/** `xn--80ak6aa92e` -> `аpple`. Non-ACE labels are returned untouched. */
export function toUnicodeLabel(label: string): string {
  if (!label.toLowerCase().startsWith(ACE_PREFIX)) return label;
  try {
    return punycodeDecode(label.slice(ACE_PREFIX.length));
  } catch {
    // A malformed A-label is itself suspicious, but it is not this function's
    // job to judge that: hand the original back and let the scorer see it.
    return label;
  }
}

/** `аpple` -> `xn--80ak6aa92e`. Pure-ASCII labels are returned untouched. */
export function toAsciiLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(label)) return label;
  return ACE_PREFIX + punycodeEncode(label);
}
