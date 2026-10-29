import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryHit } from '../api/client.js';
import type { RecordedCall } from '../test/context.js';
import { makeContext } from '../test/context.js';
import { createMemoryBank, SEARCH_DEBOUNCE_MS } from './memory-bank.js';

const IMG = '<img src=x onerror=alert(1)>';
const BIDI = '‮';
const ZW = '​';
const NOW = Date.parse('2026-10-17T10:00:00.000Z');
const DAY = 86_400_000;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function hit(overrides: Partial<MemoryHit> = {}): MemoryHit {
  return {
    memory_id: 'mem_1',
    scope_type: 'project',
    scope_id: 'proj_000000000000000000000000t1',
    kind: 'decision',
    subject: 'Use the AuthService',
    content: 'Do not call vendor SDKs directly',
    tags: ['auth'],
    authority: 'agent',
    verification_status: 'unverified',
    status: 'active',
    needs_review: false,
    created_at: new Date(NOW - 15 * DAY).toISOString(),
    updated_at: new Date(NOW - 15 * DAY).toISOString(),
    score: 0.4,
    why: { relevance: 1, weight: 0.4, uses: 0 },
    ...overrides,
  };
}

const RESULTS = [
  hit({
    memory_id: 'mem_agent',
    subject: `Agent ${IMG} ${BIDI}note`,
    content: `${IMG}\n${'w'.repeat(5000)}`,
    score: 0.9,
  }),
  hit({ memory_id: 'mem_human', authority: 'human-approved', subject: 'Human rule', kind: 'constraint', score: 0.2 }),
  hit({ memory_id: 'mem_task', scope_type: 'task', kind: 'convention', subject: 'Task convention', score: 0.5 }),
];
const REVIEW = [
  hit({ memory_id: 'mem_review', subject: `Review ${BIDI}me${ZW}`, needs_review: true, tags: [`t${BIDI}`] }),
];

function setup(answers: Record<string, unknown> = {}) {
  const ctx = makeContext({
    answers: { 'GET /memory': { memories: RESULTS }, 'GET /memory/review': { memories: REVIEW }, ...answers },
  });
  const drawer = createMemoryBank(ctx, { kind: 'memory' });
  document.body.append(drawer.el);
  return { ctx, drawer };
}

function subjects(root: Element): string[] {
  return [...root.querySelectorAll('.dr-mem-subject')].map((e) => e.textContent ?? '');
}

function buttonNamed(root: Element, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the memory bank', () => {
  it('searches and lists memories with human-approved ones pinned first', async () => {
    const { ctx, drawer } = setup();
    await settle();
    const search = ctx.transport.to('GET', '/memory')[0];
    expect(new URLSearchParams(search?.path.split('?')[1]).get('limit')).toBe('40');
    expect(new URLSearchParams(search?.path.split('?')[1]).has('query')).toBe(false);
    expect(ctx.transport.to('GET', '/memory/review')).toHaveLength(1);
    const list = drawer.el.querySelector('.dr-mem-list[aria-label="Memories"]') as Element;
    expect(subjects(list)).toEqual(['Human rule', `Agent ${IMG} note`, 'Task convention']);
    expect(list.querySelector('.dr-mem-pinned .dr-pin')).not.toBeNull();
    expect(list.querySelector('.dr-mem-pinned')?.textContent).toContain('Human-approved');
    expect(list.querySelector('.dr-mem-pinned')?.textContent).toContain('never fades');
    drawer.destroy();
  });

  it('shows hostile memory text as text, with visible marks on items to review', async () => {
    const { drawer } = setup();
    await settle();
    expect(drawer.el.querySelector('img')).toBeNull();
    expect(drawer.el.textContent).toContain(IMG);
    const review = drawer.el.querySelector('.dr-mem-review') as Element;
    expect(review.textContent).toContain('Needs review (1)');
    expect(subjects(review)).toEqual(['Review ⟨U+202E⟩me⟨U+200B⟩']);
    expect(review.textContent).toContain('#t⟨U+202E⟩');
    expect(review.querySelector('.hidden-warning')).not.toBeNull();
    drawer.destroy();
  });

  it('shortens long content until asked', async () => {
    const { drawer } = setup();
    await settle();
    const card = [...drawer.el.querySelectorAll('.dr-mem')].find((c) =>
      c.querySelector('.dr-mem-subject')?.textContent?.startsWith('Agent '),
    ) as Element;
    const content = card.querySelector('.dr-mem-content') as Element;
    expect(Array.from(content.textContent ?? '').length).toBe(600);
    buttonNamed(card, 'Show all')?.click();
    expect(content.textContent).toContain('w'.repeat(5000));
    expect(buttonNamed(card, 'Show all')).toBeUndefined();
    drawer.destroy();
  });

  it('draws the recency bar from the half-life', async () => {
    const { drawer } = setup();
    await settle();
    const card = [...drawer.el.querySelectorAll('.dr-mem')].find((c) => c.textContent?.includes('Task convention'));
    const meter = card?.querySelector('[role="meter"]');
    // An agent memory 15 days old with a 30-day half-life keeps 2^-0.5 ≈ 71%.
    expect(meter?.getAttribute('aria-valuenow')).toBe('71');
    expect(card?.textContent).toContain('half-life 30 d');
    expect(card?.textContent).toContain('weight 0.40');
    drawer.destroy();
  });

  it('filters by kind and scope on the results shown, without asking the daemon', async () => {
    const { ctx, drawer } = setup();
    await settle();
    expect(drawer.el.textContent).toContain('The kind and scope filters apply to the results shown below.');
    const list = drawer.el.querySelector('.dr-mem-list[aria-label="Memories"]') as Element;
    const kind = drawer.el.querySelector<HTMLSelectElement>('.dr-mem-kind') as HTMLSelectElement;
    kind.value = 'decision';
    kind.dispatchEvent(new Event('change'));
    expect(subjects(list)).toEqual([`Agent ${IMG} note`]);
    expect(drawer.el.querySelector('.dr-mem-count')?.textContent).toBe('1 memory (2 hidden by the filters)');
    kind.value = '';
    kind.dispatchEvent(new Event('change'));
    const scope = drawer.el.querySelector<HTMLSelectElement>('.dr-mem-scope') as HTMLSelectElement;
    scope.value = 'task';
    scope.dispatchEvent(new Event('change'));
    expect(subjects(list)).toEqual(['Task convention']);
    expect(ctx.transport.to('GET', '/memory')).toHaveLength(1);
    drawer.destroy();
  });

  it('waits for typing to pause before searching', async () => {
    vi.useFakeTimers();
    const { ctx, drawer } = setup();
    await vi.advanceTimersByTimeAsync(0);
    const input = drawer.el.querySelector<HTMLInputElement>('.dr-mem-search') as HTMLInputElement;
    input.value = 'au';
    input.dispatchEvent(new Event('input'));
    input.value = 'auth';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 10);
    expect(ctx.transport.to('GET', '/memory')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    const calls = ctx.transport.to('GET', '/memory');
    expect(calls).toHaveLength(2);
    expect(new URLSearchParams(calls[1]?.path.split('?')[1]).get('query')).toBe('auth');
    input.value = 'now';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('GET', '/memory')).toHaveLength(3);
    input.dispatchEvent(new Event('input'));
    drawer.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('approves a memory that needs review and reads both lists again', async () => {
    const { ctx, drawer } = setup();
    await settle();
    buttonNamed(drawer.el.querySelector('.dr-mem-review') as Element, 'Approve')?.click();
    await settle();
    expect(ctx.transport.to('POST', '/memory/mem_review/approve')).toHaveLength(1);
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'success', text: 'Memory approved' });
    expect(ctx.transport.to('GET', '/memory/review')).toHaveLength(2);
    expect(ctx.transport.to('GET', '/memory')).toHaveLength(2);
    drawer.destroy();
  });

  it('retracts only after the user confirms', async () => {
    const { ctx, drawer } = setup();
    await settle();
    const review = drawer.el.querySelector('.dr-mem-review') as Element;
    ctx.confirmAnswer = false;
    buttonNamed(review, 'Retract')?.click();
    await settle();
    expect(ctx.confirms[0]).toMatchObject({ danger: true, confirmLabel: 'Retract' });
    expect(String(ctx.confirms[0]?.body)).toContain('⟨U+202E⟩');
    expect(ctx.transport.to('POST', '/memory/mem_review/retract')).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonNamed(review, 'Retract')?.click();
    await settle();
    const calls = ctx.transport.to('POST', '/memory/mem_review/retract');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ reason: 'retracted in the memory bank' });
    drawer.destroy();
  });

  it('shows a search error with its message', async () => {
    const { drawer } = setup({
      'GET /memory': (_c: RecordedCall) => {
        throw new Error('memory is unavailable');
      },
    });
    await settle();
    expect(drawer.el.querySelector('.dr-error')?.textContent).toContain('memory is unavailable');
    drawer.destroy();
  });
});
