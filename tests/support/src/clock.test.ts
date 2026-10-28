import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';

describe('FakeClock', () => {
  it('starts at the given time with monotonic zero', () => {
    const clock = new FakeClock('2026-10-13T08:00:00.000Z');
    expect(clock.now()).toBe('2026-10-13T08:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
  });

  it('advance() moves wall and monotonic time together', () => {
    const clock = new FakeClock();
    clock.advance(30_000);
    expect(clock.now()).toBe('2026-01-01T00:00:30.000Z');
    expect(clock.monotonicMs()).toBe(30_000);
  });

  it('set() changes wall time without moving monotonic time', () => {
    const clock = new FakeClock().advance(5);
    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now()).toBe('2027-01-01T00:00:00.000Z');
    expect(clock.monotonicMs()).toBe(5);
  });

  it('rejects going backwards and invalid times', () => {
    expect(() => new FakeClock().advance(-1)).toThrow();
    expect(() => new FakeClock('not a date')).toThrow();
  });
});
