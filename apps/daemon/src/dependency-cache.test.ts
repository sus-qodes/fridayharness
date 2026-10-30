import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DependencyCache,
  dependencyCacheDir,
  dependencyCacheKey,
  META_FILE,
  nodeModulesDirs,
  pathForms,
  rewriteLinkTarget,
  rewritePaths,
} from './dependency-cache.js';
import { silentLogger } from './log.js';

/**
 * Installed trees kept per lockfile: the key, the clone as hard links with links and shim paths
 * rewritten, the restore into another worktree, and the pruning by size.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'friday-depcache-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (dir: string, rel: string, text: string) => {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const dirLink = (target: string, link: string) =>
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined);
const nlink = (p: string) => statSync(p).nlink;

/** A worktree as pnpm leaves it: real files, a link to the virtual store, a shim and `.modules.yaml` naming the worktree. */
function installed(wt: string) {
  write(wt, 'package.json', '{"name":"x"}');
  write(wt, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  write(wt, 'node_modules/.pnpm/a@1.0.0/node_modules/a/index.js', 'module.exports = "a";\n');
  write(wt, 'node_modules/.pnpm/a@1.0.0/node_modules/a/package.json', '{"name":"a","version":"1.0.0"}');
  write(wt, 'node_modules/.pnpm/a@1.0.0/node_modules/a/lib/deep/big.bin', 'x'.repeat(5000));
  write(
    wt,
    'node_modules/.bin/a.cmd',
    `@SET "NODE_PATH=${path.join(wt, 'node_modules', '.pnpm', 'node_modules')}"\r\nnode "%~dp0\\..\\a\\index.js" %*\r\n`,
  );
  write(wt, 'node_modules/.bin/a', `new_node_path='${pathForms(path.join(wt, 'node_modules'))[1]}'\n`);
  write(
    wt,
    'node_modules/.modules.yaml',
    `{\n  "virtualStoreDir": ${JSON.stringify(path.join(wt, 'node_modules', '.pnpm'))}\n}\n`,
  );
  dirLink(path.join(wt, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a'), path.join(wt, 'node_modules', 'a'));
  // A workspace package with its own node_modules, linking back to the root's store.
  write(wt, 'packages/web/package.json', '{"name":"web"}');
  mkdirSync(path.join(wt, 'packages', 'web', 'node_modules'), { recursive: true });
  dirLink(
    path.join(wt, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a'),
    path.join(wt, 'packages', 'web', 'node_modules', 'a'),
  );
  // Source folders, a dot folder and something too deep: never part of the entry.
  write(wt, 'src/index.ts', 'export {};\n');
  write(wt, '.git/HEAD', 'ref: refs/heads/main\n');
  write(wt, 'a/b/c/node_modules/x.js', '');
}

function cache(dir = path.join(root, 'cache'), maxBytes = () => 1024 * 1024 * 1024) {
  return new DependencyCache({ dir, maxBytes, logger: silentLogger });
}

describe('dependencyCacheKey', () => {
  it('changes with the manager, the scripts flag, the lockfile, package.json and the manager configuration, not with other files', async () => {
    const wt = path.join(root, 'wt');
    write(wt, 'package.json', '{"name":"x"}');
    write(wt, 'package-lock.json', '{"lockfileVersion":3}');
    const base = await dependencyCacheKey(wt, 'npm', 'package-lock.json', false);
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(await dependencyCacheKey(wt, 'npm', 'package-lock.json', false)).toBe(base);
    expect(await dependencyCacheKey(wt, 'npm', 'package-lock.json', true)).not.toBe(base);
    expect(await dependencyCacheKey(wt, 'bun', 'package-lock.json', false)).not.toBe(base);
    write(wt, 'src/index.ts', 'export {};\n');
    expect(await dependencyCacheKey(wt, 'npm', 'package-lock.json', false)).toBe(base);
    write(wt, '.npmrc', 'legacy-peer-deps=true\n');
    const withRc = await dependencyCacheKey(wt, 'npm', 'package-lock.json', false);
    expect(withRc).not.toBe(base);
    write(wt, 'package.json', '{"name":"x","version":"2"}');
    const withManifest = await dependencyCacheKey(wt, 'npm', 'package-lock.json', false);
    expect(withManifest).not.toBe(withRc);
    write(wt, 'package-lock.json', '{"lockfileVersion":3,"packages":{}}');
    expect(await dependencyCacheKey(wt, 'npm', 'package-lock.json', false)).not.toBe(withManifest);
  });
});

describe('nodeModulesDirs', () => {
  it('finds the root folder first, then workspace packages up to three levels down, never inside dot folders', async () => {
    const wt = path.join(root, 'wt');
    installed(wt);
    mkdirSync(path.join(wt, '.hidden', 'node_modules'), { recursive: true });
    expect(await nodeModulesDirs(wt)).toEqual(['node_modules', 'packages/web/node_modules']);
    expect(await nodeModulesDirs(path.join(root, 'nothing'))).toEqual([]);
  });
});

describe('path rewriting', () => {
  it('rewrites a path in every form a package manager writes it', () => {
    if (process.platform === 'win32') {
      expect(pathForms('C:\\wt\\one')).toEqual(['C:\\wt\\one', 'C:/wt/one', 'C:\\\\wt\\\\one', '/mnt/c/wt/one']);
      const text = 'a=C:\\wt\\one\\x;b=C:/wt/one/y;c="C:\\\\wt\\\\one";d=/mnt/c/wt/one/z;e=C:\\wt\\other';
      expect(rewritePaths(text, 'C:\\wt\\one', 'D:\\cache\\k\\tree')).toBe(
        'a=D:\\cache\\k\\tree\\x;b=D:/cache/k/tree/y;c="D:\\\\cache\\\\k\\\\tree";d=/mnt/d/cache/k/tree/z;e=C:\\wt\\other',
      );
      expect(rewriteLinkTarget('C:\\wt\\one\\node_modules\\.pnpm\\a', 'C:\\wt\\one', 'D:\\k\\tree')).toBe(
        'D:\\k\\tree\\node_modules\\.pnpm\\a',
      );
      expect(rewriteLinkTarget('\\\\?\\C:\\WT\\ONE\\x', 'C:\\wt\\one', 'D:\\k')).toBe('D:\\k\\x');
      expect(rewriteLinkTarget('C:\\wt\\one-more\\x', 'C:\\wt\\one', 'D:\\k')).toBe('C:\\wt\\one-more\\x');
    } else {
      expect(pathForms('/wt/one')).toEqual(['/wt/one']);
      expect(rewritePaths('a=/wt/one/x;e=/wt/other', '/wt/one', '/cache/k/tree')).toBe('a=/cache/k/tree/x;e=/wt/other');
      expect(rewriteLinkTarget('/wt/one/node_modules/a', '/wt/one', '/k/tree')).toBe('/k/tree/node_modules/a');
      expect(rewriteLinkTarget('/wt/one-more/x', '/wt/one', '/k')).toBe('/wt/one-more/x');
    }
    expect(rewriteLinkTarget('../.pnpm/a/node_modules/a', '/wt/one', '/k')).toBe('../.pnpm/a/node_modules/a');
  });
});

describe('DependencyCache', () => {
  it('lives beside the worktrees folder', () => {
    expect(dependencyCacheDir(path.join(root, 'state', 'friday-worktrees'))).toBe(
      path.join(root, 'state', 'friday-dependency-cache'),
    );
  });

  it('stores a worktree as hard links with links and shims naming the entry, and restores it into another worktree naming that one', async () => {
    const c = cache();
    const wt1 = path.join(root, 'wt1');
    installed(wt1);
    const key = await dependencyCacheKey(wt1, 'pnpm', 'pnpm-lock.yaml', false);
    expect(await c.lookup(key)).toBeNull();

    const stored = await c.store(key, wt1, { manager: 'pnpm', lockfile: 'pnpm-lock.yaml', scripts: false });
    expect(stored).toMatchObject({ files: 6, links: 2, copied: 3 });
    expect(stored?.linked).toBe(3);
    expect(stored?.bytes ?? 0).toBeGreaterThan(5000);
    const meta = await c.lookup(key);
    expect(meta).toMatchObject({
      key,
      manager: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
      scripts: false,
      files: 6,
      dirs: ['node_modules', 'packages/web/node_modules'],
    });
    const tree = path.join(c.entryDir(key), 'tree');
    const entryFile = path.join(tree, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a', 'index.js');
    // The same file, not a copy; the link and the shim name the entry, not the worktree.
    expect(nlink(entryFile)).toBe(2);
    expect(
      path.resolve(
        path.dirname(path.join(tree, 'node_modules', 'a')),
        readlinkSync(path.join(tree, 'node_modules', 'a')),
      ),
    ).toBe(path.join(tree, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a'));
    expect(readFileSync(path.join(tree, 'node_modules', '.bin', 'a.cmd'), 'utf8')).toContain(
      path.join(tree, 'node_modules'),
    );
    expect(readFileSync(path.join(tree, 'node_modules', '.bin', 'a.cmd'), 'utf8')).not.toContain(wt1);
    expect(readFileSync(path.join(tree, 'node_modules', '.modules.yaml'), 'utf8')).toContain(
      JSON.stringify(path.join(tree, 'node_modules', '.pnpm')),
    );
    // Nothing outside node_modules folders, and nothing too deep, is in the entry.
    expect(existsSync(path.join(tree, 'src'))).toBe(false);
    expect(existsSync(path.join(tree, 'a'))).toBe(false);
    expect(existsSync(path.join(tree, 'packages', 'web', 'package.json'))).toBe(false);

    const wt2 = path.join(root, 'wt2');
    write(wt2, 'package.json', '{"name":"x"}');
    mkdirSync(path.join(wt2, 'packages', 'web'), { recursive: true });
    const restored = await c.restore(key, wt2);
    expect(restored).toMatchObject({ files: 6, links: 2, copied: 3, linked: 3 });
    const file2 = path.join(wt2, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a', 'index.js');
    expect(readFileSync(file2, 'utf8')).toBe('module.exports = "a";\n');
    expect(nlink(file2)).toBe(3);
    expect(readFileSync(path.join(wt2, 'node_modules', 'a', 'index.js'), 'utf8')).toBe('module.exports = "a";\n');
    expect(path.resolve(path.join(wt2, 'node_modules'), readlinkSync(path.join(wt2, 'node_modules', 'a')))).toBe(
      path.join(wt2, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a'),
    );
    expect(
      path.resolve(
        path.join(wt2, 'packages', 'web', 'node_modules'),
        readlinkSync(path.join(wt2, 'packages', 'web', 'node_modules', 'a')),
      ),
    ).toBe(path.join(wt2, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a'));
    const shim = readFileSync(path.join(wt2, 'node_modules', '.bin', 'a.cmd'), 'utf8');
    expect(shim).toContain(path.join(wt2, 'node_modules', '.pnpm', 'node_modules'));
    expect(shim).not.toContain(tree);
    expect(readFileSync(path.join(wt2, 'node_modules', '.bin', 'a'), 'utf8')).toContain(
      pathForms(path.join(wt2, 'node_modules'))[1],
    );
    expect(readFileSync(path.join(wt2, 'node_modules', '.modules.yaml'), 'utf8')).toContain(
      JSON.stringify(path.join(wt2, 'node_modules', '.pnpm')),
    );
    expect(Date.parse((await c.lookup(key))?.last_used_at ?? '')).not.toBeLessThan(
      Date.parse(meta?.last_used_at ?? ''),
    );

    // The worktrees own their entries: a change in one reaches neither the other nor the cache.
    rmSync(path.join(wt2, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a', 'package.json'));
    writeFileSync(path.join(wt2, 'node_modules', 'added.js'), '');
    expect(existsSync(path.join(wt1, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a', 'package.json'))).toBe(
      true,
    );
    expect(existsSync(path.join(tree, 'node_modules', '.pnpm', 'a@1.0.0', 'node_modules', 'a', 'package.json'))).toBe(
      true,
    );
    expect(existsSync(path.join(tree, 'node_modules', 'added.js'))).toBe(false);
    // Removing the worktree leaves the entry whole.
    rmSync(wt2, { recursive: true, force: true });
    expect(readFileSync(entryFile, 'utf8')).toBe('module.exports = "a";\n');
    expect(nlink(entryFile)).toBe(2);
  });

  it('leaves a node_modules that is already there, and a package folder the checkout lacks', async () => {
    const c = cache();
    const wt1 = path.join(root, 'wt1');
    installed(wt1);
    const key = await dependencyCacheKey(wt1, 'pnpm', 'pnpm-lock.yaml', false);
    await c.store(key, wt1, { manager: 'pnpm', lockfile: 'pnpm-lock.yaml', scripts: false });
    const wt2 = path.join(root, 'wt2');
    write(wt2, 'node_modules/mine.js', 'kept');
    const restored = await c.restore(key, wt2);
    expect(restored.files).toBe(0);
    expect(readFileSync(path.join(wt2, 'node_modules', 'mine.js'), 'utf8')).toBe('kept');
    expect(existsSync(path.join(wt2, 'packages'))).toBe(false);
  });

  it('stores nothing for a worktree without node_modules, and keeps the first entry of a key', async () => {
    const c = cache();
    const bare = path.join(root, 'bare');
    write(bare, 'package.json', '{}');
    expect(await c.store('k', bare, { manager: 'npm', lockfile: 'package-lock.json', scripts: false })).toBeNull();
    expect(await c.lookup('k')).toBeNull();
    const wt1 = path.join(root, 'wt1');
    installed(wt1);
    await c.store('same', wt1, { manager: 'pnpm', lockfile: 'pnpm-lock.yaml', scripts: false });
    const first = await c.lookup('same');
    const wt2 = path.join(root, 'wt2');
    write(wt2, 'node_modules/other.js', '');
    await c.store('same', wt2, { manager: 'pnpm', lockfile: 'pnpm-lock.yaml', scripts: false });
    expect(await c.lookup('same')).toEqual(first);
    expect(existsSync(path.join(c.entryDir('same'), 'tree', 'node_modules', 'other.js'))).toBe(false);
    // No staging folder is left behind.
    expect(existsSync(c.dir) && readFileSync(path.join(c.entryDir('same'), META_FILE), 'utf8')).toBeTruthy();
    expect((await c.entries()).map((e) => e.key)).toEqual(['same']);
  });

  it('prunes the least recently used entries once over its size, never the one just stored', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const c = new DependencyCache({
      dir: path.join(root, 'cache'),
      maxBytes: () => 12_000,
      logger: silentLogger,
      now: () => new Date(now),
    });
    const make = async (name: string, bytes: number) => {
      const wt = path.join(root, name);
      write(wt, 'node_modules/big.bin', 'x'.repeat(bytes));
      now += 1000;
      await c.store(name, wt, { manager: 'npm', lockfile: 'package-lock.json', scripts: false });
      return wt;
    };
    await make('one', 5000);
    await make('two', 5000);
    expect((await c.entries()).map((e) => e.key)).toEqual(['one', 'two']);
    // A use makes `one` the newer entry.
    now += 1000;
    mkdirSync(path.join(root, 'use'));
    await c.restore('one', path.join(root, 'use'));
    // The third pushes the cache over 12,000 bytes: `two`, least recently used, goes.
    await make('three', 5000);
    expect((await c.entries()).map((e) => e.key)).toEqual(['one', 'three']);
    expect(existsSync(c.entryDir('two'))).toBe(false);
    // The worktree restored from `one` keeps its files whatever happens to the entry.
    await make('four', 11_000);
    expect((await c.entries()).map((e) => e.key)).toEqual(['four']);
    expect(readFileSync(path.join(root, 'use', 'node_modules', 'big.bin'), 'utf8')).toHaveLength(5000);
    // Nothing to remove below the size; a missing cache folder is empty.
    expect(await c.prune()).toEqual([]);
    expect(await cache(path.join(root, 'none')).entries()).toEqual([]);
  });
});
