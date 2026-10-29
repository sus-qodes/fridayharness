import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAgentLauncher } from '@friday/cli';
import type { AgentHost, UiLoginCode } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { closeBrowser, E2E, ensureBundle, launchBrowser, pointAt, SHOTS } from './harness.js';

/**
 * A day in the life (plan §10.3): a repository Friday has never seen, used from the browser only.
 * Friday runs in this process so the agent launcher's child is a scripted agent (`worker.mjs`):
 * no real host can start (LESSONS UI-34). `friday ui --start` itself is covered by
 * `tests/scenarios/ui-start.e2e.test.ts`.
 */

const ws = useTestWorkspace();
const WORKER = path.join(REPO_ROOT, 'tests', 'fixtures', 'scripted-adapter', 'worker.mjs');
const HOSTS: AgentHost[] = [
  { host: 'codex', found: true, version: '0.0.0-test', supported: true, path: null, reason: null },
  { host: 'claude-code', found: false, version: null, supported: false, path: null, reason: 'not installed (test)' },
];
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});
afterAll(() => closeBrowser());

/** The launcher with its child replaced by the scripted agent; no PATH, so nothing real is found. */
function launcher() {
  return createAgentLauncher({
    detectHosts: async () => HOSTS,
    stopGraceMs: 3000,
    child: (req, ctx) => ({
      command: process.execPath,
      args: [
        WORKER,
        `http://127.0.0.1:${ctx.port()}`,
        path.join(ctx.privateDir, 'bootstrap.token'),
        ctx.project.project_id,
        req.agent_key,
        req.role,
      ],
      env: { SystemRoot: process.env.SystemRoot ?? '' },
    }),
  });
}

async function start(): Promise<TestDaemon> {
  return startTestDaemon(ws(), { initialized: true, tickMs: 500, uiDir: ensureBundle(), extensions: [launcher()] });
}

const PLAN = JSON.stringify({
  objective: 'Document the checkout',
  summary: 'One page about discount codes',
  tasks: [
    {
      key: 'page',
      summary: 'Write the checkout page',
      kind: 'docs',
      role: 'developer',
      acceptance_criteria: ['the page exists'],
      scope: { write: ['docs/**'], read: ['**'] },
    },
  ],
});

describe.skipIf(!E2E)('a day in the life', () => {
  it('from a new repository to a verified, integrated goal, across a restart, without a terminal', async () => {
    // A repository Friday has never seen.
    const dir = ws().projectDir;
    writeFileSync(path.join(dir, 'README.md'), '# shop\n');
    const git = deterministicGit(dir);
    await git.init();
    expect((await cli(['--project', dir, 'init', '--name', 'shop'])).code).toBe(0);
    await git.commitAll('init friday');

    let td = await start();
    const browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    const shot = (name: string) => page.screenshot({ path: path.join(SHOTS, `day-${name}.png`) });
    const op = () => td.operator;
    const taskStatus = async () => {
      const r = await op().get<{ tasks: { summary: string; status: string }[] }>(op().projectPath('/tasks?all=1'));
      return r.tasks.find((t) => t.summary === 'Write the checkout page')?.status ?? null;
    };

    try {
      // Sign in by the link Friday's shortcut opens.
      const link = await op().post<UiLoginCode>(op().projectPath('/ui/login-codes'), {});
      await page.goto(link.url);
      await page.getByText('shop', { exact: true }).first().waitFor({ timeout: 15_000 });
      await shot('signed-in');

      // Start an agent from the Agents drawer.
      await page.locator('.dk-dock').getByRole('button', { name: 'Agents' }).click();
      await page.getByRole('button', { name: 'Start agent' }).click();
      await page.getByRole('button', { name: 'Start the agent' }).click();
      await expect
        .poll(
          async () => (await op().get<{ agents: { status: string }[] }>(op().projectPath('/agents'))).agents.length,
          {
            timeout: 15_000,
          },
        )
        .toBe(1);
      await page.keyboard.press('Escape');
      await shot('agent-started');

      // A goal with a plan written by hand (no planner is configured), imported as JSON.
      await page.locator('.dk-dock').getByRole('button', { name: 'New goal' }).click();
      await page.getByLabel('Request').fill('Document the checkout');
      await page.getByRole('button', { name: 'Write the plan myself' }).click();
      // The JSON tools sit behind the editor's More fold (review §4); a closed fold's buttons are not visible.
      await page.locator('details.pn-json-tools > summary').click();
      await page.getByRole('button', { name: 'Import JSON' }).click();
      await page.locator('.pn-json-box textarea').fill(PLAN);
      await page.getByRole('button', { name: 'Load this JSON' }).click();
      await shot('plan-editor');
      await page.getByRole('button', { name: 'Propose the plan' }).click();

      // Approve it on the board.
      const bar = page.locator('.nd-planbar');
      await bar.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(900);
      // The plan is approved in its review, where every task's instructions are shown in full.
      await bar.getByRole('button', { name: 'Review and approve' }).click();
      const approve = page.locator('.sh-modal').getByRole('button', { name: 'Approve plan' });
      await approve.waitFor({ timeout: 5000 });
      await page.waitForTimeout(900);
      await pointAt(page, approve);
      await expect.poll(() => approve.getAttribute('aria-disabled')).toBe('false');
      await approve.click();

      // The agent takes the task, writes the page, and asks for a commit: one click allows it.
      const rail = page.locator('.sh-rail');
      // The row itself, not the word: Getting started's notification item names "approvals" too,
      // so a text match could catch the checklist before the request arrives.
      const approvalRow = rail.locator('.gv-tray-approval .gv-tray-row').first();
      await approvalRow.waitFor({ timeout: 30_000 });
      await shot('approval-waiting');
      await approvalRow.click();
      const allow = rail.getByRole('button', { name: /Allow once/ });
      await allow.waitFor({ timeout: 5000 });
      await page.waitForTimeout(900);
      await pointAt(page, allow);
      await expect.poll(() => allow.getAttribute('aria-disabled')).toBe('false');
      await allow.click();

      // The same run continues and claims the task done; a human verifies it.
      await expect.poll(taskStatus, { timeout: 30_000 }).toBe('READY_FOR_VERIFICATION');
      const card = page.locator('.nd-task', { hasText: 'Write the checkout page' }).first();
      await card.hover();
      await card.getByRole('button', { name: 'Verify' }).click();
      await page.getByRole('button', { name: "Run Friday's checks" }).click();
      await expect.poll(taskStatus, { timeout: 30_000 }).toBe('COMPLETED');
      // The dialog follows the task and offers Close once the result is in.
      const verifyDialog = page.locator('.sh-modal', { hasText: 'Verify the task' });
      await verifyDialog.getByText('Completed', { exact: true }).waitFor({ timeout: 10_000 });
      await shot('verified');
      await verifyDialog.getByRole('button', { name: 'Close', exact: true }).last().click();

      // Integrated into the goal's branch; the goal completes and shows how to land it.
      const land = page.getByRole('button', { name: 'Ready to land' });
      await land.waitFor({ timeout: 30_000 });
      await shot('goal-completed');
      await land.click();
      await page.getByText('friday/goal-', { exact: false }).first().waitFor({ timeout: 5000 });
      await shot('landing');
      await page.keyboard.press('Escape');

      // Friday restarts on another address: the old tab says so; the agent comes back by itself.
      await td.daemon.close('restart');
      await page.getByText('Friday is not reachable here', { exact: false }).first().waitFor({ timeout: 30_000 });
      await shot('old-tab');
      td = await start();
      await expect
        .poll(
          async () =>
            (await op().get<{ processes: { status: string }[] }>(op().projectPath('/agent-processes'))).processes.map(
              (p) => p.status,
            ),
          { timeout: 20_000 },
        )
        .toContain('running');
      const again = await op().post<UiLoginCode>(op().projectPath('/ui/login-codes'), {});
      const fresh = await context.newPage();
      await fresh.goto(again.url);
      await fresh.getByText('shop', { exact: true }).first().waitFor({ timeout: 15_000 });
      await fresh.screenshot({ path: path.join(SHOTS, 'day-after-restart.png') });
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
