import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Contrast is a requirement, so it is a test.
 *
 * The tokens are read out of the real stylesheet rather than duplicated here:
 * changing `--wt-text-muted` to something prettier and slightly too dim should
 * fail the build, which is the only way a colour rule survives contact with a
 * redesign.
 */

const STYLES = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(STYLES);
  if (match === null) throw new Error(`Token --${name} not found or not a hex colour`);
  return match[1] as string;
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const int = Number.parseInt(full.slice(0, 6), 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

const SURFACE = 'wt-surface';
const SUNKEN = 'wt-surface-sunken';
const RAISED = 'wt-surface-raised';

/** [description, foreground token, background token, minimum ratio] */
const TEXT_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['body text on a panel', 'wt-text', SURFACE],
  ['body text on a sunken field', 'wt-text', SUNKEN],
  ['body text on a raised button', 'wt-text', RAISED],
  ['body text on the page background', 'wt-text', 'wt-bg'],
  ['muted text on a panel', 'wt-text-muted', SURFACE],
  ['muted text on a sunken field', 'wt-text-muted', SUNKEN],
  ['section headings', 'wt-accent-strong', SURFACE],
  ['accent text', 'wt-accent', SURFACE],
  ['critical risk label', 'wt-risk-critical', SURFACE],
  ['high risk label', 'wt-risk-high', SURFACE],
  ['medium risk label', 'wt-risk-medium', SURFACE],
  ['low risk label', 'wt-risk-low', SURFACE],
  ['benign label', 'wt-risk-benign', SURFACE],
  ['error text', 'wt-danger', SURFACE],
  ['warning text', 'wt-warning', SURFACE],
  ['primary button label', 'wt-accent-contrast', 'wt-accent'],
];

/** Non-text UI: focus rings and boundaries need 3:1, not 4.5:1. */
const UI_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['focus ring against a panel', 'wt-accent-strong', SURFACE],
  ['focus ring against a sunken field', 'wt-accent-strong', SUNKEN],
  ['focus ring against the page background', 'wt-accent-strong', 'wt-bg'],
];

describe('palette contrast', () => {
  it.each(TEXT_PAIRS)('%s meets WCAG AA for text (4.5:1)', (_name, fg, bg) => {
    expect(contrastRatio(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(UI_PAIRS)('%s meets WCAG AA for non-text (3:1)', (_name, fg, bg) => {
    expect(contrastRatio(token(fg), token(bg))).toBeGreaterThanOrEqual(3);
  });

  it('gives each risk level a distinct colour', () => {
    const levels = ['critical', 'high', 'medium', 'low', 'none'].map((level) =>
      token(`wt-risk-${level}`),
    );
    expect(new Set(levels).size).toBe(levels.length);
  });

  it('paints a solid background colour behind the photograph', () => {
    // Panels are translucent, so contrast is only guaranteed if something
    // opaque and known sits underneath the background image.
    expect(STYLES).toMatch(/background-color:\s*var\(--wt-bg\)/);
  });

  it('keeps a readable fallback when the background image is missing', () => {
    const backgroundImage = /background-image:[\s\S]*?;/.exec(STYLES)?.[0] ?? '';
    expect(backgroundImage).toContain('linear-gradient');
    expect(backgroundImage).toContain('var(--wt-backdrop)');
    expect(STYLES).toMatch(/--wt-backdrop:\s*url\("\.\/assets\/background/);
  });

  it('serves a smaller backdrop to small screens', () => {
    expect(STYLES).toContain('background-1280.jpg');
  });

  it('references the backdrop relatively, so it survives being served from a subpath', () => {
    // An absolute "/background.jpg" resolves at the domain root, so it 404s on
    // a GitHub Pages project site, which is served from /<repo>/.
    const urls = STYLES.match(/url\("[^"]+"\)/g) ?? [];
    expect(urls.filter((url) => url.startsWith('url("/'))).toEqual([]);
  });

  it('inverts selected text instead of leaving it to the browser default', () => {
    const selection = /::selection\s*{[^}]*}/.exec(STYLES)?.[0] ?? '';
    expect(selection).toContain('var(--wt-accent-strong)');
    expect(selection).toContain('var(--wt-accent-contrast)');
    expect(
      contrastRatio(token('wt-accent-contrast'), token('wt-accent-strong')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('has no text glow anywhere', () => {
    // A halo is the first thing to blur small type and the first thing to fail
    // at 200% zoom, so it is banned rather than tuned.
    const declarations = STYLES.match(/text-shadow:[^;]+;/g) ?? [];
    expect(declarations.filter((rule) => !/text-shadow:\s*none\s*;/.test(rule))).toEqual([]);
  });

  it('respects a reduced-motion preference', () => {
    expect(STYLES).toContain('prefers-reduced-motion: reduce');
  });

  it('ships a visible focus style rather than removing outlines', () => {
    expect(STYLES).toContain(':focus-visible');
    expect(STYLES).not.toMatch(/outline:\s*(none|0)\s*;/);
  });
});
