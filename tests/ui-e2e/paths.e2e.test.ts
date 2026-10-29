import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterAll, describe, expect, it } from 'vitest';
import { attachedSession } from '../helpers/ui.js';
import { closeBrowser, E2E, openStudio } from './harness.js';

/**
 * Paths a user can take that the happy-path tests do not (deep review R1, R2, R3, R10): a goal
 * whose plan editor was closed, a board read that failed while nothing else happened, a diff opened
 * from a dialog, and a change of nothing but the final newline.
 */

const ws = useTestWorkspace();
afterAll(() => closeBrowser());

const PLAN = JSON.stringify({
  objective: 'Write the onboarding guide',
  summary: 'One page for new developers',
  tasks: [
    {
      key: 'guide',
      summary: 'Write the onboarding page',
      kind: 'docs',
      acceptance_criteria: ['the page exists'],
      scope: { write: ['docs/**'], read: ['**'] },
    },
  ],
});

describe.skipIf(!E2E)('paths off the happy path', () => {
  it('brings a goal back to its plan after the editor was closed, from its card and from the palette', async () => {
    const rig = await openStudio(ws());
    try {
      const { td, page } = rig;
      const op = td.operator;
      await page.getByText('test-project', { exact: false }).first().waitFor({ timeout: 15_000 });

      // A goal created to be planned by hand, whose editor is closed before any plan is written.
      await page.locator('.dk-dock').getByRole('button', { name: 'New goal' }).click();
      await page.getByLabel('Request').fill('Write the onboarding guide');
      await page.getByRole('button', { name: 'Write the plan myself' }).click();
      const editor = page.locator('.sh-modal', { hasText: 'Write the plan' });
      await editor.waitFor({ timeout: 5000 });
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await editor.waitFor({ state: 'hidden', timeout: 5000 });

      // The goal's card is the way back; with no planner configured it offers only writing it.
      const card = page.locator('.nd-goal', { hasText: 'Write the onboarding guide' }).first();
      const write = card.locator('[data-action="write-plan"]');
      await write.waitFor({ timeout: 15_000 });
      expect(await card.locator('[data-action="brain-plan"]').count()).toBe(0);
      await rig.shot('paths-goal-without-plan');
      await write.click();
      await editor.waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: 'Import JSON' }).click();
      await page.locator('.pn-json-box textarea').fill(PLAN);
      await page.getByRole('button', { name: 'Load this JSON' }).click();
      await page.getByRole('button', { name: 'Propose the plan' }).click();
      await page.locator('.nd-planbar').waitFor({ timeout: 15_000 });
      await expect.poll(() => card.locator('[data-action="write-plan"]').count()).toBe(0);

      // A second goal, created elsewhere without a plan: the palette offers writing it.
      await op.post(op.projectPath('/goals'), { request: 'Tidy the release checklist', plan: false });
      await page.locator('.nd-goal', { hasText: 'Tidy the release checklist' }).first().waitFor({ timeout: 15_000 });
      await page.keyboard.press('Control+k');
      await page.keyboard.type('Write the plan');
      const entry = page.getByText('Write the plan: Tidy the release checklist', { exact: false }).first();
      await entry.waitFor({ timeout: 5000 });
      await entry.click();
      await page.locator('.sh-modal', { hasText: 'Write the plan' }).waitFor({ timeout: 5000 });
      await rig.shot('paths-plan-from-palette');
      expect(rig.problems).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  it('reads the board again after a failed read while the stream stays quiet', async () => {
    const rig = await openStudio(ws());
    try {
      const { td, page } = rig;
      const op = td.operator;
      await page.getByText('test-project', { exact: false }).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);

      // The next read of the board fails once; the event that asked for it is the last one.
      let failed = 0;
      await page.route('**/ui/snapshot*', async (route) => {
        if (failed === 0) {
          failed++;
          await route.abort('connectionreset');
        } else await route.continue();
      });
      await op.post(op.projectPath('/tasks'), { summary: 'Shown after a failed read', kind: 'docs' });
      await page.locator('.nd-task', { hasText: 'Shown after a failed read' }).first().waitFor({ timeout: 20_000 });
      expect(failed).toBe(1);
      // A failed request is a console error by design of the browser; nothing else may be.
      expect(rig.problems.filter((p) => !p.includes('Failed to load resource'))).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  it('opens the diff from the verification dialog in front of it, comes back, and shows a removed final newline', async () => {
    const rig = await openStudio(ws(), { extensions: [claudeCodeHooks()] });
    try {
      const { td, page } = rig;
      await page.getByText('test-project', { exact: false }).first().waitFor({ timeout: 15_000 });
      // A committed file whose change is only its final newline.
      const dir = td.ws.projectDir;
      writeFileSync(path.join(dir, 'GUIDE.md'), 'line one\nline two\n');
      await deterministicGit(dir).commitAll('add the guide');
      const s = await attachedSession(td, { summary: 'Tidy the guide' });
      writeFileSync(path.join(s.dir, 'GUIDE.md'), 'line one\nline two');
      await s.client.reportResult({
        task_id: s.task.task_id,
        run_id: s.run_id,
        status: 'completed_claim',
        summary: 'removed the trailing newline',
        changed_paths: ['GUIDE.md'],
        checks: [],
        notes: [],
      });

      const card = page.locator('.nd-task', { hasText: 'Tidy the guide' }).first();
      await card.waitFor({ timeout: 15_000 });
      await card.hover();
      await card.getByRole('button', { name: 'Verify' }).click();
      const dialog = page.locator('.sh-modal', { hasText: 'Verify the task' });
      await dialog.waitFor({ timeout: 5000 });
      await dialog.getByRole('button', { name: 'Open the diff' }).click();

      // The dialog gave way: the drawer takes the pointer, and its Back button returns.
      await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      const drawer = page.locator('.sh-drawer').first();
      await drawer.getByText('No newline at end of file', { exact: false }).first().waitFor({ timeout: 10_000 });
      expect(await drawer.locator('.dr-eof').count()).toBeGreaterThan(0);
      await rig.shot('paths-diff-from-verify');
      // A click only lands on an element nothing covers (Playwright checks the hit target).
      await drawer.getByRole('button', { name: 'Back to verification' }).click();
      await dialog.waitFor({ timeout: 5000 });
      expect(rig.problems).toEqual([]);
    } finally {
      await rig.close();
    }
  });
});
