/**
 * The two commands as `friday` runs them (`harness config antigravity`, `harness doctor
 * antigravity`): what they print, what `--print` and `--remove` do, and the flags that belong to
 * another host. Detection looks only in empty folders, so no Antigravity is ever started.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@friday/protocol';
import { loadProject, renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, describe, expect, it } from 'vitest';
import { type AntigravityCliIo, antigravityConfigCli, antigravityDoctorCli } from './cli.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ENTRY = path.join(REPO, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');

const ws = useTestWorkspace({ prefix: 'fri-agc-' });
const env = () => {
  const none = path.join(ws().root, 'none');
  return { FRIDAY_STATE_DIR: ws().stateDir, FRIDAY_MCP_ENTRY: ENTRY, PATH: '', LOCALAPPDATA: none, ProgramFiles: none };
};

function initProject() {
  mkdirSync(path.join(ws().projectDir, '.friday'), { recursive: true });
  writeFileSync(path.join(ws().projectDir, '.friday', 'config.yaml'), renderInitialConfig(newId('proj'), 'shop'));
  return loadProject(ws().projectDir);
}

/** An `io` that keeps what the command printed. */
function capture() {
  const printed: { value: unknown; text: string }[] = [];
  const io: AntigravityCliIo = {
    out: (value, text) => printed.push({ value, text: text() }),
    diff: (before, after) => [`- ${before.length}`, `+ ${after.length}`],
  };
  return { io, printed };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('friday harness config antigravity', () => {
  it('configures the project and says what it reached, that it is experimental, and what to do next', () => {
    const ref = initProject();
    const { io, printed } = capture();
    antigravityConfigCli(ref, { agent: 'ag-1' }, io, env());
    const [{ value, text }] = printed as [{ value: Record<string, unknown>; text: string }];
    expect(value).toMatchObject({ host: 'antigravity', experimental: true, applied: true, removed: false });
    expect(value.antigravity).toEqual({ cli: null, app: null, hook_level: 'unverified' });
    expect(text).toContain('Configured Antigravity for Friday project "shop" (this machine\'s agent key: ag-1):');
    expect(text).toContain('+ .agents/hooks.json');
    expect(text).toContain(
      "Antigravity was not found on this machine: experimental. L1 unverified once a session's hooks reach Friday: what Antigravity does with a call when its hook crashes or times out is not documented",
    );
    expect(text).toContain('There is no spawn mode');
    expect(text).toContain('Check everything with: friday harness doctor antigravity');
    expect(existsSync(path.join(ws().projectDir, '.agents', 'hooks.json'))).toBe(true);
  });

  it('--print writes nothing and shows each change; --remove takes everything back', () => {
    const ref = initProject();
    const shown = capture();
    antigravityConfigCli(ref, { print: true }, shown.io, env());
    expect(shown.printed[0]?.text).toMatch(/^Would change Antigravity/);
    expect(shown.printed[0]?.text).toContain('      + <!-- friday:begin -->');
    expect(existsSync(path.join(ws().projectDir, '.agents'))).toBe(false);

    antigravityConfigCli(ref, {}, capture().io, env());
    const removed = capture();
    antigravityConfigCli(ref, { remove: true }, removed.io, env());
    expect(removed.printed[0]?.text).toMatch(/^Removed Antigravity/);
    expect(existsSync(path.join(ws().projectDir, '.agents'))).toBe(false);
    expect(existsSync(path.join(ws().projectDir, 'AGENTS.md'))).toBe(false);
  });

  it('refuses the flags of another host, and refuses to promise enforcement', () => {
    const ref = initProject();
    const { io } = capture();
    expect(() => antigravityConfigCli(ref, { scope: 'local' }, io, env())).toThrow(/--scope local is for claude-code/);
    expect(() => antigravityConfigCli(ref, { claudeMd: true }, io, env())).toThrow(/AGENTS\.md/);
    expect(() => antigravityConfigCli(ref, { requireEnforcing: true }, io, env())).toThrow(
      /cannot be shown to enforce Friday's hooks yet \(L1 unverified\)/,
    );
    expect(existsSync(path.join(ws().projectDir, '.agents'))).toBe(false);
  });
});

describe('friday harness doctor antigravity', () => {
  it('fails before config, passes after it, and names the level as experimental', async () => {
    const ref = initProject();
    const before = capture();
    await antigravityDoctorCli(ref, { quick: true }, before.io, { env: env() });
    expect(process.exitCode).toBe(1);
    expect(before.printed[0]?.text).toContain('Enforcement: not attached (experimental)');
    process.exitCode = undefined;

    antigravityConfigCli(ref, {}, capture().io, env());
    const after = capture();
    await antigravityDoctorCli(ref, { quick: true }, after.io, { env: env() });
    expect(process.exitCode).toBeUndefined();
    const text = after.printed[0]?.text ?? '';
    expect(text).toContain('Enforcement: L1 unverified (experimental)');
    expect(text).toContain('[info] ag.spawn no spawn mode');
    expect(text).not.toContain('ag.mcp ');
  });
});
