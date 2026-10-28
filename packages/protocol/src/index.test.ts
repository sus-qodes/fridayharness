import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@friday/protocol', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@friday/protocol');
  });
});
