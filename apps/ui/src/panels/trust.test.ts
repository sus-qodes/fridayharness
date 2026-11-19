import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { flush } from './test-support.js';
import { trustLoosening, trustWhatStays } from './trust.js';

const item = (id: string, setting: string, trusted: boolean, to = 'auto') => ({
  id,
  trusted,
  source: 'config.yaml',
  setting,
  from: 'review',
  to,
});
const policyOf = (loosening: unknown[], trusted = false) => ({
  policy: { version: 'v1', loosening, loosening_hash: 'h_all', trusted },
});
const sent = (ctx: ReturnType<typeof makeContext>) => ctx.transport.to('POST', '/policy/trust').map((c) => c.body);

describe('trust asked by a switch (2026-11-18)', () => {
  it('asks about the setting that was switched on, and only that one is trusted', async () => {
    const view = policyOf([
      item('id_install', 'autonomy.package.install', false),
      item('id_land', 'landing.mode', false, 'goal'),
      item('id_files', 'worktrees.files', true, '.env'),
    ]);
    const ctx = makeContext({ answers: { 'GET /policy': view, 'POST /policy/trust': view } });
    ctx.confirmAnswer = true;
    const r = await trustLoosening(ctx, {
      expects: 'autonomy.package.install',
      success: 'Agents install packages without asking',
    });
    await flush();
    expect(r).toBe('trusted');
    // The question names it alone: what else waits is neither shown nor sent.
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.title).toBe('Trust this setting on this computer?');
    expect(ctx.confirms[0]?.body).toHaveLength(2);
    expect(String(ctx.confirms[0]?.body?.[0])).toContain('autonomy.package.install');
    expect(JSON.stringify(ctx.confirms[0]?.body)).not.toContain('landing.mode');
    expect(sent(ctx)).toEqual([{ items: ['id_install'] }]);
  });

  it('asks nothing when that setting is trusted already, though others wait', async () => {
    const view = policyOf([
      item('id_install', 'autonomy.package.install', true),
      item('id_land', 'landing.mode', false, 'goal'),
    ]);
    const ctx = makeContext({ answers: { 'GET /policy': view } });
    expect(await trustLoosening(ctx, { expects: 'autonomy.package.install', success: 'x' })).toBe('nothing');
    expect(ctx.confirms).toHaveLength(0);
    expect(sent(ctx)).toEqual([]);
  });

  it('trusts every file of a list setting that waits, and says when the setting is not asked for at all', async () => {
    const view = policyOf([
      item('id_a', 'worktrees.files', false, '.env.agents.local as .env'),
      item('id_b', 'worktrees.files', false, 'apps/api/.env.local'),
      item('id_c', 'worktrees.files', true, 'old.env'),
    ]);
    const ctx = makeContext({ answers: { 'GET /policy': view, 'POST /policy/trust': view } });
    ctx.confirmAnswer = true;
    expect(await trustLoosening(ctx, { expects: 'worktrees.files', success: 'x' })).toBe('trusted');
    expect(ctx.confirms[0]?.title).toBe('Trust these settings on this computer?');
    expect(sent(ctx)).toEqual([{ items: ['id_a', 'id_b'] }]);
    const missing = makeContext({ answers: { 'GET /policy': view } });
    expect(await trustLoosening(missing, { expects: 'landing.mode', missing: 'Not asked for', success: 'x' })).toBe(
      'missing',
    );
    expect(missing.toasts.at(-1)?.text).toBe('Not asked for');
    expect(sent(missing)).toEqual([]);
  });

  it('backing out trusts nothing; the desktop asks in its own window', async () => {
    const view = policyOf([item('id_install', 'autonomy.package.install', false)]);
    const no = makeContext({ answers: { 'GET /policy': view, 'POST /policy/trust': view } });
    no.confirmAnswer = false;
    expect(await trustLoosening(no, { expects: 'autonomy.package.install', success: 'x' })).toBe('cancelled');
    expect(sent(no)).toEqual([]);
    const desk = makeContext({ answers: { 'GET /policy': view, 'POST /policy/trust': view } });
    (desk as { platform: unknown }).platform = { ...desk.platform, kind: 'tauri', desktop: {} };
    expect(await trustLoosening(desk, { expects: 'autonomy.package.install', success: 'x' })).toBe('trusted');
    expect(desk.confirms).toHaveLength(0);
    expect(sent(desk)).toEqual([{ items: ['id_install'] }]);
  });

  it('asks nothing after a setting was switched off: the others stay trusted', async () => {
    // What stays on is trusted by its own name; something else that never was trusted still waits,
    // and switching a setting off is no reason to ask about it.
    const view = policyOf([
      item('id_install', 'autonomy.package.install', true),
      item('id_land', 'landing.mode', false, 'goal'),
    ]);
    const ctx = makeContext({ answers: { 'GET /policy': view } });
    expect(await trustWhatStays(ctx)).toBe('nothing');
    expect(ctx.confirms).toHaveLength(0);
  });

  it('asks a daemon from before per-setting trust for the whole list, as it was', async () => {
    const old = {
      policy: {
        version: 'v1',
        loosening: [{ source: 'config.yaml', setting: 'autonomy.package.install', from: 'review', to: 'auto' }],
        loosening_hash: 'h_old',
        trusted: false,
      },
    };
    const ctx = makeContext({ answers: { 'GET /policy': old, 'POST /policy/trust': old } });
    ctx.confirmAnswer = true;
    expect(await trustLoosening(ctx, { expects: 'autonomy.package.install', success: 'x' })).toBe('trusted');
    expect(sent(ctx)).toEqual([{ loosening_hash: 'h_old' }]);
    // There the shorter list has to be trusted again after one was switched off.
    const stays = makeContext({ answers: { 'GET /policy': old, 'POST /policy/trust': old } });
    stays.confirmAnswer = true;
    expect(await trustWhatStays(stays)).toBe('trusted');
    expect(stays.confirms[0]?.title).toBe('Keep these settings on?');
  });
});
