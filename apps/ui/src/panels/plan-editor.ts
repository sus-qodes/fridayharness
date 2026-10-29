/**
 * The plan editor (plan §7.7). First mode writes a goal's first plan: objective, summary and tasks
 * (key, summary, kind, role, description, acceptance criteria, dependencies picked from earlier
 * keys, write and read scopes with the scope picker, priority, risk). Revision mode (the goal has
 * an ACTIVE plan) adds tasks, drops tasks that have not started and reworks FAILED tasks with a
 * note, and shows what changes before it is sent. The page's checks run before sending; the
 * daemon's `details.errors` are the final word and are shown beside the form.
 */
import type { GoalView, LivePlanVersion } from '@friday/protocol';
import {
  canDrop,
  canRework,
  changeLines,
  type DraftIssue,
  type DraftTask,
  type ExistingTask,
  existingFromPlan,
  exportJson,
  type FirstPlanDraft,
  importFirstPlan,
  importRevision,
  MAX_IMPORT_BYTES,
  newTask,
  nextKey,
  normalizeFirstPlan,
  normalizeRevision,
  PLAN_LIMITS,
  PRIORITIES,
  type RevisionDraft,
  RISKS,
  revisionChanges,
  TASK_KINDS,
  validateFirstPlan,
  validateRevision,
} from '../model/plan-draft.js';
import { PRIORITY, RISK, statusLook } from '../model/status.js';
import { visible } from '../model/text.js';
import type { AppContext, Component, ModalRequest } from '../shell/context.js';
import { append, button, h, replace } from '../ui/dom.js';
import { humanize, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import {
  actWithError,
  checkbox,
  errorBox,
  errorOf,
  field,
  fold,
  group,
  input,
  note,
  panel,
  plain,
  select,
  Teardown,
  textarea,
} from './common.js';
import { type ScopePicker, scopePicker } from './scope-picker.js';

interface Target {
  setError(message: string | null): void;
  focus(): void;
}

interface Candidate {
  value: string;
  label: string;
}

interface TaskEditor {
  el: HTMLElement;
  renderDeps(): void;
  destroy(): void;
}

interface TaskEditorOptions {
  task: DraftTask;
  index: number;
  count: number;
  prefix: 'tasks' | 'new_tasks';
  candidates: () => Candidate[];
  register: (path: string, target: Target) => void;
  onInput: () => void;
  onKeyChange: (oldKey: string, newKey: string) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

/** One task's fields. The draft task is edited in place. */
function taskEditor(ctx: AppContext, o: TaskEditorOptions): TaskEditor {
  const t = o.task;
  const p = `${o.prefix}.${o.index}`;
  const pickers: ScopePicker[] = [];

  const key = input({ class: 'input mono', value: t.key, maxLength: 48, aria: { label: `Task ${o.index + 1} key` } });
  const keyField = field('Key', key, { hint: 'lowercase letters, digits and dashes' });
  let lastKey = t.key;
  key.addEventListener('input', () => {
    t.key = key.value;
    const before = lastKey;
    lastKey = key.value;
    title.textContent = `Task ${o.index + 1} · ${visible(key.value || '…')}`;
    o.onKeyChange(before.trim(), key.value.trim());
    o.onInput();
  });

  const summary = input({ value: t.summary, maxLength: 200, placeholder: 'What this task delivers' });
  const summaryField = field('Summary', summary);
  summary.addEventListener('input', () => {
    t.summary = summary.value;
    o.onInput();
  });

  const kind = select(
    TASK_KINDS.map((k) => ({ value: k, label: humanize(k) })),
    t.kind,
    (v) => {
      t.kind = v;
      o.onInput();
    },
  );
  const kindField = field('Kind', kind);

  const role = input({ class: 'input mono', value: t.role, maxLength: 32, placeholder: 'developer' });
  const roleField = field('Role', role, { hint: 'who should take it: backend, frontend, qa, developer…' });
  role.addEventListener('input', () => {
    t.role = role.value;
    o.onInput();
  });

  const priority = select(
    PRIORITIES.map((v) => ({ value: v, label: PRIORITY[v]?.label ?? v })),
    t.priority,
    (v) => {
      t.priority = v;
      o.onInput();
    },
  );
  const priorityField = field('Priority', priority);

  const risk = select(
    RISKS.map((v) => ({ value: v, label: RISK[v]?.label ?? v })),
    t.risk_level,
    (v) => {
      t.risk_level = v;
      o.onInput();
    },
  );
  const riskField = field('Risk', risk);

  const description = textarea({
    rows: 3,
    maxLength: 4000,
    value: t.description ?? '',
    placeholder: 'Details the agent needs (optional)',
  });
  const descriptionField = field('Description', description);
  description.addEventListener('input', () => {
    t.description = description.value;
    o.onInput();
  });

  const criteria = textarea({ rows: 3, value: t.acceptance_criteria.join('\n'), placeholder: 'node --test passes' });
  const criteriaField = field('Acceptance criteria', criteria, { hint: 'one per line; at least one' });
  criteria.addEventListener('input', () => {
    t.acceptance_criteria = criteria.value.split('\n');
    o.onInput();
  });

  const depsBox = h('div', { class: 'pn-deps' });
  const depsError = h('div', { class: 'field-error', hidden: true, role: 'alert' });
  const deps = group('Depends on', depsBox, depsError);

  const write = scopePicker(ctx, {
    label: 'Write scope',
    value: t.scope.write,
    emptyText: 'No write scope: only review and research tasks may be read-only.',
    onChange: (globs) => {
      t.scope.write = globs;
      o.onInput();
    },
  });
  const read = scopePicker(ctx, {
    label: 'Read scope',
    value: t.scope.read,
    emptyText: 'No read scope: the agent reads what its context gives it.',
    onChange: (globs) => {
      t.scope.read = globs;
      o.onInput();
    },
  });
  pickers.push(write, read);

  const title = h('h4', { class: 'pn-task-title' }, `Task ${o.index + 1} · ${visible(t.key || '…')}`);
  const up = button(icon('chevronDown', 14), () => o.onMove(-1), {
    class: 'btn btn-ghost btn-icon pn-flip',
    ariaLabel: `Move task ${o.index + 1} up`,
    disabled: o.index === 0,
  });
  const down = button(icon('chevronDown', 14), () => o.onMove(1), {
    class: 'btn btn-ghost btn-icon',
    ariaLabel: `Move task ${o.index + 1} down`,
    disabled: o.index === o.count - 1,
  });
  const remove = button(icon('close', 14), () => o.onRemove(), {
    class: 'btn btn-ghost btn-icon',
    ariaLabel: `Remove task ${o.index + 1}`,
  });

  function renderDeps() {
    const options = o.candidates();
    const known = new Set(options.map((c) => c.value));
    const extra = t.depends_on.filter((d) => d.trim() && !known.has(d.trim()));
    const all: Candidate[] = [...options, ...extra.map((d) => ({ value: d, label: `${d} (not in this plan)` }))];
    replace(
      depsBox,
      all.length === 0
        ? h(
            'span',
            { class: 'muted' },
            o.index === 0 && o.prefix === 'tasks'
              ? 'The first task depends on nothing.'
              : 'No earlier task to depend on.',
          )
        : all.map((c) =>
            checkbox(visible(c.label), t.depends_on.includes(c.value), (on) => {
              t.depends_on = on
                ? [...t.depends_on.filter((d) => d !== c.value), c.value]
                : t.depends_on.filter((d) => d !== c.value);
              o.onInput();
            }),
          ),
    );
  }
  renderDeps();

  const reg = (name: string, f: { setError(m: string | null): void }, focus: HTMLElement) =>
    o.register(`${p}.${name}`, { setError: (m) => f.setError(m), focus: () => focus.focus() });
  reg('key', keyField, key);
  reg('summary', summaryField, summary);
  reg('kind', kindField, kind);
  reg('role', roleField, role);
  reg('priority', priorityField, priority);
  reg('risk_level', riskField, risk);
  reg('description', descriptionField, description);
  reg('acceptance_criteria', criteriaField, criteria);
  o.register(`${p}.depends_on`, {
    setError: (m) => {
      depsError.hidden = !m;
      depsError.textContent = m ?? '';
    },
    focus: () => (depsBox.querySelector('input') as HTMLInputElement | null)?.focus(),
  });
  o.register(`${p}.scope.write`, { setError: (m) => write.setError(m), focus: () => write.input.focus() });
  o.register(`${p}.scope.read`, { setError: (m) => read.setError(m), focus: () => read.input.focus() });

  const el = h(
    'li',
    { class: 'pn-task' },
    h('div', { class: 'pn-task-head' }, title, h('span', { class: 'spacer' }), up, down, remove),
    h('div', { class: 'pn-grid2' }, keyField.el, summaryField.el),
    h('div', { class: 'pn-grid4' }, kindField.el, roleField.el, priorityField.el, riskField.el),
    descriptionField.el,
    criteriaField.el,
    deps,
    h(
      'div',
      { class: 'pn-grid2' },
      h('div', null, h('div', { class: 'field-label' }, 'Write scope'), write.el),
      h('div', null, h('div', { class: 'field-label' }, 'Read scope'), read.el),
    ),
  );

  return {
    el,
    renderDeps,
    destroy() {
      for (const pk of pickers) pk.destroy();
      el.remove();
    },
  };
}

export interface PlanEditorData {
  goal: GoalView;
  active: LivePlanVersion | null;
  proposed: LivePlanVersion | null;
}

/** The goal and its live plans from the board, or null when the board does not show the goal. */
export function editorDataFromBoard(ctx: AppContext, goalId: string): PlanEditorData | null {
  const board = ctx.store.select('board');
  const goal = board?.goals.find((g) => g.goal_id === goalId);
  if (!goal) return null;
  const plans = board?.plans[goalId];
  return { goal, active: plans?.active ?? null, proposed: plans?.proposed ?? null };
}

export function planEditorModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'lg' } {
  const td = new Teardown();
  const goalId = request.id ?? '';
  const body = h('div', { class: 'pn-editor-body' });
  const el = panel('pn-plan-editor', body);
  let editor: { destroy(): void } | null = null;

  function start(data: PlanEditorData) {
    editor?.destroy();
    body.replaceChildren();
    const revision = data.active?.status === 'ACTIVE';
    const notes: string[] = [];
    if (request.mode === 'revision' && !revision)
      notes.push('This goal has no active plan yet, so this is its first plan.');
    if (request.mode !== 'revision' && revision)
      notes.push('This goal already has an active plan, so this is a revision of it.');
    if (data.proposed)
      notes.push(
        `Version ${data.proposed.version} is proposed and waits for a decision; approve or reject it on the board.`,
      );
    editor = revision ? revisionEditor(ctx, data, body, notes, close) : firstPlanEditor(ctx, data, body, notes, close);
  }

  async function load() {
    body.replaceChildren(h('div', { class: 'empty' }, 'Reading the goal…'));
    try {
      const detail = await ctx.api.goal(goalId);
      if (td.done) return;
      if (detail?.goal?.goal_id) {
        start({ goal: detail.goal, active: detail.active ?? null, proposed: detail.proposed ?? null });
        return;
      }
      body.replaceChildren(h('div', { class: 'empty' }, 'This goal is not on the board.'));
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      body.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          `Could not read the goal: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`,
        ),
        h(
          'div',
          { class: 'pn-actions' },
          button('Try again', () => void load(), { class: 'btn' }),
        ),
      );
    }
  }

  const fromBoard = editorDataFromBoard(ctx, goalId);
  if (fromBoard) start(fromBoard);
  else void load();

  return {
    title: fromBoard?.active?.status === 'ACTIVE' ? 'Revise the plan' : 'Write the plan',
    size: 'lg',
    el,
    destroy() {
      td.run();
      editor?.destroy();
      el.remove();
    },
  };
}

// ---- the shared frame of both modes ------------------------------------------------------------

interface Frame {
  register: (path: string, target: Target) => void;
  clearRegistry: () => void;
  show: (issues: DraftIssue[]) => void;
  setServer: (errors: string[]) => void;
}

function frame(side: HTMLElement): Frame {
  const targets = new Map<string, Target>();
  const pageList = h('ul', { class: 'pn-errors-list' });
  const pageBox = h(
    'div',
    { class: 'pn-errors pn-errors-page', hidden: true, role: 'alert' },
    h('div', { class: 'pn-errors-title' }, 'To fix before sending'),
    pageList,
  );
  const server = errorBox('Friday refused it');
  side.append(pageBox, server.el);
  return {
    register: (path, target) => targets.set(path, target),
    clearRegistry: () => targets.clear(),
    show(issues) {
      const byPath = new Map<string, string[]>();
      for (const issue of issues) {
        for (const path of [issue.path, ...(issue.related ?? [])]) {
          const list = byPath.get(path) ?? [];
          if (!list.includes(issue.message)) list.push(issue.message);
          byPath.set(path, list);
        }
      }
      for (const [path, target] of targets) target.setError(byPath.get(path)?.join(' · ') ?? null);
      pageBox.hidden = issues.length === 0;
      pageList.replaceChildren(...issues.map((i) => h('li', null, visible(i.message))));
    },
    setServer: (errors) => server.set(errors),
  };
}

/** Moves focus to the first field the checks marked. */
function focusFirstError(host: HTMLElement): void {
  (host.querySelector('[aria-invalid="true"], .pn-invalid input') as HTMLElement | null)?.focus();
}

function jsonTools(
  ctx: AppContext,
  exportText: () => string,
  load: (text: string) => { error?: string; warnings?: string[] },
): HTMLElement {
  const area = textarea({ class: 'textarea mono pn-json', rows: 10, spellcheck: false, aria: { label: 'Plan JSON' } });
  const status = h('div', { class: 'pn-json-status', aria: { live: 'polite' } });
  const file = h('input', {
    type: 'file',
    class: 'visually-hidden',
    tabIndex: -1,
    attrs: { accept: 'application/json,.json' },
    aria: { hidden: true },
  });
  const box = h(
    'div',
    { class: 'pn-json-box', hidden: true },
    area,
    h(
      'div',
      { class: 'pn-actions pn-actions-start' },
      button('Load this JSON', () => apply(area.value), { class: 'btn btn-primary' }),
      button('Choose a file…', () => file.click(), { class: 'btn' }),
      button(
        'Copy',
        () => {
          void ctx.platform
            .copy(area.value)
            .then((ok) =>
              ctx.toast(
                ok
                  ? { kind: 'success', text: 'Copied the plan JSON' }
                  : { kind: 'warn', text: 'This page may not copy; select the text and copy it' },
              ),
            );
        },
        { class: 'btn' },
      ),
    ),
    status,
    file,
  );

  function say(text: string, error = false) {
    status.className = error ? 'pn-json-status field-error' : 'pn-json-status muted';
    status.textContent = text;
  }

  function apply(text: string) {
    const r = load(text);
    if (r.error) say(`Not loaded: ${r.error}`, true);
    else say(r.warnings?.length ? `Loaded, with notes: ${r.warnings.join('; ')}` : 'Loaded.');
  }

  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (f.size > MAX_IMPORT_BYTES) {
      say('Not loaded: the file is too large for a plan (over 1 MB)', true);
      return;
    }
    void f.text().then((text) => {
      area.value = text;
      apply(text);
    });
  });

  // Behind a fold (review §4): the editor opens on its fields, and a drafted plan to paste is one
  // click away.
  return fold(
    'More',
    { class: 'pn-json-tools' },
    h(
      'div',
      { class: 'row' },
      button(
        'Export JSON',
        () => {
          box.hidden = false;
          area.value = exportText();
          say('The plan as JSON: copy it, or edit it and load it back.');
        },
        { class: 'btn btn-ghost' },
      ),
      button(
        'Import JSON',
        () => {
          box.hidden = false;
          area.value = '';
          say('Paste a plan, or choose a .json file.');
          area.focus();
        },
        { class: 'btn btn-ghost' },
      ),
    ),
    box,
  );
}

// ---- first plan --------------------------------------------------------------------------------

function firstPlanEditor(
  ctx: AppContext,
  data: PlanEditorData,
  host: HTMLElement,
  notes: string[],
  close: () => void,
): { destroy(): void } {
  const draft: FirstPlanDraft = {
    objective: truncate(data.goal.objective ?? data.goal.request, 500),
    summary: '',
    tasks: [newTask('task-1')],
  };
  let editors: TaskEditor[] = [];
  let attempted = false;
  let busy = false;

  const main = h('div', { class: 'pn-editor-main' });
  const side = h('aside', { class: 'pn-editor-side', aria: { label: 'Checks and answers' } });
  const f = frame(side);

  const objective = input({ value: draft.objective ?? '', maxLength: 500 });
  const objectiveField = field('Objective', objective, { hint: 'the goal restated as one outcome' });
  objective.addEventListener('input', () => {
    draft.objective = objective.value;
    changed();
  });
  const summary = textarea({ rows: 2, maxLength: 1000, placeholder: 'How the work is split, in a sentence or two' });
  const summaryField = field('Summary', summary);
  summary.addEventListener('input', () => {
    draft.summary = summary.value;
    changed();
  });

  const list = h('ol', { class: 'pn-tasks' });
  const addBtn = button(
    [icon('plus', 14), 'Add a task'],
    () => {
      draft.tasks.push(newTask(nextKey(draft.tasks.map((t) => t.key))));
      rebuild();
      changed();
      (list.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus();
    },
    { class: 'btn' },
  );
  const submitBtn = button([icon('check', 14), 'Propose the plan'], () => void submit(), { class: 'btn btn-primary' });

  function registerStatic() {
    f.register('objective', { setError: (m) => objectiveField.setError(m), focus: () => objective.focus() });
    f.register('summary', { setError: (m) => summaryField.setError(m), focus: () => summary.focus() });
  }

  function rebuild() {
    for (const e of editors) e.destroy();
    f.clearRegistry();
    registerStatic();
    editors = draft.tasks.map((task, index) =>
      taskEditor(ctx, {
        task,
        index,
        count: draft.tasks.length,
        prefix: 'tasks',
        candidates: () =>
          draft.tasks
            .slice(0, index)
            .map((t) => t.key.trim())
            .filter(Boolean)
            .map((k) => ({ value: k, label: k })),
        register: f.register,
        onInput: changed,
        onKeyChange: (before, after) => {
          if (before && before !== after)
            for (const other of draft.tasks)
              if (other !== task) other.depends_on = other.depends_on.map((d) => (d === before ? after : d));
          editors.forEach((e, i) => {
            if (i !== index) e.renderDeps();
          });
        },
        onMove: (delta) => {
          const j = index + delta;
          if (j < 0 || j >= draft.tasks.length) return;
          [draft.tasks[index], draft.tasks[j]] = [draft.tasks[j] as DraftTask, draft.tasks[index] as DraftTask];
          rebuild();
          changed();
        },
        onRemove: () => {
          const removed = draft.tasks.splice(index, 1)[0];
          if (removed)
            for (const other of draft.tasks)
              other.depends_on = other.depends_on.filter((d) => d !== removed.key.trim());
          rebuild();
          changed();
        },
      }),
    );
    list.replaceChildren(...editors.map((e) => e.el));
    addBtn.disabled = draft.tasks.length >= PLAN_LIMITS.maxTasks;
  }

  function changed() {
    if (attempted) f.show(validateFirstPlan(normalizeFirstPlan(draft)));
  }

  async function submit() {
    if (busy) return;
    attempted = true;
    const wire = normalizeFirstPlan(draft);
    const issues = validateFirstPlan(wire);
    f.show(issues);
    f.setServer([]);
    if (issues.length) {
      focusFirstError(host);
      return;
    }
    busy = true;
    submitBtn.disabled = true;
    const r = await actWithError(
      ctx,
      'Propose the plan',
      () => ctx.api.proposePlan(data.goal.goal_id, wire),
      (e) => f.setServer(e.errors.length ? e.errors : [`${e.code ? `${e.code}: ` : ''}${e.message}`]),
      'Plan proposed: review and approve it on the board',
    );
    busy = false;
    submitBtn.disabled = false;
    if (!r) return;
    ctx.refresh();
    close();
  }

  const tools = jsonTools(
    ctx,
    () => exportJson(normalizeFirstPlan(draft)),
    (text) => {
      const r = importFirstPlan(text);
      if (!r.ok) return { error: r.error };
      draft.objective = r.draft.objective ?? draft.objective;
      draft.summary = r.draft.summary;
      draft.tasks = r.draft.tasks.slice(0, PLAN_LIMITS.maxTasks);
      objective.value = draft.objective ?? '';
      summary.value = draft.summary;
      rebuild();
      changed();
      const warnings = [...r.warnings];
      if (r.draft.tasks.length > PLAN_LIMITS.maxTasks)
        warnings.push(`only the first ${PLAN_LIMITS.maxTasks} tasks were loaded`);
      return { warnings };
    },
  );

  append(
    main,
    notes.length ? note(notes.join(' ')) : null,
    h('div', { class: 'pn-goal-line' }, h('span', { class: 'muted' }, 'Goal: '), plain(data.goal.request, 300)),
    objectiveField.el,
    summaryField.el,
    h('h3', { class: 'section-title' }, 'Tasks'),
    list,
    h('div', { class: 'pn-actions pn-actions-start' }, addBtn),
    tools,
  );
  side.prepend(note('Friday checks the plan here before sending it; its own checks have the final word.'));
  host.append(
    h('div', { class: 'pn-editor' }, main, side),
    h(
      'div',
      { class: 'pn-actions' },
      button('Cancel', () => close(), { class: 'btn btn-ghost' }),
      submitBtn,
    ),
  );
  rebuild();

  return {
    destroy() {
      for (const e of editors) e.destroy();
      editors = [];
    },
  };
}

// ---- revision ----------------------------------------------------------------------------------

function revisionEditor(
  ctx: AppContext,
  data: PlanEditorData,
  host: HTMLElement,
  notes: string[],
  close: () => void,
): { destroy(): void } {
  const active = data.active as LivePlanVersion;
  const existing: ExistingTask[] = existingFromPlan(active, ctx.store.select('board')?.tasks ?? []);
  const draft: RevisionDraft = { summary: '', rework: [], drop: [], new_tasks: [] };
  let editors: TaskEditor[] = [];
  let attempted = false;
  let busy = false;

  const main = h('div', { class: 'pn-editor-main' });
  const side = h('aside', { class: 'pn-editor-side', aria: { label: 'Changes, checks and answers' } });
  const f = frame(side);
  const changesBox = h('div', { class: 'pn-changes' });

  const summary = textarea({ rows: 2, maxLength: 1000, placeholder: 'What the revision changes and why' });
  const summaryField = field('Summary of the revision', summary);
  summary.addEventListener('input', () => {
    draft.summary = summary.value;
    changed();
  });

  const existingList = h('ul', { class: 'pn-existing' });
  const staticTargets = new Map<string, Target>();

  function renderExisting() {
    staticTargets.clear();
    existingList.replaceChildren(
      ...existing.map((t) => {
        const look = statusLook(t.status);
        const pill = h('span', { class: 'pill pn-status' }, look.label);
        pill.style.setProperty('--pn-status', look.color);
        const head = h(
          'div',
          { class: 'pn-existing-head' },
          pill,
          t.key ? h('span', { class: 'mono pn-key' }, visible(t.key)) : null,
          h('span', { class: 'pn-existing-summary' }, plain(t.summary, 200)),
        );
        const extra = h('div', { class: 'pn-existing-extra' });
        const error = h('div', { class: 'field-error', hidden: true, role: 'alert' });
        let control: HTMLElement;
        if (canRework(t)) {
          const entry = draft.rework.find((r) => r.task_id === t.task_id);
          const noteBox = textarea({
            rows: 2,
            maxLength: 1000,
            value: entry?.note ?? '',
            placeholder: 'What to do differently',
            aria: { label: `Rework note for ${visible(t.key ?? t.task_id)}` },
          });
          noteBox.addEventListener('input', () => {
            const r = draft.rework.find((x) => x.task_id === t.task_id);
            if (r) r.note = noteBox.value;
            changed();
          });
          extra.append(noteBox);
          extra.hidden = !entry;
          control = checkbox('Rework with a note', !!entry, (on) => {
            draft.rework = draft.rework.filter((r) => r.task_id !== t.task_id);
            if (on) draft.rework.push({ task_id: t.task_id, note: noteBox.value });
            extra.hidden = !on;
            if (on) noteBox.focus();
            changed();
          });
          staticTargets.set(`rework.${t.task_id}`, {
            setError: (m) => setErr(error, noteBox, m),
            focus: () => noteBox.focus(),
          });
        } else if (canDrop(t)) {
          const entry = draft.drop.find((d) => d.task_id === t.task_id);
          const reason = input({
            value: entry?.reason ?? '',
            maxLength: 500,
            placeholder: 'Why it is no longer needed',
            aria: { label: `Reason to drop ${visible(t.key ?? t.task_id)}` },
          });
          reason.addEventListener('input', () => {
            const d = draft.drop.find((x) => x.task_id === t.task_id);
            if (d) d.reason = reason.value;
            changed();
          });
          extra.append(reason);
          extra.hidden = !entry;
          control = checkbox('Drop it (not started)', !!entry, (on) => {
            draft.drop = draft.drop.filter((d) => d.task_id !== t.task_id);
            if (on) draft.drop.push({ task_id: t.task_id, reason: reason.value });
            extra.hidden = !on;
            if (on) reason.focus();
            for (const e of editors) e.renderDeps();
            changed();
          });
          staticTargets.set(`drop.${t.task_id}`, {
            setError: (m) => setErr(error, reason, m),
            focus: () => reason.focus(),
          });
        } else {
          control = h('span', { class: 'muted pn-kept' }, 'kept as it is');
        }
        return h('li', { class: 'pn-existing-item' }, head, control, extra, error);
      }),
    );
  }

  function setErr(error: HTMLElement, control: HTMLElement, m: string | null) {
    error.hidden = !m;
    error.textContent = m ?? '';
    if (m) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }

  const newList = h('ol', { class: 'pn-tasks' });
  const addBtn = button(
    [icon('plus', 14), 'Add a task'],
    () => {
      const taken = [...existing.map((t) => t.key ?? ''), ...draft.new_tasks.map((t) => t.key)];
      draft.new_tasks.push(newTask(nextKey(taken)));
      rebuild();
      changed();
      (newList.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus();
    },
    { class: 'btn' },
  );
  const submitBtn = button([icon('check', 14), 'Propose the revision'], () => void submit(), {
    class: 'btn btn-primary',
  });

  function rebuild() {
    for (const e of editors) e.destroy();
    f.clearRegistry();
    f.register('summary', { setError: (m) => summaryField.setError(m), focus: () => summary.focus() });
    for (const [path, target] of staticTargets) f.register(path, target);
    editors = draft.new_tasks.map((task, index) =>
      taskEditor(ctx, {
        task,
        index,
        count: draft.new_tasks.length,
        prefix: 'new_tasks',
        candidates: () => [
          ...draft.new_tasks
            .slice(0, index)
            .map((t) => t.key.trim())
            .filter(Boolean)
            .map((k) => ({ value: k, label: `${k} (new)` })),
          ...existing
            .filter(
              (t) =>
                !draft.drop.some((d) => d.task_id === t.task_id) &&
                t.status !== 'CANCELLED' &&
                t.status !== 'ABANDONED',
            )
            .map((t) => ({
              value: t.task_id,
              label: `${t.key ?? t.task_id}: ${truncate(t.summary, 60)} (${statusLook(t.status).label})`,
            })),
        ],
        register: f.register,
        onInput: changed,
        onKeyChange: (before, after) => {
          if (before && before !== after)
            for (const other of draft.new_tasks)
              if (other !== task) other.depends_on = other.depends_on.map((d) => (d === before ? after : d));
          editors.forEach((e, i) => {
            if (i !== index) e.renderDeps();
          });
        },
        onMove: (delta) => {
          const j = index + delta;
          if (j < 0 || j >= draft.new_tasks.length) return;
          [draft.new_tasks[index], draft.new_tasks[j]] = [
            draft.new_tasks[j] as DraftTask,
            draft.new_tasks[index] as DraftTask,
          ];
          rebuild();
          changed();
        },
        onRemove: () => {
          const removed = draft.new_tasks.splice(index, 1)[0];
          if (removed)
            for (const other of draft.new_tasks)
              other.depends_on = other.depends_on.filter((d) => d !== removed.key.trim());
          rebuild();
          changed();
        },
      }),
    );
    newList.replaceChildren(...editors.map((e) => e.el));
    addBtn.disabled = draft.new_tasks.length >= PLAN_LIMITS.maxTasks;
  }

  function renderChanges() {
    const c = revisionChanges(normalizeRevision(draft), existing);
    const lines = changeLines(c);
    changesBox.replaceChildren(
      h('div', { class: 'pn-errors-title' }, 'What changes'),
      h(
        'ul',
        { class: 'pn-changes-list' },
        lines.map((l) => h('li', null, visible(l))),
      ),
    );
  }

  function changed() {
    renderChanges();
    if (attempted) f.show(validateRevision(normalizeRevision(draft), existing));
  }

  async function submit() {
    if (busy) return;
    attempted = true;
    const wire = normalizeRevision(draft);
    const issues = validateRevision(wire, existing);
    f.show(issues);
    f.setServer([]);
    if (issues.length) {
      focusFirstError(host);
      return;
    }
    const lines = changeLines(revisionChanges(wire, existing));
    const ok = await ctx.confirm({
      title: 'Propose this revision?',
      body: lines.map((l) => visible(l)),
      confirmLabel: 'Propose the revision',
    });
    if (!ok) return;
    busy = true;
    submitBtn.disabled = true;
    const r = await actWithError(
      ctx,
      'Propose the revision',
      () => ctx.api.proposePlan(data.goal.goal_id, wire),
      (e) => f.setServer(e.errors.length ? e.errors : [`${e.code ? `${e.code}: ` : ''}${e.message}`]),
      'Revision proposed: review and approve it on the board',
    );
    busy = false;
    submitBtn.disabled = false;
    if (!r) return;
    ctx.refresh();
    close();
  }

  const tools = jsonTools(
    ctx,
    () => exportJson(normalizeRevision(draft)),
    (text) => {
      const r = importRevision(text);
      if (!r.ok) return { error: r.error };
      draft.summary = r.draft.summary;
      draft.rework = r.draft.rework;
      draft.drop = r.draft.drop;
      draft.new_tasks = r.draft.new_tasks.slice(0, PLAN_LIMITS.maxTasks);
      summary.value = draft.summary;
      renderExisting();
      rebuild();
      changed();
      const known = new Set(existing.map((t) => t.task_id));
      const warnings = [...r.warnings];
      for (const id of [...draft.rework.map((x) => x.task_id), ...draft.drop.map((x) => x.task_id)])
        if (!known.has(id)) warnings.push(`${id} is not a task of the active plan`);
      return { warnings };
    },
  );

  renderExisting();
  append(
    main,
    notes.length ? note(notes.join(' ')) : null,
    h(
      'div',
      { class: 'pn-goal-line' },
      h('span', { class: 'muted' }, `Goal: `),
      plain(data.goal.request, 300),
      h('span', { class: 'muted' }, ` · active plan version ${active.version}`),
    ),
    summaryField.el,
    h('h3', { class: 'section-title' }, 'Tasks of the active plan'),
    existing.length ? existingList : h('div', { class: 'empty' }, 'The active plan has no tasks.'),
    note(
      'Only FAILED tasks can be reworked, and only tasks that have not started (proposed or ready) can be dropped. Tasks you do not change are kept.',
    ),
    h('h3', { class: 'section-title' }, 'New tasks'),
    newList,
    h('div', { class: 'pn-actions pn-actions-start' }, addBtn),
    tools,
  );
  side.prepend(changesBox);
  host.append(
    h('div', { class: 'pn-editor' }, main, side),
    h(
      'div',
      { class: 'pn-actions' },
      button('Cancel', () => close(), { class: 'btn btn-ghost' }),
      submitBtn,
    ),
  );
  rebuild();
  renderChanges();

  return {
    destroy() {
      for (const e of editors) e.destroy();
      editors = [];
    },
  };
}
