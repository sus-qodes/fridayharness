/**
 * This clone's trust in what the project's files loosen, asked the same way by every switch that
 * turns such a setting on from Settings (checking the work automatically, approving plans
 * automatically, what agents may run without asking).
 *
 * Friday's rule stands as it was: a tracked file may ask for a loosening, and it applies on a
 * computer only once the person there has trusted it. Since 2026-11-18 trust is per setting. A
 * switch sets its setting and asks for trust in that setting alone: before, one "Trust" took the
 * whole list, so ticking a file for the copies also switched on whatever else happened to wait,
 * and each click showed everything again. Turning a setting off leaves the others trusted.
 *
 * The question is the platform's: the desktop shows its own (`confirm_and_send`), a browser asks
 * here. A daemon from before per-setting trust is still asked for the whole list, as it was.
 */
import { looseningLine } from '../model/loosening-words.js';
import type { AppContext } from '../shell/context.js';
import { readLoosening } from './settings.js';

export type TrustOutcome = 'trusted' | 'nothing' | 'missing' | 'cancelled' | 'failed';

/**
 * Asks for this clone's trust in the list that waits. `nothing`: nothing waits (none loosens, or it
 * is trusted already); `missing`: `expects` is not among it, so nothing was trusted.
 */
export async function trustLoosening(
  ctx: AppContext,
  opts: {
    /** The setting the caller just turned on: only it is trusted, and it must be asked for. */
    expects?: string;
    /** What to say when it is not. */
    missing?: string;
    title?: string;
    /** Said under the list a browser shows. */
    why?: string;
    success: string;
  },
): Promise<TrustOutcome> {
  const view = await ctx.act('Read the policy', () => ctx.api.policy());
  const p = readLoosening(view ?? null);
  if (!p.hash) return 'nothing';
  // Per setting where the daemon says which are trusted; the whole list where it does not.
  const perSetting = p.items.length > 0 && p.items.every((l) => l.id !== undefined && l.trusted !== undefined);
  const asked = opts.expects ? p.items.filter((l) => l.setting === opts.expects) : p.items;
  if (opts.expects && asked.length === 0) {
    ctx.toast({
      kind: 'warn',
      text: opts.missing ?? 'That setting is not among the ones that wait for trust',
      detail: 'config.yaml may have changed; look at the list in Settings → Permissions, and try again.',
    });
    return 'missing';
  }
  const waiting = perSetting ? asked.filter((l) => l.trusted !== true) : p.trusted ? [] : p.items;
  if (waiting.length === 0) return 'nothing';
  // The desktop shows its own dialog (`confirm_and_send`); a browser asks here.
  if (!ctx.platform.desktop) {
    const ok = await ctx.confirm({
      title:
        opts.title ??
        (waiting.length === 1 ? 'Trust this setting on this computer?' : 'Trust these settings on this computer?'),
      // Each setting as what it allows, with the exact form trust is recorded in.
      body: [...waiting.map(looseningLine), opts.why ?? 'Anyone who can change the project files chose it.'],
      confirmLabel: waiting.length === 1 ? 'Trust it' : 'Trust them',
      danger: true,
    });
    if (!ok) return 'cancelled';
  }
  const done = await ctx.act(
    'Trust the setting',
    () =>
      perSetting ? ctx.api.trustSettings(waiting.map((l) => l.id as string)) : ctx.api.trustPolicy(p.hash as string),
    opts.success,
  );
  return done ? 'trusted' : 'failed';
}

/**
 * After a loosening was turned off. Trust is per setting, so the ones that stay on stay trusted
 * and nothing is asked. Only a daemon from before that, which trusted one list as a whole, is
 * asked for the shorter list again: there the others would silently stop applying.
 */
export async function trustWhatStays(ctx: AppContext): Promise<TrustOutcome> {
  const view = await ctx.act('Read the policy', () => ctx.api.policy());
  const p = readLoosening(view ?? null);
  if (!p.hash || p.trusted || p.items.every((l) => l.id !== undefined)) return 'nothing';
  return trustLoosening(ctx, {
    title: 'Keep these settings on?',
    why: 'They were trusted together with the one you just turned off, as one list, so Friday asks again. Until you trust them, none of them applies.',
    success: 'The other settings stay in force',
  });
}
