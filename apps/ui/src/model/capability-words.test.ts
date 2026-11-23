import { describe, expect, it } from 'vitest';
import { capabilityWords, knownCapability } from './capability-words.js';

describe('what an agent asks to do, in words (2026-11-17)', () => {
  it('says each capability of the policy as the act it is', () => {
    expect(capabilityWords('package.install')).toBe('Install packages');
    expect(capabilityWords('shell.git.commit')).toBe('Commit or change branches');
    expect(capabilityWords('shell.git.push')).toBe('Push to a remote');
    expect(capabilityWords('file.delete')).toBe('Delete a file');
    expect(capabilityWords('process.spawn')).toBe('Run a command');
    expect(capabilityWords('mcp.call')).toBe('Use a tool of a connected server');
    for (const c of ['file.read', 'file.write', 'network.read', 'secret.resolve', 'operation.run']) {
      expect(knownCapability(c), c).toBe(true);
      expect(capabilityWords(c), c).not.toContain('.');
    }
  });

  it('shows one it does not know as written, hidden characters marked, and shortened', () => {
    expect(knownCapability('future.thing')).toBe(false);
    expect(capabilityWords('future.thing')).toBe('future.thing');
    expect(capabilityWords(`x${String.fromCodePoint(0x202e)}y`)).toBe('x⟨U+202E⟩y');
    expect(capabilityWords('c'.repeat(500)).length).toBeLessThanOrEqual(81);
    // A name of the object's own does not pass for a capability.
    expect(knownCapability('constructor')).toBe(false);
  });
});
