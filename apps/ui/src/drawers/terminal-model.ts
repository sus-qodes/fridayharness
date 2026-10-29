/**
 * The terminal drawer's pure parts (plan §7.4, ERRATA F23, F38): which tab it opens on, which lines
 * each tab shows, the text filter, the local clear, and the drawer's height (300–600 px, 320 by
 * default).
 */
import type { LogLine, ToolActivity } from '../store/state.js';
import { cleanText } from '../ui/format.js';

export type TerminalTab = 'combined' | 'tools' | 'errors' | 'process';

const ACTIVITY_TABS: readonly TerminalTab[] = ['combined', 'tools', 'errors'];

/**
 * The tab the drawer opens on (review M9k): the one asked for; else *Errors* after a failure, that
 * is when the newest thing Friday recorded for the agent is an error line, its last tool failed, or
 * its task failed, and there is an error line to show; else *Combined*. The process tab is never
 * the start: it exists only once a launched process is found.
 */
export function startTab(opts: {
  requested?: string | undefined;
  log: readonly LogLine[];
  lastDecision?: ToolActivity['decision'] | null;
  taskFailed?: boolean;
}): Exclude<TerminalTab, 'process'> {
  const asked = opts.requested;
  if (asked && asked !== 'process' && ACTIVITY_TABS.includes(asked as TerminalTab))
    return asked as Exclude<TerminalTab, 'process'>;
  if (!opts.log.some((l) => l.stream === 'error')) return 'combined';
  const newest = opts.log[opts.log.length - 1];
  const failed = newest?.stream === 'error' || opts.lastDecision === 'failed' || opts.taskFailed === true;
  return failed ? 'errors' : 'combined';
}

export const MIN_HEIGHT = 300;
export const MAX_HEIGHT = 600;
export const DEFAULT_HEIGHT = 320;

export function clampHeight(h: unknown): number {
  const n = typeof h === 'number' ? h : Number(h);
  if (!Number.isFinite(n)) return DEFAULT_HEIGHT;
  return Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n)));
}

function matchesFilter(text: string, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  return !f || text.toLowerCase().includes(f);
}

/** The activity lines a tab shows: after the clear, matching the filter. */
export function visibleLines(
  log: readonly LogLine[],
  opts: { tab: Exclude<TerminalTab, 'process'>; filter: string; clearedThrough: number },
): LogLine[] {
  return log.filter((line) => {
    if (line.sequence <= opts.clearedThrough) return false;
    if (opts.tab === 'tools' && line.stream !== 'tool') return false;
    if (opts.tab === 'errors' && line.stream !== 'error') return false;
    return matchesFilter(line.text, opts.filter);
  });
}

/** The sequence a clear hides up to: the newest line now shown. */
export function clearPoint(log: readonly LogLine[], current: number): number {
  return Math.max(current, ...log.map((l) => l.sequence));
}

/**
 * The launched process's output: escape sequences removed, the lines up to the last one shown at
 * the clear hidden (its tail has no ids; the last cleared line is found again by its text).
 */
export function processLines(tail: readonly string[], opts: { filter: string; clearedAt: string | null }): string[] {
  const clean = tail.map((l) => cleanText(l));
  let start = 0;
  if (opts.clearedAt !== null) {
    const i = clean.lastIndexOf(opts.clearedAt);
    if (i >= 0) start = i + 1;
  }
  return clean.slice(start).filter((l) => matchesFilter(l, opts.filter));
}

/** What a clear of the process tab remembers. */
export function processClearPoint(tail: readonly string[]): string | null {
  const last = tail[tail.length - 1];
  return last === undefined ? null : cleanText(last);
}
