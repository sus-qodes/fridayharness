/**
 * Friday's own folders, skipped by the project's linter (2026-11-19, the trial's F18). Tried with
 * ESLint 10.10.0 by hand: `eslint . --max-warnings 0` failed on `.friday/harness/x/hook.mjs` and
 * `.agents/.friday/harness/x/hook.mjs`, and passed once each folder held this file, the project's
 * own eslint.config.js unchanged.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureLintSkip, LINT_SKIP, LINT_SKIP_FILE } from './lint-skip.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'friday-lint-skip-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Friday's folders kept out of the project's lint", () => {
  it('writes the file into each of Friday’s folders the project has, once', () => {
    mkdirSync(path.join(root, '.friday', 'harness'), { recursive: true });
    mkdirSync(path.join(root, '.agents', '.friday'), { recursive: true });
    expect(ensureLintSkip(root)).toEqual(['.friday/eslint.config.mjs', '.agents/.friday/eslint.config.mjs']);
    expect(readFileSync(path.join(root, '.friday', LINT_SKIP_FILE), 'utf8')).toBe(LINT_SKIP);
    expect(LINT_SKIP).toContain("export default [{ ignores: ['**'] }];");
    // Nothing more the next time.
    expect(ensureLintSkip(root)).toEqual([]);
  });

  it('writes nothing where Friday has no scripts, and what a folder git tracks is left to setup', () => {
    // `.friday` with only its settings: no hook launcher to keep out of the lint.
    mkdirSync(path.join(root, '.friday'));
    writeFileSync(path.join(root, '.friday', 'config.yaml'), 'project: {}\n');
    expect(ensureLintSkip(root)).toEqual([]);
    mkdirSync(path.join(root, '.friday', 'harness'));
    mkdirSync(path.join(root, '.agents', '.friday'), { recursive: true });
    expect(ensureLintSkip(root, (folder) => folder === '.friday')).toEqual(['.agents/.friday/eslint.config.mjs']);
  });

  it('makes no folder of its own, and leaves a file already there as it is', () => {
    mkdirSync(path.join(root, '.friday', 'harness'), { recursive: true });
    writeFileSync(path.join(root, '.friday', LINT_SKIP_FILE), 'export default [];\n');
    // No `.agents/.friday`: Antigravity is not set up here, so nothing is made for it.
    expect(ensureLintSkip(root)).toEqual([]);
    expect(readFileSync(path.join(root, '.friday', LINT_SKIP_FILE), 'utf8')).toBe('export default [];\n');
    expect(() => readFileSync(path.join(root, '.agents', '.friday', LINT_SKIP_FILE))).toThrow();
    // A project without Friday's folder at all: nothing.
    rmSync(path.join(root, '.friday'), { recursive: true });
    expect(ensureLintSkip(root)).toEqual([]);
  });
});
