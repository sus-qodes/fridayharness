/**
 * The panels and forms (plan §7.7, §7.10, §7.5 verification): what this area registers with the
 * shell, and the getting-started checklist `main.ts` mounts as a banner.
 *
 * Modals: `new-goal`; `plan-editor` (`id` = goal id, `mode` 'first' | 'revision'); `verify`
 * (`id` = task id); `land` (`id` = goal id); `claude-setup`; `start-agent` (an `id` of
 * `claude-code` or `codex` preselects the host). Drawers: `agents` (`tab` 'claude' scrolls to the
 * Claude Code card; 'pins' or 'routing', the pins' old door, opens Settings → Routing instead) and
 * `settings` (`tab` names a section: notifications, sound, look, planner, routing, policy, friday,
 * desktop, about).
 */
import type { AppContext } from '../shell/context.js';
import { agentsDrawer } from './agents-panel.js';
import { claudeSetupModal } from './claude-setup.js';
import { landModal } from './land-panel.js';
import { newGoalModal } from './new-goal.js';
import { planEditorModal } from './plan-editor.js';
import { settingsDrawer } from './settings.js';
import { startAgentModal } from './start-agent.js';
import { verifyModal } from './verify-panel.js';

export { gettingStarted } from './getting-started.js';

export function registerPanels(ctx: AppContext): void {
  const r = ctx.registry;
  r.modal('new-goal', newGoalModal);
  r.modal('plan-editor', planEditorModal);
  r.modal('verify', verifyModal);
  r.modal('land', landModal);
  r.modal('claude-setup', claudeSetupModal);
  r.modal('start-agent', startAgentModal);
  r.drawer('agents', agentsDrawer);
  r.drawer('settings', settingsDrawer);
}
