import type { GraphSetupStep } from '@friday/daemon';

/**
 * The one-time setup `friday init` and a first `friday start` run: the code graph, built now so
 * the Studio and the first agent start from a ready one. The daemon is imported only here, so the
 * other commands keep their start-up cost.
 */
export const SETUP_HEADING = 'Setting up your project';

export async function buildGraphAtInit(projectRoot: string, print: boolean): Promise<GraphSetupStep> {
  const { buildProjectGraph } = await import('@friday/daemon');
  if (print) process.stdout.write(`${SETUP_HEADING}\n`);
  return buildProjectGraph({
    projectRoot,
    ...(print ? { onLine: (line: string) => process.stdout.write(`  ${line}\n`) } : {}),
  });
}

/** One line for the summary `friday init` prints after the setup. */
export function graphSummaryLine(step: GraphSetupStep | null): string {
  if (!step) return '  code graph: not built now (--no-graph); it is built the first time something needs it';
  const s = step.stats;
  switch (step.status) {
    case 'done':
      return s
        ? `  code graph: ready (${s.files.toLocaleString('en-US')} files, ${s.symbols.toLocaleString('en-US')} symbols); it follows your changes from here`
        : '  code graph: ready; it follows your changes from here';
    case 'skipped':
      return `  code graph: not built yet (${step.reason}); it is built once the repository has git`;
    default:
      return `  code graph: not built (${step.reason}); it is built the first time something needs it`;
  }
}
