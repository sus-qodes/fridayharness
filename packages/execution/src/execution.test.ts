/**
 * The execution profile and the gateway's runner (plan M6c, ADR-0029 §4–§5).
 */
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  checkArguments,
  type ExecutionProfile,
  executeRun,
  ProfileError,
  prepareRun,
  profileEnvironment,
  resolveBinary,
  sanitizeOutput,
} from './index.js';

const WIN = process.platform === 'win32';
const NODE_DIR = path.dirname(process.execPath);
const SECRET = 'sk_test_51Hfriday0123456789abcdefXYZ';
const same = (a: string, b: string) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The test process's environment with PATH replaced (Windows keeps `Path`, so it is removed first). */
function baseEnv(pathDirs: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const inherited = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const old = inherited ? (env[inherited] ?? '') : '';
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  env.PATH = [...pathDirs, old].join(path.delimiter);
  return { ...env, ...extra };
}

describe('execution profile', () => {
  const ws = useTestWorkspace();
  const profile = (extra: Partial<ExecutionProfile> = {}): ExecutionProfile => ({
    binaries: ['node', 'git'],
    envPassthrough: [],
    forbiddenRoots: [ws().projectDir],
    base: baseEnv([NODE_DIR], {
      FRIDAY_STATE_DIR: ws().stateDir,
      ANTHROPIC_API_KEY: 'sk-ant-api03-shouldnotpass0123456789',
      NODE_OPTIONS: '--require ./evil.js',
      JAVA_HOME: '/opt/java',
    }),
    stateDir: ws().stateDir,
    ...extra,
  });
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ProfileError) return e.rule;
      throw e;
    }
    return 'accepted';
  };

  it('resolves a listed binary to its real path, and refuses names off the list and relative paths', () => {
    const node = resolveBinary('node', profile());
    expect(same(node.path, realpathSync.native(process.execPath))).toBe(true);
    expect(node.viaCmd).toBe(false);
    expect(resolveBinary(process.execPath, profile()).name).toBe('node');
    expect(refusal(() => resolveBinary('curl', profile()))).toBe('binary.not_listed');
    expect(refusal(() => resolveBinary('./node', profile()))).toBe('binary.relative');
    expect(refusal(() => resolveBinary('bin/node', profile()))).toBe('binary.relative');
  });

  it('never runs a copy planted inside the project, even first on PATH', () => {
    const planted = path.join(ws().projectDir, 'bin');
    mkdirSync(planted, { recursive: true });
    const file = path.join(planted, WIN ? 'node.cmd' : 'node');
    writeFileSync(file, WIN ? '@echo planted\r\n' : '#!/bin/sh\necho planted\n');
    if (!WIN) chmodSync(file, 0o755);
    const first = profile({ base: baseEnv([planted, NODE_DIR]) });
    expect(same(resolveBinary('node', first).path, realpathSync.native(process.execPath))).toBe(true);
    const only: ExecutionProfile = { ...profile(), base: { ...baseEnv([]), PATH: planted } };
    if (WIN) delete only.base.Path;
    const e = (() => {
      try {
        resolveBinary('node', only);
      } catch (err) {
        return err as ProfileError;
      }
      return null;
    })();
    expect(e?.rule).toBe('binary.not_found');
    expect(e?.message).toContain('only found inside the project');
  });

  it('gives the process a minimal environment, the passed-through names and its own variables', () => {
    const env = profileEnvironment(profile({ envPassthrough: ['JAVA_HOME'] }), {
      tempDir: 'T',
      env: { STRIPE_MODE: 'sandbox' },
      credentials: { STRIPE_SECRET_KEY: SECRET },
    });
    expect(env.FRIDAY_STATE_DIR).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env).toMatchObject({ STRIPE_MODE: 'sandbox', STRIPE_SECRET_KEY: SECRET, JAVA_HOME: '/opt/java' });
    expect(WIN ? env.TEMP : env.TMPDIR).toBe('T');
    expect((env.PATH ?? '').split(path.delimiter).some((d) => same(d, realpathSync.native(NODE_DIR)))).toBe(true);
    if (WIN) expect(env.SystemRoot).toBeTruthy();
    expect(Object.keys(profileEnvironment(profile(), { tempDir: 'T' })).filter((k) => /friday/i.test(k))).toEqual([]);
  });

  it("refuses arguments naming Friday's private state, a folder outside the checkout, and what cmd.exe would expand", () => {
    const root = ws().projectDir;
    expect(refusal(() => checkArguments(['%LOCALAPPDATA%\\Friday\\credentials\\x.key'], root, root, profile()))).toBe(
      'argument.private',
    );
    expect(refusal(() => checkArguments(['.friday/run/daemon.json'], root, root, profile()))).toBe('argument.private');
    expect(refusal(() => checkArguments([path.join(ws().stateDir, 'x')], root, root, profile()))).toBe(
      'argument.private',
    );
    expect(refusal(() => checkArguments(['--test'], path.dirname(root), root, profile()))).toBe('cwd.outside');
    expect(refusal(() => checkArguments(['%PATH%'], root, root, profile(), true))).toBe('argument.cmd_unsafe');
    expect(refusal(() => checkArguments(['--test', 'test/a.test.mjs'], root, root, profile()))).toBe('accepted');
  });
});

describe('sanitized output', () => {
  it('removes a credential as written and in the encodings code prints it in', () => {
    const value = 'ab+c/d=efGHIJ\\KLmnop"q';
    const b = Buffer.from(value);
    const forms = [
      value,
      b.toString('base64'),
      b.toString('base64url'),
      b.toString('hex'),
      b.toString('hex').toUpperCase(),
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ];
    // Inside a larger base64 blob, at each of the three alignments.
    const blobs = [1, 2, 3].map((k) =>
      Buffer.from(`${'x'.repeat(k)}{"key":"${value}"}`)
        .toString('base64')
        .slice(4),
    );
    const text = [...forms, ...blobs, 'and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'].join('\n');
    const out = sanitizeOutput(text, [{ name: 'stripe-test', value }]);
    for (const f of [...forms, value.slice(0, 10)]) expect(out.text).not.toContain(f);
    expect(out.text).not.toContain('sk-ant-api03');
    expect(out.text).toContain('[REDACTED:stripe-test]');
    expect(out.redactions).toBeGreaterThanOrEqual(forms.length + blobs.length);
    for (const blob of blobs) {
      const kept = out.text.split('\n')[forms.length + blobs.indexOf(blob)] ?? '';
      expect(Buffer.from(kept.replace(/\[REDACTED:stripe-test\]/g, ''), 'base64').toString()).not.toContain(
        value.slice(2, 12),
      );
    }
  });
});

describe('executeRun', () => {
  const ws = useTestWorkspace();
  const profile = (): ExecutionProfile => ({
    binaries: ['node'],
    envPassthrough: [],
    forbiddenRoots: [ws().projectDir],
    base: baseEnv([NODE_DIR], { FRIDAY_STATE_DIR: ws().stateDir, NODE_OPTIONS: '--no-warnings' }),
    stateDir: ws().stateDir,
  });

  it('runs with the credential in its environment and never in its output', async () => {
    const root = ws().projectDir;
    mkdirSync(root, { recursive: true });
    const script = [
      'const k = process.env.STRIPE_SECRET_KEY;',
      'console.log("plain", k);',
      'console.log("b64", Buffer.from(k).toString("base64"));',
      'console.error("hex", Buffer.from(k).toString("hex"));',
      // Counted without naming them: an argument naming Friday's state variable is refused.
      'console.log("state", Object.keys(process.env).filter((n) => /^fri.ay_/i.test(n)).length, "opts", process.env.NODE_OPTIONS ?? "none");',
      'console.log("mode", process.env.STRIPE_MODE);',
    ].join('\n');
    const run = prepareRun(
      { command: 'node', args: ['-e', script], root, cwd: root, env: { STRIPE_MODE: 'sandbox' } },
      profile(),
    );
    const out = await executeRun(run, profile(), {
      timeoutMs: 30_000,
      credentials: [{ variable: 'STRIPE_SECRET_KEY', name: 'stripe-test', value: SECRET }],
    });
    expect(out.passed).toBe(true);
    expect(out.output).not.toContain(SECRET);
    expect(out.output).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(out.output).not.toContain(Buffer.from(SECRET).toString('hex'));
    expect(out.output).toContain('plain [REDACTED:stripe-test]');
    expect(out.output).toContain('state 0 opts none');
    expect(out.output).toContain('mode sandbox');
    expect(out.redactions).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('ends a run past its time limit, and refuses a credential too short to keep out of the output', async () => {
    const root = ws().projectDir;
    mkdirSync(root, { recursive: true });
    const slow = prepareRun(
      { command: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'], root, cwd: root },
      profile(),
    );
    const out = await executeRun(slow, profile(), { timeoutMs: 1000 });
    expect(out).toMatchObject({ timed_out: true, passed: false });
    expect(out.duration_ms).toBeLessThan(30_000);
    await expect(
      executeRun(slow, profile(), { timeoutMs: 1000, credentials: [{ variable: 'K', name: 'pin', value: '1234' }] }),
    ).rejects.toThrow(/too short/);
  }, 60_000);

  it.runIf(WIN)(
    'runs a .cmd shim outside the project through cmd.exe with quoted arguments',
    async () => {
      const root = ws().projectDir;
      mkdirSync(root, { recursive: true });
      const tools = path.join(ws().root, 'tools');
      mkdirSync(tools, { recursive: true });
      writeFileSync(path.join(tools, 'mytool.cmd'), '@echo off\r\necho [%~1] [%~2]\r\n');
      const p: ExecutionProfile = { ...profile(), binaries: ['mytool'], base: baseEnv([tools]) };
      const run = prepareRun({ command: 'mytool', args: ['a b', 'plain'], root, cwd: root }, p);
      expect(run.binary.viaCmd).toBe(true);
      const out = await executeRun(run, p, { timeoutMs: 30_000 });
      expect(out.output).toContain('[a b] [plain]');
      expect(out.passed).toBe(true);
    },
    60_000,
  );
});
