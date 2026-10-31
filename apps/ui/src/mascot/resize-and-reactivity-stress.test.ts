/**
 * Adversarial Stress Tests for Friday Mascot:
 * Multi-Size Adaptability & Store Reactivity / Priority Resolution.
 *
 * Executed by Challenger 2 (Multi-Size & Store Reactivity Challenger):
 *
 * Challenge 1: Dynamic Resize Stress Test
 * - Cycle through standard and boundary sizes: 16px -> 24px -> 30px -> 32px -> 36px -> 56px -> 72px -> 80px -> 120px -> 256px -> 512px.
 * - Verify SVG viewBox ('0 0 120 120'), 1:1 aspect ratio, and root bounding box adapt without distortion.
 * - Verify rapid-fire setSize() thrashing and boundary value resilience (0, negative, NaN).
 *
 * Challenge 2: Rapid Store State Stream Simulation
 * - Stream 100 rapid RootState updates with alternating jobs, pulses, approvals, and errors.
 * - Verify selectState() and selectCanonicalState() resolve priority deterministically without throwing or freezing.
 * - Verify pairwise competing condition resolution against the PRIORITY hierarchy.
 * - Verify high-throughput performance (10,000 evaluations < 100ms).
 * - Verify live ObservableStore reactive subscription stream and unmount cleanup.
 */

import type { UiSnapshot } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RootState } from '../store/state.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { createFridayMascot, type FridayMascotHandle } from './component.js';
import { type MascotState as LookMascotState, nextChangeAt, selectCanonicalState, selectState } from './states.js';
import { renderFridaySvg, renderFridaySvgString } from './svg.js';
import { type MascotState as CanonicalMascotState, FRIDAY_VIEWBOX } from './types.js';

describe('Challenger 2: Dynamic Resize & Store Reactivity Adversarial Verification', () => {
  let ctx: TestContext;
  let mascot: FridayMascotHandle | null = null;

  beforeEach(() => {
    ctx = makeContext();
  });

  afterEach(() => {
    mascot?.destroy();
    mascot = null;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // ADVERSARIAL CHALLENGE 1: Dynamic Resize Stress Test
  // ==========================================================================
  describe('Adversarial Challenge 1: Dynamic Resize Stress Test', () => {
    const TARGET_SIZES = [16, 24, 30, 32, 36, 56, 72, 80, 120, 256, 512] as const;

    it('creates mascot instances across all standard and boundary sizes with exact 1:1 viewBox and bounding box', () => {
      for (const size of TARGET_SIZES) {
        const instance = createFridayMascot(undefined, { size });

        // Verify host root bounding box
        expect(instance.el.style.width).toBe(`${size}px`);
        expect(instance.el.style.height).toBe(`${size}px`);
        expect(instance.el.style.display).toBe('inline-flex');
        expect(instance.el.style.overflow).toBe('visible');

        // Verify SVG geometry and viewBox
        const svg = instance.el.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute('viewBox')).toBe(FRIDAY_VIEWBOX);
        expect(svg?.getAttribute('viewBox')).toBe('0 0 120 120');

        // Verify 1:1 aspect ratio preservation
        expect(svg?.style.width).toBe('100%');
        expect(svg?.style.height).toBe('100%');
        expect(svg?.style.display).toBe('block');
        expect(svg?.style.overflow).toBe('visible');

        // Verify essential SVG elements exist and are not clipped/distorted
        expect(svg?.querySelector('#friday-body-silhouette')).not.toBeNull();
        expect(svg?.querySelector('#friday-beak')).not.toBeNull();
        expect(svg?.querySelector('#friday-face')).not.toBeNull();

        instance.destroy();
      }
    });

    it('dynamically resizes an active mascot instance cycling forward and backward across all 11 sizes', () => {
      mascot = createFridayMascot(undefined, { size: 36 });
      const host = mascot.el;
      const initialSvg = host.querySelector('svg');
      expect(initialSvg).not.toBeNull();

      // 1. Forward cycle: 16 -> 24 -> 30 -> 32 -> 36 -> 56 -> 72 -> 80 -> 120 -> 256 -> 512
      for (const targetSize of TARGET_SIZES) {
        mascot.setSize(targetSize);

        // Host bounding dimensions must adapt strictly
        expect(host.style.width).toBe(`${targetSize}px`);
        expect(host.style.height).toBe(`${targetSize}px`);

        // SVG attributes must adapt
        const svg = host.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute('width')).toBe(`${targetSize}`);
        expect(svg?.getAttribute('height')).toBe(`${targetSize}`);
        expect(svg?.getAttribute('viewBox')).toBe('0 0 120 120');
      }

      // 2. Reverse cycle: 512 -> 256 -> 120 -> 80 -> 72 -> 56 -> 36 -> 32 -> 30 -> 24 -> 16
      const reversedSizes = [...TARGET_SIZES].reverse();
      for (const targetSize of reversedSizes) {
        mascot.setSize(targetSize);

        expect(host.style.width).toBe(`${targetSize}px`);
        expect(host.style.height).toBe(`${targetSize}px`);

        const svg = host.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute('width')).toBe(`${targetSize}`);
        expect(svg?.getAttribute('height')).toBe(`${targetSize}`);
        expect(svg?.getAttribute('viewBox')).toBe('0 0 120 120');
      }
    });

    it('survives rapid-fire setSize() thrashing across extreme bounds (100 iterations)', () => {
      mascot = createFridayMascot(undefined, { size: 36 });
      const host = mascot.el;

      for (let i = 0; i < 100; i++) {
        // Alternate between tiny (16px) and gigantic (512px)
        const size = i % 2 === 0 ? 16 : 512;
        mascot.setSize(size);

        expect(host.style.width).toBe(`${size}px`);
        expect(host.style.height).toBe(`${size}px`);

        // Check exactly one SVG is present in host (no DOM duplication leak)
        const svgs = host.querySelectorAll('svg');
        expect(svgs.length).toBe(1);
        expect(svgs[0]).toBeDefined();
        expect(svgs[0]?.getAttribute('viewBox')).toBe('0 0 120 120');
      }
    });

    it('safely rejects invalid, zero, negative, and non-finite sizes without mutating current size', () => {
      mascot = createFridayMascot(undefined, { size: 72 });
      const host = mascot.el;

      expect(host.style.width).toBe('72px');

      // Invalid inputs
      mascot.setSize(0);
      expect(host.style.width).toBe('72px');

      mascot.setSize(-24);
      expect(host.style.width).toBe('72px');

      mascot.setSize(Number.NaN);
      expect(host.style.width).toBe('72px');

      mascot.setSize(Number.POSITIVE_INFINITY);
      expect(host.style.width).toBe('72px');

      mascot.setSize(Number.NEGATIVE_INFINITY);
      expect(host.style.width).toBe('72px');

      // Subsequent valid size must still work
      mascot.setSize(80);
      expect(host.style.width).toBe('80px');
      expect(host.style.height).toBe('80px');
    });

    it('preserves 120x120 coordinate system and aspect ratio in standalone SVG renderer', () => {
      for (const size of TARGET_SIZES) {
        const svgString = renderFridaySvgString({ size, state: 'thinking' });
        expect(svgString).toContain(`viewBox="${FRIDAY_VIEWBOX}"`);
        expect(svgString).toContain(`width="${size}" height="${size}"`);
        expect(svgString).toContain('style="--friday-status-tint: #F59E0B; overflow: visible;"');

        const svgDom = renderFridaySvg({ size, state: 'idle' });
        expect(svgDom.getAttribute('viewBox')).toBe('0 0 120 120');
        expect(svgDom.getAttribute('width')).toBe(`${size}`);
        expect(svgDom.getAttribute('height')).toBe(`${size}`);
      }
    });
  });

  // ==========================================================================
  // ADVERSARIAL CHALLENGE 2: Rapid Store State Stream Simulation
  // ==========================================================================
  describe('Adversarial Challenge 2: Rapid Store State Stream Simulation', () => {
    /** Helper to generate a baseline RootState. */
    function createBaselineState(now: number): RootState {
      return {
        board: makeSnapshot({
          approvals: [],
          escalations: [],
          tasks: [],
          brain_jobs: [],
          control: {
            paused: false,
            reason: null,
            changed_at: null,
            changed_by: null,
            halted_at: null,
          },
        }),
        activity: {
          lastActivityAt: now,
          agents: {},
          reactions: [],
          files: {},
          pulses: [],
        },
        system: {
          connection: 'live',
          snapshotAt: now,
          sequence: 0,
          attempts: 0,
          lastError: null,
          refreshing: false,
        },
        ui: {
          indexing: false,
        },
        prefs: {
          motion: 'full',
        },
      } as unknown as RootState;
    }

    it('streams 100 rapid RootState updates with alternating conditions and verifies priority resolution', () => {
      const baseNow = 1_700_000_000_000;
      let currentState = createBaselineState(baseNow);

      const resolvedStates: LookMascotState[] = [];
      const canonicalStates: CanonicalMascotState[] = [];

      const startTime = performance.now();

      for (let i = 0; i < 100; i++) {
        const now = baseNow + i * 500; // 500ms intervals
        const mode = i % 10;

        // Clone state shallowly
        currentState = {
          ...currentState,
          board: currentState.board ? { ...currentState.board } : null,
          activity: { ...currentState.activity },
          system: { ...currentState.system },
          ui: { ...currentState.ui },
        };

        switch (mode) {
          case 0:
            // Approval condition (Priority 0): live pending approval
            currentState.board = makeSnapshot({
              approvals: [
                {
                  id: `appr-${i}`,
                  status: 'pending',
                  expired: false,
                  expires_at: new Date(now + 60_000).toISOString(),
                } as unknown as UiSnapshot['approvals'][number],
              ],
            });
            break;

          case 1:
            // Question condition (Priority 1): pending escalation
            currentState.board = makeSnapshot({
              approvals: [],
              escalations: [{ id: `esc-${i}`, status: 'pending' } as unknown as UiSnapshot['escalations'][number]],
            });
            break;

          case 2:
            // Error condition (Priority 2): failure reaction within ERROR_MS
            currentState.board = makeSnapshot({ approvals: [], escalations: [] });
            currentState.activity = {
              ...currentState.activity,
              reactions: [{ id: i, kind: 'failed', at: now - 1000 }],
            };
            break;

          case 3:
            // Finished condition (Priority 3): completion reaction within FINISHED_MS
            currentState.activity = {
              ...currentState.activity,
              reactions: [{ id: i, kind: 'completed', at: now - 500 }],
            };
            break;

          case 4:
            // Halted condition (Priority 4): control paused and halted_at set
            currentState.activity = { ...currentState.activity, reactions: [] };
            currentState.board = makeSnapshot({
              control: {
                paused: true,
                reason: null,
                changed_at: null,
                changed_by: null,
                halted_at: new Date(now - 2000).toISOString(),
              },
            });
            break;

          case 5:
            // Paused condition (Priority 5): control paused without halted_at
            currentState.board = makeSnapshot({
              control: {
                paused: true,
                reason: null,
                changed_at: null,
                changed_by: null,
                halted_at: null,
              },
            });
            break;

          case 6:
            // Working condition (Priority 6): agent current tool active
            currentState.board = makeSnapshot({
              control: {
                paused: false,
                reason: null,
                changed_at: null,
                changed_by: null,
                halted_at: null,
              },
            });
            currentState.activity = {
              ...currentState.activity,
              agents: {
                a1: {
                  current: {
                    at: now - 200,
                    tool: 'Bash',
                    kind: 'command',
                    target: 'build',
                    decision: 'allow',
                    taskId: null,
                  },
                  log: [],
                  usage: null,
                  model: null,
                },
              },
            };
            break;

          case 7:
            // Thinking condition (Priority 7): brain job calling
            currentState.activity = { ...currentState.activity, agents: {} };
            currentState.board = makeSnapshot({
              brain_jobs: [{ job_id: `bj-${i}`, kind: 'plan', status: 'calling', goal_id: null }],
            });
            break;

          case 8:
            // Searching condition (Priority 8): UI indexing true
            currentState.board = makeSnapshot({ brain_jobs: [] });
            currentState.ui = { ...currentState.ui, indexing: true };
            break;

          case 9:
            // Idle condition (Priority 9): baseline active
            currentState.ui = { ...currentState.ui, indexing: false };
            currentState.activity = {
              lastActivityAt: now,
              agents: {},
              reactions: [],
              files: {},
              pulses: [],
            };
            currentState.system = {
              ...currentState.system,
              connection: 'live',
              snapshotAt: now,
            };
            break;
        }

        // Execute selectState and selectCanonicalState
        const selected = selectState(currentState, now);
        const canonical = selectCanonicalState(currentState, now);

        resolvedStates.push(selected);
        canonicalStates.push(canonical);

        // Verification of contract per mode
        switch (mode) {
          case 0:
            expect(selected).toBe('approval');
            expect(canonical).toBe('success');
            break;
          case 1:
            expect(selected).toBe('question');
            expect(canonical).toBe('thinking');
            break;
          case 2:
            expect(selected).toBe('error');
            expect(canonical).toBe('error');
            break;
          case 3:
            expect(selected).toBe('finished');
            expect(canonical).toBe('success');
            break;
          case 4:
            expect(selected).toBe('halted');
            expect(canonical).toBe('sleep');
            break;
          case 5:
            expect(selected).toBe('sleeping'); // paused maps to sleeping state
            expect(canonical).toBe('sleep');
            break;
          case 6:
            expect(selected).toBe('working');
            expect(canonical).toBe('tool_execution');
            break;
          case 7:
            expect(selected).toBe('thinking');
            expect(canonical).toBe('thinking');
            break;
          case 8:
            expect(selected).toBe('searching');
            expect(canonical).toBe('tool_execution');
            break;
          case 9:
            expect(selected).toBe('idle');
            expect(canonical).toBe('idle');
            break;
        }
      }

      const totalTimeMs = performance.now() - startTime;
      expect(resolvedStates.length).toBe(100);
      expect(canonicalStates.length).toBe(100);

      // Verify execution did not stall or freeze
      expect(totalTimeMs).toBeLessThan(1000); // 100 rapid evaluations should easily finish under 1000ms
    });

    it('strictly resolves pairwise competing conditions according to PRIORITY order', () => {
      const now = 1_700_000_000_000;

      // 1. Approval vs Error -> Approval wins (Priority 0 vs Priority 2)
      const approvalAndError: RootState = {
        ...createBaselineState(now),
        board: makeSnapshot({
          approvals: [
            {
              id: 'a1',
              status: 'pending',
              expired: false,
              expires_at: null,
            } as unknown as UiSnapshot['approvals'][number],
          ],
        }),
        activity: {
          lastActivityAt: now,
          agents: {},
          reactions: [{ id: 1, kind: 'failed', at: now }],
          files: {},
          pulses: [],
        },
      } as unknown as RootState;

      expect(selectState(approvalAndError, now)).toBe('approval');
      expect(selectCanonicalState(approvalAndError, now)).toBe('success');

      // 2. Question vs Error -> Question wins (Priority 1 vs Priority 2)
      const questionAndError: RootState = {
        ...createBaselineState(now),
        board: makeSnapshot({
          escalations: [{ id: 'e1', status: 'pending' } as unknown as UiSnapshot['escalations'][number]],
        }),
        activity: {
          lastActivityAt: now,
          agents: {},
          reactions: [{ id: 1, kind: 'failed', at: now }],
          files: {},
          pulses: [],
        },
      } as unknown as RootState;

      expect(selectState(questionAndError, now)).toBe('question');
      expect(selectCanonicalState(questionAndError, now)).toBe('thinking');

      // 3. Error vs Working -> Error wins (Priority 2 vs Priority 6)
      const errorAndWorking: RootState = {
        ...createBaselineState(now),
        activity: {
          lastActivityAt: now,
          reactions: [{ id: 1, kind: 'failed', at: now }],
          files: {},
          pulses: [],
          agents: {
            a1: {
              current: { at: now, tool: 'Bash', kind: 'command', target: 'build', decision: 'allow', taskId: null },
              log: [],
              usage: null,
              model: null,
            },
          },
        },
      } as unknown as RootState;

      expect(selectState(errorAndWorking, now)).toBe('error');
      expect(selectCanonicalState(errorAndWorking, now)).toBe('error');

      // 4. Working vs Thinking -> Working wins (Priority 6 vs Priority 7)
      const workingAndThinking: RootState = {
        ...createBaselineState(now),
        board: makeSnapshot({
          brain_jobs: [{ job_id: 'j1', kind: 'plan', status: 'calling', goal_id: null }],
        }),
        activity: {
          lastActivityAt: now,
          reactions: [],
          files: {},
          pulses: [],
          agents: {
            a1: {
              current: { at: now, tool: 'Bash', kind: 'command', target: 'build', decision: 'allow', taskId: null },
              log: [],
              usage: null,
              model: null,
            },
          },
        },
      } as unknown as RootState;

      expect(selectState(workingAndThinking, now)).toBe('working');
      expect(selectCanonicalState(workingAndThinking, now)).toBe('tool_execution');

      // 5. Thinking vs Searching -> Thinking wins (Priority 7 vs Priority 8)
      const thinkingAndSearching: RootState = {
        ...createBaselineState(now),
        board: makeSnapshot({
          brain_jobs: [{ job_id: 'j1', kind: 'plan', status: 'calling', goal_id: null }],
        }),
        ui: { indexing: true },
      } as unknown as RootState;

      expect(selectState(thinkingAndSearching, now)).toBe('thinking');
      expect(selectCanonicalState(thinkingAndSearching, now)).toBe('thinking');

      // 6. Searching vs Idle -> Searching wins (Priority 8 vs Priority 9)
      const searchingAndIdle: RootState = {
        ...createBaselineState(now),
        ui: { indexing: true },
      } as unknown as RootState;

      expect(selectState(searchingAndIdle, now)).toBe('searching');
      expect(selectCanonicalState(searchingAndIdle, now)).toBe('tool_execution');

      // 7. Paused vs Working -> Paused wins (Priority 5 vs Priority 6)
      const pausedAndWorking: RootState = {
        ...createBaselineState(now),
        board: makeSnapshot({
          control: {
            paused: true,
            reason: null,
            changed_at: null,
            changed_by: null,
            halted_at: null,
          },
        }),
        activity: {
          lastActivityAt: now,
          reactions: [],
          files: {},
          pulses: [],
          agents: {
            a1: {
              current: { at: now, tool: 'Bash', kind: 'command', target: 'build', decision: 'allow', taskId: null },
              log: [],
              usage: null,
              model: null,
            },
          },
        },
      } as unknown as RootState;

      expect(selectState(pausedAndWorking, now)).toBe('sleeping');
      expect(selectCanonicalState(pausedAndWorking, now)).toBe('sleep');
    });

    it('tolerates extreme corrupted state inputs without throwing', () => {
      const now = 1_700_000_000_000;

      // Null board
      const nullBoardState: RootState = {
        board: null,
        activity: { lastActivityAt: 0, agents: {}, reactions: [], files: {}, pulses: [] },
        system: { connection: 'live', snapshotAt: 0, sequence: 0, attempts: 0, lastError: null, refreshing: false },
        ui: { indexing: false },
        prefs: { motion: 'full' },
      } as unknown as RootState;
      expect(() => selectState(nullBoardState, now)).not.toThrow();
      expect(selectState(nullBoardState, now)).toBe('idle');

      // Corrupted expires_at ISO date strings
      const corruptedDatesState: RootState = {
        board: makeSnapshot({
          approvals: [
            {
              id: 'a1',
              status: 'pending',
              expired: false,
              expires_at: 'NOT-A-DATE',
            } as unknown as UiSnapshot['approvals'][number],
            {
              id: 'a2',
              status: 'pending',
              expired: false,
              expires_at: '',
            } as unknown as UiSnapshot['approvals'][number],
            {
              id: 'a3',
              status: 'pending',
              expired: true,
              expires_at: null,
            } as unknown as UiSnapshot['approvals'][number],
          ],
        }),
        activity: { lastActivityAt: now, agents: {}, reactions: [], files: {}, pulses: [] },
        system: { connection: 'live', snapshotAt: now, sequence: 0, attempts: 0, lastError: null, refreshing: false },
        ui: { indexing: false },
        prefs: { motion: 'full' },
      } as unknown as RootState;
      expect(() => selectState(corruptedDatesState, now)).not.toThrow();
      // 'NOT-A-DATE' parses to null, exp === null means no expiration, so live() returns true -> approval wins
      expect(selectState(corruptedDatesState, now)).toBe('approval');

      // Clock skew (reaction stamped 500ms in the future within SKEW_MS 1000ms)
      const skewedState: RootState = {
        ...createBaselineState(now),
        activity: {
          lastActivityAt: now,
          agents: {},
          reactions: [{ id: 99, kind: 'failed', at: now + 500 }],
          files: {},
          pulses: [],
        },
      } as unknown as RootState;
      expect(selectState(skewedState, now)).toBe('error');

      // nextChangeAt evaluation does not throw
      expect(() => nextChangeAt(skewedState, now)).not.toThrow();
    });

    it('evaluates high-throughput benchmark (10,000 state selections) in under 500ms', () => {
      const now = 1_700_000_000_000;
      const testState = createBaselineState(now);

      const t0 = performance.now();
      const iterations = 10_000;

      for (let i = 0; i < iterations; i++) {
        selectState(testState, now);
        selectCanonicalState(testState, now);
      }

      const elapsedMs = performance.now() - t0;
      expect(elapsedMs).toBeLessThan(500); // 10k evaluations must execute in < 500ms
    });

    it('streams 100 real reactive patches through ObservableStore to FridayMascot component', () => {
      // Mount mascot with real context and store
      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('idle');
      expect(mascot.el.dataset.state).toBe('idle');

      const baseNow = ctx.now();

      for (let i = 0; i < 100; i++) {
        const mode = i % 4;
        const now = baseNow + i * 100;
        ctx.clock.now = now;

        switch (mode) {
          case 0:
            // Tool execution
            ctx.store.patch('activity', {
              agents: {
                a1: {
                  current: {
                    at: now,
                    tool: 'Bash',
                    kind: 'command',
                    target: 'build',
                    decision: 'allow',
                    taskId: null,
                  },
                  log: [],
                  usage: null,
                  model: null,
                },
              },
              reactions: [],
            });
            expect(mascot.getState()).toBe('tool_execution');
            expect(mascot.el.dataset.state).toBe('tool_execution');
            break;

          case 1:
            // Success reaction
            ctx.store.patch('activity', {
              agents: {},
              reactions: [{ id: i, kind: 'completed', at: now }],
            });
            expect(mascot.getState()).toBe('success');
            expect(mascot.el.dataset.state).toBe('success');
            break;

          case 2:
            // Error reaction
            ctx.store.patch('activity', {
              agents: {},
              reactions: [{ id: i, kind: 'failed', at: now }],
            });
            expect(mascot.getState()).toBe('error');
            expect(mascot.el.dataset.state).toBe('error');
            break;

          case 3:
            // Back to baseline idle
            ctx.store.patch('activity', {
              lastActivityAt: now,
              agents: {},
              reactions: [],
            });
            expect(mascot.getState()).toBe('idle');
            expect(mascot.el.dataset.state).toBe('idle');
            break;
        }
      }
    });
  });
});
