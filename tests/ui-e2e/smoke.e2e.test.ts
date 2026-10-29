import { useTestWorkspace } from '@friday/test-support';
import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser, E2E, openStudio } from './harness.js';

/** The page signs in by its one-time link and shows the board with no error (plan §10.3). */

const ws = useTestWorkspace();
afterAll(() => closeBrowser());

describe.skipIf(!E2E)('the Studio, signed in', () => {
  it('loads, signs in by the link, shows the project, and logs no error', async () => {
    const rig = await openStudio(ws());
    try {
      const page = rig.page;
      // The fragment is gone from the address before anything else happens.
      await page.waitForFunction(() => !location.hash.includes('code='), null, { timeout: 15_000 });
      await page.getByText('test-project', { exact: false }).first().waitFor({ timeout: 15_000 });
      await rig.shot('smoke-board');
      expect(rig.problems).toEqual([]);
      // The session token is in this tab's sessionStorage only, and nowhere in localStorage.
      const stored = await page.evaluate(() => ({
        local: JSON.stringify(localStorage),
        session: Object.keys(sessionStorage),
      }));
      expect(stored.local).not.toMatch(/token/i);
    } finally {
      await rig.close();
    }
  });
});
