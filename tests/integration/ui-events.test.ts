import { claudeCodeHooks } from '@friday/adapter-claude';
import type { DomainEvent } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { attachedSession, NO_WORKTREES, raw, signIn, spawnedSession } from '../helpers/ui.js';

/**
 * Every event type the interface's routes record can be read back through `GET events`: an
 * unregistered observation would throw, or vanish behind a catch (LESSONS UI-32).
 */

const ws = useTestWorkspace();

describe("the interface's events", () => {
  it('are recorded and read back', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()], extraConfig: NO_WORKTREES });
    const token = await signIn(td);
    await raw(td, 'POST', td.operator.projectPath('/ui/logout'), { token, body: '{}' });
    await attachedSession(td);
    await spawnedSession(td, { hooks: true });
    const op = td.daemon.tokens.operator;
    await raw(td, 'POST', td.operator.projectPath('/control/pause'), { token: op, body: '{}' });
    await raw(td, 'POST', td.operator.projectPath('/control/resume'), { token: op, body: '{}' });
    await raw(td, 'POST', td.operator.projectPath('/control/halt'), {
      token: op,
      body: JSON.stringify({ reason: 'test' }),
    });
    const { events } = await td.operator.get<{ events: DomainEvent[] }>(td.operator.projectPath('/events?limit=1000'));
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      'ui.session_started',
      'ui.session_ended',
      'control.paused',
      'control.resumed',
      'control.halted',
      'control.task_stopped',
    ]) {
      expect(types.has(t), t).toBe(true);
    }
  });
});
