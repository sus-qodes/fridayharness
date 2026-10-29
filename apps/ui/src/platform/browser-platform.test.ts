import { describe, expect, it, vi } from 'vitest';
import { browserPlatform, editorLink } from './browser-platform.js';

describe('editorLink (ERRATA F39)', () => {
  it('builds vscode://file links with forward slashes and an optional line', () => {
    expect(editorLink('C:\\demo\\shop\\src\\a.ts')).toBe('vscode://file/C:/demo/shop/src/a.ts');
    expect(editorLink('C:/demo/shop/src/a.ts', 12)).toBe('vscode://file/C:/demo/shop/src/a.ts:12');
    expect(editorLink('/home/me/shop/a.ts', 3)).toBe('vscode://file/home/me/shop/a.ts:3');
  });

  it('resolves a relative path against the project root', () => {
    expect(editorLink('src/a.ts', undefined, 'C:\\demo\\shop\\')).toBe('vscode://file/C:/demo/shop/src/a.ts');
    expect(editorLink('./src/a.ts', undefined, 'C:/demo/shop')).toBe('vscode://file/C:/demo/shop/src/a.ts');
    expect(editorLink('src/a.ts')).toBeNull();
    expect(editorLink('src/a.ts', undefined, 'relative/root')).toBeNull();
  });

  it('encodes odd characters and refuses unsafe paths', () => {
    expect(editorLink('C:/demo/my file#1?.ts')).toBe('vscode://file/C:/demo/my%20file%231%3F.ts');
    expect(editorLink('C:/demo/../secrets/x')).toBeNull();
    expect(editorLink('C:/demo/a\u0000b')).toBeNull();
    expect(editorLink('C:/demo/a\nb')).toBeNull();
    expect(editorLink('')).toBeNull();
    expect(editorLink('   ')).toBeNull();
    expect(editorLink('<img src=x onerror=alert(1)>', undefined, 'C:/demo')).toBe(
      'vscode://file/C:/demo/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    );
    expect(editorLink('C:/demo/a\u202Eb.ts')).toBe('vscode://file/C:/demo/a%E2%80%AEb.ts');
  });

  it('ignores lines that are not positive integers', () => {
    expect(editorLink('/a.ts', 0)).toBe('vscode://file/a.ts');
    expect(editorLink('/a.ts', -1)).toBe('vscode://file/a.ts');
    expect(editorLink('/a.ts', 1.5)).toBe('vscode://file/a.ts');
    expect(editorLink('/a.ts', Number.NaN)).toBe('vscode://file/a.ts');
  });
});

describe('browserPlatform', () => {
  it('opens files through the link opener, with the root for relative paths', () => {
    const openLink = vi.fn();
    const p = browserPlatform({ openLink, root: () => 'C:/demo/shop' });
    expect(p.kind).toBe('browser');
    p.openInEditor('src/a.ts', 4);
    expect(openLink).toHaveBeenCalledWith('vscode://file/C:/demo/shop/src/a.ts:4');
    p.openInEditor('../x');
    expect(openLink).toHaveBeenCalledOnce();
  });

  it('never throws when the opener or the root fails', () => {
    const p = browserPlatform({
      openLink: () => {
        throw new Error('blocked');
      },
      root: () => {
        throw new Error('no board');
      },
    });
    expect(() => p.openInEditor('C:/a.ts')).not.toThrow();
    expect(() => p.openInEditor('a.ts')).not.toThrow();
  });

  it('opens with a detached anchor by default (no window reference kept)', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    browserPlatform().openInEditor('C:/demo/a.ts');
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.href).toBe('vscode://file/C:/demo/a.ts');
    expect(anchor.rel).toContain('noopener');
    expect(anchor.isConnected).toBe(false);
    click.mockRestore();
  });

  it('copies text and answers false when the page may not', async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await browserPlatform({ clipboard: { writeText } }).copy('git merge friday/goal-1')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('git merge friday/goal-1');
    const refused = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    expect(await browserPlatform({ clipboard: { writeText: refused } }).copy('x')).toBe(false);
    expect(await browserPlatform({ clipboard: null }).copy('x')).toBe(false);
  });

  it('asks the Notification API for permission, and says when there is none', async () => {
    const ask = (requestPermission?: () => Promise<string>) =>
      browserPlatform({ notifications: requestPermission ? { requestPermission } : {} }).requestNotifications();
    expect(await ask(async () => 'granted')).toBe('granted');
    expect(await ask(async () => 'denied')).toBe('denied');
    expect(await ask(async () => 'default')).toBe('default');
    expect(await ask(async () => 'something else')).toBe('default');
    expect(
      await ask(async () => {
        throw new Error('SecurityError');
      }),
    ).toBe('denied');
    expect(await ask()).toBe('unsupported');
    expect(await browserPlatform({ notifications: null }).requestNotifications()).toBe('unsupported');
  });

  it('reads the page’s own Notification API when asked', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    vi.stubGlobal('Notification', { requestPermission });
    try {
      expect(await browserPlatform().requestNotifications()).toBe('granted');
      expect(requestPermission).toHaveBeenCalledOnce();
      vi.stubGlobal('Notification', undefined);
      expect(await browserPlatform().requestNotifications()).toBe('unsupported');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
