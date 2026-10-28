import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@friday/adapter-claude', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@friday/adapter-claude');
  });
});
