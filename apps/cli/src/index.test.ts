import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@friday/cli', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@friday/cli');
  });
});
