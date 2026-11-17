import type { VerificationCheckView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { checkName, checkOutput, findingsList, findingsOf, summaryIsCodes } from './check-details.js';
import { buttonBy, flush, HOSTILE } from './test-support.js';

const REF = 'artifact:A1b2_c3-d4';
const PATH = 'GET /artifacts/A1b2_c3-d4';

function check(over: Partial<VerificationCheckView> = {}): VerificationCheckView {
  return {
    name: 'friday.diff',
    kind: 'diff',
    status: 'FAILED',
    exit_code: null,
    artifact_ref: null,
    summary: '2 changed file(s); failed: diff.outside_team_scope',
    required: true,
    origin: 'friday',
    duration_ms: 30,
    details: {
      findings: [
        { rule: 'diff.large', severity: 'warn', message: 'The change is large', paths: [] },
        { rule: 'diff.ok', severity: 'info', message: 'Two files changed', paths: [] },
        {
          rule: 'diff.outside_team_scope',
          severity: 'fail',
          message: 'Files were changed outside what this task may change',
          paths: ['docs/x.md', 'README.md'],
        },
      ],
    },
    ...over,
  } as VerificationCheckView;
}

describe('a check, for a person (2026-11-17)', () => {
  it("names Friday's own checks by what they check, and a project's as it is named", () => {
    expect(checkName('friday.diff')).toBe('Changes stay where the task may work');
    expect(checkName('friday.secrets')).toBe('No credentials in the changes');
    expect(checkName('friday.evidence')).toBe('The work was run');
    expect(checkName('manual')).toBe('Recorded by a person');
    expect(checkName('unit tests')).toBe('unit tests');
  });

  it('lists what went wrong and what needs a look, the failures first, and nothing that is only a note', () => {
    expect(findingsOf(check()).map((f) => f.rule)).toEqual(['diff.outside_team_scope', 'diff.large']);
    expect(findingsOf(check({ details: null }))).toEqual([]);
    expect(findingsOf(check({ details: {} }))).toEqual([]);
  });

  it('shows each finding as its sentence and its files, in place of the line of rule codes', () => {
    const c = check();
    expect(summaryIsCodes(c)).toBe(true);
    const list = findingsList(c) as HTMLElement;
    const rows = [...list.querySelectorAll<HTMLElement>('.pn-finding')];
    expect(rows.map((r) => r.querySelector('.pn-finding-mark')?.textContent)).toEqual(['Failed: ', 'Worth a look: ']);
    expect(rows[0]?.textContent).toContain('Files were changed outside what this task may change');
    expect([...(rows[0]?.querySelectorAll('.pn-finding-paths li') ?? [])].map((x) => x.textContent)).toEqual([
      'docs/x.md',
      'README.md',
    ]);
    // The rule's code is kept for whoever looks for it, not read out.
    expect(rows[0]?.title).toBe('diff.outside_team_scope');
    expect(list.textContent).not.toContain('diff.outside_team_scope');
  });

  it("keeps the summary of a project's check, and of a Friday check with nothing found", () => {
    expect(summaryIsCodes(check({ origin: 'configured', name: 'tests', summary: 'exit 1' }))).toBe(false);
    expect(summaryIsCodes(check({ details: null, summary: '2 files' }))).toBe(false);
    expect(findingsList(check({ details: null }))).toBeNull();
  });

  it('keeps hostile findings as text, and says how many files it left out', () => {
    const paths = Array.from({ length: 11 }, (_, i) => `src/${i}.ts`);
    const list = findingsList(
      check({
        details: { findings: [{ rule: HOSTILE, severity: 'fail', message: HOSTILE, paths: [HOSTILE, ...paths] }] },
      }),
    ) as HTMLElement;
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain(HOSTILE);
    const shown = [...list.querySelectorAll('.pn-finding-paths li')].map((x) => x.textContent);
    expect(shown).toHaveLength(9);
    expect(shown.at(-1)).toBe('and 4 more');
  });
});

describe('Show output (2026-11-17)', () => {
  it('offers nothing for a check that kept no output', () => {
    expect(checkOutput(makeContext(), null)).toBeNull();
  });

  it('reads what the check printed on the first click, once, and folds it away again', async () => {
    const ctx = makeContext({
      answers: {
        [PATH]: {
          artifact_ref: REF,
          kind: 'verification',
          text: `$ npm test\n${HOSTILE}\n1 failing`,
          lines: 3,
          from_line: 1,
          truncated: false,
        },
      },
    });
    const el = checkOutput(ctx, REF) as HTMLElement;
    const box = el.querySelector('.pn-check-output') as HTMLElement;
    expect(box.hidden).toBe(true);
    expect(ctx.transport.calls).toHaveLength(0);
    buttonBy(el, 'Show output').click();
    expect(box.textContent).toContain('Reading what the check printed');
    await flush();
    expect(ctx.transport.to('GET', '/artifacts/A1b2_c3-d4')).toHaveLength(1);
    expect(box.hidden).toBe(false);
    expect(box.querySelector('pre')?.textContent).toBe(`$ npm test\n${HOSTILE}\n1 failing`);
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).not.toContain('The end of the output');
    buttonBy(el, 'Hide output').click();
    expect(box.hidden).toBe(true);
    buttonBy(el, 'Show output').click();
    expect(box.hidden).toBe(false);
    expect(ctx.transport.calls).toHaveLength(1);
  });

  it('says which lines it shows when the output was long', async () => {
    const ctx = makeContext({
      answers: {
        [PATH]: {
          artifact_ref: REF,
          kind: 'verification',
          text: 'tail',
          lines: 2400,
          from_line: 2001,
          truncated: true,
        },
      },
    });
    const el = checkOutput(ctx, REF) as HTMLElement;
    buttonBy(el, 'Show output').click();
    await flush();
    expect(el.textContent).toContain('The end of the output: lines 2001 to 2400 of 2400.');
  });

  it('says so when the check printed nothing', async () => {
    const ctx = makeContext({
      answers: {
        [PATH]: { artifact_ref: REF, kind: 'verification', text: '\n', lines: 0, from_line: 1, truncated: false },
      },
    });
    const el = checkOutput(ctx, REF) as HTMLElement;
    buttonBy(el, 'Show output').click();
    await flush();
    expect(el.textContent).toContain('The check printed nothing.');
  });

  it('says why when the output cannot be read, and reads again on the next click', async () => {
    let fail = true;
    const ctx = makeContext({
      answers: {
        [PATH]: () => {
          if (fail) throw new Error('the output of this check is not kept');
          return { artifact_ref: REF, kind: 'verification', text: 'ok now', lines: 1, from_line: 1, truncated: false };
        },
      },
    });
    const el = checkOutput(ctx, REF) as HTMLElement;
    buttonBy(el, 'Show output').click();
    await flush();
    expect(el.querySelector('.field-error')?.textContent).toBe(
      'The output could not be read: the output of this check is not kept',
    );
    fail = false;
    buttonBy(el, 'Show output').click();
    await flush();
    expect(el.querySelector('pre')?.textContent).toBe('ok now');
  });
});
