import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOST_MODULES, LAUNCHER_BUDGET_MS, LAUNCHER_DEFAULT_BUDGET_MS } from '@friday/adapter-claude';
import { renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { applyGeminiPlan, planGemini, readSettings, stripJsonComments } from './config.js';
import {
  GEMINI_HOOK_EVENTS,
  GEMINI_MCP_ENTRY,
  GEMINI_MD_BLOCK,
  geminiHookCommand,
  SPAWN_DENIED_TOOLS,
  spawnPolicyToml,
} from './templates.js';

const ws = useTestWorkspace();
const HOOK = '// friday-hook-launcher-version: 0.2.0\nexport {};\n';

function project(): string {
  mkdirSync(ws().fridayDir, { recursive: true });
  writeFileSync(
    path.join(ws().fridayDir, 'config.yaml'),
    renderInitialConfig(`proj_${'0'.repeat(24)}g1`, 'gemini-test'),
  );
  return ws().projectDir;
}
const at = (...p: string[]) => path.join(ws().projectDir, ...p);
const json = (...p: string[]) => JSON.parse(readFileSync(at(...p), 'utf8')) as Record<string, unknown>;
const configure = (opts: { remove?: boolean; geminiMd?: boolean } = {}) => {
  const changes = planGemini({ projectDir: ws().projectDir, hookSource: HOOK, ...opts });
  applyGeminiPlan(changes, ws().projectDir);
  return changes;
};

describe('the hooks Friday writes for Gemini CLI', () => {
  it('give the host more time than the launcher takes, for every event', () => {
    for (const e of GEMINI_HOOK_EVENTS) {
      const budget = LAUNCHER_BUDGET_MS[e.friday] ?? LAUNCHER_DEFAULT_BUDGET_MS;
      expect(e.timeout, e.event).toBeGreaterThan(budget);
    }
  });

  it("name the host's own events, which the launcher's Gemini module turns into Friday's", () => {
    for (const e of GEMINI_HOOK_EVENTS) {
      const n = HOST_MODULES.gemini.normalize({ hook_event_name: e.event, session_id: 's' }, e.event, {});
      expect(n.event, e.event).toBe(e.friday);
    }
  });

  it('run the tracked launcher by a relative path, which needs no quoting in PowerShell or bash', () => {
    expect(geminiHookCommand('BeforeTool')).toBe('node .friday/harness/gemini/hook.mjs gemini BeforeTool');
    // No quote, variable, drive or backslash: nothing either shell would read differently.
    for (const e of GEMINI_HOOK_EVENTS) expect(geminiHookCommand(e.event)).not.toMatch(/['"$`:\\]/);
  });

  it('deny, in a spawned session, exactly the tools Friday cannot judge, and keep only Friday’s own server in', () => {
    const toml = spawnPolicyToml();
    const [ours, ...rules] = toml.split('[[rule]]').slice(1);
    // Friday's server for the attempt, above every deny rule: the host takes the highest-priority match.
    expect(ours).toMatch(/mcpName = "friday"\ndecision = "allow"\npriority = 950/);
    expect(rules).toHaveLength(SPAWN_DENIED_TOOLS.length);
    for (const [i, r] of rules.entries()) {
      expect(r).toContain(`toolName = "${SPAWN_DENIED_TOOLS[i]?.tool}"`);
      expect(r).toContain('decision = "deny"');
      expect(r).toContain('priority = 900');
    }
    // The only allow is that server's: Friday restricts, and approves nothing else.
    expect(toml.match(/decision = "allow"/g)).toHaveLength(1);
  });
});

describe('friday harness config gemini', () => {
  it('writes the launcher, the hooks, the friday server and the GEMINI.md block, with no machine path', () => {
    project();
    const changes = configure();
    expect(changes.map((c) => c.display).sort()).toEqual(
      [
        '(private) agent.json',
        '.friday/harness/gemini/README.md',
        '.friday/harness/gemini/hook.mjs',
        '.friday/harness/gemini/launch-mcp.mjs',
        '.gemini/settings.json',
        'GEMINI.md',
      ].sort(),
    );
    const settings = json('.gemini', 'settings.json');
    expect(Object.keys(settings.hooks as object)).toEqual(GEMINI_HOOK_EVENTS.map((e) => e.event));
    expect((settings.hooks as Record<string, { matcher?: string }[]>).BeforeTool?.[0]?.matcher).toBe('.*');
    expect((settings.mcpServers as Record<string, unknown>).friday).toEqual(GEMINI_MCP_ENTRY);
    expect(readFileSync(at('GEMINI.md'), 'utf8')).toBe(`${GEMINI_MD_BLOCK}\n`);
    expect(readFileSync(at('.friday', 'harness', 'gemini', 'hook.mjs'), 'utf8')).toBe(HOOK);
    // Nothing committed names this machine: no project path, no state folder.
    for (const c of changes.filter((x) => x.tracked)) {
      const text = c.after ?? '';
      expect(text, c.display).not.toContain(ws().root);
      expect(text, c.display).not.toContain(ws().root.replaceAll('\\', '/'));
      expect(text, c.display).not.toContain(ws().stateDir);
    }
  });

  it('changes nothing the second time', () => {
    project();
    configure();
    expect(planGemini({ projectDir: ws().projectDir, hookSource: HOOK })).toEqual([]);
  });

  it("keeps the user's settings, hooks, servers and notes, and removing gives them back", () => {
    project();
    mkdirSync(at('.gemini'), { recursive: true });
    const user = {
      theme: 'Dracula',
      hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      mcpServers: { github: { command: 'npx', args: ['github-mcp'] } },
    };
    writeFileSync(at('.gemini', 'settings.json'), `${JSON.stringify(user, null, 2)}\n`);
    writeFileSync(at('GEMINI.md'), '# Notes\n\nKeep tests green.\n');
    configure();
    const merged = json('.gemini', 'settings.json');
    expect(merged.theme).toBe('Dracula');
    const before = (merged.hooks as Record<string, { hooks: { command: string }[] }[]>).BeforeTool ?? [];
    expect(before.map((g) => g.hooks[0]?.command)).toEqual(['echo mine', geminiHookCommand('BeforeTool')]);
    expect(Object.keys(merged.mcpServers as object)).toEqual(['github', 'friday']);
    expect(readFileSync(at('GEMINI.md'), 'utf8')).toBe(`# Notes\n\nKeep tests green.\n\n${GEMINI_MD_BLOCK}\n`);

    configure({ remove: true });
    expect(json('.gemini', 'settings.json')).toEqual(user);
    expect(readFileSync(at('GEMINI.md'), 'utf8')).toBe('# Notes\n\nKeep tests green.\n');
    expect(existsSync(at('.friday', 'harness', 'gemini'))).toBe(false);
    expect(existsSync(at('.friday', 'config.yaml'))).toBe(true);
  });

  it('removes every file it created when nothing of the user is in them', () => {
    project();
    configure();
    configure({ remove: true });
    for (const p of [['.gemini'], ['GEMINI.md'], ['.friday', 'harness']])
      expect(existsSync(at(...p)), p.join('/')).toBe(false);
    expect(planGemini({ projectDir: ws().projectDir, remove: true })).toEqual([]);
  });

  it('reads settings with comments, as Gemini CLI does, and says their comments go', () => {
    project();
    mkdirSync(at('.gemini'), { recursive: true });
    writeFileSync(
      at('.gemini', 'settings.json'),
      '{\n  // my theme\n  "theme": "a // not a comment",\n  /* block */ "x": 1\n}\n',
    );
    const changes = planGemini({ projectDir: ws().projectDir, hookSource: HOOK });
    const settings = changes.find((c) => c.display === '.gemini/settings.json');
    expect(settings?.note).toMatch(/comments are not kept; a backup is/);
    expect(JSON.parse(settings?.after ?? '{}')).toMatchObject({ theme: 'a // not a comment', x: 1 });
    expect(stripJsonComments('{"a":"/* kept */"} // gone')).toBe('{"a":"/* kept */"} \n');
  });

  it('refuses a settings file that is not a JSON object', () => {
    project();
    mkdirSync(at('.gemini'), { recursive: true });
    writeFileSync(at('.gemini', 'settings.json'), '[1, 2]');
    expect(() => planGemini({ projectDir: ws().projectDir, hookSource: HOOK })).toThrow(/not a JSON object/);
    expect(() => readSettings('{nope', 'x.json')).toThrow(/x\.json is not a JSON object/);
  });

  it('leaves GEMINI.md alone when asked', () => {
    project();
    const changes = configure({ geminiMd: false });
    expect(changes.map((c) => c.display)).not.toContain('GEMINI.md');
    expect(existsSync(at('GEMINI.md'))).toBe(false);
  });
});
