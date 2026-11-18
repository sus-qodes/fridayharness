/**
 * What agents may do without asking: each kind of command as words with Ask me or Allow. Allowing
 * is a loosening, written to config.yaml and trusted on this computer before it applies.
 */
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { agentPermissionsCard, PERMISSIONS, permissionState } from './agent-permissions.js';
import { Teardown } from './common.js';
import { flush } from './test-support.js';

const item = (cls: string, source = 'config.yaml', to = 'auto') => ({
  source,
  setting: `autonomy.${cls}`,
  from: 'review',
  to,
});

const POLICY = (trusted: boolean, items: ReturnType<typeof item>[] = []) => ({
  policy: { loosening: items, loosening_hash: items.length ? 'hash0123456789ab' : null, trusted },
});

const sent = (ctx: ReturnType<typeof makeContext>, path: string) => ctx.transport.to('POST', path).map((c) => c.body);

function rowOf(el: HTMLElement, cls: string): HTMLElement {
  return el.querySelector(`[data-cls="${cls}"]`) as HTMLElement;
}

function pressed(row: HTMLElement): string | undefined {
  return row.querySelector<HTMLButtonElement>('.pn-seg[aria-pressed="true"]')?.dataset.value;
}

function choose(row: HTMLElement, value: 'ask' | 'allow'): void {
  (row.querySelector(`.pn-seg[data-value="${value}"]`) as HTMLButtonElement).click();
}

describe('where a permission stands', () => {
  it('asks by default, allows when the project asks for it, and is in force once trusted', () => {
    expect(permissionState([], true, 'package.install')).toEqual({ level: 'ask', inForce: false, elsewhere: null });
    const items = [item('package.install')];
    expect(permissionState(items, false, 'package.install')).toEqual({
      level: 'allow',
      inForce: false,
      elsewhere: null,
    });
    expect(permissionState(items, true, 'package.install')).toEqual({ level: 'allow', inForce: true, elsewhere: null });
    expect(permissionState(items, true, 'git.mutate').level).toBe('ask');
  });

  it('names the policy file that allows it when that is not config.yaml', () => {
    const items = [item('unknown', '.friday/policies/ci.yaml')];
    expect(permissionState(items, true, 'unknown')).toEqual({
      level: 'allow',
      inForce: true,
      elsewhere: '.friday/policies/ci.yaml',
    });
  });

  it('offers only the kinds Friday asks about by default, never pushing, publishing or secrets', () => {
    expect(PERMISSIONS.map((p) => p.cls).sort()).toEqual(
      [
        'file.write',
        'fs.destructive',
        'git.mutate',
        'network.fetch',
        'package.install',
        'process.kill',
        'unknown',
      ].sort(),
    );
  });
});

describe('what agents may do without asking (2026-11-17)', () => {
  it('shows each kind in words, asking by default, and says what always asks', async () => {
    const ctx = makeContext({ answers: { 'GET /policy': POLICY(true) } });
    const td = new Teardown();
    const el = agentPermissionsCard(ctx, td);
    await flush();
    const rows = [...el.querySelectorAll<HTMLElement>('.pn-perm-item')];
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.querySelector('.pn-perm-title')?.textContent)).toEqual(PERMISSIONS.map((p) => p.title));
    expect(rows.every((r) => pressed(r) === 'ask')).toBe(true);
    expect(rowOf(el, 'package.install').textContent).toContain('npm install, pip install');
    expect(el.textContent).toContain('Always asks you, whatever is set here: pushing to a remote');
    expect(el.textContent).toContain('Never allowed: reading stored secrets.');
    // No class name is read out as the choice.
    expect(el.querySelector('.pn-perm-title')?.textContent).not.toContain('package.install');
    td.run();
  });

  it('Allow writes the setting, then asks for this computer’s trust in the list that holds it', async () => {
    let policy = POLICY(true);
    const ctx = makeContext({
      answers: {
        'GET /policy': () => policy,
        'POST /config/settings': () => {
          policy = POLICY(false, [item('package.install')]);
          return { changed: ['autonomy.package.install'] };
        },
        'POST /policy/trust': () => {
          policy = POLICY(true, [item('package.install')]);
          return policy;
        },
      },
    });
    const td = new Teardown();
    const el = agentPermissionsCard(ctx, td);
    await flush();
    choose(rowOf(el, 'package.install'), 'allow');
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'autonomy.package.install': 'auto' } }]);
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.body).toContain(
      'Agents may install packages without asking (autonomy.package.install: review → auto, config.yaml)',
    );
    expect(sent(ctx, '/policy/trust')).toEqual([{ loosening_hash: 'hash0123456789ab' }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Agents install packages without asking' });
    expect(pressed(rowOf(el, 'package.install'))).toBe('allow');
    expect(rowOf(el, 'package.install').textContent).not.toContain('waits for your trust');
    td.run();
  });

  it('says it waits for trust when the person does not trust it, and nothing is in force', async () => {
    let policy = POLICY(true);
    const ctx = makeContext({
      answers: {
        'GET /policy': () => policy,
        'POST /config/settings': () => {
          policy = POLICY(false, [item('unknown')]);
          return { changed: ['autonomy.unknown'] };
        },
      },
    });
    ctx.confirmAnswer = false;
    const td = new Teardown();
    const el = agentPermissionsCard(ctx, td);
    await flush();
    choose(rowOf(el, 'unknown'), 'allow');
    await flush();
    expect(sent(ctx, '/policy/trust')).toHaveLength(0);
    expect(pressed(rowOf(el, 'unknown'))).toBe('allow');
    expect(rowOf(el, 'unknown').textContent).toContain('waits for your trust');
    td.run();
  });

  it('Ask me sets it back at once, and asks again for what stays on, since that was one list', async () => {
    let policy = POLICY(true, [item('package.install'), item('git.mutate')]);
    const ctx = makeContext({
      answers: {
        'GET /policy': () => policy,
        'POST /config/settings': () => {
          policy = POLICY(false, [item('git.mutate')]);
          return { changed: ['autonomy.package.install'] };
        },
        'POST /policy/trust': () => {
          policy = POLICY(true, [item('git.mutate')]);
          return policy;
        },
      },
    });
    const td = new Teardown();
    const el = agentPermissionsCard(ctx, td);
    await flush();
    expect(pressed(rowOf(el, 'package.install'))).toBe('allow');
    choose(rowOf(el, 'package.install'), 'ask');
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'autonomy.package.install': 'review' } }]);
    // What stays on is shown and trusted again, in words that say why.
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.title).toBe('Keep these settings on?');
    expect(ctx.confirms[0]?.body[0]).toBe(
      'Agents may commit and change branches without asking (autonomy.git.mutate: review → auto, config.yaml)',
    );
    expect(sent(ctx, '/policy/trust')).toHaveLength(1);
    expect(pressed(rowOf(el, 'package.install'))).toBe('ask');
    expect(pressed(rowOf(el, 'git.mutate'))).toBe('allow');
    td.run();
  });

  it('asks nothing more when nothing else was on', async () => {
    let policy = POLICY(true, [item('process.kill')]);
    const ctx = makeContext({
      answers: {
        'GET /policy': () => policy,
        'POST /config/settings': () => {
          policy = POLICY(true);
          return { changed: ['autonomy.process.kill'] };
        },
      },
    });
    const td = new Teardown();
    const el = agentPermissionsCard(ctx, td);
    await flush();
    choose(rowOf(el, 'process.kill'), 'ask');
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    expect(sent(ctx, '/policy/trust')).toHaveLength(0);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Agents ask before they stop running programs' });
    td.run();
  });

  it('does not change what another policy file allows, and says which file', async () => {
    const ctx = makeContext({
      answers: { 'GET /policy': POLICY(true, [item('network.fetch', '.friday/policies/ci.yaml')]) },
    });
    const td = new Teardown();
    const el = agentPermissionsCard(ctx, td);
    await flush();
    const row = rowOf(el, 'network.fetch');
    expect(row.textContent).toContain('Allowed by .friday/policies/ci.yaml, which is changed in that file.');
    expect([...row.querySelectorAll<HTMLButtonElement>('.pn-seg')].every((b) => b.disabled)).toBe(true);
    td.run();
  });

  it('says why when the settings cannot be read, and reads again when trust changes elsewhere', async () => {
    const failing = makeContext({
      answers: {
        'GET /policy': () => {
          throw new Error('this daemon has no project policy');
        },
      },
    });
    const td = new Teardown();
    const el = agentPermissionsCard(failing, td);
    await flush();
    expect(el.querySelector('.field-error')?.textContent).toBe(
      'The settings could not be read: this daemon has no project policy',
    );
    td.run();

    let policy = POLICY(false, [item('unknown')]);
    const ctx = makeContext({
      snapshot: makeSnapshot({ policy_untrusted: true }),
      answers: { 'GET /policy': () => policy },
    });
    const td2 = new Teardown();
    const el2 = agentPermissionsCard(ctx, td2);
    await flush();
    expect(rowOf(el2, 'unknown').textContent).toContain('waits for your trust');
    // Trusted from the list below: the board says so, and the card follows.
    policy = POLICY(true, [item('unknown')]);
    ctx.board(makeSnapshot({ policy_untrusted: false }));
    await flush();
    expect(rowOf(el2, 'unknown').textContent).not.toContain('waits for your trust');
    td2.run();
  });
});
