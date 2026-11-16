/**
 * Two rules every panel shares: a cancelled desktop confirmation shows no error beside the form,
 * and no "Restart Friday" runs while config.yaml cannot be read (Friday would not start again).
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { actWithError, restartBlocked } from './common.js';
import { HOSTILE } from './test-support.js';

describe('actWithError', () => {
  it('shows a refusal beside the form, and nothing for a cancelled confirmation', async () => {
    const ctx = makeContext();
    const shown: string[] = [];
    const refused = await actWithError(
      ctx,
      'Land the goal',
      async () => {
        throw new ApiError(400, 'COS-1000', 'invalid_request', 'git did not merge');
      },
      (e) => shown.push(e.message),
    );
    expect(refused).toBeUndefined();
    expect(shown).toEqual(['git did not merge']);
    const cancelled = await actWithError(
      ctx,
      'Land the goal',
      async () => {
        throw new ApiError(400, 'DESKTOP-1003', 'cancelled', 'you cancelled it in the confirmation dialog');
      },
      (e) => shown.push(e.message),
    );
    expect(cancelled).toBeUndefined();
    expect(shown).toEqual(['git did not merge']);
  });
});

describe('restartBlocked', () => {
  it('lets a restart run while config.yaml reads, and stops it with the reason while it does not', () => {
    const ok = makeContext();
    expect(restartBlocked(ok)).toBe(false);
    expect(ok.toasts).toEqual([]);
    const changed = makeContext({
      snapshot: makeSnapshot({
        config: {
          loaded_hash: 'h1',
          current_hash: 'h2',
          changes: { applied: [], restart_needed: ['master_brain.provider'], error: null },
        },
      }),
    });
    expect(restartBlocked(changed)).toBe(false);
    const broken = makeContext({
      snapshot: makeSnapshot({
        config: {
          loaded_hash: 'h1',
          current_hash: null,
          changes: { applied: [], restart_needed: [], error: `config.yaml: ${HOSTILE}` },
        },
      }),
    });
    expect(restartBlocked(broken)).toBe(true);
    expect(broken.toasts).toHaveLength(1);
    expect(broken.toasts[0]).toMatchObject({ kind: 'warn' });
    expect(broken.toasts[0]?.detail).toContain('config.yaml:');
  });
});
