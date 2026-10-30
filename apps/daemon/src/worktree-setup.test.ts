import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCKFILE_NAMES, planSetup } from './worktree-setup.js';

/** The decision for a fresh task worktree (plan Phase 7): what runs, what is skipped, what is refused. */

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'friday-setup-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const base = { enabled: true, declared: null, held: null, allowScripts: false };
const manifest = () => writeFileSync(path.join(root, 'package.json'), '{"name":"x","private":true}\n');

describe('planSetup', () => {
  it('installs what the lockfile calls for, frozen, offline first, scripts ignored', () => {
    manifest();
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    expect(planSetup(root, base)).toEqual({
      source: 'lockfile',
      command: 'pnpm',
      args: ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'],
      manager: 'pnpm',
    });
    // Scripts only when the policy trusted them.
    expect(planSetup(root, { ...base, allowScripts: true })).toMatchObject({
      args: ['install', '--frozen-lockfile', '--prefer-offline'],
    });
    rmSync(path.join(root, 'pnpm-lock.yaml'));
    writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
    expect(planSetup(root, base)).toMatchObject({
      command: 'npm',
      args: ['ci', '--prefer-offline', '--no-audit', '--no-fund', '--ignore-scripts'],
    });
    rmSync(path.join(root, 'package-lock.json'));
    writeFileSync(path.join(root, 'yarn.lock'), '');
    expect(planSetup(root, base)).toMatchObject({
      command: 'yarn',
      args: ['install', '--frozen-lockfile', '--ignore-scripts'],
    });
    rmSync(path.join(root, 'yarn.lock'));
    writeFileSync(path.join(root, 'bun.lock'), '');
    expect(planSetup(root, base)).toMatchObject({
      command: 'bun',
      args: ['install', '--frozen-lockfile', '--ignore-scripts'],
    });
  });

  it("runs the project's own command when trusted, and refuses a declared one that is not, never guessing instead", () => {
    manifest();
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    const declared = { command: 'node', args: ['scripts/setup.mjs'] };
    expect(planSetup(root, { ...base, declared })).toEqual({
      source: 'config',
      command: 'node',
      args: ['scripts/setup.mjs'],
      manager: null,
    });
    const held = { source: 'config.yaml', reason: 'waits for "friday policy trust"' };
    expect(planSetup(root, { ...base, held })).toEqual({
      refused: 'config.yaml declares worktrees.setup.command, which waits for "friday policy trust"',
    });
  });

  it('skips when disabled, when node_modules is already there, and when nothing says what to install', () => {
    expect(planSetup(root, { ...base, enabled: false })).toEqual({ skipped: 'worktrees.setup.enabled is false' });
    expect(planSetup(root, base)).toEqual({ skipped: 'no package.json' });
    manifest();
    expect(planSetup(root, base)).toEqual({ skipped: `no lockfile (${LOCKFILE_NAMES.join(', ')})` });
    mkdirSync(path.join(root, 'node_modules'));
    // A reused worktree keeps what it has, whatever is declared.
    expect(planSetup(root, { ...base, declared: { command: 'node', args: [] } })).toEqual({
      skipped: 'node_modules is already there',
    });
  });
});
