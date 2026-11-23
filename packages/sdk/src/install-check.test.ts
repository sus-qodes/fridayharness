/**
 * Which copy of Friday the apps a person opens themselves start (`install.json`), next to the copy
 * that runs a setup check. Every file is in the test's own temp folder: the state folder of the
 * person running the tests is never read.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { installCheck, ownMcpEntry, samePath } from './index.js';

const ws = useTestWorkspace({ prefix: 'fri-ic-' });
const env = () => ({ FRIDAY_STATE_DIR: ws().stateDir });
const windows = process.platform === 'win32';

/** A stand-in copy of Friday in `<root>/<name>`: its MCP server launcher, empty (never run). */
function copy(name: string): { home: string; entry: string } {
  const home = path.join(ws().root, name);
  const entry = path.join(home, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '');
  return { home, entry };
}

/** `install.json` as `friday setup` writes it. */
function record(
  entry: string | null,
  extra: Record<string, unknown> = { written_at: '2026-10-31T12:00:00.000Z' },
): void {
  const info = {
    friday_version: '0.1.0',
    node_path: process.execPath,
    cli_entry: null,
    daemon_entry: null,
    mcp_server_entry: entry,
    ...extra,
  };
  writeFileSync(path.join(ws().stateDir, 'install.json'), `${JSON.stringify(info, null, 2)}\n`);
}

const NOT_SET_UP = {
  status: 'fail',
  message: 'Friday is not set up on this machine (install.json has no MCP server entry)',
  fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
};
const other = (where: string, when = ', set up on 31 October 2026') =>
  `Apps you open yourself start another copy of Friday (${where}${when}), not this one. Open the Friday desktop app once, or run friday setup, to switch them to this copy.`;

describe('ownMcpEntry', () => {
  it("finds the MCP server launcher of the copy the code runs from, a checkout's or a bundle's", () => {
    const { home, entry } = copy('friday');
    expect(ownMcpEntry(path.join(home, 'packages', 'sdk', 'dist', 'discovery.js'))).toBe(entry);
    expect(ownMcpEntry(path.join(home, 'packages', 'sdk', 'src', 'discovery.ts'))).toBe(entry);
    expect(ownMcpEntry(path.join(home, 'packages', 'adapters', 'antigravity', 'dist', 'doctor.js'))).toBe(entry);
    expect(ownMcpEntry(path.join(home, 'apps', 'cli', 'dist', 'bin.js'))).toBe(entry);
    // The nearest copy: one copy inside another answers for itself.
    const inner = copy(path.join('friday', 'node_modules', 'friday'));
    expect(ownMcpEntry(path.join(inner.home, 'apps', 'cli', 'dist', 'bin.js'))).toBe(inner.entry);
    // It does not look further up than a copy is deep.
    expect(ownMcpEntry(path.join(home, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'x.js'))).toBeUndefined();
  });

  it('is, for this code, the launcher `friday setup` records from this checkout', () => {
    const own = ownMcpEntry();
    expect(own && existsSync(own)).toBe(true);
    expect(own?.split(path.sep).slice(-4)).toEqual(['packages', 'mcp-server', 'bin', 'friday-mcp.mjs']);
  });
});

describe('samePath', () => {
  it('compares where the paths lead, not how they are written', () => {
    const { home, entry } = copy('friday');
    expect(
      samePath(entry, path.join(home, 'packages', '..', 'packages', 'mcp-server', '.', 'bin', 'friday-mcp.mjs')),
    ).toBe(true);
    expect(samePath(home, `${home}${path.sep}`)).toBe(true);
    expect(samePath(entry, copy('other').entry)).toBe(false);
    // Files that do not exist are compared as written.
    expect(samePath(path.join(home, 'gone', 'a.mjs'), path.join(home, 'gone', 'x', '..', 'a.mjs'))).toBe(true);
    expect(samePath(path.join(home, 'gone', 'a.mjs'), path.join(home, 'gone', 'b.mjs'))).toBe(false);
  });

  it.skipIf(!windows)('takes no notice of case or of the direction of a slash on Windows', () => {
    const { home, entry } = copy('Friday');
    expect(samePath(entry, entry.toUpperCase())).toBe(true);
    expect(samePath(entry, entry.toLowerCase().replaceAll('\\', '/'))).toBe(true);
    expect(samePath(path.join(home, 'Gone', 'A.mjs'), path.join(home, 'gone', 'a.mjs').replaceAll('\\', '/'))).toBe(
      true,
    );
    expect(samePath(entry, `${entry}x`)).toBe(false);
  });
});

describe('installCheck', () => {
  it('fails as before when the machine is not set up, or the recorded entry is not there', () => {
    const own = copy('this').entry;
    expect(installCheck({ env: env(), own })).toEqual(NOT_SET_UP);
    record(null);
    expect(installCheck({ env: env(), own })).toEqual(NOT_SET_UP);
    record(path.join(ws().root, 'gone', 'friday-mcp.mjs'));
    expect(installCheck({ env: env(), own })).toEqual(NOT_SET_UP);
    writeFileSync(path.join(ws().stateDir, 'install.json'), '{ not json');
    expect(installCheck({ env: env(), own })).toEqual(NOT_SET_UP);
  });

  it('keeps its words when install.json names the copy that runs the check', () => {
    const own = copy('this').entry;
    record(own);
    expect(installCheck({ env: env(), own })).toEqual({
      status: 'ok',
      message: `MCP server entry: ${own}`,
      entry: own,
    });
    // The same file by another spelling is still this copy; the recorded spelling is what is shown.
    const spelled = path.join(ws().root, 'this', 'packages', '..', 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
    expect(installCheck({ env: env(), own: spelled })).toMatchObject({ status: 'ok', entry: own });
  });

  it.skipIf(!windows)('reads a recorded path in another case, or with other slashes, as the same copy', () => {
    const own = copy('This').entry;
    const recorded = own.toLowerCase().replaceAll('\\', '/');
    record(recorded);
    expect(installCheck({ env: env(), own })).toEqual({
      status: 'ok',
      message: `MCP server entry: ${recorded}`,
      entry: recorded,
    });
  });

  it('warns in plain words when the apps a person opens would start another copy', () => {
    const own = copy('this').entry;
    const old = copy('old');
    record(old.entry);
    // No `fix`: the words say what to do, and only the status and the message differ from "ok".
    expect(installCheck({ env: env(), own })).toEqual({ status: 'warn', message: other(old.home), entry: old.entry });
    // A recorded time that cannot be read is left out.
    record(old.entry, {});
    expect(installCheck({ env: env(), own }).message).toBe(other(old.home, ''));
    record(old.entry, { written_at: 'yesterday' });
    expect(installCheck({ env: env(), own }).message).toBe(other(old.home, ''));
    record(old.entry, { written_at: 20261031 });
    expect(installCheck({ env: env(), own }).message).toBe(other(old.home, ''));
    // An entry that is not inside a copy's own folders is named as it is.
    const odd = path.join(ws().root, 'odd', 'mcp.mjs');
    mkdirSync(path.dirname(odd), { recursive: true });
    writeFileSync(odd, '');
    record(odd);
    expect(installCheck({ env: env(), own })).toEqual({ status: 'warn', message: other(odd), entry: odd });
  });

  it('compares with the copy this code runs from unless told another', () => {
    const old = copy('old');
    record(old.entry);
    expect(installCheck({ env: env() })).toMatchObject({ status: 'warn', message: other(old.home) });
    record(ownMcpEntry() ?? '');
    expect(installCheck({ env: env() })).toMatchObject({ status: 'ok' });
  });

  it('compares nothing when an entry is named by hand, or the copy that asks has none', () => {
    const own = copy('this').entry;
    const old = copy('old');
    record(old.entry);
    // FRIDAY_MCP_ENTRY, as the caller read it: used as it is.
    expect(installCheck({ env: env(), named: own, own })).toEqual({
      status: 'ok',
      message: `MCP server entry: ${own}`,
      entry: own,
    });
    expect(installCheck({ env: env(), named: old.entry, own })).toMatchObject({ status: 'ok', entry: old.entry });
    expect(installCheck({ env: env(), named: '', own })).toEqual(NOT_SET_UP);
    expect(installCheck({ env: env(), own: null })).toEqual({
      status: 'ok',
      message: `MCP server entry: ${old.entry}`,
      entry: old.entry,
    });
  });
});
