import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DrawerKind } from '../shell/context.js';
import { makeContext } from '../test/context.js';
import { makeScenario } from '../test/fixtures.js';
import { registerDrawers } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('registerDrawers', () => {
  it('registers the five drawers, each returning content, a title and destroy', () => {
    vi.useFakeTimers();
    try {
      const ctx = makeContext({ snapshot: makeScenario() });
      registerDrawers(ctx);
      const kinds = ['inspector', 'diff', 'graph', 'memory', 'terminal'] as const satisfies readonly DrawerKind[];
      expect([...ctx.registry.drawers.keys()].sort()).toEqual([...kinds].sort());
      const requests = {
        inspector: { kind: 'inspector', id: 'task_00000000000000000000api001' },
        diff: { kind: 'diff', id: 'task_00000000000000000000api001' },
        graph: { kind: 'graph', path: 'backend/src/a.ts' },
        memory: { kind: 'memory' },
        terminal: { kind: 'terminal', id: 'claude-1' },
      } as const;
      for (const kind of kinds) {
        const factory = ctx.registry.drawers.get(kind);
        const drawer = factory?.(ctx, requests[kind]);
        expect(drawer?.el).toBeInstanceOf(HTMLElement);
        expect(drawer?.title.length).toBeGreaterThan(0);
        drawer?.destroy();
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the drawer sources', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.ts'));
  const page = files.filter((f) => !f.endsWith('.test.ts'));

  it('never parse HTML, set inline styles by attribute, or name the loopback host by word', () => {
    const banned = [
      // Built from parts, so this file does not contain the words it looks for.
      new RegExp(['\\.inner', 'HTML\\b'].join('')),
      new RegExp(['\\.outer', 'HTML\\b'].join('')),
      new RegExp(['insertAdjacent', 'HTML'].join('')),
      new RegExp(['document', '\\.write'].join('')),
      /setAttribute\(\s*['"]style['"]/,
      /setAttribute\(\s*['"]on/,
      new RegExp(['local', 'host'].join(''), 'i'),
      /\bfetch\(/,
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(path.join(HERE, f), 'utf8');
      for (const re of banned) if (re.test(text)) offenders.push(`${f}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });

  it('import shared packages for types only, and nothing from Node', () => {
    const offenders: string[] = [];
    for (const f of page) {
      const text = readFileSync(path.join(HERE, f), 'utf8');
      for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[2] ?? '';
        if (spec.startsWith('@friday/') && !m[1]) offenders.push(`${f}: value import of ${spec}`);
        if (spec.startsWith('node:')) offenders.push(`${f}: ${spec}`);
      }
      if (/\bprocess\.|\bBuffer\b/.test(text)) offenders.push(`${f}: Node global`);
    }
    expect(offenders).toEqual([]);
  });

  it('use only `dr-` classes of their own in the stylesheet', () => {
    const css = readFileSync(path.join(HERE, '..', 'styles', 'drawers.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string);
    // Shared classes appear only as descendants of a drawer's own class (`.dr-scope .pill`).
    const shared = new Set(['input', 'select', 'pill', 'section-title']);
    expect(classes.filter((c) => !c.startsWith('dr-') && !shared.has(c))).toEqual([]);
    expect(css).not.toMatch(/!important/);
  });
});
