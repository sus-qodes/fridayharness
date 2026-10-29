/**
 * Laya's client, question identity and threshold fitting (plan M7c, ADR-0031 §10). The arithmetic
 * is checked on a synthetic set; it says nothing about routing quality.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  askLaya,
  type CalibrationRecord,
  DEFAULT_ROUTING,
  fitThresholds,
  LayaError,
  layaQuestion,
  loadGuide,
} from './index.js';

const guide = loadGuide();
const task = {
  task_id: 'task_1',
  kind: 'implementation',
  role: 'backend',
  summary: 'Fix a difficult TypeScript generic inference bug',
};

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A stand-in `laya-serve` that records requests and answers with `reply`. */
async function stub(reply: (body: Record<string, unknown>) => { status: number; json?: unknown; hang?: boolean }) {
  const seen: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => {
      const body = JSON.parse(data || '{}') as Record<string, unknown>;
      seen.push({ url: req.url, auth: req.headers.authorization ?? null, ...body });
      const r = reply(body);
      if (r.hang) return;
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen };
}

describe('the routing question', () => {
  it('lists the models eligible without a harness, and keeps its identity while nothing it depends on changes', () => {
    const q = layaQuestion(task, guide.models, DEFAULT_ROUTING, [], guide.version);
    expect(q?.options.map(([id]) => id)).toEqual(guide.models.map((m) => m.id));
    expect(q?.options[0]?.[1]).toContain('anthropic model; remote; sees images');
    expect(layaQuestion(task, guide.models, DEFAULT_ROUTING, [], guide.version)?.question_id).toBe(q?.question_id);
    expect(
      layaQuestion(task, guide.models, DEFAULT_ROUTING, ['claude-haiku-5-5'], guide.version)?.question_id,
    ).not.toBe(q?.question_id);
    expect(
      layaQuestion(task, guide.models, { ...DEFAULT_ROUTING, must_use_local: true }, [], guide.version),
    ).toBeNull();
  });
});

describe('askLaya', () => {
  const q = layaQuestion(task, guide.models, DEFAULT_ROUTING, [], guide.version);
  if (!q) throw new Error('no question');

  it("sends one typed choice question with the options as criteria, and reads Laya's confidence", async () => {
    const laya = await stub(() => ({
      status: 200,
      json: {
        model: 'typed-decisions',
        answers: {
          route: {
            type: 'choice',
            choice: 'claude-opus-5-5',
            probabilities: { 'claude-opus-5-5': 0.7, 'claude-sonnet-5-5': 0.3 },
            answer_confidence: 0.7,
          },
        },
      },
    }));
    const r = await askLaya({ url: laya.url, timeout_ms: 2000, api_key: 'k' }, q);
    expect(r).toMatchObject({
      checkpoint: 'typed-decisions',
      choice: 'claude-opus-5-5',
      confidence: 0.7,
      basis: 'answer_confidence',
    });
    const sent = laya.seen[0] as {
      url: string;
      auth: string;
      questions: { route: { type: string; criteria: Record<string, string> } };
    };
    expect(sent.url).toBe('/v1/systemone');
    expect(sent.auth).toBe('Bearer k');
    expect(sent.questions.route.type).toBe('choice');
    expect(Object.keys(sent.questions.route.criteria)).toEqual(q.options.map(([id]) => id));
  });

  it('falls back to the highest probability, and refuses a choice that was not offered', async () => {
    const laya = await stub(() => ({
      status: 200,
      json: { answers: { route: { choice: 'claude-sonnet-5-5', probabilities: [0.1, 0.2, 0.6, 0.05, 0.05] } } },
    }));
    const r = await askLaya({ url: laya.url, timeout_ms: 2000, model: 'english' }, q);
    expect(r).toMatchObject({ checkpoint: 'english', confidence: 0.6, basis: 'max_probability' });
    await new Promise<void>((done) => server?.close(() => done()));
    const bad = await stub(() => ({ status: 200, json: { answers: { route: { choice: 'gpt-9', confidence: 0.9 } } } }));
    await expect(askLaya({ url: bad.url, timeout_ms: 2000 }, q)).rejects.toThrow(/not an option/);
  });

  it('reports an unreachable, failing or slow Laya as a LayaError', async () => {
    await expect(askLaya({ url: 'http://127.0.0.1:9', timeout_ms: 2000 }, q)).rejects.toMatchObject({
      kind: 'unreachable',
    });
    const busy = await stub(() => ({ status: 503 }));
    await expect(askLaya({ url: busy.url, timeout_ms: 2000 }, q)).rejects.toMatchObject({ kind: 'http' });
    await new Promise<void>((done) => server?.close(() => done()));
    const slow = await stub(() => ({ status: 200, hang: true }));
    const err = await askLaya({ url: slow.url, timeout_ms: 300 }, q).catch((e) => e);
    expect(err).toBeInstanceOf(LayaError);
    expect(err.kind).toBe('timeout');
    server?.closeAllConnections();
  });
});

describe('fitThresholds', () => {
  it('finds the lowest confidence whose answers reach the target accuracy, per checkpoint and option count', () => {
    // 40 answers: the top 30 (confidence 0.95 down to 0.66) are 90% right, the last 10 all wrong.
    const records: CalibrationRecord[] = Array.from({ length: 40 }, (_, i) => ({
      checkpoint: 'typed-decisions',
      options: 5,
      confidence: Math.round((0.95 - i * 0.01) * 100) / 100,
      correct: i < 30 ? i % 10 !== 9 : false,
    }));
    const [c] = fitThresholds(records, { target: 0.9, minSupport: 20 });
    expect(c).toMatchObject({ checkpoint: 'typed-decisions', shape: 'choice:5', support: 40, target: 0.9 });
    expect(c?.threshold).toBe(0.66);
    expect(c?.accuracy).toBe(0.9);
    expect(c?.coverage).toBe(0.75);
    // Too few answers, or never accurate enough: no threshold, so Laya stays advisory.
    expect(fitThresholds(records.slice(0, 10), { minSupport: 20 })[0]?.threshold).toBeNull();
    expect(fitThresholds(records, { target: 0.99 })[0]?.threshold).toBeNull();
    // Each option count is its own bucket.
    const mixed = fitThresholds([...records, ...records.map((r) => ({ ...r, options: 3 }))]);
    expect(mixed.map((m) => m.shape)).toEqual(['choice:3', 'choice:5']);
  });
});
