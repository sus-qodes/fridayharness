/**
 * The drawers of the Studio (plan §7.4). The shell's drawer host provides the slide-over container
 * (right, 540 px; the terminal at the bottom), `Esc` and the focus trap; each factory returns only
 * the drawer's content and its title.
 */
import type { AppContext } from '../shell/context.js';
import { createCodeGraph } from './code-graph.js';
import { createDiffViewer } from './diff-viewer.js';
import { createMemoryBank } from './memory-bank.js';
import { createTaskInspector } from './task-inspector.js';
import { createTerminal } from './terminal.js';

export function registerDrawers(ctx: AppContext): void {
  ctx.registry.drawer('inspector', createTaskInspector);
  ctx.registry.drawer('diff', createDiffViewer);
  ctx.registry.drawer('graph', createCodeGraph);
  ctx.registry.drawer('memory', createMemoryBank);
  ctx.registry.drawer('terminal', createTerminal);
}

export { createCodeGraph } from './code-graph.js';
export { diffLines, type LineDiff } from './diff.js';
export { type DiffMode, fileNotice, renderFileDiff } from './diff-viewer.js';
export { discrepancies, hasDiscrepancy } from './discrepancy.js';
export { createMemoryBank } from './memory-bank.js';
export { createTaskInspector } from './task-inspector.js';
export { createTerminal } from './terminal.js';
