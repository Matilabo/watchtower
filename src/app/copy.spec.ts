import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * House style, enforced rather than remembered.
 *
 * Em dashes are not used in this repository. They were removed in one pass, and
 * the interesting part of that pass was the fallout: a global replace left
 * three-space holes mid-sentence, and turned two "no value" placeholders in the
 * detail card into a blank space, so those rows rendered empty with nothing to
 * say the value was absent.
 *
 * So this checks both halves: no em dashes, and no gaps of the kind their
 * removal leaves behind. Prose is a deliverable here, and a rule nobody can see
 * is a rule that lasts until the next edit.
 */

const EM_DASH = String.fromCharCode(0x2014);

const ROOTS = ['src', 'e2e'];
const EXTRA_FILES = ['README.md', 'public/README.md'];
const EXTENSIONS = /\.(ts|html|css|md|graphql)$/;

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (EXTENSIONS.test(entry)) found.push(path);
  }
  return found;
}

function sourceFiles(): string[] {
  const files = ROOTS.flatMap((root) => walk(join(process.cwd(), root)));
  return [...files, ...EXTRA_FILES.map((file) => join(process.cwd(), file))];
}

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scan(
  test: (line: string) => boolean,
  options: { readonly skip?: (line: string) => boolean; readonly skipCodeBlocks?: boolean } = {},
): Offence[] {
  const offences: Offence[] = [];

  for (const file of sourceFiles()) {
    // This spec necessarily contains the character it forbids.
    if (file.endsWith('copy.spec.ts')) continue;

    let insideFence = false;

    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (options.skipCodeBlocks === true && line.trimStart().startsWith('```')) {
          insideFence = !insideFence;
          return;
        }
        // Alignment inside a fenced block is deliberate, not a missing dash.
        if (insideFence) return;
        if (options.skip?.(line) === true) return;

        if (test(line)) {
          offences.push({
            file: file.replace(process.cwd(), '').replace(/\\/g, '/'),
            line: index + 1,
            text: line.trim().slice(0, 100),
          });
        }
      });
  }

  return offences;
}

describe('house style', () => {
  it('uses no em dashes', () => {
    const offences = scan((line) => line.includes(EM_DASH));
    expect(offences, `Em dashes found:\n${JSON.stringify(offences, null, 2)}`).toEqual([]);
  });

  it('leaves no three-space holes where punctuation belongs', () => {
    /*
     * Runs of two spaces are load-bearing in plenty of places -- aligned
     * columns in fenced code blocks, indentation, deliberate whitespace inside
     * test fixtures -- so this looks only for the specific signature of a
     * removed dash: three or more spaces between two words on a prose line.
     */
    const offences = scan((line) => /[a-z),.'"`]   +[a-z(`'"]/i.test(line), {
      skipCodeBlocks: true,
      skip: (line) =>
        // Indented code, box-drawing diagrams and markdown tables all align
        // with runs of spaces on purpose.
        /^\s{2,}/.test(line) || /[│┌└├─▶]/.test(line) || line.trim().startsWith('|'),
    });

    expect(offences, `Gaps found:\n${JSON.stringify(offences, null, 2)}`).toEqual([]);
  });
});
