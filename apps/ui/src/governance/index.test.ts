import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeEscalation, makeSnapshot } from '../test/fixtures.js';
import { registerGovernance } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('registerGovernance', () => {
  it('registers the approval, question, recover and plan-review modals and the inbox drawer', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ escalations: [makeEscalation()] }) });
    registerGovernance(ctx);
    expect([...ctx.registry.modals.keys()].sort()).toEqual(['approval', 'plan-review', 'question', 'recover']);
    expect([...ctx.registry.drawers.keys()]).toEqual(['inbox']);
    const question = ctx.registry.modals.get('question');
    let closed = 0;
    const m = question?.(ctx, { kind: 'question', id: 'esc_000000000000000000000es01' }, () => {
      closed += 1;
    });
    expect(m?.el.classList.contains('gv-question')).toBe(true);
    const later = [...(m?.el.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Later');
    later?.click();
    expect(closed).toBe(1);
    m?.destroy();
    const gone = question?.(ctx, { kind: 'question', id: 'esc_gone' }, () => undefined);
    expect(gone?.el.textContent).toContain('no longer pending');
    const inbox = ctx.registry.drawers.get('inbox')?.(ctx, { kind: 'inbox' });
    expect(inbox?.title).toBe('Messages for you');
    inbox?.destroy();
  });
});

describe('governance source rules', () => {
  const files = [
    ...readdirSync(HERE)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => path.join(HERE, f)),
    path.join(HERE, '..', 'model', 'escalations.ts'),
  ];

  it('never parses HTML, never names the loopback host by name, imports shared packages as types only', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const rules: [RegExp, string][] = [
        [/inner(?:HTML)|outer(?:HTML)|insertAdjacent(?:HTML)|document\.write/, 'HTML parsing'],
        [/local(?:host)/i, 'loopback name'],
        [/^import (?!type)[^;]*from '@friday\//m, 'value import from @friday'],
        [/from 'node:|\bprocess\.|\bBuffer\b/, 'Node API'],
        [/setAttribute\(\s*['"](on|style)/, 'inline handler or style'],
        [/\bfetch\(/, 'fetch outside the API client'],
      ];
      for (const [pattern, why] of rules) if (pattern.test(text)) offenders.push(`${path.basename(file)}: ${why}`);
    }
    expect(offenders).toEqual([]);
  });
});
