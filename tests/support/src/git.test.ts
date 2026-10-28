import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deterministicGit } from './git.js';
import { useTestWorkspace } from './tmp.js';

/**
 * HEAD after the two commits in `buildRepo`. Identical on Windows and Linux because content is LF,
 * modes are 100644, identity and dates are fixed and no machine config is read.
 * If this changes, the deterministic setup broke (or the fixture below was edited on purpose).
 */
const EXPECTED_HEAD = '8eef1c4ef67fc0a083300cbb91312f88e9ef43fe';

async function buildRepo(dir: string): Promise<string> {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  const git = deterministicGit(dir);
  await git.init();
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  await git.commitAll('chore: first');
  writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
  return git.commitAll('feat: second');
}

describe('deterministicGit', () => {
  const ws = useTestWorkspace();

  it('produces the same commit SHA for the same content in two repositories', async () => {
    const a = await buildRepo(path.join(ws().root, 'a'));
    const b = await buildRepo(path.join(ws().root, 'b'));
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(a).toBe(b);
  });

  it('matches the cross-platform expected HEAD', async () => {
    const head = await buildRepo(path.join(ws().root, 'c'));
    expect(head).toBe(EXPECTED_HEAD);
  });

  it('ignores the machine CRLF setting and stores LF', async () => {
    const dir = path.join(ws().root, 'd');
    mkdirSync(dir);
    const git = deterministicGit(dir);
    await git.init();
    writeFileSync(path.join(dir, 'x.txt'), 'line\n');
    await git.commitAll('add x');
    expect(await git.run(['ls-files', '--eol', 'x.txt'])).toMatch(/i\/lf/);
  });
});
