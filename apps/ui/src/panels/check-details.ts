/**
 * What a check found, for a person (2026-11-17), shared by the task inspector and the Verify dialog.
 *
 * A failed check showed its name as the daemon writes it (`friday.diff`), a line of rule codes
 * ("2 changed file(s); failed: diff.outside_team_scope") and an exit code. What it had found in
 * words, and what a project's check had printed, were recorded and not shown: a person could not
 * tell a failing test from a file changed in the wrong folder. Here:
 * - Friday's own checks go by what they check;
 * - each finding is its sentence and the files it is about, the failures first;
 * - **Show output** reads what the check printed (`GET artifacts/:id`), the end of it first.
 */
import type { VerificationCheckView, VerificationFinding } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { agentText, errorOf, plain } from './common.js';

/** Friday's own checks, by what they check. */
const FRIDAY_CHECKS: Record<string, string> = {
  'friday.diff': 'Changes stay where the task may work',
  'friday.secrets': 'No credentials in the changes',
  'friday.evidence': 'The work was run',
  manual: 'Recorded by a person',
};

/** A check's name as a person reads it: Friday's by what it checks, a project's own as it is named. */
export function checkName(name: string): string {
  return FRIDAY_CHECKS[name] ?? plain(name, 120);
}

/** The findings of a check that say something went wrong or needs a look, the failures first. */
export function findingsOf(check: Pick<VerificationCheckView, 'details'>): VerificationFinding[] {
  const all = (check.details?.findings ?? []).filter((f) => f.severity === 'fail' || f.severity === 'warn');
  return [...all].sort((a, b) => Number(b.severity === 'fail') - Number(a.severity === 'fail'));
}

/** Whether a check's summary only repeats its findings as rule codes ("failed: diff.outside_scope"). */
export function summaryIsCodes(check: Pick<VerificationCheckView, 'summary' | 'details' | 'origin'>): boolean {
  return check.origin === 'friday' && findingsOf(check).length > 0;
}

const PATHS_SHOWN = 8;

/** The findings as sentences, each with the files it is about; null when there is none to show. */
export function findingsList(check: Pick<VerificationCheckView, 'details'>): HTMLElement | null {
  const findings = findingsOf(check);
  if (!findings.length) return null;
  return h(
    'ul',
    { class: 'pn-findings' },
    findings.map((f) =>
      h(
        'li',
        { class: ['pn-finding', `pn-finding-${f.severity}`], title: plain(f.rule, 80) },
        h('span', { class: 'pn-finding-mark' }, f.severity === 'fail' ? 'Failed: ' : 'Worth a look: '),
        h('span', null, plain(f.message, 800)),
        f.paths.length
          ? h(
              'ul',
              { class: 'pn-finding-paths mono' },
              f.paths.slice(0, PATHS_SHOWN).map((p) => h('li', null, visible(p))),
              f.paths.length > PATHS_SHOWN
                ? h('li', { class: 'muted' }, `and ${f.paths.length - PATHS_SHOWN} more`)
                : null,
            )
          : null,
      ),
    ),
  );
}

/**
 * "Show output" for a check that kept what it printed: reads it on the first click, shows the end
 * of it (where a failing check says what failed), and folds it away again.
 */
export function checkOutput(ctx: AppContext, artifactRef: string | null): HTMLElement | null {
  if (!artifactRef) return null;
  const box = h('div', { class: 'pn-check-output', hidden: true });
  let loaded = false;
  let loading = false;
  const toggle = button(
    'Show output',
    () => {
      if (loading) return;
      if (loaded) {
        box.hidden = !box.hidden;
        toggle.textContent = box.hidden ? 'Show output' : 'Hide output';
        return;
      }
      loading = true;
      box.hidden = false;
      replace(box, h('div', { class: 'muted' }, 'Reading what the check printed…'));
      ctx.api.artifactText(artifactRef).then(
        (r) => {
          loading = false;
          loaded = true;
          toggle.textContent = 'Hide output';
          const text = typeof r?.text === 'string' ? r.text : '';
          replace(
            box,
            r?.truncated
              ? h('div', { class: 'muted' }, `The end of the output: lines ${r.from_line} to ${r.lines} of ${r.lines}.`)
              : null,
            text.trim() ? agentText(text, 'pre') : h('div', { class: 'muted' }, 'The check printed nothing.'),
          );
        },
        (e: unknown) => {
          loading = false;
          replace(
            box,
            h('div', { class: 'field-error' }, `The output could not be read: ${plain(errorOf(e).message, 300)}`),
          );
        },
      );
    },
    { class: 'btn btn-ghost pn-check-output-toggle' },
  );
  return h('div', { class: 'pn-check-more' }, toggle, box);
}
