import { describe, expect, it } from 'vitest';
import { drawEye, EYE_SHAPES, EYES, type EyeShape, isEyeShape, MIN_LID } from './eyes.js';
import { numbersOf, recordingContext } from './testing.js';

describe('eye glyphs', () => {
  it('has fourteen distinct shapes, each with a glyph', () => {
    expect(EYE_SHAPES).toHaveLength(14);
    expect(new Set(EYE_SHAPES).size).toBe(14);
    expect(Object.keys(EYES).sort()).toEqual([...EYE_SHAPES].sort());
    expect(EYE_SHAPES).toEqual(
      expect.arrayContaining([
        'pill',
        'wide',
        'dot',
        'line',
        'flat',
        'happy',
        'closed',
        'spiral',
        'heart',
        'star',
        'tired',
        'wink',
        'cup',
        'x',
      ]),
    );
    expect(isEyeShape('x')).toBe(true);
    expect(isEyeShape('monocle')).toBe(false);
    expect(isEyeShape(3)).toBe(false);
  });

  it('draws every shape on both sides with finite numbers and something lit', () => {
    for (const shape of EYE_SHAPES) {
      for (const side of [-1, 1] as const) {
        for (const lid of [0, 0.5, 1, Number.NaN]) {
          const { g, log } = recordingContext();
          drawEye(g, shape, 30, 40, 6, 10, side, lid);
          const nums = numbersOf(log);
          expect(nums.every(Number.isFinite), `${shape} side ${side} lid ${lid}`).toBe(true);
          expect(
            log.calls.some((c) => c.name === 'fill' || c.name === 'stroke'),
            shape,
          ).toBe(true);
        }
      }
    }
  });

  it('blinks only the open shapes', () => {
    const blinking = EYE_SHAPES.filter((s) => EYES[s].blinks).sort();
    expect(blinking).toEqual(['dot', 'flat', 'pill', 'tired', 'wide']);
  });

  it('never closes an LED to nothing', () => {
    const height = (lid: number) => {
      const { g, log } = recordingContext();
      drawEye(g, 'pill', 0, 0, 6, 10, 1, lid);
      const ys = log.calls.filter((c) => c.name === 'arcTo').flatMap((c) => [c.args[1] as number, c.args[3] as number]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(height(1)).toBeCloseTo(10, 6);
    expect(height(0)).toBeCloseTo(10 * MIN_LID, 6);
    expect(height(0.5)).toBeCloseTo(5, 6);
  });

  it('winks with one eye: the left stays open, the right smiles', () => {
    const calls = (side: -1 | 1) => {
      const { g, log } = recordingContext();
      drawEye(g, 'wink', 0, 0, 6, 10, side, 1);
      return log.calls.map((c) => c.name);
    };
    expect(calls(-1)).toContain('fill');
    expect(calls(-1)).not.toContain('stroke');
    expect(calls(1)).toContain('stroke');
  });

  it('ignores the lid for shapes that do not blink, and falls back to pill for unknown shapes', () => {
    const run = (shape: EyeShape, lid: number) => {
      const { g, log } = recordingContext();
      drawEye(g, shape, 0, 0, 6, 10, 1, lid);
      return JSON.stringify(log.calls);
    };
    expect(run('happy', 0)).toBe(run('happy', 1));
    expect(run('x', 0)).toBe(run('x', 1));
    expect(run('unknown' as EyeShape, 1)).toBe(run('pill', 1));
  });
});
