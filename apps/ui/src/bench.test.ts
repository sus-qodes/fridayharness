import { describe, expect, it } from 'vitest';
import { deriveBoard, layoutInputOf } from './model/board.js';
import { layout } from './model/layout.js';
import { createStore } from './store/state.js';
import { Dispatcher } from './sync/dispatcher.js';
import { makeEvent, makeSnapshot, makeTask } from './test/fixtures.js';

/**
 * The interface's measurements that need no browser (plan §10.3), recorded in PLAN §13. Gated
 * like the repository's other benchmarks: `FRIDAY_TEST_BENCH=1`.
 */
const BENCH = process.env.FRIDAY_TEST_BENCH === '1';

describe.skipIf(!BENCH)('interface measurements', () => {
  it('ingests events, and holds a large board in a bounded store', () => {
    // 500 tasks, each depending on the one before (499 edges) and on one more (1 000 edges in all).
    const tasks = Array.from({ length: 500 }, (_, i) =>
      makeTask({
        task_id: `task_${String(i).padStart(26, '0')}`,
        summary: `Task ${i} of the big goal`,
        status: i % 3 === 0 ? 'RUNNING' : 'READY',
        depends_on: [
          i > 0 ? `task_${String(i - 1).padStart(26, '0')}` : null,
          i > 1 ? `task_${String(i - 2).padStart(26, '0')}` : null,
        ].filter((x): x is string => x !== null),
      } as never),
    );
    const snapshot = makeSnapshot({ tasks });
    const store = createStore();
    store.setState({ board: snapshot });
    const dispatcher = new Dispatcher(store);

    // Event ingestion: tool calls, file changes and progress, the bulk of a busy day.
    const types = ['agent.tool_completed', 'agent.progress', 'task.updated'];
    const N = 5000;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      dispatcher.handle(
        makeEvent(i + 1, types[i % types.length] as string, {
          task_id: tasks[i % tasks.length]?.task_id,
          agent_key: 'dev-1',
          changed_paths: [`src/file-${i % 40}.ts`],
          output: `line ${i}`,
        }),
        Date.now(),
      );
    }
    const perEventUs = ((performance.now() - start) * 1000) / N;

    // The board itself: derive and lay out 500 tasks.
    const t0 = performance.now();
    const board = deriveBoard(snapshot, { showFinished: true });
    const placed = layout(layoutInputOf(board));
    const layoutMs = performance.now() - t0;

    const storeBytes = JSON.stringify(store.getState()).length;
    process.stdout.write(
      `BENCH ${JSON.stringify({
        events: N,
        per_event_us: Math.round(perEventUs * 10) / 10,
        layout_500_tasks_ms: Math.round(layoutMs * 10) / 10,
        nodes: placed.rects.size,
        store_kb: Math.round(storeBytes / 1024),
      })}\n`,
    );
    expect(perEventUs).toBeLessThan(1000);
    expect(storeBytes).toBeLessThan(20 * 1024 * 1024);
  });
});
