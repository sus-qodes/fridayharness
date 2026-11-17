/**
 * Which model does the work (Settings → Routing, plan §7.10).
 *
 * Reviewed 2026-11-17. The page was a line of jargon ("static role registry; pins beat registry
 * rank"), a list of pins by scope and raw id, and a form with a free-text role (a mistyped one
 * matched nothing and said nothing) and every model id of the catalog, the dearest first. "Use one
 * model for everything" took about six clicks per kind of work. It is now:
 * - one choice on top: let Friday choose, or always use one model (a project-wide pin underneath);
 * - a fold for a model for one kind of work or one task, with kinds to pick from, not to type;
 * - models by name, only those an agent Friday starts can run, the everyday one first;
 * - a line saying what a choice does not reach: an agent a person runs in their own editor
 *   chooses its own model.
 */
import type { RoutingPinView } from '@friday/protocol';
import { defaultModel, type ModelInfo, modelLabel, modelName, usableModels } from '../model/models.js';
import { kindWord } from '../model/routing-words.js';
import { visible } from '../model/text.js';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { shortId, timeAgo, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { errorOf, field, fold, note, plain, select, type Teardown } from './common.js';

export type PinScope = 'role' | 'task';

/** The kinds of work a model can be chosen for: the ranking's own roles, in a person's words. */
export const WORK_KINDS: readonly { role: string; label: string }[] = [
  { role: 'backend_engineer', label: 'General coding (backend, libraries, docs)' },
  { role: 'frontend_engineer', label: 'Frontend and UI' },
  { role: 'qa_and_debugging', label: 'Testing and debugging' },
  { role: 'devops_and_terminal', label: 'Build, deployment and tooling' },
  { role: 'code_reviewer_and_security', label: 'Review and security' },
  { role: 'system_architect', label: 'Architecture and research' },
];
const WORK_LABEL = new Map(WORK_KINDS.map((k) => [k.role, k.label]));

/** "Let Friday choose", in the one-model choice. */
export const FRIDAY_CHOOSES = '';

export interface RoutingPins {
  el: HTMLElement;
  /** Reads the pins and the models. */
  load(): void;
}

/** A project-wide pin of a model: what "always use one model" is underneath. Never a sensitive-work pin. */
export function everythingPin(pins: readonly RoutingPinView[]): RoutingPinView | null {
  return pins.find((p) => !p.revoked_at && p.scope === 'project' && p.model && !p.sensitive) ?? null;
}

export function routingPins(ctx: AppContext, td: Teardown): RoutingPins {
  let pins: RoutingPinView[] = [];
  let models: ModelInfo[] = [];
  let pinsRead = false;
  let busy = false;
  const pinState: { scope: PinScope; target: string; model: string } = {
    scope: 'role',
    target: WORK_KINDS[0]?.role ?? '',
    model: '',
  };

  const everything = h('div', { class: 'pn-one-model' }, h('div', { class: 'muted' }, 'Reading the model choice…'));
  const pinsList = h('div', { class: 'pn-pins' }, h('div', { class: 'muted' }, 'Reading the choices…'));
  const pinForm = h('div', { class: 'pn-pin-form' });
  const more = fold('A model for one kind of work or one task', { class: 'pn-pins-more' }, pinsList, pinForm);

  const taskName = (id: string): string => {
    const t = ctx.store.select('board')?.tasks.find((x) => x.task_id === id);
    return t ? `“${truncate(plain(t.summary, 80), 70)}”` : shortId(id);
  };
  /** What a pin is for, in words. */
  const forWhat = (p: RoutingPinView): string => {
    if (p.scope === 'project') return 'Every task';
    if (p.scope === 'kind') return `Every ${kindWord(p.target)} task`;
    if (p.scope === 'task') return `The task ${p.target ? taskName(p.target) : ''}`.trim();
    return WORK_LABEL.get(p.target ?? '') ?? `Work of the role ${visible(truncate(p.target ?? '', 80))}`;
  };

  // ---- the one choice
  function renderEverything() {
    if (!pinsRead) return;
    const current = everythingPin(pins);
    const options = usableModels(models).map((m) => ({ value: m.id, label: `Always use ${modelLabel(m)}` }));
    // A choice made elsewhere (a terminal) of a model no agent here runs is still shown as it is.
    if (current?.model && !options.some((o) => o.value === current.model)) {
      options.push({
        value: current.model,
        label: `Always use ${plain(current.model, 80)} (no agent here can run it)`,
      });
    }
    const choice = select(
      [{ value: FRIDAY_CHOOSES, label: 'Let Friday choose for each task (recommended)' }, ...options],
      current?.model ?? FRIDAY_CHOOSES,
      (v) => void choose(v),
    );
    choice.disabled = busy;
    replace(
      everything,
      field('Which model does the work?', choice, {
        hint: current
          ? 'Every task runs on this model, so only agents that can run it take work.'
          : 'Friday picks a model for each kind of work from its ranking, on whichever agent is free.',
      }).el,
      note(
        'An agent you run in your own editor (Claude Code in VS Code, Antigravity) chooses its own model: this choice does not reach it.',
      ),
    );
  }

  async function choose(model: string) {
    if (busy) return;
    const was = everythingPin(pins);
    if ((was?.model ?? FRIDAY_CHOOSES) === model) return;
    busy = true;
    renderEverything();
    const done = await ctx.act(
      model ? 'Use one model' : 'Let Friday choose',
      async () => {
        // The old choice goes first: two project-wide models would leave it open which one counts.
        if (was) await ctx.api.unpin(was.pin_id);
        if (model) {
          await ctx.api.pin({ scope: 'project', model, note: 'one model for every task, chosen in Settings' });
        }
        return true;
      },
      model ? `Every task now runs on ${modelName(model)}` : 'Friday chooses the model for each task again',
    );
    busy = false;
    if (td.done) return;
    // Read again either way: a failure half way leaves what the daemon has, not what was asked for.
    void loadPins();
    if (!done) renderEverything();
  }

  // ---- a model for one kind of work or one task
  function renderPins() {
    const live = pins.filter((p) => !p.revoked_at && p !== everythingPin(pins));
    if (live.length) more.open = true;
    replace(
      pinsList,
      live.length === 0
        ? h('div', { class: 'muted' }, 'None: the choice above covers every task.')
        : h(
            'ul',
            { class: 'pn-list' },
            live.map((p) => {
              const marks = [p.sensitive ? 'sensitive work' : null, p.needs_vision ? 'needs to see images' : null]
                .filter((v): v is string => v !== null)
                .join(', ');
              const what = p.model ? `→ ${modelName(plain(p.model, 80))}` : '';
              return h(
                'li',
                { class: 'pn-item' },
                h('span', null, forWhat(p)),
                h('span', { class: 'pn-grow' }, [what, marks].filter(Boolean).join(' · ')),
                p.until ? h('span', { class: 'muted' }, `until ${timeAgo(p.until, ctx.now())}`) : null,
                p.note ? h('span', { class: 'muted' }, plain(p.note, 200)) : null,
                button('Remove', () => void unpin(p), {
                  class: 'btn btn-ghost',
                  ariaLabel: `Remove the model choice for ${forWhat(p).toLowerCase()}`,
                }),
              );
            }),
          ),
    );
  }

  async function loadPins() {
    try {
      const r = await ctx.api.pins();
      if (td.done) return;
      pins = Array.isArray(r?.pins) ? r.pins : [];
      pinsRead = true;
      renderEverything();
      renderPins();
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      const said = `Could not read the model choices: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`;
      replace(everything, h('div', { class: 'field-error' }, said));
      replace(pinsList, h('div', { class: 'field-error' }, said));
    }
  }

  async function unpin(p: RoutingPinView) {
    const r = await ctx.act('Remove the model choice', () => ctx.api.unpin(p.pin_id), 'Removed');
    if (r && !td.done) void loadPins();
  }

  function renderPinForm() {
    const board = ctx.store.select('board');
    const offered = usableModels(models);
    const scope = select<PinScope>(
      [
        { value: 'role', label: 'A kind of work' },
        { value: 'task', label: 'One task' },
      ],
      pinState.scope,
      (v) => {
        pinState.scope = v;
        pinState.target =
          v === 'role'
            ? (WORK_KINDS[0]?.role ?? '')
            : (board?.tasks.find((t) => !['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(t.status))?.task_id ?? '');
        renderPinForm();
      },
    );
    let target: HTMLElement;
    if (pinState.scope === 'task') {
      const tasks = (board?.tasks ?? []).filter((t) => !['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(t.status));
      target = select(
        tasks.length
          ? tasks.map((t) => ({ value: t.task_id, label: truncate(plain(t.summary, 80), 70) }))
          : [{ value: '', label: 'No open task', disabled: true }],
        pinState.target,
        (v) => {
          pinState.target = v;
        },
      );
    } else {
      target = select(
        WORK_KINDS.map((k) => ({ value: k.role, label: k.label })),
        pinState.target,
        (v) => {
          pinState.target = v;
        },
      );
    }
    if (!offered.some((m) => m.id === pinState.model)) pinState.model = defaultModel(offered);
    const model = select(
      offered.length
        ? offered.map((m) => ({ value: m.id, label: modelLabel(m) }))
        : [{ value: '', label: 'No model an agent here can run', disabled: true }],
      pinState.model,
      (v) => {
        pinState.model = v;
      },
    );
    const add = button([icon('plus', 14), 'Use this model'], () => void addPin(), {
      class: 'btn',
      disabled: offered.length === 0,
    });
    replace(
      pinForm,
      h('div', { class: 'pn-grid3' }, field('For', scope).el, field('Which', target).el, field('Model', model).el),
      h('div', { class: 'pn-actions pn-actions-start' }, add),
    );
  }

  async function addPin() {
    if (!pinState.target || !pinState.model) {
      ctx.toast({ kind: 'warn', text: 'Choose what it is for and a model' });
      return;
    }
    const model = pinState.model;
    const r = await ctx.act(
      'Choose a model',
      () => ctx.api.pin({ scope: pinState.scope, target: pinState.target, model }),
      `${modelName(model)} is used for it from its next start`,
    );
    if (r && !td.done) void loadPins();
  }

  // One answer lists the models for both pickers.
  async function loadModels() {
    try {
      const r = await ctx.api.models();
      if (td.done) return;
      models = (Array.isArray(r?.models) ? r.models : []).filter((m) => typeof m?.id === 'string');
    } catch {
      models = [];
    }
    if (td.done) return;
    renderEverything();
    renderPinForm();
    renderPins();
  }

  renderPinForm();
  return {
    el: h('div', { class: 'pn-routing' }, everything, more),
    load() {
      void loadPins();
      void loadModels();
    },
  };
}
