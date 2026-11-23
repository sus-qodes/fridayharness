/**
 * The Master Brain's context and the provider's cache (plan M14.8): the block the provider caches
 * holds nothing that a commit changes, and the revision with its recent commits travels apart,
 * after it, so a commit does not rebuild the cache.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBrainContext, buildIntentSources, buildRepositoryStatus } from '@friday/daemon';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();

describe("the planner's context and the revision (plan M14.8)", () => {
  it('keeps the cached block the same across a commit, and carries the revision apart from it', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const { state, project } = { state: td.daemon.state, project: td.project };
    const opts = { redactor: state.redactor };
    const before = await buildBrainContext(state, project, opts);
    const statusBefore = await buildRepositoryStatus(project.root, state.redactor);
    expect(before).not.toMatch(/^HEAD /m);
    expect(before).not.toContain('Recent commits');
    expect(before).toContain('## Tracked files');
    expect(statusBefore).toMatch(/^## Repository\nHEAD [0-9a-f]{7,}\nRecent commits:\n/);

    await deterministicGit(project.root).run(['commit', '--allow-empty', '-q', '-m', 'an empty commit']);
    const after = await buildBrainContext(state, project, opts);
    const statusAfter = await buildRepositoryStatus(project.root, state.redactor);
    expect(after).toBe(before);
    expect(statusAfter).not.toBe(statusBefore);
    expect(statusAfter).toContain('an empty commit');
  });
});

/**
 * A project worked on with Codex or Antigravity keeps its rules for agents in AGENTS.md (Gemini CLI
 * in GEMINI.md). Only CLAUDE.md was read, so its plans were written without them (2026-11-23).
 */
describe("the project's rules for agents, whichever agent they were written for", () => {
  it('reads AGENTS.md and GEMINI.md as it reads CLAUDE.md, without the block Friday itself wrote there', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const { state, project } = { state: td.daemon.state, project: td.project };
    const root = project.root;
    const skipped: { path: string; included: boolean }[] = [];
    const build = () =>
      buildBrainContext(state, project, { redactor: state.redactor, onSources: (s) => skipped.push(...s) });
    expect(await build()).not.toContain('## AGENTS.md');

    const fridays =
      '<!-- friday:begin -->\nFriday coordinates the work here: call friday_whoami first.\n<!-- friday:end -->';
    writeFileSync(path.join(root, 'AGENTS.md'), `# Rules\nEvery endpoint needs a test in tests/api.\n\n${fridays}\n`);
    writeFileSync(path.join(root, 'GEMINI.md'), 'Money is stored in paise, never as a float.\n');
    writeFileSync(path.join(root, 'CLAUDE.md'), `${fridays}\n`);
    const text = await build();
    expect(text).toContain('## AGENTS.md\n# Rules\nEvery endpoint needs a test in tests/api.');
    expect(text).toContain('## GEMINI.md\nMoney is stored in paise, never as a float.');
    // Friday's own guidance for an agent at work is not the project's rules.
    expect(text).not.toContain('friday_whoami');
    expect(text).not.toContain('friday:begin');
    // A file that holds nothing but Friday's block is not sent as an empty section.
    expect(text).not.toContain('## CLAUDE.md');
    expect(skipped.filter((s) => s.included).map((s) => s.path)).toEqual(
      expect.arrayContaining(['AGENTS.md', 'GEMINI.md']),
    );
  });
});

describe('the documents a project-intent draft may draw on (ADR-0034 §2)', () => {
  it('sends the README, outlines of at most eight docs and the manifest description, redacted', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const { state, project } = { state: td.daemon.state, project: td.project };
    const root = project.root;
    state.redactor.addSecret('sk-intent-test-0123456789');
    writeFileSync(path.join(root, 'README.md'), '# Edutube\nA study platform. Key: sk-intent-test-0123456789\n');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    const long = `# Roadmap\n${'filler line\n'.repeat(400)}## Later\nsocial features are out of scope\n`;
    writeFileSync(path.join(root, 'docs', 'A-ROADMAP.md'), long);
    for (let i = 0; i < 9; i += 1) writeFileSync(path.join(root, 'docs', `B-${i}.md`), `# Doc ${i}\n`);
    writeFileSync(path.join(root, 'docs', 'notes.txt'), 'not markdown');
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'edutube', description: 'Study without distractions', scripts: { secret: 'x' } }),
    );

    const sources = buildIntentSources(project, { redactor: state.redactor });
    const paths = sources.map((s) => s.path);
    expect(paths[0]).toBe('README.md');
    expect(paths.filter((p) => p.startsWith('docs/'))).toHaveLength(8);
    expect(paths).not.toContain('docs/notes.txt');
    expect(paths).toContain('package.json');
    const readme = sources.find((s) => s.path === 'README.md')?.text ?? '';
    expect(readme).toContain('A study platform.');
    expect(readme).not.toContain('sk-intent-test-0123456789');
    const roadmap = sources.find((s) => s.path === 'docs/A-ROADMAP.md')?.text ?? '';
    // An outline: its opening and its headings, never the whole file.
    expect(roadmap.length).toBeLessThan(1600);
    expect(roadmap).toContain('# Roadmap');
    const manifest = JSON.parse(sources.find((s) => s.path === 'package.json')?.text ?? '{}');
    expect(manifest).toEqual({ name: 'edutube', description: 'Study without distractions', keywords: [] });
  });
});
