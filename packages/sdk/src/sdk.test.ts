import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ContextPacket } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  findProjectRoot,
  formatSse,
  loadProject,
  parseConfig,
  privateDirFor,
  projectKey,
  renderContextMarkdown,
  renderInitialConfig,
  SseParser,
  stateDir,
  writePrivateFile,
} from './index.js';

const PID = 'proj_0000000000000000000000000a';

describe('SseParser', () => {
  it('parses messages split across arbitrary chunks, with CRLF, comments and ids', () => {
    const p = new SseParser();
    const text = ': ping\r\n\r\nid: 7\r\nevent: task\r\ndata: {"a":\r\ndata: 1}\r\n\r\nid: 8\ndata: two\n\n';
    const out = [];
    for (const ch of text) out.push(...p.push(ch));
    expect(out).toEqual([
      { id: '7', event: 'task', data: '{"a":\n1}' },
      { id: '8', event: 'message', data: 'two' },
    ]);
    expect(p.lastEventId).toBe('8');
  });

  it('round-trips formatSse', () => {
    const p = new SseParser();
    expect(p.push(formatSse({ id: 3, event: 'x', data: 'a\nb' }))).toEqual([{ id: '3', event: 'x', data: 'a\nb' }]);
  });
});

describe('config', () => {
  it('parses the initial config with defaults', () => {
    const c = parseConfig(renderInitialConfig(PID, 'shop'));
    expect(c.project).toEqual({ id: PID, name: 'shop' });
    expect(c.daemon).toMatchObject({ port: 0, log_level: 'info', trusted_origins: [] });
    expect(c.verification).toEqual({ auto_on_completion: false, checks: [] });
    expect(c.providers.anthropic?.allow_remote).toBe(false);
  });

  it('reports schema problems with paths', () => {
    expect(() => parseConfig('project: { id: nope }')).toThrow(/project.id/);
    expect(() => parseConfig('project: [')).toThrow(/not valid YAML/);
  });
});

describe('discovery', () => {
  const ws = useTestWorkspace();

  function makeProject(dir: string) {
    mkdirSync(path.join(dir, '.friday'), { recursive: true });
    writeFileSync(path.join(dir, '.friday', 'config.yaml'), renderInitialConfig(PID, 'shop'));
  }

  it('finds the project from a subdirectory and computes a stable key', () => {
    const root = ws().projectDir;
    makeProject(root);
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const ref = loadProject(path.join(root, 'a', 'b'));
    expect(ref.project_id).toBe(PID);
    expect(ref.project_key).toBe(projectKey(PID, ref.root));
    expect(ref.project_key).toMatch(new RegExp(`^${PID}-[0-9a-f]{8}$`));
  });

  it('resolves a linked git worktree to the main worktree (ADR-0012)', async () => {
    const root = ws().projectDir;
    makeProject(root);
    const git = deterministicGit(root);
    await git.init();
    await git.commitAll('init');
    const wt = path.join(ws().root, 'wt');
    await git.run(['worktree', 'add', '-q', wt, '-b', 'side']);
    expect(findProjectRoot(wt)).toBe(findProjectRoot(root));
    expect(loadProject(wt).project_key).toBe(loadProject(root).project_key);
  });

  it('two clones of one project get different private directories', () => {
    const a = path.join(ws().root, 'a');
    const b = path.join(ws().root, 'b');
    makeProject(a);
    makeProject(b);
    expect(loadProject(a).project_key).not.toBe(loadProject(b).project_key);
  });

  it('uses FRIDAY_STATE_DIR and writes private files atomically', () => {
    const env = { FRIDAY_STATE_DIR: ws().stateDir };
    expect(stateDir(env)).toBe(path.resolve(ws().stateDir));
    const dir = privateDirFor({ project_key: 'k' }, env);
    writePrivateFile(dir, 'x.token', 'one');
    writePrivateFile(dir, 'x.token', 'two');
    expect(readFileSync(path.join(dir, 'x.token'), 'utf8')).toBe('two');
  });

  it('reports a missing project clearly', () => {
    expect(() => loadProject(ws().root)).toThrow(/friday init/);
  });
});

describe('renderContextMarkdown', () => {
  const src = {
    source_id: 'task_1',
    source_type: 'task_record' as const,
    authority: 'human',
    recency: 't',
    relevance: 1,
    relationship_distance: 0,
    verification_status: 'verified' as const,
    selection_reason: 'assigned task',
    estimated_tokens: 10,
  };
  const packet: ContextPacket = {
    context_id: 'ctx_1',
    project_id: PID,
    recipient: { kind: 'agent', id: 'agent_1' },
    task_id: 'task_1',
    created_at: 't',
    state_version: 4,
    budget: { tokens: 2000, latency_ms: 300, chars: 9000 },
    sections: [
      { kind: 'task.contract', content: 'Add discount codes', sources: [src], authority: 'human' },
      { kind: 'repo.dirty', content: 'x'.repeat(5000), sources: [src], authority: 'git' },
      { kind: 'protocol.reminder', content: 'Claim before editing.', sources: [], authority: 'system' },
    ],
    staleness: { is_stale: false },
  };

  it('renders sections with provenance tags and keeps the reminder within budget', () => {
    const md = renderContextMarkdown(packet, 1500);
    expect(md.length).toBeLessThanOrEqual(1500);
    expect(md).toContain('## Task [task.contract · task_record:task_1 · human]');
    expect(md).toContain('Claim before editing.');
    expect(md).toContain('1 section(s) omitted');
    expect(renderContextMarkdown(packet, 9000)).toContain('x'.repeat(5000));
  });
});
