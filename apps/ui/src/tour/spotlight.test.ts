import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpotlight, defaultSpotlightEnv, type SpotlightHandle } from './spotlight.js';

function fakeViewportEnv(width = 1280, height = 800) {
  return { doc: document, viewport: () => ({ width, height }) };
}

let spot: SpotlightHandle | null = null;

afterEach(() => {
  spot?.destroy();
  spot = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('the spotlight', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('starts hidden and shows around a target', () => {
    spot = createSpotlight(fakeViewportEnv());
    expect(spot.visible).toBe(false);
    expect(spot.el.hidden).toBe(true);
    spot.highlight({ x: 400, y: 200, width: 160, height: 60 });
    expect(spot.visible).toBe(true);
    expect(spot.el.hidden).toBe(false);
    expect(spot.el.querySelectorAll('.tour-shade')).toHaveLength(4);
    const ring = spot.el.querySelector<HTMLElement>('.tour-ring');
    expect(ring?.style.display).toBe('');
    expect(ring?.style.top).toBe('193px');
    expect(ring?.style.left).toBe('393px');
    expect(ring?.style.width).toBe('174px');
    expect(ring?.style.height).toBe('74px');
  });

  it('positions four shade strips around the hole', () => {
    spot = createSpotlight(fakeViewportEnv(1000, 600));
    spot.highlight({ x: 300, y: 200, width: 100, height: 50 });
    const shades = [...spot.el.querySelectorAll<HTMLElement>('.tour-shade')];
    const top = shades[0] as HTMLElement;
    const bottom = shades[1] as HTMLElement;
    const left = shades[2] as HTMLElement;
    const right = shades[3] as HTMLElement;
    expect(top.style.height).toBe('193px');
    expect(top.style.width).toBe('1000px');
    expect(bottom.style.top).toBe('257px');
    expect(bottom.style.height).toBe('343px');
    expect(left.style.top).toBe('193px');
    expect(left.style.width).toBe('293px');
    expect(right.style.left).toBe('407px');
    expect(right.style.width).toBe('593px');
  });

  it('clamps the hole to the viewport', () => {
    spot = createSpotlight(fakeViewportEnv(1000, 600));
    spot.highlight({ x: -50, y: -50, width: 40, height: 40 });
    const ring = spot.el.querySelector<HTMLElement>('.tour-ring');
    expect(ring?.style.top).toBe('0px');
    expect(ring?.style.left).toBe('0px');
  });

  it('dims everything with no hole for a null target', () => {
    spot = createSpotlight(fakeViewportEnv(1000, 600));
    spot.highlight(null);
    const shades = [...spot.el.querySelectorAll<HTMLElement>('.tour-shade')];
    for (const s of shades) {
      expect(s.style.top).toBe('0px');
      expect(s.style.width).toBe('1000px');
      expect(s.style.height).toBe('600px');
    }
    expect(spot.el.querySelector<HTMLElement>('.tour-ring')?.style.display).toBe('none');
  });

  it('clear() hides the overlay', () => {
    spot = createSpotlight(fakeViewportEnv());
    spot.highlight({ x: 1, y: 1, width: 10, height: 10 });
    spot.clear();
    expect(spot.visible).toBe(false);
    expect(spot.el.hidden).toBe(true);
  });

  it('is a component: mounts and removes cleanly', () => {
    spot = createSpotlight(defaultSpotlightEnv());
    document.body.append(spot.el);
    expect(document.querySelector('.tour-spotlight')).not.toBeNull();
    spot.destroy();
    expect(document.querySelector('.tour-spotlight')).toBeNull();
    spot = null;
  });
});

describe('the spotlight env', () => {
  it('defaults to the window size', () => {
    const env = defaultSpotlightEnv();
    const vp = env.viewport();
    expect(vp.width).toBeGreaterThan(0);
    expect(env.doc).toBe(document);
  });
});
