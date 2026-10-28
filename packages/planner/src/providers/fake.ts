import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type Billed,
  ModelError,
  type ModelErrorCode,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type PlannerModel,
  ZERO_USAGE,
} from './types.js';

/**
 * A scripted model for tests and offline demos: each request takes the first unused response
 * whose purpose matches and whose `match` text (if any) appears in the request. Never remote.
 */
export interface FakeResponse {
  purpose: 'plan' | 'replan';
  /** Only used when this text appears in the context or prompt. */
  match?: string;
  output?: unknown;
  /** `billed: 'yes'` reports `usage` with the error, like a refusal or a cut-off answer. */
  error?: { code: ModelErrorCode; message: string; retryable?: boolean; billed?: Billed };
  usage?: Partial<ModelUsage>;
  /** Answer after this many milliseconds (a slow provider). */
  delay_ms?: number;
}

/**
 * Scripted revisions cannot know task ids in advance: `${task:<key>}` in a scripted answer is
 * replaced with the id the request's plan text lists for that key (`- task_… [STATUS] "key" …`).
 */
export function resolveTaskRefs(value: unknown, prompt: string): unknown {
  const ids = new Map([...prompt.matchAll(/- (task_[0-9a-z]+) \[[A-Z_]+\] "([a-z0-9-]+)"/g)].map((m) => [m[2], m[1]]));
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\$\{task:([a-z0-9-]+)\}/g, (all, key: string) => ids.get(key) ?? all);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

export class FakePlannerModel implements PlannerModel {
  readonly provider = 'fake';
  readonly remote = false;
  readonly requests: ModelRequest[] = [];
  #queue: FakeResponse[];

  constructor(responses: FakeResponse[]) {
    this.#queue = [...responses];
  }

  /** Loads every `*.json` file in a directory (each a FakeResponse or an array of them), in name order. */
  static fromDirectory(dir: string): FakePlannerModel {
    const responses = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .flatMap((f) => {
        const value = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as FakeResponse | FakeResponse[];
        return Array.isArray(value) ? value : [value];
      });
    return new FakePlannerModel(responses);
  }

  get remaining(): number {
    return this.#queue.length;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const text = `${request.context}\n${request.prompt}`;
    const i = this.#queue.findIndex((r) => r.purpose === request.purpose && (!r.match || text.includes(r.match)));
    if (i < 0)
      throw new ModelError('unavailable', `fake model has no scripted ${request.purpose} response for this request`);
    const [r] = this.#queue.splice(i, 1) as [FakeResponse];
    if (r.delay_ms) await new Promise((res) => setTimeout(res, r.delay_ms));
    if (r.error) {
      const billed = r.error.billed ?? 'no';
      throw new ModelError(r.error.code, r.error.message, r.error.retryable ?? false, undefined, {
        billed,
        ...(billed === 'yes'
          ? { usage: { ...ZERO_USAGE, input_tokens: 1200, output_tokens: 400, ...r.usage }, model: request.model }
          : {}),
        requestId: `fake-${this.requests.length}`,
      });
    }
    return {
      output: resolveTaskRefs(r.output, request.prompt),
      model: request.model,
      usage: { ...ZERO_USAGE, input_tokens: 1200, output_tokens: 400, ...r.usage },
      stop_reason: 'end_turn',
      request_id: `fake-${this.requests.length}`,
    };
  }
}
