import type { GoalDiff } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeGoal, makeSnapshot } from '../test/fixtures.js';
import { goalBranch, landModal } from './land-panel.js';
import { BIDI, buttonBy, flush, HOSTILE, LONG, ZW } from './test-support.js';

const GID = 'goal_0000000000000000000000gg01';

function diff(over: Partial<GoalDiff> = {}): GoalDiff {
  return {
    goal_id: GID,
    source: 'goal',
    branch: goalBranch(GID),
    head: 'h'.repeat(40),
    merge_base: 'm'.repeat(40),
    root: 'C:/demo/shop',
    base: 'm'.repeat(40),
    commits_ahead: [
      { sha: 'abcdef0123456789', subject: 'Add the API', author: 'friday', date: '2026-10-17T09:00:00.000Z' },
      { sha: '0123456789abcdef', subject: HOSTILE, author: 'friday', date: '2026-10-17T09:30:00.000Z' },
    ],
    files: [
      {
        path: 'backend/api.ts',
        change: 'added',
        orig_path: null,
        committed: true,
        uncommitted: false,
        binary: false,
        too_large: false,
        link: false,
        protected: false,
        before: null,
        after: null,
        added: 40,
        removed: 0,
      },
      {
        path: `docs/${BIDI}`,
        change: 'modified',
        orig_path: null,
        committed: true,
        uncommitted: false,
        binary: false,
        too_large: false,
        link: false,
        protected: false,
        before: null,
        after: null,
        added: 2,
        removed: 3,
      },
      {
        path: LONG,
        change: 'added',
        orig_path: null,
        committed: true,
        uncommitted: false,
        binary: true,
        too_large: false,
        link: false,
        protected: false,
        before: null,
        after: null,
        added: null,
        removed: null,
      },
    ],
    truncated: false,
    notes: [],
    ...over,
  };
}

describe('landing', () => {
  it('shows the branch, its commits and files, and the steps with copy buttons', async () => {
    const copied: string[] = [];
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: { [`GET /goals/${GID}/diff`]: diff() },
    });
    (ctx.platform as { copy: (t: string) => Promise<boolean> }).copy = async (t) => {
      copied.push(t);
      return true;
    };
    let closed = 0;
    const m = landModal(ctx, { kind: 'land', id: GID }, () => {
      closed += 1;
    });
    await flush();
    expect(ctx.transport.calls[0]?.path).toContain(`/goals/${GID}/diff?stat=1`);
    const text = m.el.textContent ?? '';
    expect(text).toContain(`Ready to land: friday/goal-${GID}`);
    expect(text).toContain("2 commits ahead of the main checkout's HEAD");
    expect(text).toContain('abcdef0123');
    expect(text).toContain('+42');
    expect(text).toContain('−3');
    expect(text).toContain('Source Control');
    expect(text).toContain('Merge Branch…');
    expect(text).toContain('Friday never merges into your branch');
    buttonBy(m.el, 'Copy the merge command').click();
    buttonBy(m.el, 'Copy the branch name').click();
    await flush();
    expect(copied).toEqual([`git merge friday/goal-${GID}`, `friday/goal-${GID}`]);
    expect(closed).toBe(0);
    buttonBy(m.el, 'Open the full goal diff').click();
    // The dialog closes first: a drawer under it would take no input (review R3).
    expect(closed).toBe(1);
    expect(ctx.store.select('ui').drawer).toEqual({
      kind: 'diff',
      id: GID,
      tab: 'goal',
      back: { modal: { kind: 'land', id: GID }, label: 'Back to landing' },
    });
    m.destroy();
  });

  it('renders hostile subjects and file names as text', async () => {
    const ctx = makeContext({ answers: { [`GET /goals/${GID}/diff`]: diff() } });
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(m.el.querySelector('img')).toBeNull();
    const text = m.el.textContent ?? '';
    expect(text).toContain(HOSTILE);
    expect(text).toContain('⟨U+202E⟩');
    expect(text).not.toContain('\u202E');
    expect(text).toContain(LONG);
    m.destroy();
  });

  it('refuses to copy a branch name with hidden characters', async () => {
    const ctx = makeContext({ answers: { [`GET /goals/${GID}/diff`]: diff({ branch: `friday/goal-${ZW}x` }) } });
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(buttonBy(m.el, 'Copy the branch name').disabled).toBe(true);
    expect(buttonBy(m.el, 'Copy the merge command').disabled).toBe(true);
    expect(m.el.textContent).toContain('⟨U+200B⟩');
    m.destroy();
  });

  it('says when the goal is not completed yet, and when the branch cannot be read', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'ACTIVE' })] }),
      answers: {
        [`GET /goals/${GID}/diff`]: () => {
          throw new Error('no goal branch');
        },
      },
    });
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(m.el.textContent).toContain('This goal is active; it is ready to land once it is completed.');
    expect(m.el.textContent).toContain('Could not read the goal branch: no goal branch');
    m.destroy();
  });
});
