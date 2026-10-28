import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAlive, killTree, spawnNode, waitForExit, waitForPidGone } from './proc.js';
import { useTestWorkspace } from './tmp.js';

const PARENT_SCRIPT = `
import { spawn } from 'node:child_process';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(String(grandchild.pid) + '\\n');
setInterval(() => {}, 1000);
`;

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) resolve(buf.slice(0, nl).trim());
    });
    stream.on('error', reject);
  });
}

describe('proc', () => {
  const ws = useTestWorkspace();

  it('isAlive reports the current process and rejects an unused pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2_147_483_000)).toBe(false);
  });

  it('killTree stops a child and its grandchild', async () => {
    const script = path.join(ws().root, 'parent.mjs');
    writeFileSync(script, PARENT_SCRIPT);
    const child = ws().track(spawnNode(script));
    const stdout = child.stdout;
    if (!stdout || child.pid === undefined) throw new Error('child did not start');

    const grandchildPid = Number(await firstLine(stdout));
    expect(grandchildPid).toBeGreaterThan(0);
    expect(isAlive(child.pid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    await killTree(child.pid);
    await waitForExit(child, 5_000);
    expect(await waitForPidGone(grandchildPid, 5_000)).toBe(true);
  });

  it('killTree on a pid that is already gone is a no-op', async () => {
    await expect(killTree(2_147_483_000)).resolves.toBeUndefined();
    await expect(killTree(undefined)).resolves.toBeUndefined();
  });
});
