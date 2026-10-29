/**
 * How Gemini CLI runs a hook command (0.64.0, `hookRunner.ts` and `shell-utils.ts`), so the doctor
 * can run Friday's command exactly as the host would on this machine, before any session does.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface HookShell {
  executable: string;
  args: string[];
  kind: 'powershell' | 'bash';
}

/**
 * The shell Gemini CLI runs hook commands in: on Windows the `ComSpec` shell when it is
 * PowerShell, else `pwsh.exe` from `PATH`, else Windows PowerShell 5.1; `bash -c` elsewhere.
 */
export function hookShell(env: NodeJS.ProcessEnv = process.env): HookShell {
  if (process.platform !== 'win32') return { executable: 'bash', args: ['-c'], kind: 'bash' };
  const ps = ['-NoProfile', '-NonInteractive', '-Command'];
  const comSpec = env.ComSpec ?? env.COMSPEC;
  if (comSpec && /(powershell|pwsh)\.exe$/i.test(comSpec)) return { executable: comSpec, args: ps, kind: 'powershell' };
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const pwsh = path.join(dir, 'pwsh.exe');
    if (existsSync(pwsh)) return { executable: pwsh, args: ['-NoProfile', '-Command'], kind: 'powershell' };
  }
  return { executable: 'powershell.exe', args: ps, kind: 'powershell' };
}

/** A value as the host quotes it into a command for its shell. */
export function hostQuote(value: string, kind: HookShell['kind']): string {
  if (!value) return '';
  if (/^[a-zA-Z0-9\-_.]+$/.test(value)) return value;
  return kind === 'powershell' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The command line the host's shell is given: the project and session variables replaced with
 * quoted values, and, for PowerShell, the line the host appends to pass on the exit code.
 */
export function hostCommandLine(command: string, cwd: string, sessionId: string, kind: HookShell['kind']): string {
  const dir = hostQuote(cwd, kind);
  const expanded = command
    .replace(/\$GEMINI_PROJECT_DIR/g, () => dir)
    .replace(/\$GEMINI_CWD/g, () => dir)
    .replace(/\$GEMINI_SESSION_ID/g, () => hostQuote(sessionId, kind))
    .replace(/\$CLAUDE_PROJECT_DIR/g, () => dir);
  return kind === 'powershell' ? `${expanded}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` : expanded;
}

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** What the host would read: stdout, else stderr, as JSON. */
  json: Record<string, unknown> | null;
  error: string | null;
}

/** Runs a hook command as the host does: through its shell, in `cwd`, the input on standard input. */
export function runHookCommand(
  command: string,
  input: Record<string, unknown>,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; shell?: HookShell },
): Promise<HookRun> {
  const shell = opts.shell ?? hookShell(opts.env);
  const line = hostCommandLine(command, opts.cwd, String(input.session_id ?? ''), shell.kind);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: Omit<HookRun, 'stdout' | 'stderr' | 'json'>) => {
      if (done) return;
      done = true;
      const text = stdout.trim() || stderr.trim();
      let json: Record<string, unknown> | null = null;
      try {
        const v = text ? (JSON.parse(text) as unknown) : null;
        json = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      resolve({ ...r, stdout, stderr, json });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.executable, [...shell.args, line], {
        cwd: opts.cwd,
        env: {
          ...opts.env,
          GEMINI_PROJECT_DIR: opts.cwd,
          GEMINI_CWD: opts.cwd,
          GEMINI_SESSION_ID: String(input.session_id ?? ''),
          CLAUDE_PROJECT_DIR: opts.cwd,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      finish({ code: null, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, error: `no answer within ${opts.timeoutMs} ms` });
    }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ code: null, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, error: null });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify(input));
  });
}
