/**
 * This clone's trust in what the project's files loosen (2026-11-17), asked the same way by every
 * switch that turns such a setting on from Settings (checking the work automatically, approving
 * plans automatically, what agents may run without asking).
 *
 * Friday's rule stands as it was: a tracked file may ask for a loosening, and it applies on a
 * computer only once the person there has trusted exactly the list (its hash). A switch sets the
 * setting, then asks for that trust through the platform's confirmation: the desktop shows its own
 * dialog (`confirm_and_send`), a browser asks here. It never trusts some other setting on its own:
 * the setting it turned on must be among what waits, and the whole list is shown.
 *
 * Trust covers one list. Turning a setting off makes it another, so what stays on would silently
 * stop applying: `trustWhatStays` asks for it again, at once.
 */
import type { AppContext } from '../shell/context.js';
import { plain } from './common.js';
import { type Loosening, readLoosening } from './settings.js';

export type TrustOutcome = 'trusted' | 'nothing' | 'missing' | 'cancelled' | 'failed';

function lines(items: readonly Loosening[]): string[] {
  return items.map(
    (l) => `${plain(l.setting, 120)}: ${plain(l.from, 60)} → ${plain(l.to, 120)} (${plain(l.source, 120)})`,
  );
}

/**
 * Asks for this clone's trust in the list that waits. `nothing`: nothing waits (none loosens, or it
 * is trusted already); `missing`: `expects` is not among it, so nothing was trusted.
 */
export async function trustLoosening(
  ctx: AppContext,
  opts: {
    /** The setting the caller just turned on: it must be among what waits. */
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
  if (!p.hash || p.trusted) return 'nothing';
  if (opts.expects && !p.items.some((l) => l.setting === opts.expects)) {
    ctx.toast({
      kind: 'warn',
      text: opts.missing ?? 'That setting is not among the ones that wait for trust',
      detail: 'config.yaml may have changed; look at the list in Settings → Permissions, and try again.',
    });
    return 'missing';
  }
  // The desktop shows its own dialog (`confirm_and_send`); a browser asks here.
  if (!ctx.platform.desktop) {
    const ok = await ctx.confirm({
      title: opts.title ?? 'Trust these settings on this computer?',
      body: [...lines(p.items), opts.why ?? 'Anyone who can change the project files chose these settings.'],
      confirmLabel: 'Trust them',
      danger: true,
    });
    if (!ok) return 'cancelled';
  }
  const done = await ctx.act('Trust the setting', () => ctx.api.trustPolicy(p.hash as string), opts.success);
  return done ? 'trusted' : 'failed';
}

/**
 * After a loosening was turned off: the settings that stay on were trusted together with it, as one
 * list, so they no longer apply until the shorter list is trusted. Asked at once, in those words.
 */
export async function trustWhatStays(ctx: AppContext): Promise<TrustOutcome> {
  return trustLoosening(ctx, {
    title: 'Keep these settings on?',
    why: 'They were trusted together with the one you just turned off, as one list, so Friday asks again. Until you trust them, none of them applies.',
    success: 'The other settings stay in force',
  });
}
