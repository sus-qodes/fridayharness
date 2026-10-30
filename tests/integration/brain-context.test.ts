/**
 * The Master Brain's context and the provider's cache (plan M14.8): the block the provider caches
 * holds nothing that a commit changes, and the revision with its recent commits travels apart,
 * after it, so a commit does not rebuild the cache.
 */
import { buildBrainContext, buildRepositoryStatus } from '@friday/daemon';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();

describe("the planner's context and the revision (plan M14.8)", () => {
  it('keeps the cached block the same across a commit, and carries the revision apart from it', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const { state, project } = { state: td.daemon.state, project: td.project };
    const opts = { redactor: state.redactor };
    const before = buildBrainContext(state, project, opts);
    const statusBefore = buildRepositoryStatus(project.root, state.redactor);
    expect(before).not.toMatch(/^HEAD /m);
    expect(before).not.toContain('Recent commits');
    expect(before).toContain('## Tracked files');
    expect(statusBefore).toMatch(/^## Repository\nHEAD [0-9a-f]{7,}\nRecent commits:\n/);

    await deterministicGit(project.root).run(['commit', '--allow-empty', '-q', '-m', 'an empty commit']);
    const after = buildBrainContext(state, project, opts);
    const statusAfter = buildRepositoryStatus(project.root, state.redactor);
    expect(after).toBe(before);
    expect(statusAfter).not.toBe(statusBefore);
    expect(statusAfter).toContain('an empty commit');
  });
});
