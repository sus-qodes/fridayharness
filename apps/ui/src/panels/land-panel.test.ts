import type { GoalDiff, GoalSummary, LandPlanView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeGoal, makeSnapshot } from '../test/fixtures.js';
import { goalBranch, landModal, whoseWords } from './land-panel.js';
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
    expect(text).toContain('2 commits ahead of your own branch');
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

  it('lists what Friday did for the goal, one row per fact (plan M12.7)', async () => {
    const summary: GoalSummary = {
      tasks: { total: 3, verified: 3 },
      claims_refused: 1,
      reworked: 1,
      held_for_human: 2,
      refused_by_policy: 0,
      sessions_lost: 1,
      sessions_recovered: 1,
      hosts: { attempts: 3, reported: 2, tokens: 184_321, tokens_reporters: 2, cost_usd: 0.42, cost_reporters: 2 },
      planning: { calls: 1, cost_usd: 0.03, unknown_cost_calls: 0 },
    };
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: { [`GET /goals/${GID}/diff`]: diff(), [`GET /goals/${GID}`]: { summary } },
    });
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    expect(m.el.textContent).toContain('Reading what Friday did…');
    await flush();
    // The diff, which the dialog is for, is asked first.
    expect(ctx.transport.calls.map((c) => c.path.split('?')[0]?.split('/').at(-1))).toEqual(['diff', GID, 'land']);
    const dl = m.el.querySelector('dl[data-role="did"]') as HTMLElement;
    const dds = Array.from(dl.querySelectorAll('dd'));
    expect(Array.from(dl.querySelectorAll('dt')).map((dt, i) => [dt.textContent, dds[i]?.textContent])).toEqual([
      ['Tasks verified', '3 of 3'],
      ['Claims refused by the checks', '1, reworked'],
      ['Actions held for you', '2'],
      ['Actions refused by policy', 'none'],
      ['Sessions lost', '1, recovered'],
      ['Hosts reported', '184k tokens, $0.42 (2 of 3 attempts)'],
      ["Friday's planning", '1 call, $0.03'],
    ]);
    expect(m.el.textContent).toContain('What Friday did');
    m.destroy();
  });

  it('says when nothing is on record for the goal, and when the summary cannot be read', async () => {
    const nothing = makeContext({ answers: { [`GET /goals/${GID}/diff`]: diff() } });
    const m1 = landModal(nothing, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(m1.el.textContent).toContain('Nothing on record for this goal yet.');
    m1.destroy();
    const failing = makeContext({
      answers: {
        [`GET /goals/${GID}/diff`]: diff(),
        [`GET /goals/${GID}`]: () => {
          throw new Error(HOSTILE);
        },
      },
    });
    const m2 = landModal(failing, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(m2.el.textContent).toContain(`Could not read what Friday did: ${HOSTILE}`);
    expect(m2.el.querySelector('img')).toBeNull();
    m2.destroy();
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

  /** What `GET goals/:gid/land` answers. */
  const planOf = (over: Partial<LandPlanView> = {}): LandPlanView => ({
    goal_id: GID,
    branch: goalBranch(GID),
    into: 'main',
    state: 'ready',
    reason: null,
    files: [],
    commits: 2,
    work: 'branch',
    ...over,
  });
  const landed = {
    goal_id: GID,
    status: 'landed',
    branch: goalBranch(GID),
    into: 'main',
    head: 'f'.repeat(40),
    fast_forward: true,
  };

  it('offers to clean up the finished task folders once the goal has landed, and only then', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: {
        [`GET /goals/${GID}/diff`]: diff(),
        [`GET /goals/${GID}/land`]: planOf({ state: 'landed', commits: 0 }),
        'POST /worktrees/prune': { removed: ['C:/wt/a'], kept: [] },
      },
    });
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(m.el.textContent).toContain('The folders the tasks worked in are no longer needed.');
    buttonBy(m.el, 'Clean up finished task folders').click();
    await flush();
    expect(ctx.transport.to('POST', '/worktrees/prune')).toHaveLength(1);
    expect(ctx.toasts.at(-1)?.text).toBe('Removed 1 finished task folder; kept 0');
    m.destroy();
    // A goal still to land has nothing to clean up yet.
    const before = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: { [`GET /goals/${GID}/diff`]: diff(), [`GET /goals/${GID}/land`]: planOf({ state: 'ready' }) },
    });
    const m2 = landModal(before, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(() => buttonBy(m2.el, 'Clean up finished task folders')).toThrow();
    m2.destroy();
  });

  it('names the branch it lands into, asks in a browser, lands, and then says landed', async () => {
    let state: LandPlanView['state'] = 'ready';
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: {
        [`GET /goals/${GID}/diff`]: diff(),
        [`GET /goals/${GID}/land`]: () => planOf({ state }),
        [`POST /goals/${GID}/land`]: () => {
          state = 'landed';
          return landed;
        },
      },
    });
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    // Saying no changes nothing.
    ctx.confirmAnswer = false;
    buttonBy(m.el, 'Land into main').click();
    await flush();
    expect(ctx.confirms[0]?.title).toBe('Land this goal?');
    expect([ctx.confirms[0]?.body].flat().join(' ')).toContain(
      `into main, the branch your project folder has checked out`,
    );
    expect(ctx.transport.to('POST', `/goals/${GID}/land`)).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonBy(m.el, 'Land into main').click();
    await flush();
    expect(ctx.transport.to('POST', `/goals/${GID}/land`)).toHaveLength(1);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Landed into main (fast-forward)' });
    // The plan is read again: nothing is left to land.
    expect(m.el.textContent).toContain("The goal's work is on main.");
    expect(m.el.textContent).toContain(`Landed: ${goalBranch(GID)}`);
    expect(() => buttonBy(m.el, 'Land into main')).toThrow();
    // Once landed, the folders of the finished tasks can go, from here (2026-11-17).
    expect(() => buttonBy(m.el, 'Clean up finished task folders')).not.toThrow();
    expect(ctx.refreshes).toBe(1);
    m.destroy();
  });

  it('on the desktop leaves the asking to the shell, and shows why git refused', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: {
        [`GET /goals/${GID}/diff`]: diff(),
        [`GET /goals/${GID}/land`]: planOf(),
        [`POST /goals/${GID}/land`]: () => {
          throw new Error(`the goal's changes and main change the same lines. Nothing was changed. ${HOSTILE}`);
        },
      },
    });
    (ctx as { platform: unknown }).platform = { ...ctx.platform, kind: 'tauri', desktop: {} };
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    buttonBy(m.el, 'Land into main').click();
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    const err = m.el.querySelector('.pn-land-now [role="alert"]') as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('change the same lines. Nothing was changed');
    expect(m.el.querySelector('img')).toBeNull();
    // Still offered: the person can merge by hand, or try again.
    expect(buttonBy(m.el, 'Land into main').disabled).toBe(false);
    expect(m.el.textContent).toContain('Or in git');
    m.destroy();
  });

  it('says what is in the way before anyone clicks, with the files, and checks again when asked', async () => {
    let plan = planOf({
      state: 'blocked',
      reason:
        'these files have changes that are not committed, and the goal changes them too: commit them or set them aside first',
      files: ['src/a.ts', `docs/${BIDI}`],
    });
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: { [`GET /goals/${GID}/diff`]: diff(), [`GET /goals/${GID}/land`]: () => plan },
    });
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(buttonBy(m.el, 'Land into main').disabled).toBe(true);
    expect(m.el.textContent).toContain('Not yet: these files have changes that are not committed');
    const files = [...m.el.querySelectorAll('[data-role="land-files"] li')].map((li) => li.textContent);
    expect(files).toHaveLength(2);
    expect(files[0]).toBe('src/a.ts');
    // A hostile name is shown with its hidden character visible.
    expect(files[1]).toContain('⟨U+202E⟩');
    expect(files[1]).not.toContain('\u202E');
    // The person committed them: the same dialog now lands.
    plan = planOf();
    buttonBy(m.el, 'Check again').click();
    await flush();
    expect(buttonBy(m.el, 'Land into main').disabled).toBe(false);
    expect(m.el.textContent).not.toContain('Not yet');
    m.destroy();
  });

  it('says the work is already in the folder when it was made there, with what to commit', async () => {
    const opened: string[] = [];
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: {
        [`GET /goals/${GID}/diff`]: diff({
          head: null,
          commits_ahead: [],
          files: [],
          notes: ['the goal has no branch yet'],
        }),
        [`GET /goals/${GID}/land`]: planOf({
          state: 'in_folder',
          work: 'folder',
          into: 'main',
          commits: 0,
          reason: 'already there',
          files: ['src/a.ts'],
        }),
      },
    });
    (ctx.platform as { openInEditor: (p: string) => void }).openInEditor = (p) => opened.push(p);
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    const text = m.el.textContent ?? '';
    expect(text).toContain('Already in your project folder');
    expect(text).toContain('There is no branch to land: review the changes and commit them.');
    expect(text).toContain('Not committed yet in your project folder');
    expect([...m.el.querySelectorAll('[data-role="land-files"] li')].map((li) => li.textContent)).toEqual(['src/a.ts']);
    // Nothing to merge: no Land button, no merge steps.
    expect(() => buttonBy(m.el, /^Land into/)).toThrow();
    expect(text).not.toContain('git merge');
    expect(text).toContain('the goal has no branch yet');
    buttonBy(m.el, 'Open the folder in VS Code').click();
    expect(opened).toEqual(['C:/demo/shop']);
    m.destroy();
  });

  it('lets a merge made by hand be marked as landed, without asking, and warns of mixed work', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: {
        [`GET /goals/${GID}/diff`]: diff({ commits_ahead: [], files: [] }),
        [`GET /goals/${GID}/land`]: planOf({ state: 'landed', commits: 0, work: 'mixed' }),
        [`POST /goals/${GID}/land`]: { ...landed, status: 'already', fast_forward: false },
      },
    });
    const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(m.el.textContent).toContain("The goal's work is on main.");
    expect(m.el.textContent).toContain('that part is already in the folder and is not on this branch');
    buttonBy(m.el, 'Mark as landed').click();
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    expect(ctx.transport.to('POST', `/goals/${GID}/land`)).toHaveLength(1);
    // Once the board holds the landing, there is nothing left to mark.
    ctx.board(
      makeSnapshot({
        goals: [makeGoal({ status: 'COMPLETED' })],
        goal_landing: { [GID]: { work: 'mixed', landed: { into: 'main', at: '2026-11-17T10:00:00.000Z' } } },
      }),
    );
    expect(() => buttonBy(m.el, 'Mark as landed')).toThrow();
    m.destroy();
  });

  it('works with a daemon that cannot say what landing would do, and does not offer an unfinished goal', async () => {
    // No plan route (an older daemon answers something else): the button is as before, the daemon judges.
    const old = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
      answers: { [`GET /goals/${GID}/diff`]: diff(), [`POST /goals/${GID}/land`]: landed },
    });
    const m1 = landModal(old, { kind: 'land', id: GID }, () => undefined);
    await flush();
    buttonBy(m1.el, 'Land into my branch').click();
    await flush();
    expect(old.confirms).toHaveLength(1);
    expect(old.transport.to('POST', `/goals/${GID}/land`)).toHaveLength(1);
    m1.destroy();
    const failing = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'ACTIVE' })] }),
      answers: {
        [`GET /goals/${GID}/diff`]: diff(),
        [`GET /goals/${GID}/land`]: () => {
          throw new Error('git is not installed');
        },
      },
    });
    const m2 = landModal(failing, { kind: 'land', id: GID }, () => undefined);
    await flush();
    expect(buttonBy(m2.el, 'Land into my branch').disabled).toBe(true);
    expect(m2.el.textContent).toContain('Friday could not say what landing would do: git is not installed');
    m2.destroy();
  });

  describe('files in the way can be set aside (2026-11-18)', () => {
    const REASON =
      'these files have changes that are not committed, and the goal changes them too: commit them or set them aside first';
    const blocked = (over: Partial<NonNullable<LandPlanView['in_the_way']>> = {}) =>
      planOf({
        state: 'blocked',
        reason: REASON,
        files: ['src/a.ts', 'src/b.ts'],
        in_the_way: { count: 32, left: 32, left_by: ['antigravity-1'], working: [], ...over },
      });
    const kept = {
      ref: `refs/friday/set-aside/${GID}/landing`,
      commit: 'c'.repeat(40),
      count: 32,
      files: ['src/a.ts', 'src/b.ts'],
      into: 'main',
      at: '2026-10-17T10:00:00.000Z',
    };

    it('says whose the files are, as far as the records know', () => {
      expect(whoseWords({ count: 32, left: 32, left_by: ['antigravity-1'], working: [] })).toBe(
        'antigravity-1 left them in your folder while working on this goal. That work was finished elsewhere, so the goal already has the finished versions.',
      );
      expect(whoseWords({ count: 5, left: 2, left_by: ['antigravity-1', 'claude-vscode'], working: [] })).toBe(
        'antigravity-1 and claude-vscode left 2 of them in your folder while working on this goal. The rest may be changes of your own.',
      );
      expect(whoseWords({ count: 1, left: 0, left_by: [], working: [] })).toBe('It may be a change of your own.');
      // A hostile agent name is shown with its hidden character visible.
      expect(whoseWords({ count: 2, left: 2, left_by: [`x${BIDI}`], working: [] })).toContain('⟨U+202E⟩');
    });

    it('offers to set them aside and land, says what that does, and lands on a yes', async () => {
      let plan = blocked();
      const ctx = makeContext({
        snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
        answers: {
          [`GET /goals/${GID}/diff`]: diff(),
          [`GET /goals/${GID}/land`]: () => plan,
          [`POST /goals/${GID}/land/set-aside`]: () => {
            plan = planOf({ state: 'landed', commits: 0, set_aside: [kept] });
            return { ...landed, set_aside: { ref: kept.ref, count: 32 } };
          },
        },
      });
      const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
      await flush();
      const text = () => m.el.textContent ?? '';
      // What is in the way, in a person's words: not "commit them or set them aside first".
      expect(text()).toContain('32 files in your project folder have changes that were never committed');
      expect(text()).not.toContain('Not yet:');
      expect(text()).toContain('antigravity-1 left them in your folder while working on this goal');
      expect(text()).toContain('If the landing fails, they are written back and nothing changes.');
      // The plan lists some of them; the rest are counted.
      const files = [...m.el.querySelectorAll('[data-role="land-files"] li')].map((li) => li.textContent);
      expect(files).toEqual(['src/a.ts', 'src/b.ts', 'and 30 more']);

      const go = buttonBy(m.el, 'Set them aside and land into main');
      expect(go.disabled).toBe(false);
      ctx.confirmAnswer = false;
      go.click();
      await flush();
      expect(ctx.confirms[0]?.title).toBe('Set the files aside and land this goal?');
      expect([ctx.confirms[0]?.body].flat().join(' ')).toContain('keeps a copy of 32 files exactly as they are now');
      expect(ctx.transport.to('POST', `/goals/${GID}/land/set-aside`)).toHaveLength(0);
      ctx.confirmAnswer = true;
      buttonBy(m.el, 'Set them aside and land into main').click();
      await flush();
      expect(ctx.transport.to('POST', `/goals/${GID}/land/set-aside`)).toHaveLength(1);
      // Never the plain landing, which would only refuse again.
      expect(ctx.transport.to('POST', `/goals/${GID}/land`)).toHaveLength(0);
      expect(ctx.toasts.at(-1)).toEqual({
        kind: 'success',
        text: 'Landed into main (fast-forward). 32 files set aside',
      });
      // Landed, and the way back is right there.
      expect(text()).toContain("The goal's work is on main.");
      expect(text()).toContain('32 files were set aside when this goal landed');
      expect(() => buttonBy(m.el, 'Put them back')).not.toThrow();
      m.destroy();
    });

    it('does not offer it while an agent is working on those files in the folder', async () => {
      const ctx = makeContext({
        snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
        answers: {
          [`GET /goals/${GID}/diff`]: diff(),
          [`GET /goals/${GID}/land`]: blocked({ count: 1, left: 0, left_by: [], working: ['claude-vscode'] }),
        },
      });
      const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
      await flush();
      expect(buttonBy(m.el, 'Set it aside and land into main').disabled).toBe(true);
      expect(m.el.textContent).toContain('claude-vscode is working on some of them in your folder right now');
      m.destroy();
    });

    it('puts them back on a yes, and says which ones it left alone', async () => {
      let plan = planOf({ state: 'landed', commits: 0, set_aside: [kept] });
      const ctx = makeContext({
        snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
        answers: {
          [`GET /goals/${GID}/diff`]: diff(),
          [`GET /goals/${GID}/land`]: () => plan,
          [`POST /goals/${GID}/set-aside/restore`]: () => {
            plan = planOf({
              state: 'landed',
              commits: 0,
              set_aside: [{ ...kept, count: 1, files: ['src/b.ts'] }],
            });
            return { goal_id: GID, restored: ['src/a.ts'], skipped: ['src/b.ts'], failed: [] };
          },
        },
      });
      const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
      await flush();
      // The files are listed when asked for.
      expect(m.el.querySelector('[data-role="land-aside"] [data-role="land-files"]')).toBeNull();
      buttonBy(m.el, 'Show the files').click();
      const shown = [...m.el.querySelectorAll('[data-role="land-aside"] [data-role="land-files"] li')];
      expect(shown.map((li) => li.textContent)).toEqual(['src/a.ts', 'src/b.ts', 'and 30 more']);

      ctx.confirmAnswer = false;
      buttonBy(m.el, 'Put them back').click();
      await flush();
      expect(ctx.confirms.at(-1)?.title).toBe('Put the set-aside files back?');
      expect([ctx.confirms.at(-1)?.body].flat().join(' ')).toContain('over the landed versions in your project folder');
      expect(ctx.transport.to('POST', `/goals/${GID}/set-aside/restore`)).toHaveLength(0);
      ctx.confirmAnswer = true;
      buttonBy(m.el, 'Put them back').click();
      await flush();
      expect(ctx.transport.to('POST', `/goals/${GID}/set-aside/restore`)).toHaveLength(1);
      expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Put back 1 file' });
      expect(m.el.textContent).toContain(
        '1 file was left as it is (changed since the landing, or open in another program): src/b.ts',
      );
      // What is still kept is still offered.
      expect(m.el.textContent).toContain('1 file was set aside when this goal landed');
      m.destroy();
    });

    it('keeps the old refusal for what cannot be set aside (a staged change, a merge in progress)', async () => {
      const ctx = makeContext({
        snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }),
        answers: {
          [`GET /goals/${GID}/diff`]: diff(),
          [`GET /goals/${GID}/land`]: planOf({
            state: 'blocked',
            reason: 'the project folder has staged changes that are not committed: commit them or unstage them first',
            files: ['src/a.ts'],
          }),
        },
      });
      const m = landModal(ctx, { kind: 'land', id: GID }, () => undefined);
      await flush();
      expect(m.el.textContent).toContain('Not yet: the project folder has staged changes');
      expect([...m.el.querySelectorAll('button')].some((b) => /aside/i.test(b.textContent ?? ''))).toBe(false);
      m.destroy();
    });
  });
});
