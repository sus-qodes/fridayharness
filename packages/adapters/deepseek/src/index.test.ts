import { describe, expect, it } from 'vitest';
import { deepseekBlock, findDeepSeekHarness, findOnPath, mergeDeepSeekConfig } from './index.js';

const L = 'C:/state/hosts/friday-local-mcp.mjs';

describe('the DeepSeek Harness skeleton (ADR-0036)', () => {
  it('adds, replaces and removes one marked block, keeping the rest byte for byte', () => {
    expect(mergeDeepSeekConfig(null, L, true)).toBe(deepseekBlock(L));
    const user = 'model: deepseek-flash\nplugins:\n  - cordis\n';
    const added = mergeDeepSeekConfig(user, L, true) as string;
    expect(added.startsWith(`${user}\n${'# >>> friday'}`)).toBe(true);
    expect(added).toContain(`args: [${JSON.stringify(L)}]`);
    // Already there: nothing changes.
    expect(mergeDeepSeekConfig(added, L, true)).toBe(added);
    // A new launcher path replaces the block in place.
    const moved = mergeDeepSeekConfig(added, 'D:/elsewhere/friday-local-mcp.mjs', true) as string;
    expect(moved.startsWith(`${user}\n`)).toBe(true);
    expect(moved).toContain('D:/elsewhere');
    expect(moved).not.toContain(L);
    // Removed: the user's file as it was; a file that was only Friday's goes.
    expect(mergeDeepSeekConfig(added, L, false)).toBe(user);
    expect(mergeDeepSeekConfig(deepseekBlock(L), L, false)).toBeNull();
    expect(mergeDeepSeekConfig(null, L, false)).toBeNull();
  });

  it('never touches a file that declares mcp_servers itself', () => {
    expect(mergeDeepSeekConfig('mcp_servers:\n  other: {}\n', L, true)).toBe('manual');
  });

  it('detects installation without starting the host', () => {
    expect(findDeepSeekHarness({ PATH: '' })).toEqual({
      binary: null,
      version: null,
      problem: 'dsh is not on PATH',
    });
    expect(findOnPath('surely-not-a-binary-on-this-machine', process.env)).toBeNull();
  });
});
