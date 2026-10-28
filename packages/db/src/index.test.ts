import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@friday/db', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@friday/db');
  });
});
