import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { useTestWorkspace } from '@friday/test-support';
import { afterAll, describe, expect, it } from 'vitest';
import { attachedSession } from '../helpers/ui.js';
import { closeBrowser, E2E, openStudio, SHOTS } from './harness.js';

/**
 * The interface's measurements in the browser (plan §10.3), recorded in PLAN §13: first paint,
 * the board ready, the snapshot read, the page's heap, and how fast a new approval reaches its card.
 */

const ws = useTestWorkspace();
afterAll(() => closeBrowser());

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

describe.skipIf(!E2E)('interface measurements', () => {
  it('measures a board of 200 tasks and five approvals arriving', async () => {
    const rig = await openStudio(ws(), { extensions: [claudeCodeHooks()] });
    try {
      const { td, page } = rig;
      const op = td.operator;
      for (let i = 0; i < 200; i++) {
        await op.post(op.projectPath('/tasks'), {
          summary: `Task ${i} of the board`,
          kind: 'docs',
          scope: { write: [`docs/t${i}/**`], read: [] },
          ready: i % 2 === 0,
        });
      }

      // Load: first paint and the board ready (its first card), from a fresh link.
      const link = await op.post<{ url: string }>(op.projectPath('/ui/login-codes'), {});
      await page.goto(link.url);
      await page.locator('.nd-task').first().waitFor({ timeout: 30_000 });
      const load = await page.evaluate(() => {
        const paint = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
        const snap = performance
          .getEntriesByType('resource')
          .filter((e) => e.name.includes('/ui/snapshot'))
          .map((e) => (e as PerformanceResourceTiming).duration);
        return { paint, ready: performance.now(), snapshotFetch: snap[snap.length - 1] ?? null };
      });

      // The snapshot read on the daemon, from outside the page.
      const reads: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t = performance.now();
        await op.get(op.projectPath('/ui/snapshot'));
        reads.push(performance.now() - t);
      }

      // Approval to card: from the agent's request to its card in the Decisions tray.
      const s = await attachedSession(td, { summary: 'Measure approvals' });
      const latencies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const before = await page.locator('.sh-rail .gv-tray-approval').count();
        await page.evaluate((n) => {
          (window as unknown as { __seen?: number }).__seen = 0;
          const obs = new MutationObserver(() => {
            if (document.querySelectorAll('.sh-rail .gv-tray-approval').length > n) {
              (window as unknown as { __seen?: number }).__seen = Date.now();
              obs.disconnect();
            }
          });
          obs.observe(document.body, { childList: true, subtree: true });
        }, before);
        const sent = Date.now();
        await s.client.requestPermission({
          task_id: s.task.task_id,
          run_id: s.run_id,
          action_class: 'git.push',
          command: `git push origin release-${i}`,
          justification: 'measure',
          ttl_s: 600,
        });
        await page.waitForFunction(() => ((window as unknown as { __seen?: number }).__seen ?? 0) > 0, null, {
          timeout: 15_000,
        });
        const seen = await page.evaluate(() => (window as unknown as { __seen: number }).__seen);
        latencies.push(seen - sent);
      }

      const heap = await page.evaluate(
        () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
      );
      const result = {
        tasks: 200,
        first_paint_ms: load.paint === null ? null : Math.round(load.paint),
        board_ready_ms: Math.round(load.ready),
        snapshot_fetch_in_page_ms: load.snapshotFetch === null ? null : Math.round(load.snapshotFetch),
        snapshot_read_median_ms: Math.round(median(reads)),
        approval_to_card_ms: latencies,
        approval_to_card_median_ms: median(latencies),
        heap_mb: heap === null ? null : Math.round((heap / 1024 / 1024) * 10) / 10,
      };
      writeFileSync(path.join(SHOTS, 'measurements.json'), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`MEASURED ${JSON.stringify(result)}\n`);
      expect(rig.problems).toEqual([]);
    } finally {
      await rig.close();
    }
  });
});
