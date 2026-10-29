/**
 * The task inspector drawer (plan §7.4, handoff Part 05 §2): Overview (the contract, verification,
 * scopes, dependencies, integration, actions), Context (the packet the agent was given and why),
 * Git (the attempt's branch, worktree and changed files) and History (the task's events, newest
 * first). It reads the board snapshot and follows it; the Context, Git and History tabs load when
 * first shown.
 */
import type {
  ContextExplanation,
  ContextPacket,
  DomainEvent,
  IntegrationView,
  RunView,
  SnapshotTask,
  TaskDiff,
  TaskView,
  VerificationView,
} from '@friday/protocol';
import { notStartedText, PRIORITY, RISK, TASK_KIND, WAITING_REASON } from '../model/status.js';
import { visible } from '../model/text.js';
import { type AppContext, type Component, type DrawerRequest, openDrawer, openModal } from '../shell/context.js';
import { append, button, type Child, h, replace } from '../ui/dom.js';
import { cleanText, duration, humanize, plural, shortId, timeAgo, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import {
  badge,
  empty,
  errorNote,
  facts,
  joinPath,
  loading,
  meter,
  mono,
  section,
  shortSha,
  statusPill,
  type Tone,
  tabPanel,
  tabs,
} from './common.js';
import { describeEvent, HISTORY_PAGE, mayHaveOlder, mergeEvents, olderBefore } from './events.js';

export type InspectorTab = 'overview' | 'context' | 'git' | 'history';
export type InspectorAction = 'verify' | 'continue' | 'rework' | 'recover' | 'cancel';

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);

/** The actions the Overview offers for a task in its state (plan §7.3 hover actions). */
export function inspectorActions(
  task: Pick<TaskView, 'status' | 'waiting_reason'>,
  opts: { recoveryQuestion?: boolean } = {},
): InspectorAction[] {
  const out: InspectorAction[] = [];
  if (task.status === 'READY_FOR_VERIFICATION') out.push('verify');
  if (task.status === 'WAITING') out.push('continue');
  if (task.status === 'FAILED') out.push('rework');
  if (task.status === 'HARNESS_LOST' || task.waiting_reason === 'agent_error' || opts.recoveryQuestion)
    out.push('recover');
  if (!TERMINAL.has(task.status)) out.push('cancel');
  return out;
}

type InspectedTask = TaskView & Partial<Pick<SnapshotTask, 'agent_key' | 'waiting_note' | 'delegation_note'>>;

interface View {
  task: InspectedTask;
  run: RunView | null;
  verification: VerificationView | null;
  integration: IntegrationView | null;
  recoveryQuestion: boolean;
  fromBoard: boolean;
}

const TONE_OF_CHECK: Record<string, Tone> = {
  PASSED: 'good',
  FAILED: 'danger',
  BLOCKED: 'warn',
  RUNNING: 'info',
  QUEUED: 'muted',
  NOT_REQUESTED: 'muted',
  CANCELLED: 'muted',
};

/** Checks that ran (or run now): what "passed of run" counts. */
const NOT_RUN = new Set(['NOT_REQUESTED', 'QUEUED', 'CANCELLED']);

const INTEGRATION_TONE: Record<IntegrationView['status'], Tone> = {
  integrated: 'good',
  conflicted: 'warn',
  failed: 'danger',
  not_needed: 'muted',
};

export function createTaskInspector(ctx: AppContext, request: DrawerRequest): Component & { title: string } {
  const id = request.id ?? '';
  let destroyed = false;
  let fallback: View | null = null;
  const unsubscribe: (() => void)[] = [];

  const initial = (['overview', 'context', 'git', 'history'] as const).includes(request.tab as InspectorTab)
    ? (request.tab as InspectorTab)
    : 'overview';
  const loaded = new Set<InspectorTab>();
  const header = h('div', { class: 'dr-insp-head' });
  const tabBar = tabs<InspectorTab>(
    [
      { id: 'overview', label: 'Overview' },
      { id: 'context', label: 'Context' },
      { id: 'git', label: 'Git' },
      { id: 'history', label: 'History' },
    ],
    initial,
    (tab) => show(tab),
  );
  const panels: Record<InspectorTab, HTMLElement> = {
    overview: tabPanel(tabBar, 'overview'),
    context: tabPanel(tabBar, 'context'),
    git: tabPanel(tabBar, 'git'),
    history: tabPanel(tabBar, 'history'),
  };
  const el = h(
    'div',
    { class: 'dr-inspector' },
    header,
    tabBar.el,
    h('div', { class: 'dr-panels' }, Object.values(panels)),
  );

  const boardTask = ctx.store.select('board')?.tasks.find((t) => t.task_id === id);
  const title = boardTask ? truncate(cleanText(boardTask.summary), 60) : `Task ${shortId(id)}`;

  function view(): View | null {
    const board = ctx.store.select('board');
    const task = board?.tasks.find((t) => t.task_id === id);
    if (task && board) {
      return {
        task,
        run: board.runs[id] ?? null,
        verification: board.verifications[id] ?? null,
        integration: board.integrations[id] ?? null,
        recoveryQuestion: board.escalations.some(
          (e) => e.task_id === id && e.status === 'pending' && e.kind === 'recovery_needed',
        ),
        fromBoard: true,
      };
    }
    return fallback;
  }

  // ---- header and Overview ---------------------------------------------------------------------

  function renderHeader(v: View): void {
    const t = v.task;
    const kind = TASK_KIND[t.kind];
    replace(
      header,
      h(
        'div',
        { class: 'row-wrap' },
        statusPill(t.status),
        t.status === 'WAITING' && t.waiting_reason
          ? badge(WAITING_REASON[t.waiting_reason] ?? t.waiting_reason, 'warn')
          : null,
        badge(kind?.label ?? t.kind, 'info'),
        badge(
          PRIORITY[t.priority]?.label ?? t.priority,
          t.priority === 'urgent' || t.priority === 'high' ? 'warn' : 'muted',
        ),
        badge(
          RISK[t.risk_level]?.label ?? t.risk_level,
          t.risk_level === 'high' ? 'danger' : t.risk_level === 'medium' ? 'warn' : 'muted',
        ),
      ),
      h('h2', { class: 'dr-insp-summary' }, cleanText(t.summary)),
      h(
        'div',
        { class: 'dr-insp-ids muted' },
        h('span', { class: 'dr-mono', title: t.task_id }, t.task_id),
        t.agent_key ? [' · agent ', mono(t.agent_key)] : null,
        t.role ? ` · role ${cleanText(t.role)}` : null,
        t.plan_key ? [' · plan key ', mono(t.plan_key)] : null,
      ),
    );
  }

  function actionButtons(v: View): HTMLElement {
    const actions = inspectorActions(v.task, { recoveryQuestion: v.recoveryQuestion });
    const buttons: HTMLButtonElement[] = [];
    for (const a of actions) {
      switch (a) {
        case 'verify':
          buttons.push(
            button([icon('check', 14), 'Verify'], () => openModal(ctx, { kind: 'verify', id }), {
              class: 'btn btn-primary',
            }),
          );
          break;
        case 'continue':
          buttons.push(
            button(
              [icon('play', 14), 'Continue'],
              () => {
                void ctx
                  .act(
                    'Continue the task',
                    () => ctx.api.continueTask(id),
                    (r) =>
                      r.continued
                        ? 'The agent continues in the same session'
                        : `Not continued: ${cleanText(r.reason ?? 'no reason given')}`,
                  )
                  .then(() => ctx.refresh());
              },
              { class: 'btn' },
            ),
          );
          break;
        case 'rework':
          buttons.push(
            button(
              [icon('rework', 14), 'Rework'],
              () => {
                void ctx
                  .act('Send the task back for rework', () => ctx.api.taskAction(id, 'rework'), 'Sent back for rework')
                  .then(() => ctx.refresh());
              },
              { class: 'btn' },
            ),
          );
          break;
        case 'recover':
          buttons.push(
            button([icon('shield', 14), 'Recover…'], () => openModal(ctx, { kind: 'recover', id }), { class: 'btn' }),
          );
          break;
        case 'cancel':
          buttons.push(button([icon('cross', 14), 'Cancel task'], () => void cancel(v), { class: 'btn btn-danger' }));
          break;
      }
    }
    return h('div', { class: 'dr-actions row-wrap' }, buttons);
  }

  async function cancel(v: View): Promise<void> {
    const ok = await ctx.confirm({
      title: 'Cancel this task?',
      body: [
        `“${truncate(cleanText(v.task.summary), 160)}” stops for good: it will not run again.`,
        'Its worktree and its preserved work are kept.',
      ],
      confirmLabel: 'Cancel task',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    await ctx.act(
      'Cancel the task',
      () => ctx.api.taskAction(id, 'cancel', 'cancelled in the inspector'),
      'Task cancelled',
    );
    ctx.refresh();
  }

  function taskLink(taskId: string): HTMLElement {
    const t = ctx.store.select('board')?.tasks.find((x) => x.task_id === taskId);
    return h(
      'li',
      { class: 'dr-dep' },
      button(
        [
          t ? statusPill(t.status) : badge('not on the board', 'muted'),
          h('span', null, t ? truncate(cleanText(t.summary), 90) : shortId(taskId)),
        ],
        () => openDrawer(ctx, { kind: 'inspector', id: taskId }),
        { class: 'dr-link', title: `Inspect ${taskId}` },
      ),
    );
  }

  function renderVerification(ver: VerificationView | null): Child {
    if (!ver) return empty('Not verified yet.');
    const run = ver.checks.filter((c) => !NOT_RUN.has(c.status));
    const passed = run.filter((c) => c.status === 'PASSED').length;
    return [
      h(
        'div',
        { class: 'row-wrap' },
        badge(humanize(ver.status), TONE_OF_CHECK[ver.status] ?? 'muted'),
        h('span', null, `${passed} passed of ${run.length} run`),
        ver.ended_at ? h('span', { class: 'muted', title: ver.ended_at }, timeAgo(ver.ended_at, ctx.now())) : null,
      ),
      ver.summary ? h('p', { class: 'dr-text' }, truncate(cleanText(ver.summary), 600)) : null,
      ver.checks.length
        ? h(
            'ul',
            { class: 'dr-checks' },
            ver.checks.map((c) =>
              h(
                'li',
                { class: 'dr-check' },
                badge(humanize(c.status), TONE_OF_CHECK[c.status] ?? 'muted'),
                h('span', { class: 'dr-mono' }, cleanText(c.name)),
                h('span', { class: 'muted' }, duration(c.duration_ms)),
                c.required ? null : badge('advisory', 'muted'),
                c.origin === 'friday' ? badge('Friday', 'info', "Friday's own check: it runs no project code") : null,
                c.summary ? h('div', { class: 'dr-check-summary muted' }, truncate(cleanText(c.summary), 300)) : null,
              ),
            ),
          )
        : null,
    ];
  }

  function renderIntegration(i: IntegrationView | null): Child {
    if (!i) return empty('Not integrated into a goal branch yet.');
    return [
      h(
        'div',
        { class: 'row-wrap' },
        badge(humanize(i.status), INTEGRATION_TONE[i.status]),
        i.branch ? mono(i.branch) : null,
        i.merged_commit ? h('span', { class: 'muted' }, `at ${shortSha(i.merged_commit)}`) : null,
      ),
      i.summary ? h('p', { class: 'dr-text' }, truncate(cleanText(i.summary), 600)) : null,
      i.conflicts.length
        ? h(
            'div',
            null,
            h('div', { class: 'muted' }, 'Conflicting files:'),
            h(
              'ul',
              { class: 'dr-paths' },
              i.conflicts.map((p) => h('li', null, mono(p))),
            ),
          )
        : null,
    ];
  }

  function renderOverview(v: View): void {
    const t = v.task;
    const board = ctx.store.select('board');
    const dependents = (board?.tasks ?? []).filter((x) => x.dependencies.includes(id)).map((x) => x.task_id);
    const scope = t.scope ?? { write: [], read: [] };
    replace(
      panels.overview,
      actionButtons(v),
      t.status === 'WAITING' && t.waiting_note
        ? h(
            'div',
            { class: 'dr-banner dr-banner-warn', role: 'note' },
            h('strong', null, 'The agent says: '),
            h('span', { class: 'dr-text' }, truncate(cleanText(t.waiting_note), 1000)),
          )
        : null,
      t.status === 'READY' && t.delegation_note
        ? h('div', { class: 'dr-banner', role: 'note' }, truncate(notStartedText(cleanText(t.delegation_note)), 400))
        : null,
      section(
        'Description',
        t.description ? h('p', { class: 'dr-text dr-prewrap' }, cleanText(t.description)) : empty('No description.'),
      ),
      section(
        'Acceptance criteria',
        t.acceptance_criteria.length
          ? h(
              'ul',
              { class: 'dr-list' },
              t.acceptance_criteria.map((c) => h('li', null, cleanText(c))),
            )
          : empty('No acceptance criteria.'),
      ),
      section('Verification', renderVerification(v.verification)),
      section(
        'Scope',
        h(
          'div',
          { class: 'dr-scope' },
          h('span', { class: 'muted' }, 'write'),
          scope.write.length
            ? h(
                'span',
                { class: 'row-wrap' },
                scope.write.map((g) => h('span', { class: 'pill dr-pill-write' }, visible(g))),
              )
            : h('span', { class: 'muted' }, 'nothing'),
          h('span', { class: 'muted' }, 'read'),
          scope.read.length
            ? h(
                'span',
                { class: 'row-wrap' },
                scope.read.map((g) => h('span', { class: 'pill' }, visible(g))),
              )
            : h('span', { class: 'muted' }, 'the whole project'),
        ),
      ),
      section(
        'Depends on',
        t.dependencies.length
          ? h('ul', { class: 'dr-deps' }, t.dependencies.map(taskLink))
          : empty('Nothing: it can start on its own.'),
      ),
      dependents.length ? section('Needed by', h('ul', { class: 'dr-deps' }, dependents.map(taskLink))) : null,
      section('Integration', renderIntegration(v.integration)),
      section(
        'Timing',
        facts([
          ['Created', h('span', { title: t.created_at }, timeAgo(t.created_at, ctx.now()))],
          ['Started', t.started_at ? h('span', { title: t.started_at }, timeAgo(t.started_at, ctx.now())) : '—'],
          [
            'Duration',
            t.started_at
              ? duration((t.completed_at ? Date.parse(t.completed_at) : ctx.now()) - Date.parse(t.started_at))
              : '—',
          ],
        ]),
      ),
    );
  }

  // ---- Context ---------------------------------------------------------------------------------

  function renderPacket(packet: ContextPacket, explanation: ContextExplanation | null, label: Child): HTMLElement {
    const box = h('div', { class: 'dr-packet' });
    const stale = packet.staleness.is_stale;
    const fileSources = packet.sections
      .flatMap((s) => s.sources)
      .filter((s) => s.source_type === 'file' || s.source_type === 'graph');
    const files = [...new Map(fileSources.map((s) => [s.source_id, s] as const)).values()];
    const included = new Map((explanation?.included ?? []).map((i) => [i.source_id, i]));
    const fileIds = new Set(files.map((f) => f.source_id));
    const others = (explanation?.included ?? []).filter((i) => !fileIds.has(i.source_id));
    const budget = explanation?.budget;
    const chars = budget?.chars ?? packet.budget.chars ?? 0;
    const used = budget?.used_chars ?? 0;
    append(
      box,
      h('div', { class: 'dr-packet-label' }, label),
      h(
        'div',
        { class: 'row-wrap' },
        stale
          ? badge(
              `Stale${packet.staleness.reason ? `: ${truncate(cleanText(packet.staleness.reason), 120)}` : ''}`,
              'warn',
            )
          : badge(`Current${packet.source_version ? ` (source ${packet.source_version.slice(0, 12)})` : ''}`, 'good'),
        h('span', { class: 'muted', title: packet.created_at }, `compiled ${timeAgo(packet.created_at, ctx.now())}`),
      ),
      chars > 0
        ? h(
            'div',
            { class: 'dr-budget' },
            h(
              'div',
              { class: 'row' },
              h('span', null, `${used.toLocaleString('en-US')} of ${chars.toLocaleString('en-US')} characters`),
              h('span', { class: 'spacer' }),
              h('span', { class: 'muted' }, `${Math.round((used / chars) * 100)}%`),
            ),
            meter(used / chars, 'Context budget used', used > chars ? 'danger' : 'info'),
            budget ? h('div', { class: 'muted' }, `${budget.sources} of at most ${budget.max_sources} sources`) : null,
          )
        : null,
    );
    box.append(
      section(
        `Files (${files.length})`,
        files.length
          ? h(
              'ul',
              { class: 'dr-ctx-files' },
              files.map((f) => {
                const inc = included.get(f.source_id);
                return h(
                  'li',
                  { class: 'dr-ctx-file' },
                  h(
                    'div',
                    { class: 'row' },
                    mono(f.source_id, 'dr-ctx-path'),
                    h('span', { class: 'spacer' }),
                    button(
                      [icon('graph', 14), 'Code graph'],
                      () => openDrawer(ctx, { kind: 'graph', path: f.source_id }),
                      { class: 'btn btn-ghost', ariaLabel: `Code graph of ${visible(f.source_id)}` },
                    ),
                  ),
                  h(
                    'div',
                    { class: 'row-wrap' },
                    inc ? badge(truncate(cleanText(inc.rule), 60), 'info') : null,
                    h('span', { class: 'muted' }, `distance ${f.relationship_distance}`),
                    inc ? h('span', { class: 'muted' }, `priority ${inc.priority}`) : null,
                    h('span', { class: 'muted' }, `${f.estimated_tokens} tokens`),
                  ),
                  h('div', { class: 'dr-text muted' }, truncate(cleanText(inc?.reason ?? f.selection_reason), 300)),
                );
              }),
            )
          : empty('No files: the packet holds the task, its state and its history only.'),
      ),
    );
    if (others.length) {
      box.append(
        section(
          `Other sources (${others.length})`,
          h(
            'table',
            { class: 'dr-table' },
            h('thead', null, h('tr', null, h('th', null, 'Section'), h('th', null, 'Source'), h('th', null, 'Rule'))),
            h(
              'tbody',
              null,
              others.map((o) =>
                h(
                  'tr',
                  { title: truncate(cleanText(o.reason), 300) },
                  h('td', null, cleanText(o.section)),
                  h('td', { class: 'dr-mono' }, truncate(cleanText(o.source_id), 60)),
                  h('td', null, truncate(cleanText(o.rule), 80)),
                ),
              ),
            ),
          ),
        ),
      );
    }
    if (explanation) {
      const cut = explanation.cut_by_budget;
      const notes = explanation.notes.map((n) => h('li', null, truncate(cleanText(n), 300)));
      if (explanation.withheld_by_permission > 0)
        notes.push(
          h(
            'li',
            null,
            `${plural(explanation.withheld_by_permission, 'source')} withheld: the agent may not read them.`,
          ),
        );
      if (cut.length) {
        box.append(
          h(
            'details',
            { class: 'dr-details' },
            h('summary', null, `${plural(cut.length, 'source')} cut by the budget`),
            h(
              'ul',
              { class: 'dr-list' },
              cut.map((c) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'dr-mono' }, truncate(cleanText(c.source_id), 80)),
                  ` · ${truncate(cleanText(c.reason), 160)}`,
                ),
              ),
            ),
          ),
        );
      }
      if (notes.length) box.append(section('Notes', h('ul', { class: 'dr-list muted' }, notes)));
    }
    return box;
  }

  async function explainOf(
    contextId: string,
  ): Promise<{ packet: ContextPacket; explanation: ContextExplanation | null }> {
    const r = await ctx.api.explainContext(contextId);
    return { packet: r.packet, explanation: r.explanation ?? null };
  }

  async function loadContext(): Promise<void> {
    const delivered = h('div', { class: 'dr-ctx-delivered' }, loading('Reading the delivered packet…'));
    const preview = h('div', { class: 'dr-ctx-preview' });
    const compile = button(
      [icon('rework', 14), 'Compile a fresh preview'],
      () => {
        compile.disabled = true;
        replace(preview, loading('Compiling a preview…'));
        void ctx
          .act('Compile a context preview', async () => {
            const packet = await ctx.api.compileContext(id);
            let explanation: ContextExplanation | null = null;
            try {
              explanation = (await explainOf(packet.context_id)).explanation;
            } catch {
              explanation = null;
            }
            return { packet, explanation };
          })
          .then((r) => {
            compile.disabled = false;
            if (destroyed) return;
            replace(
              preview,
              r
                ? renderPacket(
                    r.packet,
                    r.explanation,
                    h(
                      'span',
                      null,
                      badge('Preview', 'strong'),
                      ' Compiled for a human just now: not what the agent received.',
                    ),
                  )
                : null,
            );
          });
      },
      { class: 'btn' },
    );
    replace(panels.context, h('div', { class: 'row' }, h('span', { class: 'spacer' }), compile), delivered, preview);
    try {
      const d = await ctx.api.deliveredContext(id);
      if (destroyed) return;
      if (!d.context_id) {
        replace(delivered, empty('No context packet was delivered to an agent for this task yet.'));
        return;
      }
      const r = await explainOf(d.context_id);
      if (destroyed) return;
      replace(
        delivered,
        renderPacket(
          r.packet,
          r.explanation,
          h(
            'span',
            null,
            'Delivered to ',
            d.agent_key ? mono(d.agent_key) : 'the agent',
            ` (${shortId(d.context_id)})`,
          ),
        ),
      );
    } catch (e) {
      if (!destroyed) replace(delivered, errorNote('Could not read the delivered context', e));
    }
  }

  // ---- Git -------------------------------------------------------------------------------------

  const gitInfo = h('div', { class: 'dr-git-info' });
  const gitFiles = h('div', { class: 'dr-git-files' });

  function renderGitInfo(v: View): void {
    const run = v.run;
    if (!run) {
      replace(gitInfo, empty('No attempt yet: the task has no worktree.'));
      return;
    }
    const root = run.execution_root;
    replace(
      gitInfo,
      facts([
        [
          'Attempt',
          `${run.attempt} · ${humanize(run.status)}${run.workspace === 'pending' ? ' · worktree being prepared' : ''}`,
        ],
        ['Branch', run.branch_ref ? mono(run.branch_ref) : '—'],
        [
          'Worktree',
          root
            ? h(
                'span',
                { class: 'dr-worktree' },
                mono(root),
                button(icon('expand', 14), () => ctx.platform.openInEditor(root), {
                  class: 'btn btn-ghost btn-icon',
                  ariaLabel: 'Open the worktree in VS Code',
                  title: 'Open in VS Code',
                }),
              )
            : '—',
        ],
        ['Base', h('span', { class: 'dr-mono', title: run.base_commit ?? '' }, shortSha(run.base_commit))],
        [
          'Head',
          v.verification?.commit_sha
            ? h(
                'span',
                { class: 'dr-mono', title: v.verification.commit_sha },
                `${shortSha(v.verification.commit_sha)} (verified)`,
              )
            : h('span', { class: 'muted' }, 'not verified yet'),
        ],
        ['Model', run.model_observed ?? run.model_requested ?? '—'],
      ]),
    );
  }

  async function loadGitFiles(): Promise<void> {
    replace(gitFiles, loading('Reading the changed files…'));
    let diff: TaskDiff;
    try {
      const d = await ctx.api.taskDiff(id, true);
      diff = { ...d, files: d.files ?? [], notes: d.notes ?? [] };
    } catch (e) {
      if (!destroyed)
        replace(
          gitFiles,
          errorNote('Could not read the changed files', e),
          button('Try again', () => void loadGitFiles(), { class: 'btn' }),
        );
      return;
    }
    if (destroyed) return;
    const dirty = diff.files.some((f) => f.uncommitted);
    const root = diff.root ?? ctx.store.select('board')?.project.root ?? '';
    replace(
      gitFiles,
      h(
        'div',
        { class: 'row-wrap' },
        diff.source === 'worktree'
          ? dirty
            ? badge('Dirty: uncommitted changes', 'warn')
            : badge('Clean: everything is committed', 'good')
          : badge(`From the ${diff.source === 'none' ? "agent's report" : `${diff.source} work`}`, 'info'),
        h('span', null, plural(diff.files.length, 'changed file')),
        h('span', { class: 'spacer' }),
        button([icon('rework', 14), 'Refresh'], () => void loadGitFiles(), { class: 'btn btn-ghost' }),
        diff.files.length
          ? button([icon('file', 14), 'Open the diff'], () => openDrawer(ctx, { kind: 'diff', id }), { class: 'btn' })
          : null,
      ),
      diff.files.length
        ? h(
            'ul',
            { class: 'dr-git-list' },
            diff.files.map((f) =>
              h(
                'li',
                { class: 'dr-git-file' },
                button(
                  [
                    mono(f.path, 'dr-item-path'),
                    badge(f.change, f.change === 'added' ? 'good' : f.change === 'deleted' ? 'danger' : 'info'),
                    f.protected ? badge('protected', 'warn') : null,
                    f.link ? badge('link', 'warn') : null,
                    f.binary ? badge('binary', 'muted') : null,
                    f.too_large ? badge('too large', 'muted') : null,
                    f.added !== null
                      ? h(
                          'span',
                          { class: 'dr-delta' },
                          h('span', { class: 'dr-delta-add' }, `+${f.added}`),
                          ' ',
                          h('span', { class: 'dr-delta-del' }, `−${f.removed ?? 0}`),
                        )
                      : null,
                  ],
                  () => openDrawer(ctx, { kind: 'diff', id, path: f.path }),
                  { class: 'dr-item', title: `Show the diff of ${visible(f.path)}` },
                ),
                !f.protected && !f.link && f.change !== 'deleted'
                  ? button(icon('expand', 14), () => ctx.platform.openInEditor(joinPath(root, f.path)), {
                      class: 'btn btn-ghost btn-icon',
                      ariaLabel: `Open ${visible(f.path)} in VS Code`,
                      title: 'Open in VS Code',
                    })
                  : null,
              ),
            ),
          )
        : empty('No changed files.'),
      diff.notes.length || diff.truncated
        ? h(
            'ul',
            { class: 'dr-notes muted' },
            diff.notes.map((n) => h('li', null, truncate(cleanText(n), 300))),
            diff.truncated ? h('li', null, 'The list reached its cap.') : null,
          )
        : null,
    );
  }

  // ---- History ---------------------------------------------------------------------------------

  let events: DomainEvent[] = [];
  const historyList = h('ol', { class: 'dr-history', aria: { label: 'Task events, newest first' } });
  const historyFoot = h('div', { class: 'dr-history-foot' });

  function renderHistory(more: boolean): void {
    replace(
      historyList,
      events.map((e) => {
        const line = describeEvent(e);
        return h(
          'li',
          { class: ['dr-event', `dr-event-${line.tone}`] },
          h('span', { class: 'dr-event-time muted', title: line.at }, timeAgo(line.at, ctx.now())),
          h('span', { class: 'dr-event-text' }, line.text),
          h('span', { class: 'dr-event-actor muted' }, line.actor),
        );
      }),
    );
    if (!events.length) replace(historyFoot, empty('No events recorded for this task.'));
    else if (more) {
      const b = button('Load older', () => void older(b), { class: 'btn' });
      replace(historyFoot, b);
    } else replace(historyFoot, h('div', { class: 'muted dr-history-end' }, 'The beginning of this task.'));
  }

  async function loadHistory(): Promise<void> {
    replace(panels.history, loading('Reading the history…'));
    try {
      const page = await ctx.api.taskEvents(id, { limit: HISTORY_PAGE });
      if (destroyed) return;
      events = mergeEvents([], page.events ?? []);
      replace(panels.history, historyList, historyFoot);
      renderHistory(mayHaveOlder(page.events ?? []));
    } catch (e) {
      if (!destroyed)
        replace(
          panels.history,
          errorNote('Could not read the history', e),
          button('Try again', () => void loadHistory(), { class: 'btn' }),
        );
    }
  }

  async function older(b: HTMLButtonElement): Promise<void> {
    const before = olderBefore(events);
    if (before === null) return;
    b.disabled = true;
    const page = await ctx.act('Load older events', () => ctx.api.taskEvents(id, { before, limit: HISTORY_PAGE }));
    if (destroyed) return;
    b.disabled = false;
    if (!page) return;
    events = mergeEvents(events, page.events ?? []);
    renderHistory(mayHaveOlder(page.events ?? []));
  }

  // ---- wiring ----------------------------------------------------------------------------------

  function render(): void {
    const v = view();
    if (!v) return;
    renderHeader(v);
    renderOverview(v);
    renderGitInfo(v);
  }

  function show(tab: InspectorTab): void {
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== tab;
    if (loaded.has(tab)) return;
    loaded.add(tab);
    if (tab === 'context') void loadContext();
    else if (tab === 'git') {
      replace(panels.git, gitInfo, section('Changed files', gitFiles));
      void loadGitFiles();
    } else if (tab === 'history') void loadHistory();
  }

  /**
   * What the rendered parts show, as text: every snapshot re-read brings new objects, and
   * re-rendering on each would move the keyboard focus out of the drawer for nothing.
   */
  function signature(): string {
    const v = view();
    if (!v) return '';
    const tasks = ctx.store.select('board')?.tasks ?? [];
    const linked = tasks
      .filter((t) => v.task.dependencies.includes(t.task_id) || t.dependencies.includes(id))
      .map((t) => [t.task_id, t.status, t.summary]);
    return JSON.stringify([v.task, v.run, v.verification, v.integration, v.recoveryQuestion, linked]);
  }

  let lastSignature = '';
  function renderIfChanged(): void {
    const next = signature();
    if (next === lastSignature) return;
    lastSignature = next;
    render();
  }

  unsubscribe.push(
    ctx.store.subscribe('board', (board) => {
      if (board) renderIfChanged();
    }),
  );

  if (view()) {
    renderIfChanged();
  } else {
    replace(header, loading('Reading the task…'));
    void ctx.api
      .task(id)
      .then((d) => {
        if (destroyed) return;
        const run = d.runs?.[d.runs.length - 1] ?? null;
        fallback = {
          task: d.task,
          run,
          verification: d.verification ?? null,
          integration: null,
          recoveryQuestion: false,
          fromBoard: false,
        };
        render();
      })
      .catch((e: unknown) => {
        if (!destroyed) replace(header, errorNote('Could not read the task', e));
      });
  }
  show(initial);

  return {
    el,
    title,
    destroy() {
      destroyed = true;
      for (const u of unsubscribe) u();
      el.remove();
    },
  };
}
