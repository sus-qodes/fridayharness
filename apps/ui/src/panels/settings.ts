/**
 * What the Settings view (settings-hub.ts) works from: the values a preference takes, a number read
 * from a field, the policy's loosening in either shape the route answers, the terminal steps that
 * make the planner ready, the worktrees in use, and what each desktop shortcut does.
 *
 * This file held the Settings drawer too. The view replaced it, and the drawer stayed registered:
 * every "Open Settings" built it behind the view, hidden, where it read the policy and the
 * shortcuts a second time and took the keyboard's layer. It is gone (2026-11-17); `openDrawer` of
 * kind `settings` opens the view.
 */
import type { BrainStatusView, UiSnapshot } from '@friday/protocol';
import type { PolicyView } from '../api/client.js';
import type { Prefs } from '../store/state.js';

/** Page actions a test replaces (a reload would end the test page). */
export const pageActions = {
  reload(): void {
    location.reload();
  },
};

export const OUTFITS: readonly { value: Prefs['outfit']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'headphones', label: 'Headphones' },
  { value: 'visor', label: 'Visor glasses' },
  { value: 'winter', label: 'Winter hat' },
  { value: 'witch', label: 'Witch hat' },
  { value: 'sunglasses', label: 'Sunglasses' },
];

export const NOTCH_LIMITS = { collapse: { min: 1, max: 120 }, hide: { min: 5, max: 600 } } as const;

/** A number from a field, clamped; null when it is not a number. */
export function clampNumber(text: string, min: number, max: number): number | null {
  const n = Number(text);
  if (!text.trim() || !Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export interface Loosening {
  source: string;
  setting: string;
  from: string;
  to: string;
}

/** The policy's loosening, its hash and whether this clone trusts it, from either shape the route may answer. */
export function readLoosening(view: PolicyView | null | undefined): {
  items: Loosening[];
  hash: string | null;
  trusted: boolean;
} {
  const p = (view?.policy ?? {}) as Record<string, unknown>;
  const raw = p.loosening;
  const item = (v: unknown): Loosening => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === 'string' ? x : x === undefined || x === null ? '' : String(x));
    return { source: s(o.source), setting: s(o.setting), from: s(o.from), to: s(o.to) };
  };
  if (Array.isArray(raw)) {
    return {
      items: raw.map(item),
      hash: typeof p.loosening_hash === 'string' ? p.loosening_hash : null,
      trusted: p.trusted === true,
    };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { items?: unknown; hash?: unknown; trusted?: unknown };
    return {
      items: Array.isArray(o.items) ? o.items.map(item) : [],
      hash: typeof o.hash === 'string' ? o.hash : null,
      trusted: o.trusted === true,
    };
  }
  return { items: [], hash: null, trusted: p.trusted === true };
}

/** The terminal steps that make the planner ready (FD-26: never in the page). */
export function plannerSteps(
  brain: BrainStatusView | null | undefined,
  budget: number,
): { text: string; command?: string }[] {
  // A model on this machine needs no key and no budget: its server and model (plan M12.1).
  if (brain?.provider === 'local') {
    return [
      {
        text: 'Start the model server on this machine (Ollama or LM Studio) with the model master_brain.model names, and check it:',
        command: 'friday doctor',
      },
    ];
  }
  const steps: { text: string; command?: string }[] = [];
  if (!brain?.remote || brain.key === 'missing')
    steps.push({
      text: 'Store your Anthropic API key (the terminal asks for it; it never passes through this page):',
      command: 'friday secrets set anthropic',
    });
  if (!brain?.approved_here)
    steps.push({
      text: 'Allow this clone to spend, with a daily budget in dollars:',
      command: `friday brain allow-remote --budget ${budget}`,
    });
  if (!brain?.allow_remote)
    steps.push({
      text: 'In .friday/config.yaml set providers.anthropic.allow_remote: true (the project asks for remote planning).',
    });
  steps.push({ text: 'Restart Friday: it reads its configuration when it starts.' });
  return steps;
}

const LIVE_RUN = new Set(['STARTING', 'ACTIVE', 'SUSPENDED']);

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Worktrees in use by running attempts: live runs whose workspace is ready and lies outside the main
 * checkout, counted once per folder (plan §7.3 header metrics, ERRATA F37). The one rule for the
 * number: the header showed it before M9k and no longer counts it; Settings → Friday and About do,
 * beside the one action on worktrees.
 */
export function worktreesInUse(board: UiSnapshot | null | undefined): number {
  if (!board) return 0;
  const root = normalizePath(board.project.root ?? '');
  const roots = new Set<string>();
  for (const run of Object.values(board.runs ?? {})) {
    if (!run || !LIVE_RUN.has(run.status) || run.workspace !== 'ready' || !run.execution_root) continue;
    const r = normalizePath(run.execution_root);
    if (r && r !== root) roots.add(r);
  }
  return roots.size;
}

/** What each desktop shortcut does (the shell's ids, FD-16). */
export const SHORTCUT_LABELS: Record<string, string> = {
  notch: 'Open the Notch and give it the keyboard',
  studio: 'Show the Studio',
  halt: 'Open the halt dialog',
};
