import { describe, expect, it } from 'vitest';
import { lineDiff } from './plugins.js';

describe('lineDiff', () => {
  it('shows added and removed lines and keeps common ones out', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual(['+ B', '- b', '+ d']);
    expect(lineDiff('same\n', 'same\n')).toEqual([]);
    expect(lineDiff('', 'x')).toEqual(['+ x', '- ']);
  });

  it('keeps user lines in place around inserted ones', () => {
    const before = ['{', '  "model": "opus"', '}'].join('\n');
    const after = ['{', '  "model": "opus",', '  "hooks": {}', '}'].join('\n');
    expect(lineDiff(before, after)).toEqual(['+   "model": "opus",', '+   "hooks": {}', '-   "model": "opus"']);
  });
});
