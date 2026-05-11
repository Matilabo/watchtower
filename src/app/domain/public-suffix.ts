/**
 * A pragmatic subset of the Mozilla Public Suffix List.
 *
 * Why a subset: the full PSL is ~250KB and changes weekly. Shipping it would
 * dominate the bundle and would need a refresh pipeline, while the scorer only
 * needs it to answer one question -- "where does the registrable name end?" --
 * for the handful of suffixes that phishing infrastructure actually uses. The
 * fallback (treat the final label as the suffix) is correct for every gTLD, so
 * an out-of-date list degrades gracefully instead of failing.
 *
 * If this ever needs to be exact, swap `MULTI_LABEL_SUFFIXES` for a generated
 * artefact; nothing outside this file depends on its shape.
 */

/** Suffixes made of more than one label, where the naive "last label" rule fails. */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.ar', 'com.mx', 'com.co', 'com.pe', 'com.uy', 'com.ve', 'com.ec',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 're.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'com.sg', 'com.my', 'com.tw', 'com.ph', 'com.vn', 'co.th', 'co.id', 'co.il',
  'co.za', 'org.za', 'net.za', 'co.ke', 'com.ng', 'com.eg',
  'com.tr', 'com.ua', 'com.ru', 'com.pl', 'com.es', 'com.pt', 'com.gr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'gov.us', 'k12.us', 'ac.at', 'co.at', 'or.at',
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com',
  's3.amazonaws.com', 'web.app', 'firebaseapp.com', 'appspot.com',
  'r2.dev', 'blob.core.windows.net', 'onrender.com', 'fly.dev', 'repl.co',
]);

/**
 * TLDs with a well-documented abuse rate far above the median, or whose whole
 * value proposition is confusability with a file extension. Contributes a
 * small modifier only -- never enough to raise an alert on its own.
 */
export const SUSPICIOUS_TLDS: ReadonlySet<string> = new Set([
  'zip', 'mov', 'top', 'xyz', 'cf', 'gq', 'ml', 'ga', 'tk', 'buzz', 'click',
  'link', 'work', 'kim', 'country', 'stream', 'download', 'loan', 'rest',
  'quest', 'cyou', 'sbs', 'icu', 'monster', 'bar', 'support', 'live', 'cam',
]);

export interface SuffixSplit {
  /** The public suffix, e.g. `co.uk`. */
  readonly suffix: string;
  /** The registrable name without its suffix, e.g. `example`. Empty for a bare TLD. */
  readonly core: string;
  /** The registrable domain (eTLD+1), e.g. `example.co.uk`. */
  readonly registrable: string;
  /** Labels to the left of the registrable domain, e.g. `['login', 'secure']`. */
  readonly subdomains: readonly string[];
}

/**
 * Splits ASCII labels into subdomains / registrable name / public suffix.
 * `labels` must already be lowercased and free of empty entries.
 */
export function splitPublicSuffix(labels: readonly string[]): SuffixSplit {
  if (labels.length === 0) {
    return { suffix: '', core: '', registrable: '', subdomains: [] };
  }
  if (labels.length === 1) {
    return { suffix: labels[0]!, core: '', registrable: labels[0]!, subdomains: [] };
  }

  const lastTwo = labels.slice(-2).join('.');
  const suffixLabelCount = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 2 : 1;

  if (labels.length <= suffixLabelCount) {
    const suffix = labels.join('.');
    return { suffix, core: '', registrable: suffix, subdomains: [] };
  }

  const suffix = labels.slice(-suffixLabelCount).join('.');
  const core = labels[labels.length - suffixLabelCount - 1]!;
  const registrable = `${core}.${suffix}`;
  const subdomains = labels.slice(0, labels.length - suffixLabelCount - 1);
  return { suffix, core, registrable, subdomains };
}

/** The right-most label, which is what a TLD swap actually swaps. */
export function topLevelLabel(suffix: string): string {
  const parts = suffix.split('.');
  return parts[parts.length - 1] ?? '';
}
