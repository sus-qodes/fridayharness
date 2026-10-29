import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundledHookSource } from '@friday/adapter-claude';
import { loadProject, renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { applyCursorPlan, planCursor } from './config.js';
import type { CursorCli } from './detect.js';
import { cursorDoctor } from './doctor.js';

const ws = useTestWorkspace();
const PROJECT_ID = `proj_${'0'.repeat(24)}d1`;
const NO_CLI: CursorCli = { binary: null, version: null, versions: [], problem: 'not found', checked: [] };

function configured(): string {
  const root = ws().projectDir;
  mkdirSync(path.join(root, '.friday'), { recursive: true });
  writeFileSync(path.join(root, '.friday', 'config.yaml'), renderInitialConfig(PROJECT_ID, 'doctor-test'));
  applyCursorPlan(
    planCursor({ projectDir: root, hookSource: bundledHookSource(), env: { FRIDAY_STATE_DIR: ws().stateDir } }),
    root,
  );
  return root;
}
const doctor = (root: string, ide: { version: string | null } | null = { version: '3.24.0' }) =>
  cursorDoctor(loadProject(root), {
    skipMcp: true,
    env: { ...process.env, FRIDAY_STATE_DIR: ws().stateDir, FRIDAY_MCP_ENTRY: '' },
    ide: ide ? { dir: path.join(ws().root, 'cursor'), version: ide.version, version_source: null } : null,
    cli: NO_CLI,
  });
const check = (r: Awaited<ReturnType<typeof cursorDoctor>>, id: string) => r.checks.find((c) => c.id === id);
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? snapshot(path.join(dir, e.name))
      : [`${path.join(dir, e.name)}:${statSync(path.join(dir, e.name)).mtimeMs}`],
  );

describe('friday harness doctor cursor', () => {
  it("checks Friday's files, sees the launcher fail closed with Friday down, and changes nothing", async () => {
    const root = configured();
    const before = snapshot(root);
    const r = await doctor(root);
    for (const id of ['cursor.ide', 'cursor.hook', 'cursor.launcher', 'cursor.hooks', 'cursor.mcp-json', 'cursor.rule'])
      expect(check(r, id)?.status, `${id}: ${check(r, id)?.message}`).toBe('ok');
    // The real launcher, run as Cursor runs it with no daemon: reads of Friday's files and edits refused, commands asked.
    expect(check(r, 'cursor.failsafe')).toMatchObject({ status: 'ok' });
    expect(check(r, 'cursor.status')?.message).toMatch(/^experimental/);
    expect(check(r, 'cursor.claude-import')?.message).toMatch(/has none of Friday's there/);
    expect(r.achieved).toBe('L1 enforcing');
    expect(check(r, 'cursor.level')?.message).toMatch(/once a Cursor session's hooks reach Friday/);
    expect(snapshot(root)).toEqual(before);
  });

  it('reports a permission hook without failClosed as degraded, and a missing shell hook as unjudged calls', async () => {
    const root = configured();
    const file = path.join(root, '.cursor', 'hooks.json');
    const hooks = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Record<string, unknown>[]> };
    (hooks.hooks.preToolUse?.[0] as Record<string, unknown>).failClosed = false;
    writeFileSync(file, JSON.stringify(hooks));
    const degraded = await doctor(root);
    expect(degraded.achieved).toBe('L1 degraded');
    expect(check(degraded, 'cursor.hooks')).toMatchObject({ status: 'fail' });
    expect(check(degraded, 'cursor.hooks')?.message).toMatch(/preToolUse does not set failClosed/);
    delete hooks.hooks.beforeShellExecution;
    writeFileSync(file, JSON.stringify(hooks));
    const partial = await doctor(root);
    expect(check(partial, 'cursor.hooks')?.message).toMatch(
      /lacks Friday's hooks for beforeShellExecution: .*unjudged/,
    );
    expect(partial.achieved).toBe('L0 observed');
  });

  it("says Cursor also runs Claude Code's hooks, and refuses a Cursor without preToolUse", async () => {
    const root = configured();
    mkdirSync(path.join(root, '.claude'), { recursive: true });
    writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ command: 'node', args: ['.friday/harness/claude-code/hook.mjs'] }] }] },
      }),
    );
    const r = await doctor(root, { version: '2.3.1' });
    expect(check(r, 'cursor.claude-import')?.message).toMatch(
      /launcher answers nothing on that path, so each call is judged once/,
    );
    expect(check(r, 'cursor.ide')).toMatchObject({ status: 'fail' });
    expect(check(r, 'cursor.ide')?.message).toMatch(/has no preToolUse hook/);
  });

  it('says enforcing only for a Cursor whose documentation describes failClosed: an older or unknown one is unverified', async () => {
    const root = configured();
    for (const [ide, achieved] of [
      [{ version: '3.24.0' }, 'L1 enforcing'],
      [{ version: '3.30' }, 'L1 enforcing'],
      [{ version: '2.6.0' }, 'L1 unverified'],
      [{ version: null }, 'L1 unverified'],
      // Neither the IDE nor the CLI found: which Cursor runs the hooks is not known.
      [null, 'L1 unverified'],
    ] as const) {
      const r = await doctor(root, ide);
      expect(r.achieved, JSON.stringify(ide)).toBe(achieved);
      if (achieved === 'L1 unverified')
        expect(check(r, 'cursor.level')?.message).toMatch(/documented from Cursor 3\.24/);
    }
  });

  it('refuses a program named node or git at the project root, which could answer for the hooks', async () => {
    const root = configured();
    expect(check(await doctor(root), 'cursor.root-programs')).toMatchObject({ status: 'ok' });
    writeFileSync(path.join(root, 'node.cmd'), '@echo {"permission":"allow"}\r\n');
    const r = await doctor(root);
    expect(check(r, 'cursor.root-programs')).toMatchObject({ status: 'fail' });
    expect(check(r, 'cursor.root-programs')?.message).toMatch(/node\.cmd at the project root/);
    expect(r.achieved).not.toMatch(/^L1/);
  });

  it('is not attached in a project Friday never set up for Cursor', async () => {
    const root = ws().projectDir;
    mkdirSync(path.join(root, '.friday'), { recursive: true });
    writeFileSync(path.join(root, '.friday', 'config.yaml'), renderInitialConfig(PROJECT_ID, 'doctor-test'));
    const r = await doctor(root, null);
    expect(r.achieved).toBe('not attached');
    expect(check(r, 'cursor.host')).toMatchObject({ status: 'warn' });
  });
});
