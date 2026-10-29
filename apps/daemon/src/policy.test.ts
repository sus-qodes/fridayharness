/**
 * The policy read again when its files change (LESSONS D-43), and kept while a file is caught half
 * written.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type EffectivePolicy, reloadingPolicy } from './policy.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fpol-'));
  roots.push(root);
  const dir = path.join(root, '.friday', 'policies');
  mkdirSync(dir, { recursive: true });
  let now = 0;
  let unreadable = 0;
  let loads = 0;
  const load = () => {
    loads += 1;
    const errors = Array.from({ length: unreadable }, (_, i) => ({ file: `policies/f${i}.yaml`, error: 'bad' }));
    return { version: `v${loads}`, errors } as unknown as EffectivePolicy;
  };
  const why: string[] = [];
  const policy = reloadingPolicy({
    projectRoot: root,
    initial: load(),
    load,
    onLoad: (_, w) => why.push(w),
    now: () => now,
    settleMs: 1000,
  });
  return {
    policy,
    why,
    write: (name: string, text: string) => writeFileSync(path.join(dir, name), text),
    wait: (ms: number) => {
      now += ms;
    },
    unreadable: (n: number) => {
      unreadable = n;
    },
    loads: () => loads,
  };
}

describe('the policy read again when its files change', () => {
  it('reads the files again only when they changed', () => {
    const s = setup();
    expect(s.policy.current().version).toBe('v1');
    expect(s.policy.current().version).toBe('v1');
    expect(s.loads()).toBe(1);
    s.write('infra.yaml', 'deny:\n  write: ["infra/**"]\n');
    expect(s.policy.current().version).toBe('v2');
    expect(s.policy.current().version).toBe('v2');
    expect(s.loads()).toBe(2);
    expect(s.why).toEqual(['files changed']);
  });

  it('keeps the policy in force while a file it cannot read may be half written, then reports it', () => {
    const s = setup();
    s.write('infra.yaml', 'deny:\n  write: ["infra/**"]\n');
    s.unreadable(1);
    expect(s.policy.current().version).toBe('v1');
    s.wait(600);
    expect(s.policy.current().version).toBe('v1');
    s.wait(500);
    const p = s.policy.current();
    expect(p.errors).toHaveLength(1);
    // Fixed: a readable file applies at once.
    s.unreadable(0);
    s.write('infra.yaml', 'deny:\n  write: ["infra/**", "docs/**"]\n');
    expect(s.policy.current().errors).toHaveLength(0);
  });

  it('applies a requested reload at once, readable or not', () => {
    const s = setup();
    s.unreadable(1);
    expect(s.policy.reload().errors).toHaveLength(1);
    expect(s.why).toEqual(['requested']);
  });
});
