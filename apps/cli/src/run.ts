import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeEnvironment, detectClaudeCode } from '@friday/adapter-claude';
import type { Daemon, DaemonOptions } from '@friday/daemon';

/** The interface's built bundle, next to the CLI in the repository (plan M9 FD-04). */
export function uiBundleDir(): string | undefined {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'dist');
  return existsSync(path.join(dir, 'index.html')) ? dir : undefined;
}

/** Hooks M1c adds to every daemon started by `friday run` (Claude Code hook routes, verification runner). */
export const daemonPlugins: { extensions: NonNullable<DaemonOptions['extensions']>; verify?: DaemonOptions['verify'] } =
  {
    extensions: [],
  };

export interface RunOptions {
  project?: string;
  port?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/** Starts the daemon in this process and keeps it running until a signal or `friday daemon stop`. */
export async function runDaemon(opts: RunOptions): Promise<void> {
  const { createDaemon } = await import('@friday/daemon');
  // The installed Claude Code, for a Master Brain that plans through it (`master_brain.provider:
  // claude-code`): found as the spawn adapter finds it, run with the environment a spawned
  // session gets (the user's login, nothing of a parent session).
  const claude = detectClaudeCode();
  let daemon: Daemon;
  daemon = await createDaemon({
    projectRoot: opts.project ?? process.cwd(),
    logToConsole: true,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
    ...(claude ? { brain: { claudeCode: { command: claude.binary, env: claudeEnvironment() } } } : {}),
    extensions: daemonPlugins.extensions,
    ...(uiBundleDir() ? { uiDir: uiBundleDir() as string } : {}),
    ...(daemonPlugins.verify ? { verify: daemonPlugins.verify } : {}),
  });
  process.stdout.write(`FRIDAY_READY ${JSON.stringify({ port: daemon.port(), url: daemon.url })}\n`);
  process.stdout.write(
    `Friday daemon for "${daemon.project.name}" is listening on ${daemon.url}\n` +
      `Open the interface: friday ui   (or ${daemon.url}/ui)\n` +
      'Press Ctrl+C to stop.\n',
  );
  const stop = (signal: string) => {
    process.stdout.write(`\nStopping (${signal})...\n`);
    void daemon.close(signal);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    if (process.platform !== 'win32' && sig === 'SIGBREAK') continue;
    process.once(sig, () => stop(sig));
  }
  await daemon.closed;
  process.stdout.write('Friday daemon stopped.\n');
}
