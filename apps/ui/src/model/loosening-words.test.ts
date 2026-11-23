import { describe, expect, it } from 'vitest';
import { looseningExact, looseningLine, looseningWords } from './loosening-words.js';

const item = (setting: string, to = 'true', from = 'false', source = 'config.yaml') => ({ setting, to, from, source });

describe('what a project setting allows, in words (2026-11-17)', () => {
  it('says the settings Settings can turn on as what they allow', () => {
    expect(looseningWords(item('verification.auto_on_completion'))).toBe('Finished work is checked automatically');
    expect(looseningWords(item('master_brain.auto_approve'))).toBe('Plans start without waiting for your approval');
    expect(looseningWords(item('autonomy.package.install', 'auto'))).toBe('Agents may install packages without asking');
    expect(looseningWords(item('autonomy.unknown', 'auto'))).toBe(
      'Agents may run commands Friday does not recognise without asking',
    );
    expect(looseningWords(item('autonomy.git.push', 'auto'))).toBe('Agents may push to a remote without asking');
    expect(looseningWords(item('autonomy.git.push', 'review'))).toBe(
      'Agents may push to a remote once you approve it in Friday',
    );
  });

  it('says what a project file may ask for besides', () => {
    expect(looseningWords(item('sandbox'))).toContain('treated as disposable');
    expect(looseningWords(item('daemon.port', '4310'))).toBe('Friday always answers on port 4310');
    expect(looseningWords(item('worktrees.setup.command', 'npm ci'))).toBe(
      'Task folders are prepared by running: npm ci',
    );
    expect(looseningWords(item('execution.binaries', 'cargo'))).toBe('Checks may run the program “cargo”');
    expect(looseningWords(item('operations.deploy', 'node deploy.js; risk high'))).toBe(
      'Friday runs “deploy” for agents: node deploy.js; risk high',
    );
    expect(looseningWords(item('mcp.github.default', 'auto'))).toBe('Every tool of “github” runs without asking');
    expect(looseningWords(item('mcp.github.create_issue', 'auto'))).toBe(
      'The tool “create_issue” of “github” runs without asking',
    );
  });

  it('has no words for a setting it does not know, which is then shown as written', () => {
    expect(looseningWords(item('risk.file.delete', 'low'))).toBeNull();
    expect(looseningWords(item('autonomy.something.else', 'auto'))).toBeNull();
    expect(looseningWords(item('autonomy.package.install', 'manual'))).toBeNull();
    expect(looseningLine(item('risk.file.delete', 'low', 'high', '.friday/policies/x.yaml'))).toBe(
      'risk.file.delete: high → low (.friday/policies/x.yaml)',
    );
  });

  it('keeps the exact setting beside the words: trust is in exactly that', () => {
    const l = item('verification.auto_on_completion', 'true', 'false', '.friday/config.yaml');
    expect(looseningExact(l)).toBe('verification.auto_on_completion: false → true');
    expect(looseningLine(l)).toBe(
      'Finished work is checked automatically (verification.auto_on_completion: false → true, .friday/config.yaml)',
    );
  });

  it('shows hidden characters of a project file as visible marks, and shortens what is long', () => {
    const hostile = item('operations.deploy', `node x.js ${String.fromCodePoint(0x202e)}gpj.exe`);
    expect(looseningWords(hostile)).toContain('⟨U+202E⟩');
    expect(looseningLine(hostile)).not.toContain(String.fromCodePoint(0x202e));
    const long = item('worktrees.setup.command', 'x'.repeat(5000));
    expect((looseningWords(long) ?? '').length).toBeLessThan(260);
  });
});
