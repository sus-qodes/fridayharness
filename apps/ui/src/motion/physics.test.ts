import { describe, expect, it, vi } from 'vitest';
import { AppleSpring, animateSpring, PhysicsSpring } from './physics.js';

describe('PhysicsSpring', () => {
  it('initializes to initial value and settled state', () => {
    const s = new PhysicsSpring(100);
    expect(s.current).toBe(100);
    expect(s.target).toBe(100);
    expect(s.velocity).toBe(0);
    expect(s.moving).toBe(false);
    expect(s.settled).toBe(true);
  });

  it('moves toward target under Hookes law', () => {
    const s = new PhysicsSpring(0, AppleSpring.Snappy);
    s.setTarget(100);
    expect(s.moving).toBe(true);
    expect(s.settled).toBe(false);

    let steps = 0;
    while (s.step(1 / 60) && steps < 200) {
      steps++;
    }

    expect(s.current).toBe(100);
    expect(s.velocity).toBe(0);
    expect(s.settled).toBe(true);
    expect(steps).toBeLessThan(120);
  });

  it('jumps to target immediately without motion', () => {
    const s = new PhysicsSpring(0, AppleSpring.Bouncy);
    s.jump(250);
    expect(s.current).toBe(250);
    expect(s.velocity).toBe(0);
    expect(s.settled).toBe(true);
  });

  it('survives non-finite targets gracefully', () => {
    const s = new PhysicsSpring(50);
    s.setTarget(Number.NaN);
    expect(s.target).toBe(50);
    s.setTarget(Number.POSITIVE_INFINITY);
    expect(s.target).toBe(50);
  });

  it('animates via animateSpring and calls onComplete', () => {
    vi.useFakeTimers();
    let val = 0;
    let completed = false;
    let frameCb: FrameRequestCallback | null = null;
    let idCounter = 1;

    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frameCb = cb;
      return idCounter++;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      frameCb = null;
    });

    const cancel = animateSpring(
      (v) => {
        val = v;
      },
      0,
      100,
      AppleSpring.Snappy,
      () => {
        completed = true;
      },
    );

    let time = 0;
    for (let i = 0; i < 60; i++) {
      if (!frameCb) break;
      time += 16.6;
      const cb: FrameRequestCallback = frameCb;
      frameCb = null;
      cb(time);
    }

    expect(val).toBeGreaterThan(0);
    expect(completed).toBe(true);
    cancel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
