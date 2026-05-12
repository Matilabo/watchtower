/**
 * Edit distance primitives.
 *
 * Two rows instead of a full matrix, plus an optional early exit: the scorer
 * runs this across (certificates x watchlist entries) on every poll, so the
 * common case -- two names that are nothing like each other -- must bail out
 * before doing the full O(n*m) work.
 */

/** Unicode-aware Levenshtein distance (operates on code points, not UTF-16 units). */
export function levenshtein(a: string, b: string, maxDistance = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  const s = Array.from(a);
  const t = Array.from(b);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  // A length gap alone already exceeds the budget; no need to walk the matrix.
  if (Math.abs(s.length - t.length) > maxDistance) return maxDistance + 1;

  let prev = new Array<number>(t.length + 1);
  let curr = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const value = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[t.length]!;
}

/**
 * 1 for identical strings, 0 for maximally different ones.
 * Normalised by the longer string so `ab`/`abc` scores lower than
 * `abcdefghij`/`abcdefghijk`, which is the behaviour we want: a one-character
 * difference matters more in a short name.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(Array.from(a).length, Array.from(b).length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}
