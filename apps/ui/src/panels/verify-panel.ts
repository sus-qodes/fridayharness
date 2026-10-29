/**
 * The verification panel (plan §7.5, FD-29): what the agent claims, what changed, where the two
 * disagree, and the ways to decide: run the project's checks (or, with none configured, Friday's
 * own scope and credential checks), or record a manual result that skips every check. It also
 * says how to add project checks.
 */
import type { RunView, TaskDiff, VerificationView } from '@friday/protocol';
import { statusLook } from '../model/status.js';
import type { AppContext, Component, ModalRequest } from '../shell/context.js';
import { openDrawer } from '../shell/context.js';
import { append, button, h, replace } from '../ui/dom.js';
import { duration, humanize } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import {
  agentText,
  errorOf,
  field,
  linkButton,
  note,
  panel,
  pathText,
  plain,
  projectPath,
  section,
  Teardown,
  textarea,
} from './common.js';

export interface ClaimCheck {
  name: string;
  kind: string;
  command: string | null;
  outcome: string;
  evidence: string | null;
}

/** What an agent said when it claimed the task done (the run's `claim`). */
export interface Claim {
  summary: string;
  changed_paths: string[];
  checks: ClaimCheck[];
  notes: string[];
  risks: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Reads a run's claim, which the daemon stores as free JSON; anything malformed is dropped. */
export function readClaim(v: unknown): Claim | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    summary: text(o.summary) ?? '',
    changed_paths: strings(o.changed_paths),
    checks: (Array.isArray(o.checks) ? o.checks : [])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({
        name: text(c.name) ?? 'check',
        kind: text(c.kind) ?? 'other',
        command: text(c.command),
        outcome: text(c.outcome) ?? 'unknown',
        evidence: text(c.evidence),
      })),
    notes: strings(o.notes),
    risks: strings(o.risks),
  };
}

function norm(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** Paths the claim lists that did not change, and changes the claim does not list. */
export function discrepancies(
  claimed: readonly string[],
  changed: readonly string[],
): { claimedUnchanged: string[]; changedUnclaimed: string[] } {
  const c = new Set(claimed.map(norm));
  const d = new Set(changed.map(norm));
  return {
    claimedUnchanged: [...c].filter((p) => !d.has(p)).sort(),
    changedUnclaimed: [...d].filter((p) => !c.has(p)).sort(),
  };
}

/** The changed paths a diff shows (a rename counts both names). */
export function changedPaths(diff: Pick<TaskDiff, 'files'>): string[] {
  return diff.files.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path]));
}

/** How "Run checks" is worded (plan FD-29). */
export function checksWording(checks: readonly { name: string; required: boolean }[]): {
  button: string;
  detail: string;
  configured: boolean;
} {
  if (checks.length === 0) {
    return {
      button: "Run Friday's checks",
      detail: "No project checks are configured: Friday's scope and credential checks will run.",
      configured: false,
    };
  }
  const names = checks.map((c) => (c.required ? c.name : `${c.name} (advisory)`)).join(', ');
  return {
    button: 'Run checks',
    detail: `Runs the project's checks (${names}), then Friday's scope and credential checks.`,
    configured: true,
  };
}

export const CHECKS_EXAMPLE = [
  'verification:',
  '  checks:',
  '    - name: tests',
  '      kind: test',
  '      command: npm',
  '      args: ["test"]',
].join('\n');

function verificationView(v: VerificationView): HTMLElement {
  const look = v.status === 'PASSED' ? 'badge-good' : v.status === 'FAILED' ? 'badge-danger' : 'badge-info';
  return h(
    'div',
    { class: 'pn-verification' },
    h(
      'div',
      { class: 'row' },
      h('span', { class: `badge ${look}` }, humanize(v.status)),
      h('span', null, plain(v.summary, 300)),
    ),
    v.checks.length
      ? h(
          'ul',
          { class: 'pn-list' },
          v.checks.map((c) =>
            h(
              'li',
              { class: 'pn-item' },
              h(
                'span',
                {
                  class: `badge ${c.status === 'PASSED' ? 'badge-good' : c.status === 'FAILED' ? 'badge-danger' : 'badge-muted'}`,
                },
                humanize(c.status),
              ),
              h('span', { class: 'mono' }, plain(c.name, 120)),
              c.required ? null : h('span', { class: 'muted' }, 'advisory'),
              h('span', { class: 'muted' }, duration(c.duration_ms)),
              c.summary ? h('span', { class: 'muted pn-grow' }, plain(c.summary, 300)) : null,
            ),
          ),
        )
      : null,
  );
}

function pathList(title: string, paths: readonly string[], tone: 'warn' | 'info'): HTMLElement | null {
  if (paths.length === 0) return null;
  return h(
    'div',
    { class: `pn-discrepancy pn-discrepancy-${tone}`, role: 'note' },
    h('div', { class: 'pn-errors-title' }, title),
    h(
      'ul',
      { class: 'pn-list' },
      paths.slice(0, 50).map((p) => h('li', null, pathText(p))),
    ),
    paths.length > 50 ? h('div', { class: 'muted' }, `and ${paths.length - 50} more`) : null,
  );
}

export function verifyModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const taskId = request.id ?? '';
  const board = ctx.store.select('board');
  // The task as the board shows it now: its status moves on while the panel is open.
  let task = board?.tasks.find((t) => t.task_id === taskId) ?? null;
  const run: RunView | undefined = board?.runs[taskId];
  const claim = readClaim(run?.claim);
  let diff: TaskDiff | null = null;
  let diffError: string | null = null;
  let running = false;
  let deciding = false;

  const diffBox = h('div', { class: 'pn-diffstat' }, h('div', { class: 'muted' }, 'Reading what changed…'));
  const discrepancyBox = h('div', { class: 'pn-discrepancies' });
  const resultBox = h('div', { class: 'pn-result', aria: { live: 'polite' } });

  // ---- the claim
  const claimSection = section(
    'What the agent claims',
    claim
      ? [
          h('p', { class: 'pn-claim-summary' }, plain(claim.summary, 2000) || 'No summary.'),
          claim.changed_paths.length
            ? h(
                'div',
                null,
                h('div', { class: 'field-label' }, 'Changed paths it lists'),
                h(
                  'ul',
                  { class: 'pn-list' },
                  claim.changed_paths.map((p) => h('li', null, pathText(p))),
                ),
              )
            : h('div', { class: 'muted' }, 'It lists no changed paths.'),
          claim.checks.length
            ? h(
                'div',
                null,
                h('div', { class: 'field-label' }, 'Checks it says it ran'),
                h(
                  'ul',
                  { class: 'pn-list' },
                  claim.checks.map((c) =>
                    h(
                      'li',
                      { class: 'pn-item pn-claim-check' },
                      h(
                        'span',
                        {
                          class: `badge ${c.outcome === 'passed' ? 'badge-good' : c.outcome === 'failed' ? 'badge-danger' : 'badge-muted'}`,
                        },
                        plain(c.outcome, 20),
                      ),
                      h('span', null, plain(c.name, 200)),
                      c.command ? agentText(c.command, 'code') : null,
                      c.evidence ? h('div', { class: 'muted pn-grow' }, plain(c.evidence, 600)) : null,
                    ),
                  ),
                ),
                note('These are the agent’s words; Friday’s checks are what count.'),
              )
            : h('div', { class: 'muted' }, 'It reports no checks.'),
          claim.risks.length
            ? h(
                'div',
                null,
                h('div', { class: 'field-label' }, 'Risks it names'),
                h(
                  'ul',
                  { class: 'pn-list' },
                  claim.risks.map((r) => h('li', null, plain(r, 1000))),
                ),
              )
            : null,
        ]
      : h('div', { class: 'muted' }, 'No completion claim is recorded for this task’s current run.'),
  );

  // ---- the diff and the discrepancies
  const diffSection = section(
    'What changed',
    diffBox,
    linkButton('Open the diff', () => {
      // A drawer under this dialog takes no input: close first, and let the drawer come back here.
      close();
      openDrawer(ctx, {
        kind: 'diff',
        id: taskId,
        back: { modal: { kind: 'verify', id: taskId }, label: 'Back to verification' },
      });
    }),
    discrepancyBox,
  );

  function renderDiff() {
    if (diffError) {
      replace(diffBox, h('div', { class: 'field-error' }, `Could not read the diff: ${diffError}`));
    } else if (diff) {
      const files = diff.files;
      const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
      const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
      replace(
        diffBox,
        h(
          'div',
          { class: 'row' },
          h('span', null, `${files.length} ${files.length === 1 ? 'file' : 'files'}`),
          h('span', { class: 'pn-add' }, `+${added}`),
          h('span', { class: 'pn-del' }, `−${removed}`),
          h('span', { class: 'muted' }, `from the ${diff.source === 'none' ? 'paths Friday observed' : diff.source}`),
        ),
        h(
          'ul',
          { class: 'pn-list' },
          files
            .slice(0, 12)
            .map((f) =>
              h(
                'li',
                { class: 'pn-item' },
                h('span', { class: 'badge badge-muted' }, f.change),
                pathText(f.path),
                f.binary ? h('span', { class: 'muted' }, 'binary') : null,
                f.protected ? h('span', { class: 'muted' }, 'protected') : null,
                f.added !== null ? h('span', { class: 'pn-add' }, `+${f.added}`) : null,
                f.removed !== null ? h('span', { class: 'pn-del' }, `−${f.removed}`) : null,
              ),
            ),
        ),
        files.length > 12 ? h('div', { class: 'muted' }, `and ${files.length - 12} more in the diff`) : null,
        diff.truncated ? note('The diff is longer than Friday reads at once.') : null,
      );
    }
    renderDiscrepancies();
  }

  function renderDiscrepancies() {
    if (!claim) {
      replace(discrepancyBox);
      return;
    }
    const changed = diff ? changedPaths(diff) : (run?.observed_paths ?? []);
    if (!diff && !run) {
      replace(discrepancyBox);
      return;
    }
    const d = discrepancies(claim.changed_paths, changed);
    if (d.claimedUnchanged.length === 0 && d.changedUnclaimed.length === 0) {
      replace(discrepancyBox, h('div', { class: 'muted' }, 'The claim matches what changed.'));
      return;
    }
    replace(
      discrepancyBox,
      pathList('Claimed but unchanged', d.claimedUnchanged, 'warn'),
      pathList('Changed but not claimed', d.changedUnclaimed, 'info'),
    );
  }

  // ---- deciding
  const checks = board?.verification.checks ?? [];
  const wording = checksWording(checks);
  const runBtn = button([icon('play', 14), wording.button], () => void runChecks(), { class: 'btn btn-primary' });
  // Once a result is recorded the panel has done its work; closing shows the board under it.
  const doneBtn = button('Close', () => close(), { class: 'btn btn-primary', hidden: true });
  const runState = h('div', { class: 'muted', aria: { live: 'polite' } });
  const latest = board?.verifications[taskId];

  const noteBox = textarea({ rows: 2, maxLength: 2000, placeholder: 'Why (kept with the result)' });
  const passBtn = button([icon('check', 14), 'Mark passed'], () => void manual('passed'), { class: 'btn' });
  const failBtn = button([icon('cross', 14), 'Mark failed'], () => void manual('failed'), { class: 'btn btn-danger' });

  const decideSection = section(
    'Verify',
    h('p', null, wording.detail),
    h('div', { class: 'pn-actions pn-actions-start' }, runBtn, doneBtn),
    runState,
    resultBox,
    h(
      'div',
      { class: 'pn-manual' },
      h('div', { class: 'field-label' }, 'Or record a result yourself'),
      note('Mark passed and Mark failed skip every check: nothing runs.'),
      field('Note', noteBox).el,
      h('div', { class: 'pn-actions pn-actions-start' }, passBtn, failBtn),
    ),
  );

  const root = board?.project.root ?? '';
  const howSection = section(
    'Adding project checks',
    h(
      'p',
      null,
      'Project checks are commands Friday runs in the task’s checkout, listed under verification.checks in .friday/config.yaml, for example:',
    ),
    agentText(CHECKS_EXAMPLE, 'pre'),
    h(
      'div',
      { class: 'pn-actions pn-actions-start' },
      button(
        [icon('file', 14), 'Open config.yaml in VS Code'],
        () => ctx.platform.openInEditor(projectPath(root, '.friday/config.yaml')),
        {
          class: 'btn',
          disabled: !root,
        },
      ),
    ),
    note('Friday reads config.yaml again when it changes: new checks judge the next verification.'),
  );

  function updateButtons() {
    const verifying = task?.status === 'VERIFYING';
    const decided = task?.status === 'COMPLETED' || task?.status === 'FAILED';
    runBtn.disabled = running || deciding || verifying || decided;
    passBtn.disabled = running || deciding || decided;
    failBtn.disabled = running || deciding || decided;
    doneBtn.hidden = !decided;
    runState.textContent = running
      ? 'Checks are running; this can take a while. You can close this window: the result shows on the board.'
      : verifying
        ? 'A verification of this task is already running.'
        : '';
  }

  function showResult(v: VerificationView | undefined | null) {
    replace(resultBox, v ? verificationView(v) : null);
  }

  async function runChecks() {
    if (running) return;
    running = true;
    updateButtons();
    const r = await ctx.act(
      'Verify the task',
      () => ctx.api.verify(taskId),
      (x) => `Verification ${humanize(x?.verification?.status ?? 'recorded')}`,
    );
    running = false;
    if (td.done) return;
    updateButtons();
    if (r) {
      showResult(r.verification);
      ctx.refresh();
    }
  }

  async function manual(result: 'passed' | 'failed') {
    if (deciding) return;
    if (result === 'passed') {
      const ok = await ctx.confirm({
        title: 'Mark the task passed?',
        body: [
          'This records a pass without running any check.',
          'Friday’s scope and credential checks are skipped too.',
        ],
        confirmLabel: 'Mark passed',
      });
      if (!ok) return;
    }
    deciding = true;
    updateButtons();
    const noteText = noteBox.value.trim();
    const r = await ctx.act(
      result === 'passed' ? 'Mark passed' : 'Mark failed',
      () => ctx.api.verify(taskId, { result, ...(noteText ? { note: noteText } : {}) }),
      result === 'passed' ? 'Marked passed (no checks ran)' : 'Marked failed',
    );
    deciding = false;
    if (td.done) return;
    updateButtons();
    if (r) {
      showResult(r.verification);
      ctx.refresh();
      close();
    }
  }

  const statusPill = h('span', { class: 'pill pn-status' });
  function renderStatus() {
    const status = task ? statusLook(task.status) : null;
    statusPill.hidden = !status;
    statusPill.textContent = status?.label ?? '';
    if (status) statusPill.style.setProperty('--pn-status', status.color);
  }
  renderStatus();
  td.add(
    ctx.store.subscribe('board', (next) => {
      const now = next?.tasks.find((t) => t.task_id === taskId) ?? null;
      if (now?.status === task?.status) return;
      task = now;
      renderStatus();
      updateButtons();
    }),
  );

  const el = panel(
    'pn-verify',
    h(
      'div',
      { class: 'pn-head-line' },
      statusPill,
      h('span', { class: 'pn-task-summary' }, task ? plain(task.summary, 300) : 'This task is not on the board.'),
    ),
    claimSection,
    diffSection,
    decideSection,
    howSection,
  );
  if (latest) append(resultBox, h('div', { class: 'field-label' }, 'Latest verification'), verificationView(latest));
  updateButtons();
  renderDiscrepancies();

  void (async () => {
    try {
      const d = await ctx.api.taskDiff(taskId, true);
      if (td.done) return;
      diff = d && Array.isArray(d.files) ? d : ({ ...(d ?? {}), files: [] } as TaskDiff);
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      diffError = `${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`;
    }
    renderDiff();
  })();

  return {
    title: 'Verify the task',
    size: 'md',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
