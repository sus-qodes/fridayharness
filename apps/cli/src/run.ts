import type { Daemon, DaemonOptions } from '@friday/daemon';

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
  let daemon: Daemon;
  daemon = await createDaemon({
    projectRoot: opts.project ?? process.cwd(),
    logToConsole: true,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
    extensions: daemonPlugins.extensions,
    ...(daemonPlugins.verify ? { verify: daemonPlugins.verify } : {}),
  });
  process.stdout.write(`FRIDAY_READY ${JSON.stringify({ port: daemon.port(), url: daemon.url })}\n`);
  process.stdout.write(
    `Friday daemon for "${daemon.project.name}" is listening on ${daemon.url}\n` +
      `Status page: ${daemon.url}/ui   (token: friday ui --token)\n` +
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
