/**
 * The core palette commands (plan §7.6, ERRATA F22). Areas add their own (`fit`, `zoom-in`, …)
 * through the same registry. Each command is hidden while it would do nothing (`available`), and
 * the housekeeping ones (reindex, prune, stop) are offered only when typed, so the empty list holds
 * the daily commands alone (the product review of 2026-10-17, §4 "Advanced").
 */
import { visible } from '../model/text.js';
import { type AppContext, type Command, openDrawer, openModal, type Toast } from '../shell/context.js';
import { cleanText, plural, truncate } from '../ui/format.js';
import { isConnected, isPaused, openHalt, pauseFriday, resumeFriday, setMuted } from './actions.js';

export const CORE_COMMAND_IDS = [
  'pause',
  'resume',
  'halt',
  'new-goal',
  'agents',
  'memory',
  'graph',
  'reindex-graph',
  'prune-worktrees',
  'settings',
  'mute',
  'unmute',
  'stop-friday',
  'inbox',
] as const;

export type CoreCommandId = (typeof CORE_COMMAND_IDS)[number];

/** At most this many paths are listed in the prune toast; the rest are counted. */
export const PRUNE_LIST_MAX = 8;

/** The toast after `worktrees/prune`: what was removed, and what was kept with its reason. */
export function pruneToast(result: { removed: string[]; kept: { path: string; reason: string }[] }): Toast {
  const removed = result.removed ?? [];
  const kept = result.kept ?? [];
  if (removed.length === 0 && kept.length === 0) {
    return { kind: 'info', text: 'No released worktree to prune' };
  }
  const lines: string[] = [];
  for (const p of removed.slice(0, PRUNE_LIST_MAX)) lines.push(`Removed ${visible(p)}`);
  if (removed.length > PRUNE_LIST_MAX) lines.push(`… and ${removed.length - PRUNE_LIST_MAX} more removed`);
  for (const k of kept.slice(0, PRUNE_LIST_MAX)) {
    lines.push(`Kept ${visible(k.path)}: ${truncate(cleanText(k.reason || 'no reason given'), 200)}`);
  }
  if (kept.length > PRUNE_LIST_MAX) lines.push(`… and ${kept.length - PRUNE_LIST_MAX} more kept`);
  return {
    kind: removed.length > 0 ? 'success' : 'info',
    text: `Removed ${plural(removed.length, 'clean worktree')}; kept ${kept.length}`,
    detail: lines.join('\n'),
    // Kept worktrees hold uncommitted work: the reasons stay until dismissed.
    timeoutMs: kept.length > 0 ? 0 : 8000,
  };
}

export async function reindexGraph(ctx: AppContext): Promise<void> {
  if (ctx.store.select('ui').indexing) return;
  ctx.store.patch('ui', { indexing: true });
  try {
    await ctx.act('Reindex the code graph', () => ctx.api.graphReindex(), 'The code graph is up to date');
  } finally {
    ctx.store.patch('ui', { indexing: false });
  }
}

export async function pruneWorktrees(ctx: AppContext): Promise<void> {
  const r = await ctx.act('Prune clean worktrees', () => ctx.api.pruneWorktrees());
  if (r) ctx.toast(pruneToast(r));
}

export const STOP_FRIDAY_BODY = [
  'Friday stops for this project. Agents it started disconnect; their work stays in their worktrees.',
  'This page cannot reach Friday until you open it again from its shortcut or the desktop app.',
];

export async function stopFriday(ctx: AppContext): Promise<void> {
  const ok = await ctx.confirm({
    title: 'Stop Friday?',
    body: STOP_FRIDAY_BODY,
    confirmLabel: 'Stop Friday',
    danger: true,
  });
  if (!ok) return;
  await ctx.act('Stop Friday', () => ctx.api.stopDaemon(), 'Friday is stopping');
}

export function coreCommands(): Command[] {
  return [
    {
      id: 'pause',
      label: 'Pause Friday',
      keywords: ['hold', 'freeze', 'pause all'],
      available: (c) => isConnected(c) && !isPaused(c),
      run: async (c) => {
        await pauseFriday(c);
      },
    },
    {
      id: 'resume',
      label: 'Resume Friday',
      keywords: ['continue', 'unpause', 'run again'],
      available: (c) => isPaused(c),
      run: async (c) => {
        await resumeFriday(c);
      },
    },
    {
      id: 'halt',
      label: 'Halt Friday…',
      keywords: ['emergency', 'abort', 'stop all', 'kill switch'],
      available: (c) => isConnected(c),
      run: (c) => openHalt(c),
    },
    {
      id: 'new-goal',
      label: 'New goal…',
      keywords: ['create goal', 'add', 'request'],
      available: (c) => isConnected(c),
      run: (c) => openModal(c, { kind: 'new-goal' }),
    },
    {
      id: 'agents',
      label: 'Agents',
      keywords: ['start agent', 'claude code', 'codex', 'processes', 'routing'],
      run: (c) => openDrawer(c, { kind: 'agents' }),
    },
    {
      id: 'memory',
      // One drawer, one name: the drawer's own title (the review's rename; "memory bank" stays a keyword).
      label: 'Project memory',
      keywords: ['memories', 'decisions', 'knowledge', 'memory bank'],
      run: (c) => openDrawer(c, { kind: 'memory' }),
    },
    {
      id: 'graph',
      label: 'Code graph',
      keywords: ['dependencies', 'imports', 'consumers'],
      run: (c) => openDrawer(c, { kind: 'graph' }),
    },
    {
      id: 'reindex-graph',
      label: 'Reindex the code graph',
      keywords: ['rebuild graph', 'recompile', 'index'],
      available: (c) => isConnected(c) && !c.store.select('ui').indexing,
      show: 'typed',
      run: (c) => reindexGraph(c),
    },
    {
      id: 'prune-worktrees',
      label: 'Prune clean worktrees',
      keywords: ['clean worktrees', 'remove worktrees', 'tidy'],
      available: (c) => isConnected(c),
      show: 'typed',
      run: (c) => pruneWorktrees(c),
    },
    {
      id: 'settings',
      label: 'Settings',
      keywords: ['preferences', 'planner', 'shortcuts', 'policy', 'sound'],
      run: (c) => openDrawer(c, { kind: 'settings' }),
    },
    {
      id: 'mute',
      label: 'Mute sounds',
      keywords: ['sound off', 'quiet', 'audio'],
      available: (c) => !c.store.select('prefs').muted,
      run: (c) => setMuted(c, true),
    },
    {
      id: 'unmute',
      label: 'Unmute sounds',
      keywords: ['sound on', 'audio'],
      available: (c) => c.store.select('prefs').muted,
      run: (c) => setMuted(c, false),
    },
    {
      id: 'stop-friday',
      label: 'Stop Friday…',
      keywords: ['shut down', 'quit', 'exit daemon'],
      available: (c) => isConnected(c),
      show: 'typed',
      run: (c) => stopFriday(c),
    },
    {
      id: 'inbox',
      // The header's word (the review's rename; "inbox" stays a keyword).
      label: 'Messages',
      keywords: ['inbox', 'notifications', 'replies'],
      run: (c) => openDrawer(c, { kind: 'inbox' }),
    },
  ];
}

/** Registers the core commands (plan §7.6). */
export function registerCommands(ctx: AppContext): void {
  for (const c of coreCommands()) ctx.registry.command(c);
}
