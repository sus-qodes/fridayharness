import { describe, expect, it } from 'vitest';
import { checksForChange, documentsOnly } from './analysis.js';

const CHECKS = [
  { name: 'build', kind: 'build' },
  { name: 'typecheck', kind: 'typecheck' },
  { name: 'lint', kind: 'lint' },
  { name: 'tests', kind: 'test' },
];
const names = (list: { name: string }[]) => list.map((c) => c.name);

describe('the checks a change calls for (2026-11-18)', () => {
  it('runs every check for a change to code, whatever else it touches', () => {
    for (const changed of [
      ['src/a.ts'],
      ['src/a.ts', 'README.md'],
      ['package.json'],
      ['docs/site.mdx'],
      ['notes.txt'],
    ]) {
      const f = checksForChange(CHECKS, changed, 'implementation');
      expect(names(f.run), changed.join()).toEqual(['build', 'typecheck', 'lint', 'tests']);
      expect(f).toMatchObject({ skipped: [], why: null });
    }
  });

  it('runs nothing when nothing changed, and says so', () => {
    const f = checksForChange(CHECKS, [], 'implementation');
    expect(f.run).toEqual([]);
    expect(names(f.skipped)).toEqual(['build', 'typecheck', 'lint', 'tests']);
    expect(f.why).toBe('nothing_changed');
    // Running the checks is the work of a verification task.
    expect(names(checksForChange(CHECKS, [], 'verification').run)).toHaveLength(4);
    // A project without checks has nothing to skip, and nothing to say.
    expect(checksForChange([], [], 'implementation')).toEqual({ run: [], skipped: [], why: null });
  });

  it('runs only what reads documents for a change to documents only', () => {
    const f = checksForChange(CHECKS, ['README.md', 'docs/guide/setup.rst', 'CHANGELOG.MD'], 'docs');
    expect(names(f.run)).toEqual(['lint']);
    expect(names(f.skipped)).toEqual(['build', 'typecheck', 'tests']);
    expect(f.why).toBe('documents_only');
    // A check that says it reads documents runs too (tests of a project that checks its own docs).
    const own = [...CHECKS, { name: 'links', kind: 'other', on_documents: true }];
    expect(names(checksForChange(own, ['README.md'], 'docs').run)).toEqual(['lint', 'links']);
    // Nothing skipped, nothing to say.
    expect(checksForChange([{ name: 'lint', kind: 'lint' }], ['README.md'], 'docs').why).toBeNull();
  });

  it('runs every check when what changed is not known', () => {
    expect(names(checksForChange(CHECKS, null, 'implementation').run)).toHaveLength(4);
  });

  it('knows a document by its name, and nothing else as one', () => {
    expect(documentsOnly(['a.md', 'b.markdown', 'c.rst', 'd.adoc'])).toBe(true);
    expect(documentsOnly([])).toBe(false);
    for (const p of ['requirements.txt', 'page.mdx', 'a.md.ts', 'docs/logo.svg', 'LICENSE']) {
      expect(documentsOnly(['a.md', p]), p).toBe(false);
    }
  });
});
