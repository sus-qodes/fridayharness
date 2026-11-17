import type { BrainStatusView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import {
  DEFAULT_PLANNER,
  defaultPlannerModel,
  PLANNER_DEFAULT,
  plannerModelOptions,
  plannerModelRow,
} from './planner-model.js';
import { choose, flush, HOSTILE } from './test-support.js';

const brain = (model_choice: BrainStatusView['model_choice'] | undefined): BrainStatusView =>
  ({ provider: 'claude-code', model: 'claude-opus-5-5', ...(model_choice ? { model_choice } : {}) }) as BrainStatusView;
const picker = (row: HTMLElement) => row.querySelector('select') as HTMLSelectElement;

describe('the planner’s model', () => {
  it('offers the default first, then what each other model means for the cost', () => {
    const auto = { here: null, project: 'auto', applies: true };
    expect(defaultPlannerModel(auto)).toBe(DEFAULT_PLANNER);
    expect(plannerModelOptions(auto)).toEqual([
      { value: PLANNER_DEFAULT, label: 'Friday’s default (Claude Opus 5.5)' },
      { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5: about half the cost, and faster' },
      { value: 'claude-fable-5-2', label: 'Claude Fable 5.2: the most capable, about twice the cost' },
    ]);
    // A project that names its own model: that is the default here, and Opus is a choice like the others.
    const own = { here: null, project: 'claude-sonnet-5-5', applies: true };
    expect(plannerModelOptions(own).map((o) => o.value)).toEqual([
      PLANNER_DEFAULT,
      'claude-opus-5-5',
      'claude-fable-5-2',
    ]);
    expect(plannerModelOptions(own)[0]?.label).toBe('The project’s setting (Claude Sonnet 5.5)');
    // A choice made elsewhere (a terminal) of a model not in the list is kept, as it is.
    const elsewhere = { here: `claude-haiku-5-5`, project: 'auto', applies: true };
    expect(plannerModelOptions(elsewhere).at(-1)).toEqual({ value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' });
  });

  it('is not shown where a choice made here would not be the one used', () => {
    const ctx = makeContext();
    expect(plannerModelRow(ctx, brain(undefined))).toBeNull();
    expect(plannerModelRow(ctx, brain({ here: null, project: 'qwen2.5:7b', applies: false }))).toBeNull();
  });

  it('saves the choice, says from when it applies, and hands it back to the default', async () => {
    const ctx = makeContext({ answers: { 'POST /brain/planner-choice': {} } });
    const row = plannerModelRow(ctx, brain({ here: null, project: 'auto', applies: true })) as HTMLElement;
    expect(row.textContent).toContain(
      'Which model writes the plans. Kept on this computer, and used from the next plan.',
    );
    expect(picker(row).value).toBe(PLANNER_DEFAULT);
    choose(picker(row), 'claude-sonnet-5-5');
    await flush();
    expect(ctx.transport.to('POST', '/brain/planner-choice')[0]?.body).toEqual({ model: 'claude-sonnet-5-5' });
    expect(ctx.toasts.at(-1)).toEqual({
      kind: 'success',
      text: 'Plans are written by Claude Sonnet 5.5 from the next one',
    });
    expect(ctx.refreshes).toBe(1);
    const chosen = plannerModelRow(
      ctx,
      brain({ here: 'claude-sonnet-5-5', project: 'auto', applies: true }),
    ) as HTMLElement;
    expect(picker(chosen).value).toBe('claude-sonnet-5-5');
    choose(picker(chosen), PLANNER_DEFAULT);
    await flush();
    expect(ctx.transport.to('POST', '/brain/planner-choice')[1]?.body).toEqual({ model: null });
    expect(ctx.toasts.at(-1)?.text).toBe('Plans are written by Claude Opus 5.5 again');
  });

  it('puts the old choice back when Friday refuses the model', async () => {
    const ctx = makeContext({
      answers: {
        'POST /brain/planner-choice': () => {
          throw new ApiError(400, 'COS-1001', 'invalid_request', `Friday has no price for it ${HOSTILE}`);
        },
      },
    });
    const row = plannerModelRow(ctx, brain({ here: null, project: 'auto', applies: true })) as HTMLElement;
    choose(picker(row), 'claude-fable-5-2');
    await flush();
    expect(picker(row).value).toBe(PLANNER_DEFAULT);
    expect(picker(row).disabled).toBe(false);
    expect(ctx.toasts.at(-1)?.kind).toBe('error');
    expect(ctx.refreshes).toBe(0);
  });
});
