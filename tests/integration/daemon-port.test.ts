import { createServer } from 'node:net';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';

/**
 * A fixed `daemon.port` in the tracked config is loosening (docs/frontend/PLAN.md §5.13): a
 * repository must not choose the address a browser signs in at (LESSONS UI-24).
 */

const ws = useTestWorkspace();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

interface PolicyAnswer {
  policy: { loosening: { setting: string; to: string }[]; loosening_hash: string | null; daemon_port: number | null };
}

describe('a fixed daemon port', () => {
  it('applies only once this clone trusts it', async () => {
    const port = await freePort();
    const editConfig = (y: string) => y.replace('  port: 0', `  port: ${port}`);
    const first = await startTestDaemon(ws(), { editConfig });
    expect(first.daemon.port()).not.toBe(port);
    const { policy } = await first.operator.get<PolicyAnswer>(first.operator.projectPath('/policy'));
    expect(policy.loosening).toContainEqual(expect.objectContaining({ setting: 'daemon.port', to: String(port) }));
    expect(policy.daemon_port).toBeNull();
    await first.operator.post(first.operator.projectPath('/policy/trust'), { loosening_hash: policy.loosening_hash });
    await first.daemon.close('restart');
    const second = await startTestDaemon(ws(), { editConfig });
    expect(second.daemon.port()).toBe(port);
  });
});
