/**
 * The project's checks, set from Settings: what the project has, what Friday found in package.json,
 * and adding or removing by name (the daemon builds the commands).
 */
import { describe, expect, it } from 'vitest';
import type { ProjectChecksView } from '../api/client.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { Teardown } from './common.js';
import { commandLine, kindOfCheck, projectChecksCard } from './project-checks.js';
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
    expect(el.querySelector('[data-state="none"]')?.textContent).toContain('This project has no checks of its own.');
    const offered = [...el.querySelectorAll('[data-list="suggested"] li')].map((li) => li.textContent);
    expect(offered).toHaveLength(2);
    expect(offered[0]).toContain('npm run test');
    expect(offered[0]).toContain('runs: vitest run');
    expect(el.textContent).toContain('which your team shares: commit the file');
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
    expect(el.querySelectorAll('[data-list="have"] li')[1]?.textContent).toContain('advisory');
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
    expect(el.textContent).toContain('Friday found no test, lint, type-check or build script');
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
