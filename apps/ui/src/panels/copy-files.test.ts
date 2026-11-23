// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { CopyFilesView } from '../api/client.js';
import { looseningWords } from '../model/loosening-words.js';
import { makeContext } from '../test/context.js';
import { Teardown } from './common.js';
import { copyFilesCard, copyRows, nameInCopy, tickedList } from './copy-files.js';
import { flush } from './test-support.js';

const sent = (ctx: ReturnType<typeof makeContext>, path: string) => ctx.transport.to('POST', path).map((c) => c.body);
const view = (over: Partial<CopyFilesView> = {}): CopyFilesView => ({
  files: [],
  in_force: [],
  found: ['.env', '.env.agents.local'],
  ...over,
});
const WAITING = (to: string) => ({
  policy: {
    loosening: [{ source: 'config.yaml', setting: 'worktrees.files', from: 'none', to }],
    loosening_hash: 'hash0123456789ab',
    trusted: false,
  },
});
const row = (el: HTMLElement, file: string) => {
  const b = el.querySelector<HTMLButtonElement>(`.pn-landing-choice[data-file="${file}"]`);
  if (!b) throw new Error(`no row ${file}`);
  return b;
};

describe('settings files for the copies of a project (2026-11-17)', () => {
  it('gives a file kept for agents the name the project reads, and any other file its own', () => {
    expect(nameInCopy('.env')).toBe('.env');
    expect(nameInCopy('.env.local')).toBe('.env.local');
    expect(nameInCopy('.env.agents.local')).toBe('.env');
    expect(nameInCopy('apps/api/.env.agents')).toBe('apps/api/.env');
  });

  it('shows what is on, what waits for approval, and a listed file that is gone', () => {
    const rows = copyRows(
      view({
        files: [
          { from: '.env.agents.local', to: '.env' },
          { from: 'apps/api/.env.local', to: 'apps/api/.env.local' },
        ],
        in_force: [{ from: '.env.agents.local', to: '.env' }],
      }),
    );
    expect(rows).toEqual([
      { path: '.env', to: '.env', state: 'off', gone: false },
      { path: '.env.agents.local', to: '.env', state: 'on', gone: false },
      { path: 'apps/api/.env.local', to: 'apps/api/.env.local', state: 'waiting', gone: true },
    ]);
  });

  it('a tick adds a file in place of another with its name, and a second tick takes it out', () => {
    const real = view({ files: [{ from: '.env', to: '.env' }] });
    expect(tickedList(real, '.env.agents.local')).toEqual([{ from: '.env.agents.local', to: '.env' }]);
    expect(tickedList(real, '.env')).toEqual([]);
  });

  it('writes the list, then asks before this computer trusts it', async () => {
    const ctx = makeContext({
      answers: {
        'GET /config/copy-files': view(),
        'GET /policy': WAITING('.env.agents.local as .env'),
        'POST /policy/trust': WAITING('.env.agents.local as .env'),
      },
    });
    const td = new Teardown();
    const el = copyFilesCard(ctx, td);
    await flush();
    expect(row(el, '.env').getAttribute('aria-checked')).toBe('false');
    expect(row(el, '.env.agents.local').textContent).toContain('under the name .env');

    row(el, '.env.agents.local').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([
      { set: { 'worktrees.files': [{ from: '.env.agents.local', to: '.env' }] } },
    ]);
    expect(ctx.confirms).toHaveLength(1);
    expect([ctx.confirms[0]?.body].flat().join('\n')).toContain('.env.agents.local as .env');
    expect(sent(ctx, '/policy/trust')).toEqual([{ loosening_hash: 'hash0123456789ab' }]);
    td.run();
  });

  it('offers the approval again for a list that still waits, and says when there is nothing to give', async () => {
    const waiting = makeContext({
      answers: {
        'GET /config/copy-files': view({ files: [{ from: '.env', to: '.env' }] }),
        'GET /policy': WAITING('.env'),
        'POST /policy/trust': WAITING('.env'),
      },
    });
    const td = new Teardown();
    const el = copyFilesCard(waiting, td);
    await flush();
    expect(row(el, '.env').textContent).toContain('Waits for your approval');
    el.querySelector<HTMLButtonElement>('[data-action="approve-copy-files"]')?.click();
    await flush();
    expect(sent(waiting, '/policy/trust')).toEqual([{ loosening_hash: 'hash0123456789ab' }]);
    expect(sent(waiting, '/config/settings')).toEqual([]);
    td.run();

    const none = makeContext({ answers: { 'GET /config/copy-files': view({ found: [] }) } });
    const td2 = new Teardown();
    const empty = copyFilesCard(none, td2);
    await flush();
    expect(empty.textContent).toContain('has no settings file');
    expect(empty.textContent).not.toContain('Tick the files');
    td2.run();
  });

  it('puts the setting into words a person can judge', () => {
    expect(looseningWords({ setting: 'worktrees.files', to: '.env.agents.local as .env' })).toBe(
      'Every copy of the project an agent works in gets your file .env.agents.local as .env; programs run there can read it',
    );
  });
});
