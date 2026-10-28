import { FridayError } from '@friday/protocol';
import { DaemonClient, DaemonUnreachableError, loadProject, type ProjectRef } from '@friday/sdk';

export interface GlobalOptions {
  project?: string;
  json?: boolean;
}

export function project(opts: GlobalOptions): ProjectRef {
  return loadProject(opts.project);
}

export function operator(opts: GlobalOptions): { ref: ProjectRef; client: DaemonClient } {
  const ref = project(opts);
  return { ref, client: DaemonClient.forProject(ref, 'operator', { clientName: 'friday-cli' }) };
}

export class UsageError extends Error {}

/** Maps errors to the exit codes of plan M1.6 and prints a short message. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) {
    process.stderr.write(`friday: ${err.message}\n`);
    return 2;
  }
  if (err instanceof DaemonUnreachableError) {
    process.stderr.write(`friday: ${err.message}\n`);
    return 3;
  }
  if (err instanceof FridayError) {
    process.stderr.write(`friday: ${err.code} ${err.message}\n`);
    const issues = (err.details as { issues?: { path: string; message: string }[] } | undefined)?.issues;
    for (const i of issues ?? []) process.stderr.write(`  ${i.path || '(body)'}: ${i.message}\n`);
    return 4;
  }
  process.stderr.write(`friday: ${(err as Error)?.message ?? String(err)}\n`);
  return 1;
}

export function out(opts: GlobalOptions, value: unknown, human: () => string): void {
  process.stdout.write(`${opts.json ? JSON.stringify(value, null, 2) : human()}\n`);
}
