import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type RecordedCall } from '../test/context.js';
import { globFor, MATCH_DEBOUNCE_MS, parentDir, scopePicker } from './scope-picker.js';
import { BIDI, buttonBy, flush, HOSTILE, LONG, ZW } from './test-support.js';

function addGlob(el: HTMLElement, glob: string) {
  const input = el.querySelector('.pn-scope-add input') as HTMLInputElement;
  input.value = glob;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}

describe('scope picker helpers', () => {
  it('turns listing entries into globs and walks up folders', () => {
    expect(globFor({ path: 'backend', kind: 'dir' })).toBe('backend/**');
    expect(globFor({ path: 'backend/', kind: 'dir' })).toBe('backend/**');
    expect(globFor({ path: 'a/b.ts', kind: 'file' })).toBe('a/b.ts');
    expect(parentDir('a/b/c')).toBe('a/b');
    expect(parentDir('a')).toBe('');
  });
});

describe('scope picker counts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces the match counts by 300 ms and asks once for every glob', async () => {
    const ctx = makeContext({
      answers: { 'POST /files/match': { counts: { 'backend/**': 3, 'nothing/**': 0 }, total: 3, truncated: false } },
    });
    const changes: string[][] = [];
    const picker = scopePicker(ctx, { label: 'Write scope', value: [], onChange: (g) => changes.push(g) });
    addGlob(picker.el, 'backend/**');
    await vi.advanceTimersByTimeAsync(MATCH_DEBOUNCE_MS - 1);
    expect(ctx.transport.to('POST', '/files/match')).toHaveLength(0);
    addGlob(picker.el, 'nothing/**');
    await vi.advanceTimersByTimeAsync(MATCH_DEBOUNCE_MS - 1);
    expect(ctx.transport.to('POST', '/files/match')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const calls = ctx.transport.to('POST', '/files/match');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ globs: ['backend/**', 'nothing/**'] });
    expect(changes.at(-1)).toEqual(['backend/**', 'nothing/**']);
    const counts = Array.from(picker.el.querySelectorAll('.pn-glob-count')).map((e) => e.textContent);
    expect(counts).toEqual(['3 files', 'matches no tracked file']);
    expect(picker.el.querySelectorAll('.pn-glob-zero')).toHaveLength(1);
    picker.destroy();
  });

  it('counts the initial globs, ignores a stale answer, and stops on destroy', async () => {
    let resolveFirst: ((v: unknown) => void) | null = null;
    let n = 0;
    const ctx = makeContext({
      answers: {
        'POST /files/match': () => {
          n += 1;
          if (n === 1) return new Promise((r) => (resolveFirst = r));
          return { counts: { 'a/**': 1, 'b/**': 2 }, total: 3, truncated: false };
        },
      },
    });
    const picker = scopePicker(ctx, { label: 'Read scope', value: ['a/**'], onChange: () => undefined });
    await vi.advanceTimersByTimeAsync(MATCH_DEBOUNCE_MS);
    expect(n).toBe(1);
    addGlob(picker.el, 'b/**');
    await vi.advanceTimersByTimeAsync(MATCH_DEBOUNCE_MS);
    expect(n).toBe(2);
    (resolveFirst as unknown as (v: unknown) => void)({ counts: { 'a/**': 99 } });
    await flush();
    const texts = Array.from(picker.el.querySelectorAll('.pn-glob-count')).map((e) => e.textContent);
    expect(texts).toEqual(['1 file', '2 files']);
    addGlob(picker.el, 'c/**');
    picker.destroy();
    await vi.advanceTimersByTimeAsync(MATCH_DEBOUNCE_MS * 2);
    expect(n).toBe(2);
  });

  it('says when a count failed and asks again on the next change', async () => {
    const ctx = makeContext({
      answers: {
        'POST /files/match': () => {
          throw new Error('offline');
        },
      },
    });
    const picker = scopePicker(ctx, { label: 'Write scope', value: ['a/**'], onChange: () => undefined });
    await vi.advanceTimersByTimeAsync(MATCH_DEBOUNCE_MS);
    expect(picker.el.querySelector('.pn-glob-count')?.textContent).toBe('not counted');
    picker.destroy();
  });
});

describe('scope picker editing', () => {
  it('refuses globs that are not project-relative, and duplicates', async () => {
    const ctx = makeContext();
    const changes: string[][] = [];
    const picker = scopePicker(ctx, {
      label: 'Write scope',
      value: ['a/**'],
      onChange: (g) => changes.push(g),
      debounceMs: 0,
    });
    addGlob(picker.el, '../outside/**');
    const error = picker.el.querySelector('.pn-scope > .field-error') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toMatch(/project-relative/);
    addGlob(picker.el, 'a/**');
    expect(error.textContent).toMatch(/already in the list/);
    expect(changes).toEqual([]);
    buttonBy(picker.el, 'Remove a/**').click();
    expect(changes).toEqual([[]]);
    expect(picker.globs).toEqual([]);
    picker.destroy();
  });

  it('browses folders, opens one and adds it as folder/**', async () => {
    const ctx = makeContext({
      answers: {
        'GET /files': (c: RecordedCall) =>
          c.path.includes('dir=backend')
            ? {
                dir: 'backend',
                entries: [{ name: 'server.ts', path: 'backend/server.ts', kind: 'file', files: null }],
                truncated: false,
              }
            : {
                dir: '',
                entries: [
                  { name: 'backend', path: 'backend', kind: 'dir', files: 12 },
                  { name: 'README.md', path: 'README.md', kind: 'file', files: null },
                ],
                truncated: true,
              },
        'POST /files/match': { counts: {}, total: 0, truncated: false },
      },
    });
    const changes: string[][] = [];
    const picker = scopePicker(ctx, {
      label: 'Write scope',
      value: [],
      onChange: (g) => changes.push(g),
      debounceMs: 0,
    });
    document.body.append(picker.el);
    buttonBy(picker.el, 'Browse folders').click();
    await flush();
    expect(picker.el.querySelector('.pn-browser')?.textContent).toMatch(/12 files/);
    expect(picker.el.querySelector('.pn-browser')?.textContent).toMatch(/Only the first entries/);
    buttonBy(picker.el, 'Add backend/**').click();
    expect(changes.at(-1)).toEqual(['backend/**']);
    buttonBy(picker.el, 'Open the folder backend').click();
    await flush();
    expect(ctx.transport.calls.some((c) => c.path.endsWith('/files?dir=backend'))).toBe(true);
    buttonBy(picker.el, 'Add backend/server.ts').click();
    expect(changes.at(-1)).toEqual(['backend/**', 'backend/server.ts']);
    buttonBy(picker.el, 'Up one folder').click();
    await flush();
    expect(ctx.transport.calls.filter((c) => c.path.endsWith('/files?dir='))).toHaveLength(2);
    picker.destroy();
  });

  it('renders hostile folder and file names as text with visible marks', async () => {
    const names = [HOSTILE, BIDI, ZW, LONG];
    const ctx = makeContext({
      answers: {
        'GET /files': {
          dir: '',
          entries: names.map((n, i) => ({ name: n, path: n, kind: i % 2 ? 'file' : 'dir', files: 1 })),
          truncated: false,
        },
        'POST /files/match': { counts: {}, total: 0, truncated: false },
      },
    });
    const picker = scopePicker(ctx, {
      label: 'Write scope',
      value: [HOSTILE, BIDI],
      onChange: () => undefined,
      debounceMs: 0,
    });
    buttonBy(picker.el, 'Browse folders').click();
    await flush();
    expect(picker.el.querySelector('img')).toBeNull();
    const text = picker.el.textContent ?? '';
    expect(text).toContain(HOSTILE);
    expect(text).toContain('⟨U+202E⟩');
    expect(text).toContain('⟨U+200B⟩');
    expect(text).not.toContain('‮');
    expect(text).toContain(LONG);
    picker.destroy();
  });
});
