/**
 * "Who writes your plans" (Settings → Planner, 2026-11-23). Until then the page offered Claude
 * only: Claude Code's sign-in, or an Anthropic key. A person with Codex, with a key of another
 * service, or with a model on their own computer could not have Friday plan at all.
 *
 * One row for each way to plan (`brain.planners`), each saying where it stands and offering the
 * next step it still needs. The rules stand as they were:
 *  - whether a project lets planning send its text somewhere is the project's own, shared setting,
 *    asked first and said to be shared;
 *  - a key goes into Windows' own password prompt, never into this page;
 *  - allowing it on this computer is this computer's own act, in the app's own dialog;
 *  - how a person plans, and with which model, is theirs: kept on this computer.
 * Codex and the key services have no price Friday knows, so they are held to requests a day and
 * nothing is said in dollars.
 *
 * Claude Code and the Anthropic key keep the steps they had (`quick-setup.ts`, the key card of
 * `settings-hub.ts`): they are shown under their row.
 */
import type { BrainStatusView, PlannerOptionView } from '@friday/protocol';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { badge, input, linkButton, note, plain, restartBlocked, select, type Teardown } from './common.js';
import { clampNumber } from './settings.js';

/** The requests a day offered when a person allows a planner that has no price. */
export const DEFAULT_REQUESTS = 50;

/** What each way to plan is, in a line under its name. */
const WHAT: Record<string, string> = {
  'claude-code': 'The Claude Code installed on this computer, signed in as it already is. No key.',
  codex:
    'The Codex installed on this computer, signed in as it already is (your ChatGPT plan or key). No key to store.',
  anthropic: 'Claude, with your own Anthropic API key.',
  openai: 'An OpenAI model, with your own OpenAI API key.',
  gemini: 'A Gemini model, with your own Google Gemini API key.',
  deepseek: 'A DeepSeek model, with your own DeepSeek API key.',
  openrouter: 'Any model OpenRouter offers, with your own OpenRouter key.',
  local:
    'A model that runs on this computer (Ollama, LM Studio). Free, and nothing leaves the computer; plans are simpler.',
  none: 'Friday asks no model. Each goal waits for a plan you write in the plan editor.',
};

/** The planner that counts: this person's choice, else the project's; the running one on an older Friday. */
function wanted(brain: BrainStatusView | null): string | null {
  return brain?.choice?.wanted ?? brain?.provider ?? null;
}

export type RowState = 'in_use' | 'restart' | 'not_found' | 'set_up' | 'off';

/** Where a way to plan stands: used now, chosen and waiting for a restart, missing, half set up, or not chosen. */
export function rowState(brain: BrainStatusView | null, o: PlannerOptionView): RowState {
  const chosen = wanted(brain) === o.id;
  if (chosen && brain?.provider === o.id) return brain.planner_available || o.kind === 'none' ? 'in_use' : 'set_up';
  if (chosen) return 'restart';
  if (o.found === false) return 'not_found';
  return 'off';
}

/** What a way to plan still needs before it can be used, in order. */
export function stepsLeft(o: PlannerOptionView): ('project' | 'key' | 'approve' | 'model')[] {
  const left: ('project' | 'key' | 'approve' | 'model')[] = [];
  if (o.remote && !o.allowed) left.push('project');
  if (o.kind === 'key' && o.key === 'missing') left.push('key');
  if (o.remote && !o.approved) left.push('approve');
  if (o.needs_model && !o.model) left.push('model');
  return left;
}

/**
 * The card. `own` holds the steps Claude Code and the Anthropic key already had, shown under their
 * rows. Null on a Friday that does not list its planners (an older one): the page keeps its old cards.
 */
export function plannerChoices(
  ctx: AppContext,
  td: Teardown,
  own: { 'claude-code'?: HTMLElement; anthropic?: HTMLElement },
): HTMLElement | null {
  if (!ctx.store.select('board')?.brain?.planners) return null;
  const native = ctx.platform.desktop ?? null;
  const list = h('div', { class: 'pn-planners', role: 'list' });
  const el = h(
    'div',
    { class: 'pn-quick-setup', dataset: { setup: 'planners' } },
    h('div', { class: 'pn-qs-title' }, 'Who writes your plans'),
    note(
      'Friday writes a plan for each goal, and you review it before anything starts. Choose who writes it: this is your own choice, kept on this computer.',
    ),
    list,
  );
  /** The row a person opened; the one in use, or half set up, opens by itself. */
  let open: string | null = null;
  let busy = false;
  /** The models a service listed, by planner; `null` while they are read. */
  const models = new Map<string, string[] | null>();
  const requests = new Map<string, number>();
  const brainNow = () => ctx.store.select('board')?.brain ?? null;

  async function work(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } finally {
      busy = false;
      if (!td.done) {
        ctx.refresh();
        render();
      }
    }
  }

  async function restart(why: string) {
    if (!native || restartBlocked(ctx)) return;
    await ctx.act(
      'Restart Friday',
      () => native.restart(),
      (done) => (done ? why : ''),
    );
  }

  /** 1. The project allows it: the one setting of this the team shares, asked first. */
  const allowForProject = (o: PlannerOptionView) =>
    work(async () => {
      const ok = await ctx.confirm({
        title: `Allow planning with ${o.label} in this project?`,
        body: [
          `To plan, Friday sends the goal and a summary of the project to ${o.kind === 'program' ? `${o.label}’s service, through the ${o.label} installed here` : o.label}.`,
          'Whether a project allows that is the project’s own setting, in .friday/config.yaml, which your team shares. Turning it on changes that file. Each person still allows it on their own computer.',
        ],
        confirmLabel: 'Allow it for this project',
      });
      if (!ok) return;
      await ctx.act(
        `Allow planning with ${o.label}`,
        () => ctx.api.editSettings({ [`providers.${o.id}.allow_remote`]: true }),
        'The project allows it',
      );
    });

  /** 2. The key, into Windows' own password prompt. */
  const storeKey = (o: PlannerOptionView) =>
    work(async () => {
      if (!native) return;
      const done = await ctx.act(`Store the ${o.label} key`, () => native.storeKey(o.id));
      if (done) ctx.toast({ kind: 'success', text: `The ${o.label} key is stored on this computer` });
    });

  /** 3. This computer allows it, in the app's own dialog, with its requests a day. */
  const approve = (o: PlannerOptionView) =>
    work(async () => {
      if (!native) return;
      const calls = requests.get(o.id) ?? Math.min(DEFAULT_REQUESTS, o.project_calls ?? DEFAULT_REQUESTS);
      const done = await ctx.act(`Allow planning with ${o.label}`, () => native.allowSpending(0, o.id, calls));
      if (done) {
        ctx.toast({
          kind: 'success',
          text: `Planning with ${o.label} is allowed on this computer, up to ${calls} requests a day`,
        });
      }
    });

  /** 4. The model: picked from what the service, or the server on this computer, lists. */
  const loadModels = (o: PlannerOptionView) =>
    work(async () => {
      models.set(o.id, null);
      render();
      const got = await ctx.act('Read the models', () => ctx.api.plannerModels(o.id));
      if (got) models.set(o.id, got.models);
      else models.delete(o.id);
    });

  const chooseModel = (o: PlannerOptionView, model: string | null) =>
    work(async () => {
      await ctx.act(
        'Choose the model',
        () => ctx.api.choosePlannerModel(model, o.id),
        model ? `${o.label} plans with ${plain(model, 80)}` : `${o.label} plans with its own default model`,
      );
    });

  /** Last: this person plans with it, and Friday restarts when it runs another planner. */
  const use = (o: PlannerOptionView) =>
    work(async () => {
      const chosen = await ctx.act(
        o.kind === 'none' ? 'Write plans myself' : `Plan with ${o.label}`,
        () => ctx.api.choosePlanner(o.id),
        o.kind === 'none' ? 'You write the plans: Friday asks no model' : undefined,
      );
      if (!chosen) return;
      if (chosen.provider !== o.id) {
        await restart(
          o.kind === 'none' ? 'Friday restarts without a planner' : `Friday restarts to plan with ${o.label}`,
        );
      }
    });

  const saveAddress = (field: HTMLInputElement) =>
    work(async () => {
      const value = field.value.trim();
      const set = await ctx.act(
        'Set the address',
        () => ctx.api.setLocalPlannerAddress(value || null),
        'The address is set: Friday uses it when it restarts',
      );
      if (set) models.delete('local');
    });

  function stateBadge(state: RowState, o: PlannerOptionView): HTMLElement | null {
    switch (state) {
      case 'in_use':
        return badge('in use', 'good');
      case 'restart':
        return badge('restart needed', 'warn');
      case 'set_up':
        return badge('not ready yet', 'warn');
      case 'not_found':
        return badge('not found', 'muted', `Friday did not find ${o.label} on this computer when it started`);
      default:
        return null;
    }
  }

  /** The model of a planner that names one: its own default first where it has one. */
  function modelPicker(o: PlannerOptionView): HTMLElement {
    const listed = models.get(o.id);
    if (o.kind === 'program') {
      // Codex lists no models to an outsider: its own default, or a name the person types.
      const field = input({
        value: o.model ?? '',
        placeholder: 'Codex’s own default',
        class: 'input pn-planner-model-name',
        aria: { label: `Model for ${o.label}` },
        maxLength: 100,
      });
      return h(
        'div',
        { class: 'pn-planner-step', dataset: { step: 'model' } },
        h('span', { class: 'pn-planner-step-what' }, 'Model: leave empty for the one your account uses by default.'),
        h(
          'div',
          { class: 'row' },
          field,
          button('Save', () => void chooseModel(o, field.value.trim() || null), { class: 'btn', disabled: busy }),
        ),
      );
    }
    const options = [
      { value: '', label: o.model ? 'Choose another…' : 'Choose a model…', disabled: true },
      ...[...new Set([...(o.model ? [o.model] : []), ...(listed ?? [])])].map((m) => ({
        value: m,
        label: plain(m, 100),
      })),
    ];
    const picker = select(options, o.model ?? '', (value) => void chooseModel(o, value || null), {
      aria: { label: `Model for ${o.label}` },
      disabled: busy || !listed,
    });
    const needsKey = o.kind === 'key' && o.key === 'missing';
    return h(
      'div',
      { class: 'pn-planner-step', dataset: { step: 'model' } },
      h(
        'span',
        { class: 'pn-planner-step-what' },
        o.model ? `Model: ${plain(o.model, 100)}.` : 'Choose the model that writes the plans.',
      ),
      h(
        'div',
        { class: 'row' },
        listed ? picker : null,
        button(
          listed === null
            ? 'Reading…'
            : listed
              ? 'Read the list again'
              : o.kind === 'local'
                ? 'List this computer’s models'
                : `List ${o.label}’s models`,
          () => void loadModels(o),
          {
            class: 'btn',
            disabled: busy || listed === null || needsKey,
            ...(needsKey ? { title: 'Store the key first: the list is read with it' } : {}),
          },
        ),
      ),
      listed && listed.length === 0
        ? note(
            o.kind === 'local'
              ? 'The server lists no model yet: download one in Ollama or LM Studio, then read the list again.'
              : 'The service listed no model for this key.',
          )
        : null,
    );
  }

  /** The address of the model server on this computer (LM Studio listens elsewhere than Ollama). */
  function addressRow(o: PlannerOptionView): HTMLElement {
    const field = input({
      value: o.endpoint ?? '',
      placeholder: 'http://127.0.0.1:11434/v1',
      class: 'input pn-planner-address',
      aria: { label: 'Address of the model server on this computer' },
      maxLength: 200,
    });
    return h(
      'div',
      { class: 'pn-planner-step', dataset: { step: 'address' } },
      h(
        'span',
        { class: 'pn-planner-step-what' },
        'Where the model server listens. Ollama: http://127.0.0.1:11434/v1. LM Studio: http://127.0.0.1:1234/v1. Only an address of this computer is taken.',
      ),
      h(
        'div',
        { class: 'row' },
        field,
        button('Save', () => void saveAddress(field), { class: 'btn', disabled: busy }),
      ),
    );
  }

  /** The steps of a way to plan that this card itself takes a person through. */
  function steps(o: PlannerOptionView, state: RowState): HTMLElement[] {
    const left = stepsLeft(o);
    const out: HTMLElement[] = [];
    const step = (name: string, what: string, action: HTMLElement | null) =>
      h(
        'div',
        { class: 'pn-planner-step', dataset: { step: name } },
        h('span', { class: 'pn-planner-step-what' }, what),
        action,
      );
    if (o.found === false) {
      out.push(
        step(
          'found',
          `Friday did not find ${o.label} on this computer when it started. Install ${o.label} and sign in to it; if you just did, restart Friday so it looks again.`,
          native
            ? button([icon('rework', 14), 'Restart Friday'], () => void work(() => restart('Friday is restarting')), {
                class: 'btn',
                disabled: busy,
              })
            : null,
        ),
      );
      return out;
    }
    if (left.includes('project')) {
      out.push(
        step(
          'project',
          'This project does not allow it yet.',
          button('Allow it for this project…', () => void allowForProject(o), { class: 'btn', disabled: busy }),
        ),
      );
    }
    if (left.includes('key')) {
      out.push(
        step(
          'key',
          native
            ? 'Your key is not stored yet. It goes into Windows’ own password box, never into this page.'
            : 'Your key is not stored yet. Open Friday’s desktop app to store it: a key is never typed into a browser page.',
          native
            ? button([icon('shield', 14), 'Store the key…'], () => void storeKey(o), { class: 'btn', disabled: busy })
            : null,
        ),
      );
    }
    if (left.includes('approve')) {
      const field = input({
        type: 'number',
        min: '1',
        max: '10000',
        step: '1',
        value: String(requests.get(o.id) ?? Math.min(DEFAULT_REQUESTS, o.project_calls ?? DEFAULT_REQUESTS)),
        class: 'input pn-qs-budget',
        aria: { label: `Requests a day for ${o.label}` },
      });
      field.addEventListener('input', () => {
        const v = clampNumber(field.value, 1, 10_000);
        if (v !== null) requests.set(o.id, Math.round(v));
      });
      out.push(
        step(
          'approve',
          native
            ? 'It is not allowed on this computer yet. Friday knows no price for it, so its limit is a number of requests a day (a plan is usually one or two).'
            : 'It is not allowed on this computer yet. Open Friday’s desktop app to allow it: that is this computer’s own step.',
          native
            ? h(
                'div',
                { class: 'row' },
                h('label', { class: 'pn-qs-row' }, h('span', null, 'Requests a day'), field),
                button([icon('check', 14), 'Allow on this computer…'], () => void approve(o), {
                  class: 'btn',
                  disabled: busy,
                }),
              )
            : null,
        ),
      );
    }
    if (o.kind === 'local') out.push(addressRow(o));
    if (o.needs_model || o.id === 'codex') out.push(modelPicker(o));
    // The last step, once nothing else is left: this person plans with it.
    const ready = left.length === 0;
    if (state === 'restart') {
      out.push(
        step(
          'restart',
          'Friday picks it up when it restarts.',
          native
            ? button(
                [icon('rework', 14), 'Restart Friday'],
                () => void work(() => restart(`Friday restarts to plan with ${o.label}`)),
                { class: 'btn btn-primary', disabled: busy },
              )
            : null,
        ),
      );
    } else if (state !== 'in_use') {
      out.push(
        h(
          'div',
          { class: 'pn-actions pn-actions-start' },
          button([icon('check', 14), `Plan with ${o.label}`], () => void use(o), {
            class: 'btn btn-primary',
            disabled: busy || !ready,
            dataset: { action: 'use' },
            ...(ready ? {} : { title: 'Take the steps above first' }),
          }),
        ),
      );
    }
    return out;
  }

  function row(brain: BrainStatusView, o: PlannerOptionView): HTMLElement {
    const state = rowState(brain, o);
    const isOpen = open === null ? state === 'in_use' || state === 'restart' || state === 'set_up' : open === o.id;
    const head = button(
      [
        h('span', { class: 'pn-planner-name' }, o.label),
        h('span', { class: 'pn-planner-what muted' }, WHAT[o.id] ?? ''),
        stateBadge(state, o),
      ],
      () => {
        open = isOpen ? '' : o.id;
        render();
      },
      { class: 'btn pn-planner-head', aria: { expanded: isOpen ? 'true' : 'false' }, dataset: { planner: o.id } },
    );
    let body: (HTMLElement | null)[] = [];
    if (isOpen) {
      if (o.kind === 'none') {
        body =
          state === 'in_use'
            ? [note('You write the plans. Choose another way above to let Friday write them.')]
            : state === 'restart'
              ? steps(o, state)
              : [
                  h(
                    'div',
                    { class: 'pn-actions pn-actions-start' },
                    button('I’ll write plans myself', () => void use(o), {
                      class: 'btn',
                      disabled: busy,
                      dataset: { action: 'use' },
                    }),
                  ),
                ];
      } else if (o.id === 'claude-code' || o.id === 'anthropic') {
        // The steps these two already had, with their dollar limits.
        body = [own[o.id] ?? null];
      } else {
        body = steps(o, state);
      }
    }
    return h(
      'div',
      { class: ['pn-planner', state === 'in_use' && 'is-on'], role: 'listitem', dataset: { planner: o.id, state } },
      head,
      isOpen ? h('div', { class: 'pn-planner-body' }, ...body.filter((x): x is HTMLElement => x !== null)) : null,
    );
  }

  function render() {
    const brain = brainNow();
    if (!brain?.planners) return;
    replace(list, ...brain.planners.map((o) => row(brain, o)));
  }

  render();
  td.add(ctx.store.subscribe('board', () => (busy ? undefined : render())));
  return el;
}

/**
 * What a planner without a known price may do a day, once it was allowed here: the limit, today's
 * count, a new limit (the app's own dialog) and turning it off. Null for a planner held to dollars
 * (its own card), or one that is not allowed here yet.
 */
export function plannerRequestsCard(
  ctx: AppContext,
  td: Teardown,
  brain: BrainStatusView | null | undefined,
): HTMLElement | null {
  const said = brain?.requests;
  if (!brain || !said || !brain.approved_here) return null;
  const b = brain;
  const lim = said;
  const native = ctx.platform.desktop ?? null;
  const label = b.planners?.find((p) => p.id === b.provider)?.label ?? plain(b.provider, 40);
  let amount = lim.yours ?? lim.limit;
  let busy = false;
  const field = input({
    type: 'number',
    min: '1',
    max: '10000',
    step: '1',
    value: String(amount),
    class: 'input pn-qs-budget',
    aria: { label: 'New number of requests a day' },
  });
  const under = h('div', { class: 'pn-spend-under' });
  const change = button([icon('check', 14), 'Change the limit…'], () => void changeLimit(), { class: 'btn' });
  const off = button('Turn it off', () => void turnOff(), { class: 'btn btn-danger' });
  field.addEventListener('input', () => {
    const v = clampNumber(field.value, 1, 10_000);
    if (v !== null) amount = Math.round(v);
    renderUnder();
  });

  function renderUnder() {
    replace(
      under,
      amount > lim.project
        ? h(
            'div',
            { class: 'pn-qs-limit muted', dataset: { role: 'project-limit' } },
            `The project’s own limit is ${lim.project} requests a day: Friday holds planning to that, whatever you allow here. `,
            linkButton(`Raise the project’s limit to ${amount}`, () => void raiseProject(amount)),
          )
        : null,
    );
    change.hidden = !native;
    change.disabled = busy || amount === lim.yours;
  }

  async function changeLimit() {
    if (!native || busy) return;
    busy = true;
    renderUnder();
    const wantedNow = amount;
    const done = await ctx.act('Change the limit', () => native.allowSpending(0, b.provider, wantedNow));
    busy = false;
    if (done) {
      ctx.toast({
        kind: 'success',
        text: `Planning with ${label} may make up to ${wantedNow} requests a day on this computer`,
      });
      ctx.refresh();
    }
    if (!td.done) renderUnder();
  }

  async function raiseProject(to: number) {
    if (busy) return;
    const ok = await ctx.confirm({
      title: `Raise the project’s limit to ${to} requests a day?`,
      body: [
        'The project’s limit is in .friday/config.yaml, which your team shares: it holds for everyone who plans in this project, each within what they allow on their own computer.',
        'Friday reads it when it starts: the new limit holds after a restart.',
      ],
      confirmLabel: 'Raise it',
    });
    if (!ok) return;
    busy = true;
    const set = await ctx.act(
      'Raise the project’s limit',
      () => ctx.api.editSettings({ [`providers.${b.provider}.daily_calls`]: to }),
      `The project’s limit is ${to} requests a day once Friday restarts`,
    );
    busy = false;
    if (set && native && !restartBlocked(ctx)) {
      await ctx.act(
        'Restart Friday',
        () => native.restart(),
        (done) => (done ? 'Friday restarts with the new limit' : ''),
      );
    }
    if (!td.done) {
      ctx.refresh();
      renderUnder();
    }
  }

  async function turnOff() {
    if (busy) return;
    const ok = await ctx.confirm({
      title: `Stop planning with ${label} on this computer?`,
      body: [
        `Friday stops planning with ${label} until you allow it again. Goals wait for a plan you write yourself.`,
        'Agents are not affected.',
      ],
      confirmLabel: 'Turn it off',
      danger: true,
    });
    if (!ok) return;
    busy = true;
    off.disabled = true;
    const done = await ctx.act(
      'Turn planning off',
      () => ctx.api.denySpending(b.provider),
      `Planning with ${label} is off on this computer`,
    );
    busy = false;
    if (td.done) return;
    off.disabled = false;
    if (done) ctx.refresh();
  }

  const el = h(
    'div',
    { class: 'pn-quick-setup pn-spending', dataset: { setup: 'requests' } },
    h('div', { class: 'pn-qs-title' }, 'How much planning may do'),
    h(
      'div',
      { class: 'row', dataset: { role: 'limit' } },
      h('span', null, `Up to ${lim.limit} requests a day with ${label}, on this computer. Today: ${lim.today}.`),
    ),
    note(
      `Friday knows no price for ${label}, so it counts requests instead of dollars: a plan is usually one or two. What it costs you is on ${label}’s own account page. When a day’s limit is reached, Friday stops planning and asks you.`,
    ),
    h('label', { class: 'pn-qs-row' }, h('span', null, 'Requests a day'), field),
    under,
    h('div', { class: 'pn-actions pn-actions-start' }, change, off),
  );
  renderUnder();
  return el;
}
