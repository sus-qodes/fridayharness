/**
 * The browser platform (plan FD-07, §7.7 "Open in VS Code", ERRATA F39): files open in VS Code
 * through `vscode://file/<absolute path>[:line]` links, and text goes to the clipboard when the
 * page may write it. Relative paths are resolved against the project root when one is known.
 */
import type { Platform } from '../shell/context.js';

export interface BrowserPlatformEnv {
  /** Opens a link the operating system hands to VS Code (default: a detached anchor's click). */
  openLink?: (url: string) => void;
  clipboard?: Pick<Clipboard, 'writeText'> | null;
  /** The project root, for paths given relative to it. */
  root?: () => string | null | undefined;
}

/** Characters that never belong in a path the page opens. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
const CONTROL = /[\u0000-\u001f\u007f]/;

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

/**
 * The `vscode://file/…` link for a path, or null when the path cannot be opened safely (empty,
 * control characters, `..` segments, or relative without a root).
 */
export function editorLink(path: string, line?: number, root?: string | null): string | null {
  if (typeof path !== 'string' || !path.trim() || CONTROL.test(path)) return null;
  let p = path.replace(/\\/g, '/');
  if (!isAbsolute(p)) {
    if (!root || CONTROL.test(root)) return null;
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!isAbsolute(base)) return null;
    p = `${base}/${p.replace(/^\.?\/+/, '')}`;
  }
  const segments = p.split('/');
  if (segments.some((s) => s === '..')) return null;
  const kept = segments.filter((s, i) => (s !== '' || i === 0) && s !== '.');
  const encoded = kept
    .map((s, i) => {
      const e = encodeURIComponent(s);
      // Keep a drive letter readable: `C:` rather than `C%3A`.
      return i <= 1 && /^[A-Za-z]%3A$/.test(e) ? `${s}` : e;
    })
    .join('/');
  const withSlash = encoded.startsWith('/') ? encoded : `/${encoded}`;
  const lineOk = typeof line === 'number' && Number.isInteger(line) && line > 0 && line < 10_000_000;
  return `vscode://file${withSlash}${lineOk ? `:${line}` : ''}`;
}

function anchorOpen(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  a.click();
}

export function browserPlatform(env: BrowserPlatformEnv = {}): Platform {
  const openLink = env.openLink ?? anchorOpen;
  return {
    kind: 'browser',
    openInEditor(path: string, line?: number): void {
      let root: string | null | undefined = null;
      try {
        root = env.root?.();
      } catch {
        root = null;
      }
      const url = editorLink(path, line, root);
      if (!url) return;
      try {
        openLink(url);
      } catch {
        // The browser refused to hand the link on; nothing else to do from a page.
      }
    },
    async copy(text: string): Promise<boolean> {
      const clipboard =
        env.clipboard !== undefined
          ? env.clipboard
          : typeof navigator !== 'undefined'
            ? (navigator.clipboard ?? null)
            : null;
      if (!clipboard) return false;
      try {
        await clipboard.writeText(String(text));
        return true;
      } catch {
        return false;
      }
    },
  };
}
