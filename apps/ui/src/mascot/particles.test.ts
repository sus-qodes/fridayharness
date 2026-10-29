import { describe, expect, it } from 'vitest';
import { seededRandom } from './engine.js';
import {
  addParticles,
  confetti,
  drawParticles,
  hearts,
  MAX_PARTICLES,
  type Particle,
  particleAlpha,
  particlePosition,
  snooze,
  sparks,
  stepParticles,
  sweat,
} from './particles.js';
import { numbersOf, recordingContext } from './testing.js';

function p(over: Partial<Particle> = {}): Particle {
  return {
    type: 'spark',
    x0: 1,
    y0: 2,
    vx: 10,
    vy: -20,
    gravity: 40,
    age: 0,
    lifetime: 1,
    rotation: 0,
    spin: 2,
    scale: 1,
    grow: 0,
    color: '#fff',
    ...over,
  };
}

describe('particles', () => {
  it('ramps alpha up over the first fifth of life, then fades', () => {
    expect(particleAlpha(p({ age: 0 }))).toBe(0);
    expect(particleAlpha(p({ age: 0.1 }))).toBeCloseTo(0.5, 9);
    expect(particleAlpha(p({ age: 0.2 }))).toBeCloseTo(1, 9);
    expect(particleAlpha(p({ age: 0.6 }))).toBeCloseTo(0.5, 9);
    expect(particleAlpha(p({ age: 1 }))).toBe(0);
    expect(particleAlpha(p({ age: -0.1 }))).toBe(0);
    expect(particleAlpha(p({ lifetime: 0 }))).toBe(0);
  });

  it('places a particle from its age, not by integrating', () => {
    const at = particlePosition(p({ age: 0.5 }));
    expect(at.x).toBeCloseTo(1 + 10 * 0.5, 9);
    expect(at.y).toBeCloseTo(2 - 20 * 0.5 + 0.5 * 40 * 0.25, 9);
    // Waiting particles sit at their origin.
    expect(particlePosition(p({ age: -1 }))).toEqual({ x: 1, y: 2 });
  });

  it('ages particles and removes the expired ones', () => {
    const list = [p({ age: 0.95 }), p({ age: -0.3 }), p({ age: 0.2 })];
    const next = stepParticles(list, 0.1);
    expect(next).toHaveLength(2);
    expect(next[0]?.age).toBeCloseTo(-0.2, 9);
    expect(next[1]?.rotation).toBeCloseTo(0.2, 9);
    expect(stepParticles(list, 0)).toBe(list);
    expect(stepParticles(list, Number.NaN)).toBe(list);
    let all = confetti(seededRandom(1), ['#fff']);
    for (let i = 0; i < 200 && all.length; i++) all = stepParticles(all, 1 / 60);
    expect(all).toHaveLength(0);
  });

  it('makes the bursts the reactions use, staggered and finite', () => {
    const r = seededRandom(7);
    expect(confetti(r, ['#a', '#b'])).toHaveLength(18);
    expect(confetti(r, ['#a'], 28)).toHaveLength(28);
    expect(sparks(r, '#a', 6)).toHaveLength(6);
    expect(sweat(r, '#a', 2)[1]?.age).toBeLessThan(0);
    expect(snooze(r, '#a').type).toBe('z');
    expect(hearts(r, '#a').every((h) => h.type === 'heart')).toBe(true);
    for (const q of [...confetti(r, []), ...sparks(r, '#a'), ...sweat(r, '#a', 3), snooze(r, '#a')]) {
      expect([q.x0, q.y0, q.vx, q.vy, q.gravity, q.age, q.lifetime, q.scale].every(Number.isFinite)).toBe(true);
      expect(q.age).toBeLessThanOrEqual(0);
      expect(q.lifetime).toBeGreaterThan(0);
    }
  });

  it('keeps at most MAX_PARTICLES, dropping the oldest', () => {
    const many = Array.from({ length: MAX_PARTICLES }, (_, i) => p({ x0: i }));
    const next = addParticles(many, [p({ x0: 999 })]);
    expect(next).toHaveLength(MAX_PARTICLES);
    expect(next[0]?.x0).toBe(1);
    expect(next[next.length - 1]?.x0).toBe(999);
  });

  it('draws each kind with finite numbers and skips invisible ones', () => {
    const { g, log } = recordingContext();
    const list = (['spark', 'star', 'heart', 'sweat', 'z'] as const).map((type) => p({ type, age: 0.4, grow: 0.3 }));
    drawParticles(g, [...list, p({ age: -1 })], 48, 57);
    expect(numbersOf(log).every(Number.isFinite)).toBe(true);
    expect(log.calls.filter((c) => c.name === 'save')).toHaveLength(5);
  });
});
