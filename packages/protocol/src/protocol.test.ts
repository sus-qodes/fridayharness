import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentResultParams,
  ERROR_CODES,
  encodeBase32,
  FridayError,
  fromRpcError,
  HarnessRegisterParams,
  idSchema,
  isFridayError,
  isId,
  isMethodName,
  METHODS,
  negotiateProtocolVersion,
  newId,
  rpcError,
  TaskClaimParams,
  TaskCreateRequest,
} from './index.js';
import { buildSchemas, serializeSchema } from './json-schema.js';

describe('ids', () => {
  it('encodes 128 bits as 26 Crockford base32 characters', () => {
    expect(encodeBase32(new Uint8Array(16))).toBe('0'.repeat(26));
    expect(encodeBase32(new Uint8Array(16).fill(0xff))).toBe(`7${'z'.repeat(25)}`);
  });

  it('creates prefixed ids that validate and do not collide', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('task')));
    expect(ids.size).toBe(10_000);
    for (const id of [...ids].slice(0, 100)) expect(isId(id, 'task')).toBe(true);
    const sample = newId('evt');
    expect(sample).toMatch(/^evt_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(isId(sample, 'task')).toBe(false);
    expect(isId('task_123', 'task')).toBe(false);
  });

  it('idSchema rejects other prefixes and malformed ids', () => {
    const schema = idSchema('run');
    expect(schema.safeParse(newId('run')).success).toBe(true);
    expect(schema.safeParse(newId('task')).success).toBe(false);
    expect(schema.safeParse('run_ILOU0000000000000000000000').success).toBe(false);
  });
});

describe('errors', () => {
  it('has unique, well-formed codes and sensible HTTP statuses', () => {
    const codes = Object.values(ERROR_CODES).map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const def of Object.values(ERROR_CODES)) {
      expect(def.code).toMatch(/^COS-\d{4}$/);
      expect(def.http).toBeGreaterThanOrEqual(400);
      expect(def.http).toBeLessThan(600);
    }
    expect(ERROR_CODES.invalid_state_transition.code).toBe('COS-2002');
  });

  it('round-trips through a response body and an RPC error', () => {
    const err = new FridayError('invalid_state_transition', 'READY -> COMPLETED is not allowed', { from: 'READY' });
    const back = FridayError.fromBody(JSON.parse(JSON.stringify(err.toBody())));
    expect(isFridayError(back, 'invalid_state_transition')).toBe(true);
    expect(back.details).toEqual({ from: 'READY' });

    const rpc = rpcError('1', err);
    if (!('error' in rpc)) throw new Error('expected error');
    expect(rpc.error.code).toBe(2002);
    expect(fromRpcError(rpc.error).code).toBe('COS-2002');
  });

  it('maps unknown codes to internal_error', () => {
    expect(FridayError.fromBody({ error: { code: 'COS-0001' } }).errorName).toBe('internal_error');
    expect(FridayError.fromBody('garbage').errorName).toBe('internal_error');
  });
});

describe('negotiateProtocolVersion', () => {
  it('picks the highest supported minor not above the client', () => {
    expect(negotiateProtocolVersion('1.0')).toBe('1.0');
    expect(negotiateProtocolVersion('1.3')).toBe('1.0');
    expect(negotiateProtocolVersion('1.3', ['1.0', '1.2', '1.5'])).toBe('1.2');
    expect(negotiateProtocolVersion('1.0', ['1.1', '1.2'])).toBe('1.1');
  });

  it('rejects another major version or a malformed version with COS-1002', () => {
    for (const v of ['2.0', '0.9', 'abc', '1']) {
      expect(() => negotiateProtocolVersion(v)).toThrow(FridayError);
      try {
        negotiateProtocolVersion(v);
      } catch (e) {
        expect((e as FridayError).code).toBe('COS-1002');
      }
    }
  });
});

describe('method schemas', () => {
  it('fills defaults on harness.register', () => {
    const parsed = HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: 'claude-code:proj_x:pid:1',
      vendor: 'claude-code',
      name: 'Claude Code',
      attach_mode: 'attach',
      project_id: 'proj_x',
      agent: {},
    });
    expect(parsed.capabilities).toEqual({});
    expect(parsed.agent?.role).toBe('developer');
  });

  it('task.claim needs exactly one of task_id or next', () => {
    expect(TaskClaimParams.safeParse({ task_id: 't' }).success).toBe(true);
    expect(TaskClaimParams.safeParse({ next: true }).success).toBe(true);
    expect(TaskClaimParams.safeParse({}).success).toBe(false);
    expect(TaskClaimParams.safeParse({ task_id: 't', next: true }).success).toBe(false);
  });

  it('agent.result requires an idempotency key (spec Part 14 §14)', () => {
    const base = { task_id: 't', run_id: 'r', status: 'completed_claim', summary: 'done' };
    expect(AgentResultParams.safeParse(base).success).toBe(false);
    expect(AgentResultParams.safeParse({ ...base, idempotency_key: 'k1' }).success).toBe(true);
  });

  it('agent keys are restricted to a safe character set', () => {
    const base = {
      protocol_version: '1.0',
      harness_key: 'k',
      vendor: 'generic',
      name: 'n',
      attach_mode: 'spawn',
      project_id: 'p',
    };
    expect(HarnessRegisterParams.safeParse({ ...base, agent: { agent_key: 'dev-1' } }).success).toBe(true);
    expect(HarnessRegisterParams.safeParse({ ...base, agent: { agent_key: '../etc' } }).success).toBe(false);
  });

  it('task create applies defaults', () => {
    const t = TaskCreateRequest.parse({ summary: 'x' });
    expect(t).toMatchObject({ kind: 'implementation', priority: 'normal', risk_level: 'low', ready: false });
  });

  it('knows its method names', () => {
    expect(isMethodName('task.claim')).toBe(true);
    expect(isMethodName('verification.request')).toBe(false);
    expect(isMethodName('message.inbox')).toBe(true);
    expect(isMethodName('memory.record')).toBe(true);
    expect(isMethodName('operation.run')).toBe(true);
    expect(isMethodName('approval.elicited')).toBe(true);
    expect(isMethodName('tool.check')).toBe(true);
    expect(isMethodName('learning.propose')).toBe(true);
    expect(isMethodName('graph.query')).toBe(true);
    expect(isMethodName('artifact.read')).toBe(true);
    expect(isMethodName('symbol.patch')).toBe(true);
    expect(Object.keys(METHODS)).toHaveLength(31);
  });
});

describe('generated JSON Schemas', () => {
  it('match the committed files in schemas/ (run gen:schemas after changing a schema)', () => {
    const schemasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../schemas');
    for (const [rel, schema] of Object.entries(buildSchemas())) {
      const committed = readFileSync(path.join(schemasDir, rel), 'utf8').replace(/\r\n/g, '\n');
      expect(committed, `${rel} is out of date`).toBe(serializeSchema(schema));
    }
  });
});
