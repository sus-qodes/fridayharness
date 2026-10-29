/**
 * Blip's particles (plan §7.9): sparks and stars for celebrations, hearts, sweat drops on errors
 * and floating z's while asleep. A particle's position is computed from its age (origin + v·age +
 * ½·g·age²), never integrated, so it is the same at any frame rate; its alpha ramps up over the
 * first fifth of its life and then fades; it is removed once its age reaches its lifetime.
 * Coordinates are design pixels of Blip's 96 × 96 grid, y down, relative to the head's centre.
 */
import { heartPath, type Pen, starPath } from './eyes.js';

export type ParticleType = 'spark' | 'star' | 'heart' | 'sweat' | 'z';

export interface Particle {
  type: ParticleType;
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  /** Downward acceleration (design px/s²). */
  gravity: number;
  /** Seconds; negative while the particle waits to appear (staggered bursts). */
  age: number;
  lifetime: number;
  rotation: number;
  spin: number;
  scale: number;
  /** Growth per second of life (z's grow as they rise). */
  grow: number;
  color: string;
}

/** At most this many particles live at once; the oldest give way. */
export const MAX_PARTICLES = 64;

/** The fraction of a particle's life spent fading in. */
const RAMP = 0.2;

export function particleAlpha(p: Pick<Particle, 'age' | 'lifetime'>): number {
  if (!(p.lifetime > 0) || p.age < 0 || p.age >= p.lifetime) return 0;
  const f = p.age / p.lifetime;
  return f < RAMP ? f / RAMP : (1 - f) / (1 - RAMP);
}

export function particlePosition(p: Particle): { x: number; y: number } {
  const t = Math.max(0, p.age);
  let x = p.x0 + p.vx * t;
  const y = p.y0 + p.vy * t + 0.5 * p.gravity * t * t;
  if (p.type === 'z') x += Math.sin(t * 4) * 2.2;
  return { x, y };
}

/** Ages every particle by `dt` seconds and drops the expired ones; returns the survivors. */
export function stepParticles(list: Particle[], dt: number): Particle[] {
  if (!(dt > 0)) return list;
  const out: Particle[] = [];
  for (const p of list) {
    const age = p.age + dt;
    if (age >= p.lifetime) continue;
    out.push({ ...p, age, rotation: p.rotation + p.spin * dt });
  }
  return out;
}

export function addParticles(list: Particle[], more: Particle[]): Particle[] {
  const all = list.concat(more);
  return all.length > MAX_PARTICLES ? all.slice(all.length - MAX_PARTICLES) : all;
}

type Random = () => number;

function base(type: ParticleType, color: string): Particle {
  return {
    type,
    x0: 0,
    y0: 0,
    vx: 0,
    vy: 0,
    gravity: 0,
    age: 0,
    lifetime: 1,
    rotation: 0,
    spin: 0,
    scale: 1,
    grow: 0,
    color,
  };
}

/** A radial burst of sparks and stars (completion confetti: N = 18 by default). */
export function confetti(random: Random, colors: readonly string[], count = 18, origin = { x: 0, y: -6 }): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (random() - 0.5) * 0.5;
    const speed = 46 + random() * 38;
    out.push({
      ...base(i % 3 === 0 ? 'star' : 'spark', colors[i % Math.max(1, colors.length)] ?? '#ffffff'),
      x0: origin.x,
      y0: origin.y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 30,
      gravity: 120,
      age: -random() * 0.08,
      lifetime: 0.9 + random() * 0.5,
      rotation: random() * Math.PI,
      spin: (random() - 0.5) * 9,
      scale: 0.7 + random() * 0.6,
    });
  }
  return out;
}

/** A few sparks thrown upward (a happy hop). */
export function sparks(random: Random, color: string, count = 6): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (random() - 0.5) * 1.8;
    const speed = 34 + random() * 22;
    out.push({
      ...base(i % 2 ? 'spark' : 'star', color),
      x0: (random() - 0.5) * 20,
      y0: -14,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      gravity: 70,
      age: -random() * 0.1,
      lifetime: 0.7 + random() * 0.3,
      spin: (random() - 0.5) * 6,
      scale: 0.55 + random() * 0.35,
    });
  }
  return out;
}

/** Sweat drops from the upper right of the head. */
export function sweat(random: Random, color: string, count = 1): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      ...base('sweat', color),
      x0: 18 + random() * 4,
      y0: -14 + random() * 3,
      vx: 4 + random() * 4,
      vy: 6,
      gravity: 60,
      age: -i * 0.18,
      lifetime: 0.9,
      scale: 0.8 + random() * 0.3,
    });
  }
  return out;
}

/** One z rising from the top right while asleep. */
export function snooze(random: Random, color: string): Particle {
  return {
    ...base('z', color),
    x0: 14 + random() * 3,
    y0: -24,
    vx: 6,
    vy: -12,
    lifetime: 2.2,
    scale: 0.5,
    grow: 0.35,
  };
}

/** Hearts floating up (a click on Blip). */
export function hearts(random: Random, color: string, count = 2): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      ...base('heart', color),
      x0: (i % 2 ? 1 : -1) * (12 + random() * 6),
      y0: -18,
      vx: (i % 2 ? 1 : -1) * 6,
      vy: -22 - random() * 8,
      age: -i * 0.12,
      lifetime: 1,
      scale: 0.7 + random() * 0.3,
    });
  }
  return out;
}

/** Draws the particles; `(cx, cy)` is the head's centre on the design grid. */
export function drawParticles(
  g: Pen &
    Pick<CanvasRenderingContext2D, 'translate' | 'rotate' | 'scale' | 'globalAlpha' | 'fillStyle' | 'strokeStyle'>,
  list: readonly Particle[],
  cx: number,
  cy: number,
): void {
  for (const p of list) {
    const alpha = particleAlpha(p);
    if (alpha <= 0) continue;
    const { x, y } = particlePosition(p);
    const size = p.scale * (1 + p.grow * Math.max(0, p.age));
    g.save();
    g.globalAlpha = alpha;
    g.translate(cx + x, cy + y);
    g.rotate(p.rotation);
    g.scale(size, size);
    g.fillStyle = p.color;
    g.strokeStyle = p.color;
    switch (p.type) {
      case 'spark':
        g.beginPath();
        g.moveTo(0, -3.4);
        g.lineTo(1, -1);
        g.lineTo(3.4, 0);
        g.lineTo(1, 1);
        g.lineTo(0, 3.4);
        g.lineTo(-1, 1);
        g.lineTo(-3.4, 0);
        g.lineTo(-1, -1);
        g.closePath();
        g.fill();
        break;
      case 'star':
        starPath(g, 0, 0, 3.6, 1.5);
        g.fill();
        break;
      case 'heart':
        heartPath(g, 0, 0, 7);
        g.fill();
        break;
      case 'sweat':
        g.beginPath();
        g.moveTo(0, -3.6);
        g.quadraticCurveTo(2.6, 0.4, 0, 2.6);
        g.quadraticCurveTo(-2.6, 0.4, 0, -3.6);
        g.closePath();
        g.fill();
        break;
      case 'z':
        g.beginPath();
        g.lineWidth = 1.3;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.moveTo(-2.6, -2.6);
        g.lineTo(2.6, -2.6);
        g.lineTo(-2.6, 2.6);
        g.lineTo(2.6, 2.6);
        g.stroke();
        break;
    }
    g.restore();
  }
}
