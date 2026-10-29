/**
 * The per-user secret store with DPAPI on Windows, and the operation schema (plan M6c, ADR-0029).
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  credentialsDir,
  dpapiAvailable,
  hasSecret,
  listSecrets,
  parseConfig,
  readPolicySources,
  removeSecret,
  renderInitialConfig,
  resolveSecret,
  secretProtection,
  storeSecret,
} from './index.js';

const PID = 'proj_0000000000000000000000000a';
const VALUE = 'sk_test_51Hfriday0123456789abcdefXYZ';

describe('secret store', () => {
  const ws = useTestWorkspace();
  const env = () => ({ ...process.env, FRIDAY_STATE_DIR: ws().stateDir });

  it('keeps a plain user-only file when asked to, and never lists values', async () => {
    const e = { ...env(), FRIDAY_SECRET_STORE: 'file' };
    const stored = await storeSecret('stripe-test', `  ${VALUE}\n`, e);
    expect(stored.protection).toBe('file');
    expect(readFileSync(stored.path, 'utf8')).toBe(`${VALUE}\n`);
    expect(await resolveSecret('stripe-test', e)).toBe(VALUE);
    expect(hasSecret('stripe-test', e)).toBe(true);
    expect(secretProtection('stripe-test', e)).toBe('file');
    expect(listSecrets(e)).toEqual(['stripe-test']);
    expect(removeSecret('stripe-test', e)).toBe(true);
    expect(await resolveSecret('stripe-test', e)).toBeUndefined();
    await expect(storeSecret('Stripe Key', VALUE, e)).rejects.toThrow(/lowercase/);
    await expect(storeSecret('stripe', 'two words', e)).rejects.toThrow(/whitespace/);
  });

  it.runIf(dpapiAvailable())(
    'encrypts with DPAPI on Windows, and a value copied under another name does not decrypt',
    async () => {
      const stored = await storeSecret('stripe-test', VALUE, env());
      expect(stored.protection).toBe('dpapi');
      const text = readFileSync(stored.path, 'utf8');
      expect(text.startsWith('friday-dpapi:1:')).toBe(true);
      expect(text).not.toContain(VALUE);
      expect(text).not.toContain(Buffer.from(VALUE).toString('base64'));
      expect(await resolveSecret('stripe-test', env())).toBe(VALUE);
      expect(secretProtection('stripe-test', env())).toBe('dpapi');
      copyFileSync(stored.path, path.join(credentialsDir(env()), 'other.key'));
      expect(await resolveSecret('other', env())).toBeUndefined();
    },
    60_000,
  );
});

describe('operations in the config and in policy files (ADR-0029 §1)', () => {
  const ws = useTestWorkspace();
  const base = renderInitialConfig(PID, 'shop');

  it('parses an operation with defaults, and refuses what the profile sets itself', () => {
    const c = parseConfig(
      `${base}\noperations:\n  stripe-test:\n    command: node\n    args: ["--test"]\n    credentials: { STRIPE_SECRET_KEY: stripe-test }\nexecution:\n  binaries: [make]\n`,
    );
    expect(c.operations['stripe-test']).toEqual({
      command: 'node',
      args: ['--test'],
      env: {},
      credentials: { STRIPE_SECRET_KEY: 'stripe-test' },
      timeout_ms: 120_000,
      roles: [],
    });
    expect(c.execution).toEqual({ binaries: ['make'], env_passthrough: [] });
    const bad = (op: string) => () => parseConfig(`${base}\noperations:\n  x:\n${op}`);
    expect(bad('    command: node\n    env: { PATH: /tmp }\n')).toThrow(/not PATH/);
    expect(bad('    command: node\n    env: { FRIDAY_STATE_DIR: x }\n')).toThrow(/FRIDAY_/);
    expect(bad('    command: ./run.sh\n')).toThrow(/binary name/);
    expect(bad('    command: node\n    cwd: ../elsewhere\n')).toThrow(/inside the checkout/);
    expect(bad('    command: node\n    shell: true\n')).toThrow(/shell/);
    expect(bad('    command: node\n    credentials: { KEY: Stripe }\n')).toThrow(/lowercase/);
  });

  it('reads operations from config.yaml and from policy files as policy sources', () => {
    const root = ws().projectDir;
    mkdirSync(path.join(root, '.friday', 'policies'), { recursive: true });
    writeFileSync(
      path.join(root, '.friday', 'policies', 'ops.yaml'),
      'operations:\n  lint:\n    command: node\n    args: [lint.mjs]\nexecution:\n  env_passthrough: [JAVA_HOME]\n',
    );
    const config = parseConfig(`${base}\noperations:\n  build:\n    command: pnpm\n    args: [build]\n`);
    const { sources, errors } = readPolicySources(root, config);
    expect(errors).toEqual([]);
    expect(sources.map((s) => [s.name, Object.keys(s.operations ?? {})])).toEqual([
      ['config.yaml', ['build']],
      ['policies/ops.yaml', ['lint']],
    ]);
    expect(sources[1]?.execution).toEqual({ binaries: [], env_passthrough: ['JAVA_HOME'] });
    expect(sources[0]?.auto_verification).toBe(false);
  });
});
