import { describe, expect, it } from 'vitest';
import type { MemoryHit } from '../api/client.js';
import type { LogLine } from '../store/state.js';
import { makeEvent } from '../test/fixtures.js';
import { claimedPaths, discrepancies, hasDiscrepancy } from './discrepancy.js';
import { actorLabel, describeEvent, mayHaveOlder, mergeEvents, olderBefore } from './events.js';
import { authorityLook, filterMemories, HALF_LIFE_DAYS, recencyBar, sortMemories } from './memory-model.js';
import {
  clampHeight,
  clearPoint,
  DEFAULT_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  processClearPoint,
  processLines,
  startTab,
  visibleLines,
} from './terminal-model.js';

const NOW = Date.parse('2026-10-17T10:00:00.000Z');
const DAY = 86_400_000;

describe('History lines', () => {
  it('reads transitions, reasons and actors', () => {
    const line = describeEvent(
      makeEvent(
        5,
        'task.released',
        { transition: { from: 'RUNNING', to: 'READY', trigger: 'release', reason: 'halted' } },
        { kind: 'human', id: 'local-operator' },
      ),
    );
    expect(line.text).toBe('Released: Running → Ready · halted');
    expect(line.actor).toBe('you');
    expect(line.sequence).toBe(5);
  });

  it.each([
    ['task.waiting', { waiting_reason: 'blocked' }, 'Waiting: blocked: needs you'],
    ['run.created', { run: { attempt: 2 } }, 'Attempt created: attempt 2'],
    ['task.completion_claimed', { summary: 'Done it' }, 'Agent claimed it is done: "Done it"'],
    ['approval.decided', { status: 'granted', via: 'ui', note: 'ok' }, 'Approval decided: granted · via ui · "ok"'],
    ['verification.finished', { status: 'PASSED', summary: '3/3' }, 'Verification finished: passed · 3/3'],
    ['something.new', {}, 'Something new'],
  ])('%s', (type, payload, text) => {
    expect(describeEvent(makeEvent(1, type, payload)).text).toBe(text);
  });

  it('tones by outcome', () => {
    expect(describeEvent(makeEvent(1, 'task.completed')).tone).toBe('good');
    expect(describeEvent(makeEvent(1, 'task.failed')).tone).toBe('danger');
    expect(describeEvent(makeEvent(1, 'verification.finished', { status: 'FAILED' })).tone).toBe('danger');
    expect(describeEvent(makeEvent(1, 'task.ready')).tone).toBe('info');
  });

  it('cleans and shortens hostile payload text', () => {
    const hostile = `<img src=x onerror=alert(1)>‮evil\u001b[31m${'x'.repeat(5000)}`;
    const line = describeEvent(makeEvent(1, 'task.waiting', { reason: hostile }));
    expect(line.text).not.toContain('‮');
    expect(line.text).not.toContain('\u001b');
    expect(line.text).toContain('<img src=x onerror=alert(1)>');
    expect(Array.from(line.text).length).toBeLessThanOrEqual(600);
  });

  it('names who acted', () => {
    expect(actorLabel({ kind: 'agent', id: 'agent_0000000000000000abc' })).toBe('agent agent_00000000');
    expect(actorLabel({ kind: 'system', id: 'friday' })).toBe('Friday');
    expect(actorLabel({ kind: 'master_brain', id: 'mb' })).toBe('Master Brain');
    expect(actorLabel(null)).toBe('Friday');
  });

  it('pages older events by the oldest sequence shown', () => {
    const first = [makeEvent(300, 'a'), makeEvent(250, 'b'), makeEvent(280, 'c')];
    expect(olderBefore(first)).toBe(250);
    expect(olderBefore([])).toBeNull();
    const merged = mergeEvents(first, [makeEvent(250, 'b'), makeEvent(10, 'd')]);
    expect(merged.map((e) => e.sequence)).toEqual([300, 280, 250, 10]);
    expect(mayHaveOlder(Array.from({ length: 100 }, (_, i) => makeEvent(i + 1, 'x')))).toBe(true);
    expect(mayHaveOlder(first)).toBe(false);
  });
});

function hit(overrides: Partial<MemoryHit> = {}): MemoryHit {
  return {
    memory_id: 'mem_1',
    scope_type: 'project',
    scope_id: 'proj_1',
    kind: 'decision',
    subject: 'Use the AuthService',
    content: 'Do not call vendor SDKs directly',
    tags: ['auth'],
    authority: 'agent',
    verification_status: 'unverified',
    status: 'active',
    needs_review: false,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    score: 0.5,
    why: { relevance: 1, weight: 0.4, uses: 0 },
    ...overrides,
  };
}

describe('memory model', () => {
  it.each([
    ['agent', 30],
    ['system', 90],
    ['verified', 180],
  ])('%s memories lose half their recency in %i days', (authority, days) => {
    const bar = recencyBar(hit({ authority, updated_at: new Date(NOW - days * DAY).toISOString() }), NOW);
    expect(bar.fraction).toBeCloseTo(0.5, 5);
    expect(bar.halfLifeDays).toBe(days);
    expect(bar.permanent).toBe(false);
    expect(bar.label).toContain(`half-life ${days} d`);
    expect(HALF_LIFE_DAYS[authority]).toBe(days);
  });

  it('never fades a human-approved memory', () => {
    const bar = recencyBar(
      hit({ authority: 'human-approved', updated_at: new Date(NOW - 900 * DAY).toISOString() }),
      NOW,
    );
    expect(bar).toMatchObject({ fraction: 1, permanent: true });
    expect(bar.label).toContain('never fades');
  });

  it('reads the weight defensively', () => {
    expect(recencyBar(hit({ why: { weight: 7 } }), NOW).weight).toBe(1);
    expect(recencyBar(hit({ why: { weight: 'x' } }), NOW).weight).toBeNull();
    const noWhy = hit();
    delete noWhy.why;
    expect(recencyBar(noWhy, NOW).weight).toBeNull();
    expect(recencyBar(hit({ updated_at: 'not a date' }), NOW).fraction).toBe(1);
  });

  it('filters by kind and scope on the client', () => {
    const list = [
      hit({ memory_id: 'a', kind: 'decision', scope_type: 'project' }),
      hit({ memory_id: 'b', kind: 'convention', scope_type: 'task' }),
      hit({ memory_id: 'c', kind: 'decision', scope_type: 'task' }),
    ];
    expect(filterMemories(list, { kind: '', scope: '' }).map((m) => m.memory_id)).toEqual(['a', 'b', 'c']);
    expect(filterMemories(list, { kind: 'decision', scope: '' }).map((m) => m.memory_id)).toEqual(['a', 'c']);
    expect(filterMemories(list, { kind: 'decision', scope: 'task' }).map((m) => m.memory_id)).toEqual(['c']);
  });

  it('pins human-approved memories first, then sorts by score and recency', () => {
    const list = [
      hit({ memory_id: 'low', score: 0.1 }),
      hit({ memory_id: 'pinned', authority: 'human-approved', score: 0.05 }),
      hit({ memory_id: 'high', score: 0.9 }),
      hit({ memory_id: 'tie-new', score: 0.1, updated_at: new Date(NOW + 1000).toISOString() }),
    ];
    expect(sortMemories(list).map((m) => m.memory_id)).toEqual(['pinned', 'high', 'tie-new', 'low']);
    expect(authorityLook('human-approved').tone).toBe('strong');
    expect(authorityLook('other').label).toBe('other');
  });
});

describe('terminal model', () => {
  const log: LogLine[] = [
    { at: 1, sequence: 10, stream: 'tool', text: '→ Edit src/a.ts' },
    { at: 2, sequence: 11, stream: 'error', text: '✕ Bash rm -rf — denied' },
    { at: 3, sequence: 12, stream: 'progress', text: 'progress: halfway' },
    { at: 4, sequence: 13, stream: 'info', text: 'turn ended' },
  ];

  it('clamps the height to 300–600 px', () => {
    expect(clampHeight(100)).toBe(MIN_HEIGHT);
    expect(clampHeight(900)).toBe(MAX_HEIGHT);
    expect(clampHeight(412.6)).toBe(413);
    expect(clampHeight('450')).toBe(450);
    expect(clampHeight(Number.NaN)).toBe(DEFAULT_HEIGHT);
    expect(clampHeight(undefined)).toBe(DEFAULT_HEIGHT);
  });

  it('shows every line in Combined, tool lines in Tools, error lines in Errors', () => {
    const at = (tab: 'combined' | 'tools' | 'errors') =>
      visibleLines(log, { tab, filter: '', clearedThrough: 0 }).map((l) => l.sequence);
    expect(at('combined')).toEqual([10, 11, 12, 13]);
    expect(at('tools')).toEqual([10]);
    expect(at('errors')).toEqual([11]);
  });

  it('filters by text, case-insensitively, and hides what was cleared', () => {
    expect(visibleLines(log, { tab: 'combined', filter: 'BASH', clearedThrough: 0 }).map((l) => l.sequence)).toEqual([
      11,
    ]);
    const cut = clearPoint(log, 0);
    expect(cut).toBe(13);
    expect(visibleLines(log, { tab: 'combined', filter: '', clearedThrough: cut })).toEqual([]);
    const later = [...log, { at: 5, sequence: 14, stream: 'tool' as const, text: 'new' }];
    expect(visibleLines(later, { tab: 'combined', filter: '', clearedThrough: cut }).map((l) => l.text)).toEqual([
      'new',
    ]);
    expect(clearPoint([], 7)).toBe(7);
  });

  it('opens on Errors after a failure, on Combined otherwise, and on the tab asked for', () => {
    const error = { at: 1, sequence: 20, stream: 'error' as const, text: 'tool failed' };
    const tool = { at: 2, sequence: 21, stream: 'tool' as const, text: 'Edit a.ts' };
    // The newest line is a failure: Errors.
    expect(startTab({ log: [tool, error] })).toBe('errors');
    // The agent went on working after it: Combined.
    expect(startTab({ log: [error, tool] })).toBe('combined');
    // Its last tool failed, or its task did, and there is an error line to show: Errors.
    expect(startTab({ log: [error, tool], lastDecision: 'failed' })).toBe('errors');
    expect(startTab({ log: [error, tool], taskFailed: true })).toBe('errors');
    // A failed task without one error line recorded here has nothing to open on: Combined.
    expect(startTab({ log: [tool], taskFailed: true })).toBe('combined');
    expect(startTab({ log: [] })).toBe('combined');
    // A request names the tab; the process tab is never the start.
    expect(startTab({ requested: 'tools', log: [tool, error] })).toBe('tools');
    expect(startTab({ requested: 'errors', log: [] })).toBe('errors');
    expect(startTab({ requested: 'process', log: [tool, error] })).toBe('errors');
    expect(startTab({ requested: 'nonsense', log: [tool] })).toBe('combined');
  });

  it('removes escape sequences from process output and clears by the last line seen', () => {
    const tail = ['\u001b[32mready\u001b[0m', 'working ‮evil', 'done'];
    expect(processLines(tail, { filter: '', clearedAt: null })).toEqual(['ready', 'working evil', 'done']);
    const cut = processClearPoint(tail);
    expect(cut).toBe('done');
    expect(processLines([...tail, 'next'], { filter: '', clearedAt: cut })).toEqual(['next']);
    expect(processLines(['other'], { filter: '', clearedAt: cut })).toEqual(['other']);
    expect(processLines(tail, { filter: 'WORK', clearedAt: null })).toEqual(['working evil']);
    expect(processClearPoint([])).toBeNull();
  });
});

describe('discrepancies', () => {
  it('needs a claim', () => {
    expect(claimedPaths(null)).toBeNull();
    expect(claimedPaths({ summary: 'x' })).toEqual([]);
    expect(discrepancies(null, ['a.ts'])).toBeNull();
    expect(hasDiscrepancy(null)).toBe(false);
  });

  it('lists claimed paths Friday did not see, and changes the claim does not list', () => {
    const d = discrepancies(
      { changed_paths: ['src/a.ts', './src/b.ts', 'src\\c.ts', 7] },
      ['src/a.ts'],
      ['src/c.ts', 'src/d.ts'],
    );
    expect(d).toEqual({ claimedNotSeen: ['src/b.ts'], seenNotClaimed: ['src/d.ts'] });
    expect(hasDiscrepancy(d)).toBe(true);
    expect(hasDiscrepancy(discrepancies({ changed_paths: ['a'] }, ['a']))).toBe(false);
  });
});
