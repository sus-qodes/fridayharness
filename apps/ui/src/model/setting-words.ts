/**
 * A setting of the project's config.yaml as what it is (2026-11-17), for the banner that says a
 * change waits for a restart. The banner listed the keys as the file writes them
 * ("providers.anthropic.allow_remote needs a restart to apply"); since Settings changes these from
 * buttons, a person who never opened the file met its keys there. A key this module does not know
 * is shown as written. Pure module: no DOM.
 */
import { truncate } from '../ui/format.js';
import { visible } from './text.js';

const NAMES: Record<string, string> = {
  'master_brain.provider': 'who writes the plans',
  'master_brain.model': 'the planner’s model',
  'master_brain.auto_approve': 'starting plans without your approval',
  'providers.anthropic.allow_remote': 'planning with an Anthropic key',
  'providers.anthropic.daily_budget_usd': 'the project’s spending limit for planning with a key',
  'providers.claude-code.allow_remote': 'planning through Claude Code',
  'providers.claude-code.daily_budget_usd': 'the project’s spending limit for planning through Claude Code',
  'verification.auto_on_completion': 'checking finished work automatically',
  'daemon.port': 'the port Friday answers on',
  'worktrees.mode': 'whether each task gets its own folder',
  sandbox: 'treating this folder as disposable',
};

/** A section of the file, for a key inside it that has no name of its own. */
const SECTIONS: readonly (readonly [string, string])[] = [
  ['verification.checks', 'the project’s checks'],
  ['verification', 'how work is verified'],
  ['autonomy', 'what agents may do without asking'],
  ['risk', 'how risky each kind of action counts'],
  ['providers', 'the planner’s provider settings'],
  ['master_brain', 'the planner’s settings'],
  ['worktrees', 'how task folders are set up'],
  ['leases', 'how long Friday waits for an agent that went quiet'],
  ['daemon', 'how Friday listens'],
  ['project', 'the project’s name and id'],
  ['operations', 'the operations Friday runs for agents'],
  ['execution', 'what checks and operations may run'],
  ['mcp', 'the connected tool servers'],
  ['routing', 'which model does the work'],
  ['scopes', 'the named scopes'],
  ['reservations', 'keeping agents off the same files'],
];

/** The setting as a person would name it; the key as written when Friday has no name for it. */
export function settingName(key: string): string {
  const exact = NAMES[key];
  if (exact) return exact;
  for (const [prefix, name] of SECTIONS) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return name;
  }
  return truncate(visible(key), 80);
}

/** The names of several settings, each once, in the order given. */
export function settingNames(keys: readonly string[]): string[] {
  return [...new Set(keys.map(settingName))];
}
