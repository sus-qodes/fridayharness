import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { startTestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { runHarnessConformance } from './harness-conformance.js';

const ws = useTestWorkspace();

runHarnessConformance('FakeHarness (generic adapter over HTTP)', async () => {
  const clock = new FakeClock(new Date().toISOString());
  const td = await startTestDaemon(ws(), { clock });
  return {
    td,
    clock,
    attach: async (opts = {}) => {
      const h = await FakeHarness.connect(td, {
        mode: 'spawn',
        ...(opts.key ? { key: opts.key } : {}),
        ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
      });
      ws().track({ close: () => h.close() });
      return h;
    },
  };
});
