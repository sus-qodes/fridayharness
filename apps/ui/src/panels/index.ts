/**
 * The panels and forms (plan §7.7, §7.10, §7.5 verification): what this area registers with the
 * shell, and the getting-started checklist `main.ts` mounts as a banner.
 *
 * Modals: `new-goal`; `plan-editor` (`id` = goal id, `mode` 'first' | 'revision'); `verify`
 * (`id` = task id); `land` (`id` = goal id); `claude-setup`; `antigravity-setup`; `start-agent` (an
 * `id` of `claude-code` or `codex` preselects the host). Drawers: `agents` (`tab` 'claude' scrolls
 * to the Claude Code card, 'antigravity' to the Antigravity card; 'pins' or 'routing', the pins' old
 * door, opens Settings → Models instead). Settings is a view of its own (settings-hub.ts), opened
 * by `openDrawer` of kind `settings`, whose `tab` names a page of it.
 */
import type { AppContext } from '../shell/context.js';
import { agentsDrawer } from './agents-panel.js';
import { antigravitySetupModal } from './antigravity-setup.js';
import { changeGoalModal } from './change-goal.js';
import { claudeSetupModal } from './claude-setup.js';
import { landModal } from './land-panel.js';
import { newGoalModal } from './new-goal.js';
import { planEditorModal } from './plan-editor.js';
import { raiseLimitModal } from './raise-limit.js';
import { startAgentModal } from './start-agent.js';
import { verifyModal } from './verify-panel.js';

export { gettingStarted } from './getting-started.js';

export function registerPanels(ctx: AppContext): void {
  const r = ctx.registry;
  r.modal('new-goal', newGoalModal);
  r.modal('plan-editor', planEditorModal);
  r.modal('verify', verifyModal);
  r.modal('land', landModal);
  r.modal('change-goal', changeGoalModal);
  r.modal('edit-agent', startAgentModal);
  r.modal('raise-limit', raiseLimitModal);
  r.modal('claude-setup', claudeSetupModal);
  r.modal('antigravity-setup', antigravitySetupModal);
  r.modal('start-agent', startAgentModal);
  r.drawer('agents', agentsDrawer);
}
