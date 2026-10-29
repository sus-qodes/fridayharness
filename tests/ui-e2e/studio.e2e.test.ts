import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { useTestWorkspace } from '@friday/test-support';
import { afterAll, describe, expect, it } from 'vitest';
import type { TestDaemon } from '../helpers/daemon.js';
import { attachedSession } from '../helpers/ui.js';
import { closeBrowser, E2E, openStudio, pointAt } from './harness.js';

/** The Studio with real work on it (plan §10.3): a planned goal, an agent, an approval, a question. */

const ws = useTestWorkspace();
afterAll(() => closeBrowser());

interface GoalDetail {
  goal: { goal_id: string };
  active: { plan_id: string; tasks: { key: string; task_id: string | null }[] } | null;
}

/** A goal with an approved, human-written plan of three tasks; the last waits on the first two. */
async function plannedGoal(td: TestDaemon) {
  const op = td.operator;
  const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), {
    request: 'Add discount codes to checkout',
    plan: false,
  });
  const v1 = await op.post<{ plan_id: string; version: number }>(op.projectPath(`/goals/${goal.goal_id}/plans`), {
    draft: {
      objective: 'Add discount codes to checkout',
      summary: 'Model, API and the checkout form',
      tasks: [
        {
          key: 'model',
          summary: 'Discount code model',
          acceptance_criteria: ['tests pass'],
          scope: { write: ['src/model/**'], read: ['**'] },
        },
        {
          key: 'api',
          summary: 'Apply a code in the API',
          acceptance_criteria: ['tests pass'],
          scope: { write: ['src/api/**'], read: ['**'] },
        },
        {
          key: 'form',
          summary: 'Code field on the checkout form',
          acceptance_criteria: ['tests pass'],
          scope: { write: ['src/web/**'], read: ['**'] },
          depends_on: ['model', 'api'],
        },
      ],
    },
  });
  await op.post(op.projectPath(`/plans/${v1.plan_id}/versions/${v1.version}/approve`), {});
  const detail = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
  return {
    goal_id: goal.goal_id,
    tasks: Object.fromEntries((detail.active?.tasks ?? []).map((t) => [t.key, t.task_id])),
  };
}

describe.skipIf(!E2E)('the Studio with work on it', () => {
  it('shows the goal, its tasks and the agent, and lists what waits for the human', async () => {
    const rig = await openStudio(ws(), { extensions: [claudeCodeHooks()] });
    try {
      const { td, page } = rig;
      await page.getByText('test-project', { exact: false }).first().waitFor({ timeout: 15_000 });
      await plannedGoal(td);
      const s = await attachedSession(td, { summary: 'Write the release notes' });
      await s.client.requestPermission({
        task_id: s.task.task_id,
        run_id: s.run_id,
        action_class: 'git.push',
        command: 'git push origin main',
        justification: 'publish the release notes',
        ttl_s: 600,
      });
      await s.client.escalate({
        task_id: s.task.task_id,
        run_id: s.run_id,
        question: 'Which version number should the notes use?',
        options: ['1.4.0', '2.0.0'],
      });
      await page.getByText('Code field on the checkout form').first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      await rig.shot('studio-board');
      await page.setViewportSize({ width: 1100, height: 720 });
      await page.waitForTimeout(800);
      await rig.shot('studio-board-small');
      // Focus on a card beyond the visible board moves the camera, never the board's boxes (LESSONS UI-50).
      for (let i = 0; i < 4; i++) await page.locator('.cv-toolbar').getByRole('button', { name: 'Zoom in' }).click();
      await page.waitForTimeout(400);
      // Anything that scrolls an element into view (a test driver, find in page) cannot slide the board.
      const slid = await page.evaluate(() => {
        const stage = (document.querySelector('.cv-stage') as HTMLElement).getBoundingClientRect();
        const away = [...document.querySelectorAll<HTMLElement>('.nd-card')].some((c) => {
          const r = c.getBoundingClientRect();
          return r.right > stage.right || r.bottom > stage.bottom || r.left < stage.left || r.top < stage.top;
        });
        const moved = ['.sh-stage', '.cv-stage'].map((s) => {
          const e = document.querySelector(s) as HTMLElement;
          e.scrollLeft = 300;
          e.scrollTop = 300;
          return e.scrollLeft !== 0 || e.scrollTop !== 0;
        });
        return { away, scrolled: moved.some(Boolean) };
      });
      expect(slid).toEqual({ away: true, scrolled: false });
      expect(rig.problems).toEqual([]);
      for (const t of ['Discount code model', 'Apply a code in the API', 'Write the release notes']) {
        expect(await page.getByText(t).count()).toBeGreaterThan(0);
      }

      // The question, answered from the tray: pick an option and send (decisions arm after 700 ms).
      await page.setViewportSize({ width: 1440, height: 900 });
      const rail = page.locator('.sh-rail');
      await rail.getByText('A question from the agent').click();
      const chip = rail.locator('.gv-chip', { hasText: '1.4.0' });
      await chip.waitFor();
      await page.waitForTimeout(900);
      await pointAt(page, chip);
      await chip.click();
      await rail.getByRole('button', { name: 'Send', exact: true }).click();
      await expect
        .poll(async () => {
          const r = await td.operator.get<{ escalations: { status: string; answer: string | null }[] }>(
            td.operator.projectPath('/escalations'),
          );
          return r.escalations.map((e) => [e.status, e.answer]);
        })
        .toEqual([['answered', 'Selected: 1.4.0']]);
      await rig.shot('studio-question-answered');

      // A task card opens its inspector.
      const card = page.locator('.nd-task', { hasText: 'Apply a code in the API' }).first();
      await card.hover();
      await card.getByRole('button', { name: 'Inspect' }).click();
      await page.locator('.sh-drawer').first().waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
      await rig.shot('studio-inspector');
      await page.keyboard.press('Escape');

      // The high-risk approval: its full view, then a held press allows it once.
      await rail.getByRole('button', { name: 'Open the full view of this approval' }).click();
      const hold = page.getByRole('button', { name: /Hold to allow/ });
      await hold.waitFor({ timeout: 5000 });
      await page.waitForTimeout(900);
      await rig.shot('studio-approval-modal');
      await pointAt(page, hold);
      // Armed: 700 ms after the card settled with the pointer on it (plan FD-28).
      await expect.poll(() => hold.getAttribute('aria-disabled')).toBe('false');
      await page.mouse.down();
      await page.waitForTimeout(1600);
      await page.mouse.up();
      await expect
        .poll(async () => {
          const r = await td.operator.get<{ approvals: { status: string }[] }>(td.operator.projectPath('/approvals'));
          return r.approvals.map((x) => x.status);
        })
        .toEqual(['granted']);
      await page.waitForTimeout(600);
      await rig.shot('studio-after-decisions');
      expect(rig.problems).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  it('approves a proposed plan on the board, shows a diff, and pauses, resumes and halts', async () => {
    const rig = await openStudio(ws(), { extensions: [claudeCodeHooks()] });
    try {
      const { td, page } = rig;
      const op = td.operator;
      await page.getByText('test-project', { exact: false }).first().waitFor({ timeout: 15_000 });
      const paused = async () =>
        (await op.get<{ control: { paused: boolean } }>(op.projectPath('/ui/snapshot'))).control.paused;

      // A proposed plan: its tasks are ghosts and a review bar decides it, once armed.
      const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), {
        request: 'Document the checkout',
        plan: false,
      });
      await op.post(op.projectPath(`/goals/${goal.goal_id}/plans`), {
        draft: {
          objective: 'Document the checkout',
          summary: 'One page of docs',
          tasks: [
            {
              key: 'docs',
              summary: 'Describe the checkout flow',
              kind: 'docs',
              acceptance_criteria: ['the page exists'],
              scope: { write: ['docs/**'], read: ['**'] },
            },
          ],
        },
      });
      const bar = page.locator('.nd-planbar');
      await bar.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(900);
      await rig.shot('studio-plan-proposed');
      const approve = bar.getByRole('button', { name: 'Approve' });
      await pointAt(page, approve);
      await expect.poll(() => approve.getAttribute('aria-disabled')).not.toBe('true');
      await approve.click();
      await expect
        .poll(async () => {
          const d = await op.get<{ active: { tasks: unknown[] } | null }>(op.projectPath(`/goals/${goal.goal_id}`));
          return d.active?.tasks.length ?? 0;
        })
        .toBe(1);

      // An agent's change in the main checkout, read in the diff drawer from the inspector.
      const s = await attachedSession(td, { summary: 'Write the release notes' });
      writeFileSync(path.join(s.dir, 'NOTES.md'), '# Release notes\n\n- discount codes\n');
      const card = page.locator('.nd-task', { hasText: 'Write the release notes' }).first();
      await card.waitFor({ timeout: 15_000 });
      await card.hover();
      await card.getByRole('button', { name: 'Inspect' }).click();
      const drawer = page.locator('.sh-drawer').first();
      await drawer.getByRole('tab', { name: 'Git' }).click();
      await drawer.getByRole('button', { name: 'Open the diff' }).click();
      await page.getByText('discount codes', { exact: false }).first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await rig.shot('studio-diff');
      await page.keyboard.press('Escape');

      // Pause and resume from the dock; pause again from the palette.
      const dock = page.locator('.dk-dock');
      await dock.getByRole('button', { name: 'Pause' }).click();
      await expect.poll(paused).toBe(true);
      await dock.getByRole('button', { name: 'Resume' }).click();
      await expect.poll(paused).toBe(false);
      await page.keyboard.press('Control+k');
      await page.keyboard.type('pause');
      await page.waitForTimeout(200);
      await rig.shot('studio-palette');
      await page.keyboard.press('Enter');
      await expect.poll(paused).toBe(true);
      await dock.getByRole('button', { name: 'Resume' }).click();
      await expect.poll(paused).toBe(false);

      // Halt: a dialog that says what stops, ready after its countdown.
      await dock.getByRole('button', { name: 'Halt' }).click();
      const now = page.getByRole('button', { name: /Halt now/ });
      await now.waitFor({ timeout: 6000 });
      await rig.shot('studio-halt');
      await now.click();
      await expect.poll(paused).toBe(true);
      await page.locator('.dk-halt-close').click();
      // The Notch pins while the paused agent's approval or the plan waits; the header says paused.
      await rig.shot('studio-halted');
      expect(rig.problems).toEqual([]);
    } finally {
      await rig.close();
    }
  });
});
