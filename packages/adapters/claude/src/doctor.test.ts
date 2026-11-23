/**
 * `friday harness doctor claude-code`: which copy of Friday the Claude Code a person opens
 * themselves would start. The rest of this doctor is covered in tests/integration/claude-doctor.test.ts.
 * Claude Code is not looked for (detection is injected), and its state and Friday's are read from
 * the test's own temp folder.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadProject, renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { claudeDoctor } from './doctor.js';

const ws = useTestWorkspace({ prefix: 'fri-ccd-' });

function project(): string {
  const root = ws().projectDir;
  mkdirSync(path.join(root, '.friday'), { recursive: true });
  writeFileSync(path.join(root, '.friday', 'config.yaml'), renderInitialConfig(`proj_${'0'.repeat(24)}d1`, 'doctor'));
  return root;
}

/** A stand-in copy of Friday in `<root>/<name>`: its MCP server launcher, empty (never run). */
function copy(name: string): { home: string; entry: string } {
  const home = path.join(ws().root, name);
  const entry = path.join(home, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '');
  return { home, entry };
}

const record = (entry: string) =>
  writeFileSync(
    path.join(ws().stateDir, 'install.json'),
    JSON.stringify({ mcp_server_entry: entry, written_at: '2026-10-31T12:00:00.000Z' }),
  );

const installCheckOf = async (root: string, extra: { ownMcpEntry?: string; named?: string } = {}) => {
  const report = await claudeDoctor(loadProject(root), {
    install: null,
    skipMcp: true,
    env: {
      FRIDAY_STATE_DIR: ws().stateDir,
      CLAUDE_CONFIG_DIR: path.join(ws().root, 'claude-home'),
      ...(extra.named ? { FRIDAY_MCP_ENTRY: extra.named } : {}),
    },
    ...(extra.ownMcpEntry ? { ownMcpEntry: extra.ownMcpEntry } : {}),
  });
  return report.checks.find((c) => c.id === 'cc.install');
};

describe('friday harness doctor claude-code: the copy of Friday on this machine', () => {
  it('warns when the Claude Code you open yourself would start another copy of Friday', async () => {
    const root = project();
    const own = copy('this-friday');
    const old = copy('old-friday');
    record(old.entry);
    expect(await installCheckOf(root, { ownMcpEntry: own.entry })).toEqual({
      id: 'cc.install',
      status: 'warn',
      message: `Apps you open yourself start another copy of Friday (${old.home}, set up on 31 October 2026), not this one. Open the Friday desktop app once, or run friday setup, to switch them to this copy.`,
    });
    // Without being told, the copy that asks is the one this code runs from: not the recorded one either.
    expect(await installCheckOf(root)).toMatchObject({ status: 'warn' });
  });

  it('says what it always said when install.json names this copy, or an entry is named by hand', async () => {
    const root = project();
    const own = copy('this-friday');
    const old = copy('old-friday');
    record(own.entry);
    expect(await installCheckOf(root, { ownMcpEntry: own.entry })).toEqual({
      id: 'cc.install',
      status: 'ok',
      message: `MCP server entry: ${own.entry}`,
    });
    // FRIDAY_MCP_ENTRY is someone's own choice of copy: it is used, and compared with nothing.
    expect(await installCheckOf(root, { ownMcpEntry: own.entry, named: old.entry })).toEqual({
      id: 'cc.install',
      status: 'ok',
      message: `MCP server entry: ${old.entry}`,
    });
  });

  it('fails as before on a machine that is not set up', async () => {
    expect(await installCheckOf(project(), { ownMcpEntry: copy('this-friday').entry })).toEqual({
      id: 'cc.install',
      status: 'fail',
      message: 'Friday is not set up on this machine (install.json has no MCP server entry)',
      fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
    });
  });
});
