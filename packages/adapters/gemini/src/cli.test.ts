import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FileChange } from '@friday/adapter-claude';
import { renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { type GeminiCliParts, geminiConfigCommand, geminiDoctorCommand } from './cli.js';

const ws = useTestWorkspace();

const parts: GeminiCliParts = {
  UsageError: class extends Error {},
  renderDoctor: (checks) => checks.map((c) => `${c.status} ${c.id}`).join('\n'),
};

/** Captures what a command prints. */
async function printed(run: () => unknown): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    out += String(c);
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = write;
    process.exitCode = undefined;
  }
  return out;
}

function project(): string {
  mkdirSync(ws().fridayDir, { recursive: true });
  writeFileSync(path.join(ws().fridayDir, 'config.yaml'), renderInitialConfig(`proj_${'0'.repeat(24)}c1`, 'cli-test'));
  return ws().projectDir;
}

describe('friday harness config|doctor gemini', () => {
  it('shows what it would change with --print, as JSON, writing nothing', async () => {
    const dir = project();
    const out = await printed(() => geminiConfigCommand({ project: dir, json: true }, { print: true, agent: 'gm-7' }));
    const summary = JSON.parse(out) as {
      applied: boolean;
      experimental: boolean;
      changes: { path: string; note: string }[];
    };
    expect(summary.applied).toBe(false);
    expect(summary.experimental).toBe(true);
    expect(summary.changes.find((c) => c.path === '(private) agent.json')?.note).toMatch(/gm-7/);
    expect(existsSync(path.join(dir, '.gemini'))).toBe(false);
  });

  it('applies, leaves GEMINI.md alone when asked, and applies the changes the CLI makes for every host', async () => {
    const dir = project();
    const extra: FileChange = {
      path: path.join(dir, '.friday', '.gitignore'),
      display: '.friday/.gitignore',
      before: null,
      after: '/run/\n',
      tracked: true,
      note: 'keeps Friday runtime files out of git',
      owned: false,
    };
    const out = await printed(() =>
      geminiConfigCommand({ project: dir, json: true }, { geminiMd: false }, () => [extra]),
    );
    expect(existsSync(path.join(dir, '.gemini', 'settings.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'GEMINI.md'))).toBe(false);
    expect(existsSync(path.join(dir, '.friday', '.gitignore'))).toBe(true);
    expect((JSON.parse(out) as { changes: { path: string }[] }).changes.map((c) => c.path)).toContain(
      '.friday/.gitignore',
    );
  });

  it('runs the doctor quickly, as JSON', async () => {
    const dir = project();
    const out = await printed(() => geminiDoctorCommand({ project: dir, json: true }, { quick: true }, parts));
    const report = JSON.parse(out) as { achieved: string; checks: { id: string }[] };
    expect(report.achieved).toBe('not attached');
    expect(report.checks.map((c) => c.id)).toContain('gemini.account');
  });
});
