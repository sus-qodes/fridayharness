import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FilesListing, GlobCounts } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { codeOf, raw } from '../helpers/ui.js';

/** The scope picker's view of the repository (docs/frontend/PLAN.md §5.11). */

const ws = useTestWorkspace();

describe('files', () => {
  it('lists tracked files one level at a time, folders with their counts, ignored files never', async () => {
    const dir = ws().projectDir;
    mkdirSync(path.join(dir, 'frontend', 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'frontend', 'src', 'a.ts'), 'a');
    writeFileSync(path.join(dir, 'frontend', 'src', 'b.ts'), 'b');
    writeFileSync(path.join(dir, 'frontend', 'index.html'), 'x');
    writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n');
    writeFileSync(path.join(dir, 'secret.txt'), 'nope');
    const td = await startTestDaemon(ws(), { git: true });
    // The daemon helper commits everything written before it starts.
    const top = await td.operator.get<FilesListing>(td.operator.projectPath('/files?dir='));
    expect(top.entries.find((e) => e.name === 'frontend')).toMatchObject({ kind: 'dir', files: 3 });
    expect(top.entries.some((e) => e.name === 'secret.txt')).toBe(false);
    const fe = await td.operator.get<FilesListing>(td.operator.projectPath('/files?dir=frontend'));
    expect(fe.entries.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:frontend/src', 'file:frontend/index.html']);
    const counts = await td.operator.post<GlobCounts>(td.operator.projectPath('/files/match'), {
      globs: ['frontend/**', 'frontend/src/*.ts', 'backend/**'],
    });
    expect(counts.counts).toEqual({ 'frontend/**': 3, 'frontend/src/*.ts': 2, 'backend/**': 0 });
  });

  it('refuses a folder outside the project', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const r = await raw(td, 'GET', td.operator.projectPath('/files?dir=../x'), { token: td.daemon.tokens.operator });
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe('COS-1000');
  });
});
