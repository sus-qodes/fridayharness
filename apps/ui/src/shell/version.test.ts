import { describe, expect, it } from 'vitest';
import { builtWords, UI_VERSION, versionWords } from './version.js';

describe('which build this is (2026-11-18)', () => {
  it('says when the bundle was built, beside the version', () => {
    const words = versionWords('2026-11-18T00:17:00.000Z');
    expect(words.startsWith(`Friday ${UI_VERSION} · built `)).toBe(true);
    expect(builtWords('2026-11-18T00:17:00.000Z')).toMatch(/\d/);
  });

  it('says the version alone when the build did not say, or said nonsense', () => {
    expect(versionWords(null)).toBe(`Friday ${UI_VERSION}`);
    expect(versionWords('not a date')).toBe(`Friday ${UI_VERSION}`);
  });
});
