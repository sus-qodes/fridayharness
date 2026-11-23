import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairPrompt } from '../prompts.js';
import { type Effort, structuredOutputSchema, wrapProjectContext } from './anthropic.js';
import { jsonModeInstructions } from './openai-compatible.js';
import {
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type PlannerModel,
  ZERO_USAGE,
} from './types.js';

/**
 * The Master Brain through the installed Codex, headless (2026-11-23): one `codex exec` run per
 * request, for a person who has Codex and no Claude. Until then only Claude could write a plan.
 *
 * The run can only answer: its command tools are off, it loads nothing of the user's or the
 * repository's settings (no MCP servers, no rules, no AGENTS.md), its sandbox is read-only, it
 * keeps no session, and it runs in a folder of its own that holds nothing but the answer's schema.
 * It signs in as Codex does on this machine (a ChatGPT account or a key in `CODEX_HOME`). Requests
 * leave the machine, so consent applies as for every remote planner. Codex reports tokens and no
 * price, and Friday guesses none: such a planner is held to a number of calls a day (`runPlanner`).
 */
export interface CodexPlannerOptions {
  /** The Codex program: a path, or `codex` on PATH. */
  command: string;
  /** Arguments before Friday's own (a scripted host in tests; a script the program runs). */
  args?: readonly string[];
  /** The environment the program runs with (`hostEnvironment()` of the Codex adapter: the user's login, none of Friday's). */
  env?: NodeJS.ProcessEnv;
  /** Reasoning effort; Codex's own default otherwise. Read at each call. */
  effort?: () => Effort | undefined;
  /** A plan takes minutes at most: default 10 minutes. */
  timeoutMs?: number;
  /** Injected in tests; `node:child_process`'s otherwise. */
  spawn?: typeof nodeSpawn;
  /** Where each run's folder is made (default: the system temp folder). */
  tmpDir?: string;
}

/** `model: auto` for Codex: no model is named, and Codex uses the one its account defaults to. */
export const CODEX_DEFAULT_MODEL = 'auto';
/** What Friday records as the model when Codex chose it and did not say which. */
export const CODEX_UNNAMED_MODEL = 'codex-default';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** The most of an answer Friday reads: a plan is tens of kilobytes. */
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
/** Codex's events are read line by line; one longer than this is not one of the few Friday reads. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** The features of Codex that could act on the machine or reach elsewhere: all off for a planning run. */
export const CODEX_PLANNER_OFF = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'hooks',
  'memories',
] as const;

/** Friday's effort names in Codex's (`model_reasoning_effort`), which has no `max`. */
const EFFORT: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A JSON Schema in the strict form OpenAI's structured answers take: every object closed, and
 * every property required. A property the schema left optional is offered as "this, or null", and
 * `dropNullOptionals` takes those nulls out of the answer again, so Friday's own validation sees
 * the same shape as from any other planner.
 */
export function strictOutputSchema(schema: unknown): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = {};
    // A `properties` map holds schemas by name, not a schema itself: its entries are walked below.
    for (const [k, v] of Object.entries(node)) out[k] = k === 'properties' ? v : walk(v);
    if (isObject(out.properties)) {
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(out.properties)) {
        const strict = walk(sub);
        props[name] = required.has(name) || allowsNull(strict) ? strict : { anyOf: [strict, { type: 'null' }] };
      }
      out.properties = props;
      out.required = Object.keys(props);
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(structuredOutputSchema(schema));
}

function allowsNull(schema: unknown): boolean {
  if (!isObject(schema)) return false;
  if (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null'))) return true;
  return [schema.anyOf, schema.oneOf].some((alts) => Array.isArray(alts) && alts.some(allowsNull));
}

/** The first branch of a schema that describes an object or an array (through `anyOf`/`oneOf`). */
function shapeOf(schema: unknown): Record<string, unknown> | null {
  if (!isObject(schema)) return null;
  if (isObject(schema.properties) || schema.items !== undefined) return schema;
  for (const alts of [schema.anyOf, schema.oneOf]) {
    if (!Array.isArray(alts)) continue;
    for (const alt of alts) {
      const found = shapeOf(alt);
      if (found) return found;
    }
  }
  return null;
}

/**
 * An answer to `strictOutputSchema(schema)` as the original `schema` means it: a null under a
 * property the original left optional (and did not itself allow to be null) is left out.
 */
export function dropNullOptionals(value: unknown, schema: unknown): unknown {
  const shape = shapeOf(schema);
  if (Array.isArray(value)) return value.map((v) => dropNullOptionals(v, shape?.items));
  if (!isObject(value)) return value;
  const props = isObject(shape?.properties) ? shape.properties : {};
  const required = new Set(Array.isArray(shape?.required) ? (shape.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const sub = props[k];
    if (v === null && sub !== undefined && !required.has(k) && !allowsNull(sub)) continue;
    out[k] = dropNullOptionals(v, sub);
  }
  return out;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Usage as Codex reports it (`turn.completed`): `input_tokens` counts the whole prompt, and
 * `cached_input_tokens` the part of it read from the cache.
 */
export function usageFromCodex(u: unknown): ModelUsage {
  const o = isObject(u) ? u : {};
  const cached = num(o.cached_input_tokens);
  return {
    input_tokens: Math.max(0, num(o.input_tokens) - cached),
    output_tokens: num(o.output_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

/** A small model may wrap its JSON in a code fence; the object inside is what counts. */
function unfence(text: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return m?.[1] ?? text;
}

/** What Codex said when it could not serve the request, classified as the API's errors are. */
export function classifyCodexFailure(text: string, exitCode: number | null): ModelError {
  const said = text.trim().slice(-500) || `exit code ${exitCode ?? '?'}`;
  const lower = said.toLowerCase();
  if (
    /not (?:logged|signed) in|please (?:log|sign) in|codex login|login required|unauthorized|invalid api key|\b401\b|\b403\b/.test(
      lower,
    )
  ) {
    return new ModelError('auth', `Codex is not signed in for planning: ${said}`, false, undefined, { billed: 'no' });
  }
  if (/usage limit|rate limit|too many requests|\b429\b|quota|try again (?:later|in)/.test(lower)) {
    return new ModelError('rate_limited', `Codex has reached a limit of its account: ${said}`, true, 429, {
      billed: 'no',
    });
  }
  if (/overloaded|at capacity|\b529\b|\b503\b/.test(lower)) {
    return new ModelError('overloaded', `Codex's service is overloaded: ${said}`, true, 529, { billed: 'no' });
  }
  if (
    /model.{0,80}(?:not supported|not available|not found|does not exist)|unsupported model|unknown model/.test(lower)
  ) {
    return new ModelError('bad_request', `Codex cannot use this model on your account: ${said}`, false, 400, {
      billed: 'no',
    });
  }
  return new ModelError('unavailable', `Codex could not answer: ${said}`, false, undefined, { billed: 'unknown' });
}

/** Whether a failure is the service refusing the answer's schema: the request is then sent without one. */
function schemaRefused(text: string): boolean {
  return /invalid schema|json_schema|response_format|text\.format|output[_ ]schema/i.test(text);
}

interface RunResult {
  exitCode: number | null;
  /** The answer file's text, else the last message Codex's events carried. */
  answer: string;
  usage: ModelUsage | null;
  model: string | null;
  threadId: string | null;
  /** What Codex's own events said went wrong, newest last. */
  errors: string[];
  stderr: string;
}

export class CodexPlannerModel implements PlannerModel {
  readonly provider = 'codex';
  readonly remote = true;
  /** Codex reports no price: the planner is held to calls a day, not dollars (`runPlanner`). */
  readonly unpriced = true;
  readonly #opts: CodexPlannerOptions;
  /** Whether the service took the schema; unknown until the first answer. Refused once, it is not sent again. */
  #schema: boolean | undefined;

  constructor(opts: CodexPlannerOptions) {
    if (!opts.command.trim()) throw new ModelError('unavailable', 'no Codex program to plan with');
    this.#opts = opts;
  }

  /** What the last answer taught about the schema; for tests and status. */
  get schemaSupported(): boolean | undefined {
    return this.#schema;
  }

  /** The command line of one request; the request itself goes to standard input. */
  args(req: ModelRequest, dir: string, withSchema: boolean): string[] {
    const effort = this.#opts.effort?.();
    return [
      ...(this.#opts.args ?? []),
      'exec',
      // Nothing of the user's or the repository's: no MCP servers, no rules, no session kept.
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      ...CODEX_PLANNER_OFF.flatMap((f) => ['--disable', f]),
      '-c',
      'web_search="disabled"',
      // No AGENTS.md of the user's own: the request carries everything the answer needs.
      '-c',
      'project_doc_max_bytes=0',
      ...(effort ? ['-c', `model_reasoning_effort="${EFFORT[effort]}"`] : []),
      ...(req.model && req.model !== CODEX_DEFAULT_MODEL ? ['--model', req.model] : []),
      '--color',
      'never',
      '--json',
      ...(withSchema ? ['--output-schema', path.join(dir, 'schema.json')] : []),
      '--output-last-message',
      path.join(dir, 'answer.txt'),
      '--cd',
      dir,
      '-',
    ];
  }

  /** What the run reads: Friday's rules, the repository's text as marked source material, the request. */
  input(req: ModelRequest, withSchema: boolean): string {
    const parts = [
      req.system,
      req.instructions,
      'Everything you need is in this message. Do not run commands, read files or search: answer from what is here.',
      wrapProjectContext(req.context),
      ...(req.status ? [wrapProjectContext(req.status)] : []),
      req.prompt,
    ];
    if (req.repair) parts.push(`Your previous answer was:\n${req.repair.previous}`, repairPrompt(req.repair.errors));
    if (!withSchema) parts.push(jsonModeInstructions(structuredOutputSchema(req.schema)));
    return `${parts.join('\n\n')}\n`;
  }

  async #run(req: ModelRequest, withSchema: boolean, signal?: AbortSignal): Promise<RunResult> {
    const timeoutMs = this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const dir = mkdtempSync(path.join(this.#opts.tmpDir ?? os.tmpdir(), 'friday-brain-'));
    const spawn = this.#opts.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      if (withSchema) writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(strictOutputSchema(req.schema)));
      child = spawn(this.#opts.command, this.args(req, dir, withSchema), {
        cwd: dir,
        env: this.#opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw new ModelError('unavailable', `Codex could not start: ${(e as Error).message}`, false, undefined, {
        billed: 'no',
      });
    }
    const result: RunResult = {
      exitCode: null,
      answer: '',
      usage: null,
      model: null,
      threadId: null,
      errors: [],
      stderr: '',
    };
    let lastMessage = '';
    // Codex's events, one JSON object a line: only the few Friday needs are read; the rest is dropped.
    const event = (line: string) => {
      const text = line.trim();
      if (!text.startsWith('{')) return;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof e.thread_id === 'string') result.threadId = e.thread_id;
      if (typeof e.model === 'string' && e.model) result.model = e.model;
      if (isObject(e.usage)) result.usage = usageFromCodex(e.usage);
      const item = isObject(e.item) ? e.item : null;
      if (item && (item.type === 'agent_message' || item.item_type === 'assistant_message')) {
        if (typeof item.text === 'string' && item.text.trim()) lastMessage = item.text;
      }
      const failed = e.type === 'error' || e.type === 'turn.failed' || (item && item.type === 'error');
      if (failed) {
        const err = isObject(e.error) ? e.error.message : (e.message ?? (item ? item.message : undefined));
        if (typeof err === 'string' && err.trim()) result.errors.push(err.trim().slice(0, 1000));
      }
    };
    let pending = '';
    child.stdout?.on('data', (b: Buffer) => {
      pending += b.toString('utf8');
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        event(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
      if (pending.length > MAX_LINE_BYTES) pending = '';
    });
    const err: Buffer[] = [];
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
        child.stdin?.end(this.input(req, withSchema));
      });
      if (pending) event(pending);
      result.exitCode = exit.code;
      result.stderr = Buffer.concat(err).toString('utf8');
      if (exit.error) {
        throw new ModelError('unavailable', `Codex could not start: ${exit.error.message}`, false, undefined, {
          billed: 'no',
        });
      }
      if (cancelled)
        throw new ModelError('timeout', 'the request was cancelled', false, undefined, { billed: 'unknown' });
      if (timedOut) {
        throw new ModelError(
          'timeout',
          `Codex did not answer within ${Math.round(timeoutMs / 60_000)} minutes`,
          true,
          undefined,
          { billed: 'unknown' },
        );
      }
      const file = path.join(dir, 'answer.txt');
      if (existsSync(file)) {
        const raw = readFileSync(file);
        if (raw.length > MAX_ANSWER_BYTES) {
          throw new ModelError('no_output', `the answer was larger than ${MAX_ANSWER_BYTES} bytes`, false, undefined, {
            billed: 'yes',
          });
        }
        result.answer = raw.toString('utf8');
      }
      if (!result.answer.trim()) result.answer = lastMessage;
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    let withSchema = this.#schema !== false;
    let run = await this.#run(req, withSchema, signal);
    const said = (r: RunResult) => [...r.errors, r.stderr].join('\n');
    if (withSchema && !run.answer.trim() && schemaRefused(said(run))) {
      // The service did not take the schema: it goes into the request instead, and Friday's own
      // validation (with the one repair attempt) still decides what is accepted.
      this.#schema = false;
      withSchema = false;
      run = await this.#run(req, false, signal);
    }
    const model = run.model ?? (req.model && req.model !== CODEX_DEFAULT_MODEL ? req.model : CODEX_UNNAMED_MODEL);
    const usage = run.usage ?? undefined;
    if (!run.answer.trim()) {
      const failure = classifyCodexFailure(said(run), run.exitCode);
      throw new ModelError(failure.code, failure.message, failure.retryable, failure.status, {
        ...(usage ? { usage } : {}),
        model,
        requestId: run.threadId,
        billed: usage ? 'yes' : failure.billed,
      });
    }
    if (withSchema) this.#schema = true;
    let output: unknown;
    try {
      output = JSON.parse(unfence(run.answer));
      if (withSchema) output = dropNullOptionals(output, req.schema);
    } catch {
      output = run.answer; // fails validation and earns the repair attempt
    }
    return {
      output,
      model,
      usage: usage ?? ZERO_USAGE,
      stop_reason: 'stop',
      request_id: run.threadId,
    };
  }
}
