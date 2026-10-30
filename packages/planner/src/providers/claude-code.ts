import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairPrompt } from '../prompts.js';
import { type Effort, structuredOutputSchema, wrapProjectContext } from './anthropic.js';
import { ModelError, type ModelRequest, type ModelResponse, type ModelUsage, type PlannerModel } from './types.js';

/**
 * The Master Brain through the installed Claude Code, headless (ADR-0013 extended): one `claude -p`
 * run per request, with Friday's rules as the session's system prompt, the repository's context and
 * the request on its standard input, and the answer as structured output against the plan schema.
 * The session has no tools, no MCP servers, no settings of the user's or the repository's, and runs
 * in a folder of its own, so it can only answer. It signs in as Claude Code does on this machine:
 * with the user's API key or their subscription token, which is why this provider exists: a
 * subscription cannot call the API directly. Requests leave the machine, so consent and the daily
 * budget apply as for `anthropic`; the cost is priced from the usage Claude Code reports.
 */
export interface ClaudeCodePlannerOptions {
  /** The Claude Code program: a path, or `claude` on PATH. */
  command: string;
  /** Arguments before Friday's own (a scripted host in tests). */
  args?: readonly string[];
  /** The environment the program runs with (`claudeEnvironment()` of the Claude adapter: the user's login, nothing of a parent session). */
  env?: NodeJS.ProcessEnv;
  /** Reasoning effort; the host's default otherwise. Read at each call. */
  effort?: () => Effort | undefined;
  /** A plan takes minutes at most: default 10 minutes. */
  timeoutMs?: number;
  /** Injected in tests; `node:child_process`'s otherwise. */
  spawn?: typeof nodeSpawn;
  /** Where each run's folder is made (default: the system temp folder). */
  tmpDir?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** The most of an answer Friday reads: a plan is tens of kilobytes. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** The result object `claude -p --output-format json` prints last. */
interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  usage?: Partial<Record<keyof ModelUsage, unknown>>;
  modelUsage?: Record<string, unknown>;
  session_id?: string;
  stop_reason?: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Usage as Claude Code reports it: the same four counters as the API. */
export function usageFromClaude(u: ClaudeResult['usage']): ModelUsage {
  return {
    input_tokens: num(u?.input_tokens),
    output_tokens: num(u?.output_tokens),
    cache_creation_input_tokens: num(u?.cache_creation_input_tokens),
    cache_read_input_tokens: num(u?.cache_read_input_tokens),
  };
}

/** The last JSON object on the output: Claude Code prints one result; anything before it is noise. */
function lastJsonObject(text: string): ClaudeResult | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as ClaudeResult;
  } catch {
    // several lines: the last that parses
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as ClaudeResult;
    } catch {
      // not this one
    }
  }
  return null;
}

/** What Claude Code said when it could not serve the request, classified as the API's errors are. */
function classifyFailure(text: string, exitCode: number | null): ModelError {
  const said = text.trim().slice(-500) || `exit code ${exitCode ?? '?'}`;
  const lower = said.toLowerCase();
  if (/not logged in|please run \/login|oauth|authentication_error|invalid api key|401|403/.test(lower)) {
    return new ModelError(
      'auth',
      `Claude Code is not signed in for the Master Brain: ${said}; sign in once with "claude", or set CLAUDE_CODE_OAUTH_TOKEN (from "claude setup-token") or ANTHROPIC_API_KEY where Friday runs`,
      false,
      undefined,
      { billed: 'no' },
    );
  }
  if (/rate limit|429|usage limit|out of extra usage/.test(lower)) {
    return new ModelError('rate_limited', `Claude Code is rate limited: ${said}`, true, 429, { billed: 'no' });
  }
  if (/overloaded|529/.test(lower)) {
    return new ModelError('overloaded', `the API is overloaded: ${said}`, true, 529, { billed: 'no' });
  }
  return new ModelError('unavailable', `Claude Code could not answer: ${said}`, false, undefined, {
    billed: 'unknown',
  });
}

export class ClaudeCodePlannerModel implements PlannerModel {
  readonly provider = 'claude-code';
  readonly remote = true;
  readonly #opts: ClaudeCodePlannerOptions;

  constructor(opts: ClaudeCodePlannerOptions) {
    if (!opts.command.trim())
      throw new ModelError('unavailable', 'no Claude Code program to run the Master Brain with');
    this.#opts = opts;
  }

  /** The command line of one request: Friday's rules and instructions as the system prompt; nothing else the session could do. */
  args(req: ModelRequest): string[] {
    const effort = this.#opts.effort?.();
    return [
      ...(this.#opts.args ?? []),
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(structuredOutputSchema(req.schema)),
      '--system-prompt',
      `${req.system}\n\n${req.instructions}`,
      // No tools, no servers, no settings of the user's or the repository's: the session answers.
      '--restricted',
      '--tools',
      '',
      '--strict-mcp-config',
      '--permission-prompts',
      'none',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--model',
      req.model,
      ...(effort ? ['--effort', effort] : []),
    ];
  }

  /** What the session reads: the repository's text as marked source material, then the request. */
  input(req: ModelRequest): string {
    const parts = [
      wrapProjectContext(req.context),
      ...(req.status ? [wrapProjectContext(req.status)] : []),
      req.prompt,
    ];
    if (req.repair) parts.push(`Your previous answer was:\n${req.repair.previous}`, repairPrompt(req.repair.errors));
    return `${parts.join('\n\n')}\n`;
  }

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const timeoutMs = this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const dir = mkdtempSync(path.join(this.#opts.tmpDir ?? os.tmpdir(), 'friday-brain-'));
    const spawn = this.#opts.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawn(this.#opts.command, this.args(req), {
        cwd: dir,
        env: this.#opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw new ModelError('unavailable', `Claude Code could not start: ${(e as Error).message}`, false, undefined, {
        billed: 'no',
      });
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUTPUT_BYTES) {
        tooLarge = true;
        child.kill();
        return;
      }
      out.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (err.reduce((n, x) => n + x.length, 0) < 64 * 1024) err.push(b);
    });
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.once('error', (error) => resolve({ code: null, error }));
        child.once('close', (code) => resolve({ code }));
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(this.input(req));
      });
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (exit.error) {
        throw new ModelError('unavailable', `Claude Code could not start: ${exit.error.message}`, false, undefined, {
          billed: 'no',
        });
      }
      if (cancelled)
        throw new ModelError('timeout', 'the request was cancelled', false, undefined, { billed: 'unknown' });
      if (timedOut) {
        throw new ModelError(
          'timeout',
          `Claude Code did not answer within ${Math.round(timeoutMs / 60_000)} minutes`,
          true,
          undefined,
          { billed: 'unknown' },
        );
      }
      if (tooLarge) {
        throw new ModelError('no_output', `the answer was larger than ${MAX_OUTPUT_BYTES} bytes`, false, undefined, {
          billed: 'yes',
        });
      }
      const result = lastJsonObject(stdout);
      if (exit.code !== 0 && !result) throw classifyFailure(stderr || stdout, exit.code);
      if (!result) {
        throw new ModelError('no_output', 'Claude Code printed no result object', false, undefined, {
          billed: 'unknown',
        });
      }
      const usage = usageFromClaude(result.usage);
      const model = Object.keys(result.modelUsage ?? {})[0] ?? req.model;
      const extra = { usage, model, requestId: result.session_id ?? null, billed: 'yes' as const };
      if (result.is_error === true && result.subtype !== 'error_max_structured_output_retries') {
        const said = typeof result.result === 'string' ? result.result : (result.subtype ?? 'error');
        const failure = classifyFailure(said, exit.code);
        throw new ModelError(failure.code, failure.message, failure.retryable, failure.status, extra);
      }
      // The structured answer; else the text, parsed when it is JSON (a text that is not a plan
      // fails validation and earns the repair attempt, like any other provider's).
      let output: unknown = result.structured_output;
      if (output === undefined) {
        const text = typeof result.result === 'string' ? result.result : '';
        if (!text.trim()) {
          throw new ModelError(
            'no_output',
            `Claude Code returned no answer (${result.subtype ?? 'no subtype'})`,
            false,
            undefined,
            extra,
          );
        }
        try {
          output = JSON.parse(text);
        } catch {
          output = text;
        }
      }
      return {
        output,
        model,
        usage,
        stop_reason: result.stop_reason ?? 'end_turn',
        request_id: result.session_id ?? null,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
