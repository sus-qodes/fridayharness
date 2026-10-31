import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it, vi } from 'vitest';
import type { GenericHarnessClient } from './index.js';
import { AttemptStops, TerminalReports } from './spawn.js';

const ws = useTestWorkspace();

describe('confirmed worker cleanup', () => {
  it('does not replay a completion claim after a restart interrupted worker cleanup', async () => {
    const call = vi.fn(async () => ({}));
    const client = { call } as unknown as GenericHarnessClient;
    let failStop!: (error: Error) => void;
    const stopping = new Promise<void>((_resolve, reject) => {
      failStop = reject;
    });
    const original = new TerminalReports({ dir: ws().stateDir, client: () => client, log: () => undefined });
    const delivery = original.report(
      'result',
      {
        task_id: 'task_cleanup',
        run_id: 'run_cleanup',
        status: 'completed_claim',
        summary: 'done',
        changed_paths: [],
      },
      { stop: () => stopping },
    );
    const restarted = new TerminalReports({ dir: ws().stateDir, client: () => client, log: () => undefined });
    await restarted.deliver('run_cleanup');
    try {
      expect(call).not.toHaveBeenCalledWith('agent.result', expect.anything());
      expect(call).toHaveBeenCalledWith('agent.error', expect.objectContaining({ fatal: true, worker_stopped: false }));
    } finally {
      failStop(new Error('adapter restarted during termination'));
      await delivery;
    }
  });
  it('refuses a completion claim when the worker could not be stopped', async () => {
    const call = vi.fn(async () => ({}));
    const client = { call } as unknown as GenericHarnessClient;
    const reports = new TerminalReports({ client: () => client, log: () => undefined });
    await reports.report(
      'result',
      {
        task_id: 'task_cleanup',
        run_id: 'run_cleanup',
        status: 'completed_claim',
        summary: 'done',
        changed_paths: [],
      },
      {
        stop: async () => {
          throw new Error('termination failed');
        },
      },
    );
    expect(call).not.toHaveBeenCalledWith('agent.result', expect.anything());
    expect(call).toHaveBeenCalledWith('agent.error', expect.objectContaining({ fatal: true, worker_stopped: false }));
  });
  it('spools the terminal outcome before stopping, but publishes it only after confirmed termination', async () => {
    const call = vi.fn(async () => ({}));
    const client = { call } as unknown as GenericHarnessClient;
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stop = vi.fn(() => stopped);
    const reports = new TerminalReports({ dir: ws().stateDir, client: () => client, log: () => undefined });
    const delivery = reports.report(
      'error',
      {
        task_id: 'task_cleanup',
        run_id: 'run_cleanup',
        message: 'worker exited',
        fatal: true,
      },
      { stop },
    );
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const file = path.join(ws().stateDir, 'run_cleanup.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).params.worker_stopped).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
    finish();
    expect(await delivery).toBe('recorded');
    expect(call).toHaveBeenCalledWith('agent.error', expect.objectContaining({ worker_stopped: true }));
    expect(existsSync(file)).toBe(false);
  });

  it('reports an unconfirmed stop without manufacturing successful termination evidence', async () => {
    const call = vi.fn(async () => ({}));
    const client = { call } as unknown as GenericHarnessClient;
    const reports = new TerminalReports({ client: () => client, log: () => undefined });
    await reports.report(
      'error',
      {
        task_id: 'task_cleanup',
        run_id: 'run_cleanup',
        message: 'worker exited',
        fatal: true,
      },
      {
        stop: async () => {
          throw new Error('a descendant is still running');
        },
      },
    );
    expect(call).toHaveBeenCalledWith('agent.error', expect.objectContaining({ worker_stopped: false }));
  });

  it('shares one stop between concurrent cancellation and completion', async () => {
    const stops = new AttemptStops();
    let finish!: () => void;
    const ending = new Promise<void>((r) => {
      finish = r;
    });
    const stop = vi.fn(() => ending);
    const first = stops.run('run_cleanup', stop);
    const second = stops.run('run_cleanup', stop);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
  });
});
