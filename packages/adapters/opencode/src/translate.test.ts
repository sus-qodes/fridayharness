import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { translateOpenCode } from './translate.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../../tests/fixtures/opencode/tools.json', import.meta.url), 'utf8'),
) as {
  valid: { tool: string; args: Record<string, unknown>; kind: string; paths?: string[]; patterns?: string[] }[];
  invalid: { tool: string; args: Record<string, unknown> }[];
};
const cwd = path.resolve('fixture-root');
const ws = useTestWorkspace();
describe('the pinned OpenCode tool translator', () => {
  it.each(fixture.valid)('judges every target of $tool', (entry) => {
    const action = translateOpenCode({ ...entry, sessionID: 's', callID: 'c' }, cwd);
    expect(action.kind).toBe(entry.kind);
    if (entry.patterns) expect('patterns' in action && action.patterns).toEqual(entry.patterns);
    if (entry.paths) expect('paths' in action && action.paths).toEqual(entry.paths.map((p) => path.join(cwd, p)));
  });
  it.each(fixture.invalid)('refuses unsupported or malformed $tool', (entry) => {
    expect(() => translateOpenCode({ ...entry, sessionID: 's', callID: 'c' }, cwd)).toThrow();
  });
  it('judges grep filename filters and the actual parent directory for a file target', () => {
    const root = ws().projectDir;
    const directory = path.join(root, 'src');
    const target = path.join(directory, 'a.ts');
    mkdirSync(directory);
    writeFileSync(target, 'needle');
    const grep = (args: Record<string, unknown>) =>
      translateOpenCode({ tool: 'grep', sessionID: 's', callID: 'c', args }, root);
    expect(grep({ pattern: '.env', path: target })).toEqual({
      kind: 'search',
      patterns: [],
      paths: [target, directory],
    });
    expect(grep({ pattern: 'needle', path: directory, include: '**/.env' })).toEqual({
      kind: 'search',
      patterns: ['**/.env'],
      paths: [directory],
    });
    expect(grep({ pattern: 'needle', path: path.join(directory, 'missing') })).toEqual({
      kind: 'search',
      patterns: [],
      paths: [path.join(directory, 'missing'), directory],
    });
  });
  it('refuses Windows drive aliases even where their lexical path is inside the project', () => {
    if (process.platform !== 'win32') return;
    const driveRoot = path.parse(cwd).root;
    const drive = driveRoot[0]?.toLowerCase();
    for (const alias of [
      `/${drive}/Windows`,
      `/${drive}:/Windows`,
      `/mnt/${drive}/Windows`,
      `/cygdrive/${drive}/Windows`,
    ]) {
      const lexicalRoot = path.dirname(path.resolve(driveRoot, alias));
      expect(() =>
        translateOpenCode({ tool: 'read', sessionID: 's', callID: 'c', args: { filePath: alias } }, lexicalRoot),
      ).toThrow(/drive aliases/);
    }
  });
  it('preserves the whole command and refuses NUL bytes', () => {
    expect(
      translateOpenCode(
        { tool: 'bash', sessionID: 's', callID: 'c', args: { command: 'node --test && git commit -m x' } },
        cwd,
      ),
    ).toEqual({ kind: 'command', command: 'node --test && git commit -m x' });
    expect(() =>
      translateOpenCode({ tool: 'read', sessionID: 's', callID: 'c', args: { filePath: 'a\0b' } }, cwd),
    ).toThrow();
  });
});
