import type { RoutingPinView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeSnapshot, makeTask } from '../test/fixtures.js';
import { Teardown } from './common.js';
import { everythingPin, FRIDAY_CHOOSES, routingPins, WORK_KINDS } from './routing-pins.js';
import { BIDI, buttonBy, choose, controlBy, flush, HOSTILE } from './test-support.js';

/** The catalog as the daemon lists it: the dearest first, and models no agent here could run. */
const MODELS = {
  models: [
    { id: 'claude-fable-5-1', vendors: ['claude-code'], source: 'seed' },
    { id: 'claude-sonnet-5-5', vendors: ['claude-code', 'cursor'], source: 'seed' },
    { id: 'z-ai/glm-5.3', vendors: ['opencode'], source: 'seed' },
    { id: 'openai/gpt-6.1-sol', vendors: ['codex'], source: 'seed' },
  ],
  evidence: [],
  settings: {},
};

const pin = (over: Partial<RoutingPinView> = {}): RoutingPinView => ({
  pin_id: 'pin1',
  scope: 'kind',
  target: 'docs',
  model: 'openai/gpt-6.1-sol',
  sensitive: false,
  needs_vision: false,
  until: null,
  source: 'human',
  note: null,
  created_at: 'x',
  revoked_at: null,
  ...over,
});

function open(answers: Record<string, unknown>, tasks = [makeTask()]) {
  const ctx = makeContext({ snapshot: makeSnapshot({ tasks }), answers });
  const td = new Teardown();
  const panel = routingPins(ctx, td);
  panel.load();
  return { ctx, td, el: panel.el };
}
const one = (el: HTMLElement) => controlBy<HTMLSelectElement>(el, 'Which model does the work?');
const posts = (ctx: ReturnType<typeof makeContext>) =>
  ctx.transport.calls.filter((c) => c.method === 'POST').map((c) => [c.path.split('/routing/')[1], c.body]);

describe('which model does the work', () => {
  it('opens on "Let Friday choose", with models by name, the everyday one first, and none no agent here runs', async () => {
    const { el, td } = open({ 'GET /models': MODELS, 'GET /routing/pins': { pins: [] } });
    expect(el.textContent).toContain('Reading the model choice');
    await flush();
    const choice = one(el);
    expect(choice.value).toBe(FRIDAY_CHOOSES);
    expect([...choice.options].map((o) => o.textContent)).toEqual([
      'Let Friday choose for each task (recommended)',
      'Always use Claude Sonnet 5.5 (Claude Code)',
      'Always use Claude Fable 5.1 (Claude Code)',
      'Always use GPT-6.1 Sol (Codex)',
    ]);
    expect(el.textContent).toContain('Friday picks a model for each kind of work from its ranking');
    // What a choice does not reach is said where it is made.
    expect(el.textContent).toContain(
      'An agent you run in your own editor (Claude Code in VS Code, Antigravity) chooses its own model',
    );
    // Nothing of the old page's jargon, and the finer choices are folded away while there are none.
    expect(el.textContent).not.toContain('static role registry');
    const more = el.querySelector('details.pn-pins-more') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain('None: the choice above covers every task.');
    td.run();
  });

  it('uses one model for everything in one step, changes it, and gives the choice back to Friday', async () => {
    let pins: RoutingPinView[] = [];
    let made = 0;
    const { ctx, el, td } = open({
      'GET /models': MODELS,
      'GET /routing/pins': () => ({ pins }),
      'POST /routing/pins': (c: { body: unknown }) => {
        const body = c.body as { model: string };
        made += 1;
        pins = [pin({ pin_id: `pin-${made}`, scope: 'project', target: null, model: body.model })];
        return { pin: pins[0] };
      },
      'POST /routing/pins/pin-1/revoke': () => {
        pins = [];
        return { pin: {} };
      },
      'POST /routing/pins/pin-2/revoke': () => {
        pins = [];
        return { pin: {} };
      },
    });
    await flush();
    choose(one(el), 'claude-sonnet-5-5');
    await flush();
    expect(posts(ctx)).toEqual([
      ['pins', { scope: 'project', model: 'claude-sonnet-5-5', note: 'one model for every task, chosen in Settings' }],
    ]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Every task now runs on Claude Sonnet 5.5' });
    expect(one(el).value).toBe('claude-sonnet-5-5');
    expect(el.textContent).toContain('Every task runs on this model, so only agents that can run it take work.');
    // The project-wide choice is the control itself, not a row of the finer choices.
    expect(el.querySelector('details.pn-pins-more')?.textContent).toContain(
      'None: the choice above covers every task.',
    );

    // Another model: the old choice goes first, so two project-wide models never stand together.
    choose(one(el), 'openai/gpt-6.1-sol');
    await flush();
    expect(
      posts(ctx)
        .slice(1)
        .map(([path]) => path),
    ).toEqual(['pins/pin-1/revoke', 'pins']);
    expect(one(el).value).toBe('openai/gpt-6.1-sol');

    choose(one(el), FRIDAY_CHOOSES);
    await flush();
    expect(posts(ctx).at(-1)?.[0]).toBe('pins/pin-2/revoke');
    expect(ctx.toasts.at(-1)?.text).toBe('Friday chooses the model for each task again');
    expect(one(el).value).toBe(FRIDAY_CHOOSES);
    td.run();
  });

  it('shows a project-wide choice made elsewhere as it is, and never takes a sensitive-work pin for it', async () => {
    const elsewhere = pin({ pin_id: 'p-x', scope: 'project', target: null, model: 'z-ai/glm-5.3' });
    const a = open({ 'GET /models': MODELS, 'GET /routing/pins': { pins: [elsewhere] } });
    await flush();
    expect(one(a.el).value).toBe('z-ai/glm-5.3');
    expect(one(a.el).selectedOptions[0]?.textContent).toBe('Always use z-ai/glm-5.3 (no agent here can run it)');
    a.td.run();
    const sensitive = pin({ pin_id: 'p-s', scope: 'project', target: null, model: 'local-coder', sensitive: true });
    expect(everythingPin([sensitive])).toBeNull();
    expect(everythingPin([pin({ scope: 'project', revoked_at: 'x' })])).toBeNull();
    const b = open({ 'GET /models': MODELS, 'GET /routing/pins': { pins: [sensitive] } });
    await flush();
    expect(one(b.el).value).toBe(FRIDAY_CHOOSES);
    // It is listed among the finer choices, in words, where it can be removed.
    const more = b.el.querySelector('details.pn-pins-more') as HTMLDetailsElement;
    expect(more.open).toBe(true);
    expect(more.textContent).toContain('Every task');
    expect(more.textContent).toContain('sensitive work');
    b.td.run();
  });

  it('lists the finer choices in words, and removes one', async () => {
    const task = makeTask({ summary: `Fix ${HOSTILE}` });
    let pins = [
      pin(),
      pin({ pin_id: 'p-role', scope: 'role', target: 'frontend_engineer', model: 'claude-sonnet-5-5' }),
      pin({ pin_id: 'p-task', scope: 'task', target: task.task_id, model: 'claude-fable-5-1', note: HOSTILE }),
      pin({ pin_id: 'p-odd', scope: 'role', target: BIDI, model: HOSTILE }),
      pin({ pin_id: 'p-gone', scope: 'task', target: 'task_00000000000000000000gone01', revoked_at: 'x' }),
    ];
    const { ctx, el, td } = open(
      {
        'GET /models': MODELS,
        'GET /routing/pins': () => ({ pins }),
        'POST /routing/pins/pin1/revoke': () => {
          pins = pins.filter((p) => p.pin_id !== 'pin1');
          return { pin: {} };
        },
      },
      [task],
    );
    await flush();
    const more = el.querySelector('details.pn-pins-more') as HTMLDetailsElement;
    expect(more.open).toBe(true);
    const rows = [...more.querySelectorAll('.pn-pins li')].map((li) => li.textContent);
    expect(rows[0]).toContain('Every documentation task→ GPT-6.1 Sol');
    expect(rows[1]).toContain('Frontend and UI→ Claude Sonnet 5.5');
    expect(rows[2]).toContain(`The task “Fix ${HOSTILE}”→ Claude Fable 5.1`);
    expect(rows[3]).toContain('Work of the role invoice⟨U+202E⟩txt.exe');
    expect(rows).toHaveLength(4);
    expect(el.querySelector('img')).toBeNull();
    expect(more.textContent).not.toContain('‮');
    buttonBy(el, 'Remove the model choice for every documentation task').click();
    await flush();
    expect(ctx.transport.to('POST', '/routing/pins/pin1/revoke')).toHaveLength(1);
    expect([...more.querySelectorAll('.pn-pins li')]).toHaveLength(3);
    td.run();
  });

  it('chooses a model for a kind of work picked from a list, or for one open task', async () => {
    const { ctx, el, td } = open({
      'GET /models': MODELS,
      'GET /routing/pins': { pins: [] },
      'POST /routing/pins': { pin: {} },
    });
    await flush();
    // Kinds of work to pick from, never a box to type a role into.
    expect([...controlBy<HTMLSelectElement>(el, 'Which').options].map((o) => o.textContent)).toEqual(
      WORK_KINDS.map((k) => k.label),
    );
    expect(controlBy<HTMLSelectElement>(el, 'Model').value).toBe('claude-sonnet-5-5');
    choose(controlBy<HTMLSelectElement>(el, 'Which'), 'frontend_engineer');
    choose(controlBy<HTMLSelectElement>(el, 'Model'), 'openai/gpt-6.1-sol');
    buttonBy(el, 'Use this model').click();
    await flush();
    expect(ctx.transport.to('POST', '/routing/pins')[0]?.body).toEqual({
      scope: 'role',
      target: 'frontend_engineer',
      model: 'openai/gpt-6.1-sol',
    });
    expect(ctx.toasts.at(-1)?.text).toBe('GPT-6.1 Sol is used for it from its next start');
    choose(controlBy<HTMLSelectElement>(el, 'For'), 'task');
    expect(controlBy<HTMLSelectElement>(el, 'Which').value).toBe('task_0000000000000000000000aa01');
    buttonBy(el, 'Use this model').click();
    await flush();
    expect(ctx.transport.to('POST', '/routing/pins')[1]?.body).toMatchObject({
      scope: 'task',
      target: 'task_0000000000000000000000aa01',
    });
    td.run();
  });

  it('says when the choices could not be read, and offers nothing to choose when no model is known', async () => {
    const failing = open({
      'GET /models': MODELS,
      'GET /routing/pins': () => {
        throw new Error('offline');
      },
    });
    await flush();
    expect(failing.el.textContent).toContain('Could not read the model choices: offline');
    failing.td.run();
    const bare = open({ 'GET /models': { models: [] }, 'GET /routing/pins': { pins: [] } });
    await flush();
    expect([...one(bare.el).options].map((o) => o.textContent)).toEqual([
      'Let Friday choose for each task (recommended)',
    ]);
    expect(bare.el.textContent).toContain('No model an agent here can run');
    expect(buttonBy(bare.el, 'Use this model').disabled).toBe(true);
    bare.td.run();
  });
});
