/**
 * The project's checks, set from Settings: what the project has, what Friday found in package.json,
 * and adding or removing by name (the daemon builds the commands).
 */
import { describe, expect, it } from 'vitest';
import type { ProjectChecksView } from '../api/client.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { Teardown } from './common.js';
import { commandLine, kindOfCheck, projectChecksCard, tookWords, trialVerdict } from './project-checks.js';
import { buttonBy, flush, HOSTILE } from './test-support.js';

const TESTS = {
  name: 'tests',
  kind: 'test',
  command: 'npm',
  args: ['run', 'test'],
  script: 'test',
  runs: 'vitest run',
};
const LINT = { name: 'lint', kind: 'lint', command: 'npm', args: ['run', 'lint'], script: 'lint', runs: 'eslint .' };

const view = (over: Partial<ProjectChecksView> = {}): ProjectChecksView => ({
  checks: [],
  suggested: [TESTS, LINT],
  manager: 'npm',
  ...over,
});

const have = (name: string, kind = 'test', required = true) => ({
  name,
  kind,
  command: 'npm',
  args: ['run', name],
  required,
});

const sent = (ctx: ReturnType<typeof makeContext>) => ctx.transport.to('POST', '/config/checks').map((c) => c.body);

describe('the words of a check', () => {
  it('names a kind as a person says it, and a command as it would be typed', () => {
    expect(kindOfCheck('test')).toBe('Tests');
    expect(kindOfCheck('typecheck')).toBe('Type check');
    expect(kindOfCheck('something')).toBe('Check');
    expect(commandLine({ command: 'pnpm', args: ['run', 'lint'] })).toBe('pnpm run lint');
  });
});

describe("the project's checks in Settings (2026-11-17)", () => {
  it('says the project has none, and offers what Friday found in package.json', async () => {
    const ctx = makeContext({ answers: { 'GET /config/checks': view() } });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    expect(el.textContent).toContain('Reading the project’s checks');
    await flush();
    // None is fine: checks are optional, and the card says so (2026-11-18: "what if some repo dont
    // have any tests or just in initial phase only").
    expect(el.querySelector('[data-state="none"]')?.textContent).toContain('That is fine for a project just starting');
    expect(el.textContent).toContain('They are optional');
    expect(el.textContent).not.toContain('Without any, no test decides');
    const offered = [...el.querySelectorAll('[data-list="suggested"] li')].map((li) => li.textContent);
    expect(offered).toHaveLength(2);
    expect(offered[0]).toContain('npm run test');
    expect(offered[0]).toContain('runs: vitest run');
    expect(el.textContent).toContain('commit that file with your own work: Friday never commits it for you');
    td.run();
  });

  it('adds one by its name, and shows what config.yaml then has', async () => {
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view(),
        'POST /config/checks': {
          added: ['tests'],
          removed: [],
          ...view({ checks: [have('tests')], suggested: [LINT] }),
        },
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    buttonBy(el, 'Add the check npm run test').click();
    await flush();
    // Names only: the page never sends a command.
    expect(sent(ctx)).toEqual([{ add: ['tests'], remove: [] }]);
    expect([...el.querySelectorAll('[data-list="have"] li')].map((li) => li.textContent)).toEqual([
      expect.stringContaining('npm run tests'),
    ]);
    expect(el.querySelectorAll('[data-list="suggested"] li')).toHaveLength(1);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Tests added' });
    // The board lists the checks too: it is read again.
    expect(ctx.refreshes).toBe(1);
    td.run();
  });

  it('adds every suggestion at once, and offers that only when there is more than one', async () => {
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view(),
        'POST /config/checks': {
          added: ['tests', 'lint'],
          removed: [],
          ...view({ checks: [have('tests'), have('lint', 'lint')], suggested: [] }),
        },
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    buttonBy(el, 'Add all 2').click();
    await flush();
    expect(sent(ctx)).toEqual([{ add: ['tests', 'lint'], remove: [] }]);
    expect(el.querySelector('[data-list="suggested"]')).toBeNull();
    expect(() => buttonBy(el, 'Add all')).toThrow();
    td.run();

    const one = makeContext({ answers: { 'GET /config/checks': view({ suggested: [TESTS] }) } });
    const td2 = new Teardown();
    const el2 = projectChecksCard(one, td2);
    await flush();
    expect(() => buttonBy(el2, 'Add all')).toThrow();
    td2.run();
  });

  it('removes a check by its name, and says which are advisory', async () => {
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view({ checks: [have('tests'), have('lint', 'lint', false)], suggested: [] }),
        'POST /config/checks': {
          added: [],
          removed: ['lint'],
          ...view({ checks: [have('tests')], suggested: [LINT] }),
        },
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    expect(el.querySelectorAll('[data-list="have"] li')[1]?.textContent).toContain('Advisory');
    buttonBy(el, 'Remove the check lint').click();
    await flush();
    expect(sent(ctx)).toEqual([{ add: [], remove: ['lint'] }]);
    expect(el.querySelectorAll('[data-list="have"] li')).toHaveLength(1);
    td.run();
  });

  it('says so when package.json holds nothing of the kind, and leads to the file', async () => {
    const opened: string[] = [];
    const ctx = makeContext({ answers: { 'GET /config/checks': view({ suggested: [] }) } });
    (ctx.platform as { openInEditor: (p: string) => void }).openInEditor = (p) => opened.push(p);
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    expect(el.textContent).toContain('Friday found no test, lint or build script');
    buttonBy(el, 'Open config.yaml in VS Code').click();
    expect(opened).toEqual(['C:/demo/shop/.friday/config.yaml']);
    td.run();
  });

  it('keeps what the project wrote as text, and shows a refusal without changing the list', async () => {
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view({
          checks: [{ name: HOSTILE, kind: 'other', command: HOSTILE, args: [HOSTILE], required: true }],
          suggested: [{ ...TESTS, runs: HOSTILE }],
        }),
        'POST /config/checks': () => {
          throw new Error('config.yaml could not be written (EPERM)');
        },
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain(HOSTILE);
    buttonBy(el, 'Add the check npm run test').click();
    await flush();
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', detail: 'config.yaml could not be written (EPERM)' });
    expect(el.querySelectorAll('[data-list="suggested"] li')).toHaveLength(1);
    expect(ctx.refreshes).toBe(0);
    td.run();
  });

  it('says why when the checks cannot be read, and follows a config.yaml changed elsewhere', async () => {
    const failing = makeContext({
      answers: {
        'GET /config/checks': () => {
          throw new Error('config.yaml is invalid: verification.checks.0.command: Required');
        },
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(failing, td);
    await flush();
    expect(el.querySelector('.field-error')?.textContent).toContain(
      'The checks could not be read: config.yaml is invalid',
    );
    td.run();

    let now = view();
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false } }),
      answers: { 'GET /config/checks': () => now },
    });
    const td2 = new Teardown();
    const el2 = projectChecksCard(ctx, td2);
    await flush();
    expect(el2.querySelector('[data-list="have"]')).toBeNull();
    // Someone adds a check in the file: the board says so, and the card reads the list again.
    now = view({ checks: [have('tests')], suggested: [LINT] });
    ctx.board(
      makeSnapshot({
        verification: { checks: [{ name: 'tests', kind: 'test', required: true }], auto_on_completion: false },
      }),
    );
    await flush();
    expect(el2.querySelectorAll('[data-list="have"] li')).toHaveLength(1);
    expect(ctx.transport.to('GET', '/config/checks')).toHaveLength(2);
    td2.run();
  });
});

describe('a check’s strength, and trying the checks on the untouched project (2026-11-18)', () => {
  const idle = {
    status: 'idle',
    started_at: null,
    finished_at: null,
    commit: null,
    uncommitted: false,
    running: null,
    problem: null,
    checks: [],
  };
  const row = (name: string, status: string, required = true, output_tail: string | null = null) => ({
    name,
    kind: 'test',
    required,
    status,
    summary: null,
    duration_ms: 4200,
    output_tail,
  });

  it('says of every check whether it is required, and changes it with one click', async () => {
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view({ checks: [have('tests'), have('lint', 'lint', false)], suggested: [] }),
        'GET /config/checks/trial': idle,
        'POST /config/checks': view({
          checks: [have('tests', 'test', false), have('lint', 'lint', false)],
          suggested: [],
        }),
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    const marks = [...el.querySelectorAll<HTMLButtonElement>('.pn-pc-strength')];
    expect(marks.map((b) => b.textContent)).toEqual(['Required', 'Advisory']);
    marks[0]?.click();
    await flush();
    expect(sent(ctx)).toEqual([{ add: [], remove: [], strength: { name: 'tests', required: false } }]);
    expect([...el.querySelectorAll('.pn-pc-strength')].map((b) => b.textContent)).toEqual(['Advisory', 'Advisory']);
    td.run();
  });

  it('runs them on a click, follows the run, and says what a failure before any work means', async () => {
    let step = 0;
    const steps = [
      {
        ...idle,
        status: 'running',
        running: 'tests',
        commit: 'abc123456789',
        checks: [row('tests', 'running'), row('lint', 'waiting', false)],
      },
      {
        ...idle,
        status: 'done',
        commit: 'abc123456789',
        uncommitted: true,
        checks: [row('tests', 'failed', true, 'connect ECONNREFUSED 127.0.0.1:5433'), row('lint', 'passed', false)],
      },
    ];
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view({ checks: [have('tests'), have('lint', 'lint', false)], suggested: [] }),
        'GET /config/checks/trial': () => (step === 0 ? idle : steps[Math.min(step - 1, 1)]),
        'POST /config/checks/trial': () => {
          step = 1;
          return steps[0];
        },
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    expect(el.textContent).toContain('before any agent changes it');
    buttonBy(el, 'Run the checks now').click();
    await flush();
    expect(ctx.transport.to('POST', '/config/checks/trial')).toHaveLength(1);
    expect(buttonBy(el, 'Running the checks').disabled).toBe(true);
    expect(el.textContent).toContain('Running “tests”');
    // The run ends: the daemon's next answer is read without another click.
    step = 2;
    await new Promise((r) => setTimeout(r, 1700));
    await flush();
    expect(el.querySelector('[data-trial]')?.getAttribute('data-trial')).toBe('done');
    expect(el.querySelector('.pn-pc-verdict')?.textContent).toContain(
      '“tests” fails before any agent has changed anything',
    );
    expect(el.querySelector('.pn-pc-output pre')?.textContent).toContain('ECONNREFUSED');
    expect(el.textContent).toContain('not committed yet were not part of this run');
    expect(buttonBy(el, 'Run them again').disabled).toBe(false);
    td.run();
  });

  it('judges a finished run in one sentence', () => {
    const done = (checks: ReturnType<typeof row>[]) => trialVerdict({ ...idle, status: 'done', checks } as never);
    expect(done([row('tests', 'passed'), row('lint', 'passed', false)])?.tone).toBe('good');
    expect(done([row('tests', 'passed'), row('lint', 'failed', false)])?.tone).toBe('warn');
    expect(done([row('tests', 'failed')])?.tone).toBe('danger');
    expect(trialVerdict({ ...idle, status: 'running' } as never)).toBeNull();
    expect(trialVerdict({ ...idle, status: 'failed', problem: 'git is not here' } as never)?.text).toBe(
      'git is not here',
    );
    expect(tookWords(400)).toBe('under a second');
    expect(tookWords(42_000)).toBe('42 s');
    expect(tookWords(300_000)).toBe('5 min');
  });

  // The trial (F8): lint took 116 s of its 120 s while another agent worked, and the only way to give
  // it more time was editing config.yaml by hand (2026-11-19).
  it('shows each check’s time limit and what it took, changes it, and offers the longer one its times call for', async () => {
    const timed = (name: string, over: Record<string, unknown>) => ({ ...have(name), timeout_ms: 120_000, ...over });
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view({
          checks: [
            timed('tests', { took_ms: 64_000, ran_out: false, suggested_ms: 240_000 }),
            timed('lint', { took_ms: 25_000, ran_out: false, suggested_ms: null }),
            timed('build', { took_ms: null, timeout_ms: 90_000 }),
          ],
          suggested: [],
        }),
        'GET /config/checks/trial': idle,
        'POST /config/checks': view({
          checks: [timed('tests', { timeout_ms: 240_000, took_ms: 64_000 })],
          suggested: [],
        }),
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    const lines = [...el.querySelectorAll('.pn-pc-time')];
    expect(lines.map((l) => l.getAttribute('data-limit'))).toEqual(['120000', '120000', '90000']);
    expect(lines[0]?.textContent).toContain('Took 1 min 4 s at most.');
    expect(lines[0]?.textContent).toContain('Close to its limit');
    expect(lines[1]?.textContent).toContain('Took 25 s at most.');
    expect(lines[1]?.querySelector('.pn-pc-suggest')).toBeNull();
    expect(lines[2]?.textContent).toContain('Not run yet.');
    // A limit written by hand that is not whole minutes is shown as it is, and cannot be picked again.
    const odd = lines[2]?.querySelector('select') as HTMLSelectElement;
    expect(odd.value).toBe('90000');
    expect(odd.selectedOptions[0]?.textContent).toBe('1 min 30 s');
    expect(odd.selectedOptions[0]?.disabled).toBe(true);
    // The suggestion, with one click.
    buttonBy(lines[0] as HTMLElement, 'Give it 4 min').click();
    await flush();
    expect(sent(ctx)).toEqual([{ add: [], remove: [], limit: { name: 'tests', minutes: 4 } }]);
    expect(ctx.toasts.at(-1)?.text).toBe('“tests” now has 4 min');
    // Or any limit, picked.
    const pick = el.querySelector('.pn-pc-time select') as HTMLSelectElement;
    expect(pick.getAttribute('aria-label')).toBe('Time limit of tests');
    pick.value = '600000';
    pick.dispatchEvent(new Event('change'));
    await flush();
    expect(sent(ctx).at(-1)).toEqual({ add: [], remove: [], limit: { name: 'tests', minutes: 10 } });
    td.run();
  });

  it('says a check that ran out of time as that, in the run and in its one sentence', async () => {
    const slow = { ...row('tests', 'failed'), timed_out: true, timeout_ms: 120_000, duration_ms: 120_000 };
    const verdict = trialVerdict({ ...idle, status: 'done', checks: [slow, row('lint', 'passed')] } as never);
    expect(verdict).toEqual({
      tone: 'warn',
      text: '“tests” ran out of time before finishing. Give it a longer time limit above, then run the checks again.',
    });
    // A real failure still comes first.
    expect(trialVerdict({ ...idle, status: 'done', checks: [slow, row('lint', 'failed')] } as never)?.tone).toBe(
      'danger',
    );
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view({ checks: [have('tests')], suggested: [] }),
        'GET /config/checks/trial': { ...idle, status: 'done', commit: 'abc', checks: [slow] },
      },
    });
    const td = new Teardown();
    const el = projectChecksCard(ctx, td);
    await flush();
    expect(el.querySelector('[data-list="trial"] .badge')?.textContent).toBe('ran out of time');
    td.run();
  });

  it('reads the checks again when a run ends, for the times it measured', async () => {
    let step = 0;
    const running = { ...idle, status: 'running', running: 'tests', checks: [row('tests', 'running')] };
    const ctx = makeContext({
      answers: {
        'GET /config/checks': view({ checks: [have('tests')], suggested: [] }),
        'GET /config/checks/trial': () =>
          step === 0 ? running : { ...idle, status: 'done', checks: [row('tests', 'passed')] },
      },
    });
    const td = new Teardown();
    projectChecksCard(ctx, td);
    await flush();
    expect(ctx.transport.to('GET', '/config/checks')).toHaveLength(1);
    step = 1;
    await new Promise((r) => setTimeout(r, 1700));
    await flush();
    expect(ctx.transport.to('GET', '/config/checks')).toHaveLength(2);
    td.run();
  });

  it('offers no run where there is no check, nor on a daemon that has none to offer', async () => {
    const none = makeContext({ answers: { 'GET /config/checks': view(), 'GET /config/checks/trial': idle } });
    const td = new Teardown();
    const el = projectChecksCard(none, td);
    await flush();
    expect(() => buttonBy(el, 'Run the checks now')).toThrow();
    td.run();
    const older = makeContext({ answers: { 'GET /config/checks': view({ checks: [have('tests')], suggested: [] }) } });
    const td2 = new Teardown();
    const el2 = projectChecksCard(older, td2);
    await flush();
    expect(() => buttonBy(el2, 'Run the checks now')).toThrow();
    td2.run();
  });
});
