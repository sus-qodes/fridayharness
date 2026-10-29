import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawBlip, faceLayout, MASCOT_NAME, parseColor, readPalette, rgbString } from './character.js';
import { type Gesture, MascotEngine, PITCH_LIMIT, seededRandom, YAW_LIMIT } from './engine.js';
import { EYE_SHAPES } from './eyes.js';
import { CX, R } from './geometry.js';
import { drawOutfitBehind, drawOutfitFront, isOutfit, OUTFITS } from './outfits.js';
import { MASCOT_STATES } from './states.js';
import { numbersOf, recordingContext } from './testing.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
});

describe('palette', () => {
  it('parses the colour forms the tokens use', () => {
    expect(parseColor('#38bdf8')).toEqual({ r: 0x38, g: 0xbd, b: 0xf8 });
    expect(parseColor(' #fff ')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('rgba(251, 113, 133, 0.65)')).toEqual({ r: 251, g: 113, b: 133 });
    expect(parseColor('rgb(300, 0, 0)')).toBeNull();
    expect(parseColor('url(x)')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(rgbString({ r: 300, g: -5, b: Number.NaN })).toBe('rgb(255, 0, 0)');
    expect(rgbString({ r: 1, g: 2, b: 3 }, 0.5)).toBe('rgba(1, 2, 3, 0.500)');
  });

  it('falls back to the token values when the page has none', () => {
    const p = readPalette(document.createElement('div'));
    expect(p.led).toBe('#22d3ee');
    expect(p.visor).toBe('#05080f');
    expect(p.tints['--color-amber']).toEqual({ r: 245, g: 158, b: 11 });
  });

  it('reads tokens from the page, refusing anything that is not a plain colour', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) =>
        name === '--mascot-led'
          ? ' #ff0000 '
          : name === '--mascot-visor'
            ? 'url(javascript:alert(1))'
            : name === '--color-amber'
              ? 'rgb(1, 2, 3)'
              : '',
    } as unknown as CSSStyleDeclaration);
    const p = readPalette(document.documentElement);
    expect(p.led).toBe('#ff0000');
    expect(p.visor).toBe('#05080f');
    expect(p.tints['--color-amber']).toEqual({ r: 1, g: 2, b: 3 });
  });

  it('survives a page where reading styles throws', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('no');
    });
    expect(readPalette().shell).toBe('#1e293b');
  });
});

describe('face layout', () => {
  it('keeps both eyes on the visor for every gaze within the limits', () => {
    for (let yaw = -YAW_LIMIT; yaw <= YAW_LIMIT + 1e-9; yaw += 0.17) {
      for (let pitch = -PITCH_LIMIT; pitch <= PITCH_LIMIT + 1e-9; pitch += 0.13) {
        const f = faceLayout(yaw, pitch);
        expect(f.left.x).toBeLessThan(f.right.x);
        for (const eye of [f.left, f.right]) {
          expect(eye.x - eye.w / 2).toBeGreaterThan(f.visor.x - f.visor.w / 2);
          expect(eye.x + eye.w / 2).toBeLessThan(f.visor.x + f.visor.w / 2);
          expect(eye.y - eye.h / 2).toBeGreaterThan(f.visor.y - f.visor.h / 2);
          expect(eye.y + eye.h / 2).toBeLessThan(f.visor.y + f.visor.h / 2);
        }
      }
    }
  });

  it('centres the face for a bad gaze, and turns the far eye narrower', () => {
    const f = faceLayout(Number.NaN, Number.NaN);
    expect(f.left.x + f.right.x).toBeCloseTo(2 * CX, 9);
    const turned = faceLayout(YAW_LIMIT, 0);
    expect(turned.right.w).toBeLessThan(turned.left.w);
    expect(turned.right.x).toBeGreaterThan(CX + R * 0.36);
  });
});

describe('drawing Blip', () => {
  const palette = readPalette(document.createElement('div'));

  it('is named Blip', () => {
    expect(MASCOT_NAME).toBe('Blip');
  });

  it('draws every state with every outfit using finite numbers', () => {
    const gestures: Gesture[] = ['jump', 'wink', 'droop', 'sweat'];
    for (const state of MASCOT_STATES) {
      for (const outfit of OUTFITS) {
        const e = new MascotEngine({ random: seededRandom(1) });
        e.setState(state);
        e.gesture(gestures[OUTFITS.indexOf(outfit) % gestures.length] ?? 'jump');
        e.setPointer({ dx: 200, dy: -80 });
        for (let i = 0; i < 12; i++) e.tick(1 / 60);
        const { g, log } = recordingContext();
        drawBlip(g, e.pose(), { size: 56, dpr: 2, outfit, palette });
        expect(numbersOf(log).every(Number.isFinite), `${state} ${outfit}`).toBe(true);
        expect(log.calls.some((c) => c.name === 'fill')).toBe(true);
        const saves = log.calls.filter((c) => c.name === 'save').length;
        const restores = log.calls.filter((c) => c.name === 'restore').length;
        expect(saves).toBe(restores);
      }
    }
  });

  it('draws every eye glyph', () => {
    for (const eyes of EYE_SHAPES) {
      const e = new MascotEngine({ random: seededRandom(2) });
      e.express(eyes, 5);
      const { g, log } = recordingContext();
      drawBlip(g, e.pose(), { size: 36, dpr: 1, outfit: 'none', palette });
      expect(numbersOf(log).every(Number.isFinite), eyes).toBe(true);
    }
  });

  it('clears and scales the canvas to its size and device ratio', () => {
    const e = new MascotEngine({ random: seededRandom(3) });
    const { g, log } = recordingContext();
    drawBlip(g, e.pose(), { size: 48, dpr: 2, outfit: 'none', palette });
    const transforms = log.calls.filter((c) => c.name === 'setTransform').map((c) => c.args);
    expect(transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
    expect(transforms[1]).toEqual([1, 0, 0, 1, 0, 0].map((v, i) => (i === 0 || i === 3 ? (48 / 96) * 2 : v)));
    expect(log.calls.find((c) => c.name === 'clearRect')?.args).toEqual([0, 0, 96, 96]);
  });

  it('shows a badge only when the canvas is large enough to read it', () => {
    const e = new MascotEngine({ random: seededRandom(4) });
    e.setState('approval');
    const count = (size: number) => {
      const { g, log } = recordingContext();
      drawBlip(g, e.pose(), { size, dpr: 1, outfit: 'none', palette });
      return log.calls.length;
    };
    expect(count(56)).toBeGreaterThan(count(24));
  });

  it('draws nothing for a nonsense size', () => {
    const e = new MascotEngine();
    const { g, log } = recordingContext();
    drawBlip(g, e.pose(), { size: Number.NaN, dpr: 1, outfit: 'none', palette });
    expect(log.calls).toHaveLength(0);
  });
});

describe('outfits', () => {
  it('knows the five outfits and none', () => {
    expect(OUTFITS).toEqual(['none', 'headphones', 'visor', 'winter', 'witch', 'sunglasses']);
    expect(isOutfit('witch')).toBe(true);
    expect(isOutfit('cape')).toBe(false);
  });

  it('draws the headphone band and the witch brim behind, the rest in front', () => {
    const palette = readPalette(document.createElement('div'));
    const pose = new MascotEngine().pose();
    const face = faceLayout(0, 0);
    for (const outfit of OUTFITS) {
      const behind = recordingContext();
      const front = recordingContext();
      drawOutfitBehind(behind.g, outfit, pose, palette, 1);
      drawOutfitFront(front.g, outfit, pose, palette, 1, face);
      const drewBehind = behind.log.calls.length > 0;
      const drewFront = front.log.calls.length > 0;
      expect(drewBehind, outfit).toBe(outfit === 'headphones' || outfit === 'witch');
      expect(drewFront, outfit).toBe(outfit !== 'none');
      expect(numbersOf(front.log).every(Number.isFinite)).toBe(true);
    }
  });
});
