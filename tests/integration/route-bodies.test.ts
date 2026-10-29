import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';

/** Routes the interface calls refuse what they cannot do with the right code (LESSONS UI-12). */

const ws = useTestWorkspace();

const HUMAN = { kind: 'human' as const, id: 'local-operator' };

async function call(td: TestDaemon, method: string, path: string, body?: string) {
  const res = await fetch(`${td.url}${td.operator.projectPath(path)}`, {
    method,
    headers: {
      authorization: `Bearer ${td.daemon.tokens.operator}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as { error?: { code: string } }) : {} };
}

describe('request bodies', () => {
  it('answers 400, not 500, to an empty or malformed body', async () => {
    const td = await startTestDaemon(ws());
    for (const path of ['/policy/trust', '/tasks/task_00000000000000000000000000/recover', '/file-reservations']) {
      for (const body of ['', '{not json', '[]']) {
        const r = await call(td, 'POST', path, body);
        expect(r.status, `${path} with ${JSON.stringify(body)}`).toBe(400);
        expect(r.body.error?.code).toMatch(/^COS-100[01]$/);
      }
    }
  });
});

describe('answering a question', () => {
  it('refuses an unknown escalation and a second answer', async () => {
    const td = await startTestDaemon(ws());
    const unknown = await call(td, 'POST', '/escalations/esc_00000000000000000000000000/answer', '{"answer":"yes"}');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error?.code).toBe('COS-1000');

    const id = td.daemon.state.raiseEscalation(td.project.project_id, HUMAN, {
      kind: 'ambiguous_intent',
      goal_id: null,
      task_id: null,
      question: 'Which currency?',
      options: ['EUR', 'USD'],
      details: {},
    });
    const first = await call(td, 'POST', `/escalations/${id}/answer`, '{"answer":"EUR"}');
    expect(first.status).toBe(200);
    const second = await call(td, 'POST', `/escalations/${id}/answer`, '{"answer":"USD"}');
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('COS-2002');
    expect(td.daemon.state.q.escalation(id)).toMatchObject({ status: 'answered', answer: 'EUR' });
  });
});
