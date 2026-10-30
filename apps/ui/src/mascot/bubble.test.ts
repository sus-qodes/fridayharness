import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BubbleEnv, type BubbleHandle, createBubble } from './bubble.js';

interface FakeEnv extends BubbleEnv {
  timers: Map<number, { fn: () => void; ms: number }>;
  /** Fires every pending typing timer once (one tick each). */
  tick(): void;
  /** Runs timers until the body stops typing. */
  finishTyping(): void;
}

function fakeEnv(reduced = false): FakeEnv {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const env: FakeEnv = {
    doc: document,
    timers,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
    reduced: () => reduced,
    tick() {
      const pending = [...timers.values()];
      timers.clear();
      for (const t of pending) t.fn();
    },
    finishTyping() {
      let guard = 0;
      while (timers.size && guard++ < 10_000) env.tick();
    },
  };
  return env;
}

let bubble: BubbleHandle | null = null;

afterEach(() => {
  bubble?.destroy();
  bubble = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('the thought bubble', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('starts hidden and empty', () => {
    bubble = createBubble(fakeEnv());
    expect(bubble.visible).toBe(false);
    expect(bubble.el.hidden).toBe(true);
    expect(bubble.el.textContent).toBe('');
  });

  it('shows a message with title, body and actions', () => {
    const env = fakeEnv();
    bubble = createBubble(env);
    document.body.append(bubble.el);
    bubble.show({
      title: 'Welcome',
      body: 'Hi, I am Friday.',
      actions: [{ id: 'next', label: 'Next', kind: 'primary' }],
    });
    env.finishTyping();
    expect(bubble.visible).toBe(true);
    expect(bubble.el.hidden).toBe(false);
    expect(bubble.el.querySelector('.ms-bubble-title')?.textContent).toBe('Welcome');
    expect(bubble.el.querySelector('.ms-bubble-body')?.textContent).toBe('Hi, I am Friday.');
    const action = bubble.el.querySelector<HTMLButtonElement>('button[data-action="next"]');
    expect(action?.textContent).toBe('Next');
    expect(action?.className).toContain('btn-primary');
  });

  it('types the body out over ticks, then stops', () => {
    const env = fakeEnv();
    bubble = createBubble(env);
    document.body.append(bubble.el);
    const body = 'abcdef';
    bubble.show({ body });
    expect(bubble.typing).toBe(true);
    env.tick();
    expect(bubble.el.querySelector('.ms-bubble-body')?.textContent).toBe('ab');
    env.finishTyping();
    expect(bubble.typing).toBe(false);
    expect(bubble.el.querySelector('.ms-bubble-body')?.textContent).toBe(body);
  });

  it('shows everything at once under reduced motion', () => {
    bubble = createBubble(fakeEnv(true));
    bubble.show({ body: 'All at once' });
    expect(bubble.typing).toBe(false);
    expect(bubble.el.querySelector('.ms-bubble-body')?.textContent).toBe('All at once');
  });

  it('fires an action once and drops listeners at the next show', () => {
    bubble = createBubble(fakeEnv());
    bubble.show({ body: 'x', actions: [{ id: 'a', label: 'A' }] });
    const seen: string[] = [];
    const off = bubble.onAction((action) => seen.push(action.id));
    bubble.el.querySelector<HTMLButtonElement>('button[data-action="a"]')?.click();
    expect(seen).toEqual(['a']);
    off();
    bubble.el.querySelector<HTMLButtonElement>('button[data-action="a"]')?.click();
    expect(seen).toEqual(['a']);
    bubble.show({ body: 'y', actions: [{ id: 'b', label: 'B' }] });
    const more: string[] = [];
    bubble.onAction((action) => more.push(action.id));
    bubble.el.querySelector<HTMLButtonElement>('button[data-action="b"]')?.click();
    expect(more).toEqual(['b']);
  });

  it('clear() hides the bubble and empties it', () => {
    bubble = createBubble(fakeEnv());
    bubble.show({ body: 'gone' });
    bubble.clear();
    expect(bubble.visible).toBe(false);
    expect(bubble.typing).toBe(false);
    expect(bubble.el.textContent).toBe('');
  });

  it('replacing a message drops the previous actions', () => {
    bubble = createBubble(fakeEnv());
    bubble.show({ body: 'one', actions: [{ id: 'a', label: 'A' }] });
    bubble.show({ body: 'two' });
    expect(bubble.el.querySelector('button')).toBeNull();
  });
});
