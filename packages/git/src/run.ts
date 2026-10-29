import { spawn } from 'node:child_process';
import { FridayError } from '@friday/protocol';

export interface RunOptions {
  /** Default 15 s. */
  timeoutMs?: number;
  /** Default 64 MB. */
  maxBytes?: number;
  /** Written to stdin, then closed. */
  input?: string;
  /** Exit codes that are answers, not failures (for example 1 from `rev-parse --verify --quiet`). */
  okCodes?: number[];
  /** Extra environment (a commit identity, for example). */
  env?: Record<string, string>;
  /** Also keep stdout as raw bytes (`bytes`): content that may not be UTF-8. */
  raw?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Stdout as bytes, with `raw`. */
  bytes?: Buffer;
}

/**
 * Runs git in `root` without a shell (ADR-0019 §1). Reading never takes git's optional locks,
 * so an agent's own `git add` or `git commit` in the same checkout is never blocked by Friday.
 */
export function runGit(root: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  const full = ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-C', root, ...args];
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', full, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...opts.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      });
    } catch (e) {
      reject(new FridayError('context_unavailable', `git could not be started: ${(e as Error).message}`));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new FridayError('context_unavailable', `git ${args[0]} took longer than ${timeoutMs} ms in ${root}`)),
      );
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > maxBytes) {
        child.kill();
        finish(() =>
          reject(new FridayError('context_unavailable', `git ${args[0]} produced more than ${maxBytes} bytes`)),
        );
        return;
      }
      out.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new FridayError(
            'context_unavailable',
            e.code === 'ENOENT' ? 'git is not installed or not on PATH' : `git failed to start: ${e.message}`,
          ),
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => {
        const bytes = Buffer.concat(out);
        const result: RunResult = {
          code: code ?? -1,
          stdout: opts.raw ? '' : bytes.toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          ...(opts.raw ? { bytes } : {}),
        };
        if (result.code === 0 || opts.okCodes?.includes(result.code)) resolve(result);
        else reject(gitError(root, args, result));
      }),
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function gitError(root: string, args: string[], r: RunResult): FridayError {
  const msg = r.stderr.trim().split('\n')[0] ?? '';
  if (/not a git repository/i.test(r.stderr)) {
    return new FridayError('invalid_request', `${root} is not inside a git repository`);
  }
  return new FridayError('context_unavailable', `git ${args.join(' ')} failed (${r.code}): ${msg}`, {
    exit_code: r.code,
  });
}
