/**
 * What a setup's health check found, in a person's words (2026-11-17), for the Claude Code and the
 * Antigravity dialogs alike.
 *
 * Before, the Claude Code dialog read fields the check never sends (`level`, `detail`), so it
 * showed a row of badges beside codes such as `cc.mcp-json` and nothing a person could act on;
 * the Antigravity one showed the codes with the terminal command as the fix. Here the result is one
 * sentence (is the app connected, and how firmly), then only what needs attention, each with what
 * to do in this dialog's terms; what passed is folded away. A check's code stays in its tooltip.
 */

import { h } from '../ui/dom.js';
import { plural } from '../ui/format.js';
import { badge, plain } from './common.js';

export interface SetupCheck {
  id: string;
  status: string;
  /** What the check found (`message`; `detail` in an older answer). */
  message?: string;
  detail?: string;
  fix?: string;
}

export interface SetupDoctor {
  achieved?: string;
  checks?: SetupCheck[];
  error?: string;
  [key: string]: unknown;
}

type Tone = 'good' | 'warn' | 'danger' | 'muted';

export function doctorTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s === 'ok' || s === 'pass' || s === 'passed' || s === 'good') return 'good';
  if (s === 'warn' || s === 'warning') return 'warn';
  if (s === 'fail' || s === 'failed' || s === 'error') return 'danger';
  return 'muted';
}

/** What the check's result means for the person: connected or not, and how firmly Friday checks the app. */
export function achievedWords(achieved: string | undefined, host: string): { text: string; tone: Tone } | null {
  switch ((achieved ?? '').trim().toLowerCase()) {
    case '':
      return null;
    case 'l1 enforcing':
      return { tone: 'good', text: `Ready. Friday checks what ${host} does before it happens.` };
    case 'l1 degraded':
      return {
        tone: 'warn',
        text: `Connected, with gaps: part of Friday’s checks is not in place for ${host}. See what needs attention.`,
      };
    case 'l1 unverified':
      return {
        tone: 'warn',
        text: `Connected. Friday’s checks are in place; ${host} does not say what it does when a check cannot run, so Friday marks its work “Unverified” until it has seen one work.`,
      };
    case 'l0 observed':
      return {
        tone: 'warn',
        text: `Connected, but Friday can only watch ${host}: it cannot stop an action before it happens.`,
      };
    case 'not attached':
      return { tone: 'danger', text: `Not connected yet: the setup is not complete. See what needs attention.` };
    default:
      return { tone: 'muted', text: plain(String(achieved), 80) };
  }
}

/**
 * What to do about a finding, in this dialog's terms: the check names terminal commands, and a
 * person in the app has a button for most of them.
 */
export function fixWords(fix: string, host: string): string {
  const f = fix.trim();
  if (/friday harness config/i.test(f)) return 'Apply this setup again: Preview, then Apply.';
  if (/"friday run"/i.test(f)) return 'Start Friday again, then Preview.';
  if (/pnpm build|"friday setup"/i.test(f))
    return 'Friday is not completely installed on this computer: install it again.';
  if (/^install claude code/i.test(f)) return 'Install Claude Code, then Preview again.';
  if (/^update claude code/i.test(f)) return 'Update Claude Code, then Preview again.';
  if (/accept the trust prompt/i.test(f)) return `Open ${host} on this folder once and accept its trust prompt.`;
  return plain(f, 400);
}

const needsAttention = (c: SetupCheck): boolean => {
  const tone = doctorTone(c.status);
  return tone === 'danger' || tone === 'warn';
};

const said = (c: SetupCheck): string => plain(c.message ?? c.detail ?? '', 600) || 'This check gave no detail.';

/** The health check of a setup: one sentence, what needs attention, and what passed folded away. */
export function setupChecksView(doctor: SetupDoctor | null | undefined, host: string): HTMLElement {
  if (!doctor || doctor.error) {
    return h(
      'div',
      { class: 'muted pn-checks' },
      doctor?.error
        ? `Friday could not check the setup: ${plain(doctor.error, 400)}`
        : 'Friday could not check the setup.',
    );
  }
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const attention = checks.filter(needsAttention);
  // What needs fixing before what is only worth a look.
  attention.sort((a, b) => Number(doctorTone(b.status) === 'danger') - Number(doctorTone(a.status) === 'danger'));
  const rest = checks.filter((c) => !needsAttention(c));
  const summary = achievedWords(doctor.achieved, host);
  return h(
    'div',
    { class: 'pn-checks' },
    summary ? h('p', { class: ['pn-checks-summary', `pn-tone-${summary.tone}`] }, summary.text) : null,
    attention.length
      ? h(
          'ul',
          { class: 'pn-list pn-checks-attention' },
          attention.map((c) => {
            const danger = doctorTone(c.status) === 'danger';
            return h(
              'li',
              { class: 'pn-item', title: plain(c.id, 120) },
              badge(danger ? 'Needs fixing' : 'Worth a look', danger ? 'danger' : 'warn'),
              h('span', { class: 'pn-grow' }, said(c)),
              c.fix ? h('div', { class: 'muted pn-check-fix' }, `What to do: ${fixWords(c.fix, host)}`) : null,
            );
          }),
        )
      : checks.length
        ? h('p', { class: 'muted' }, 'Nothing needs attention.')
        : null,
    rest.length
      ? h(
          'details',
          { class: 'pn-checks-passed' },
          h('summary', null, `${plural(rest.length, 'check')} with nothing to do`),
          h(
            'ul',
            { class: 'pn-list' },
            rest.map((c) => h('li', { class: 'pn-item muted', title: plain(c.id, 120) }, said(c))),
          ),
        )
      : null,
  );
}
