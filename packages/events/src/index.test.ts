import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@friday/events', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@friday/events');
  });
});
