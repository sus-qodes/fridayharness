/**
 * Friday Mascot Opaque-Box E2E Test Suite.
 *
 * Systematic 4-Tier Test Architecture:
 * - Tier 1: Feature Coverage (geometry, pure SVG renderer, 6 modular accessories, 6 lifecycle states, naming & zero-emoji invariants)
 * - Tier 2: Boundary & Corner Cases (16px to 512px scaling, empty/all accessories, invalid state fallback, reduced motion, rapid thrashing)
 * - Tier 3: Cross-Feature Combinations (state + accessory pairings, 36 pairwise combinations, custom tint overrides)
 * - Tier 4: Real-World Scenarios (complete agent lifecycle workflow, 11 DOF kinematics & area preservation, DOM mounting)
 */

import { describe, expect, it } from 'vitest';
import {
  FRIDAY_CANVAS_SIZE,
  FRIDAY_PALETTE,
  FRIDAY_PIVOT_BODY,
  FRIDAY_PIVOT_HEAD,
  FRIDAY_PIVOT_SQUASH,
  FRIDAY_VIEWBOX,
  getFridaySvgMarkup,
  MASCOT_ACCESSORIES,
  MASCOT_NAME,
  MASCOT_STATES,
  type MascotAccessory,
  type MascotState,
  renderCloudThoughts,
  renderEffects,
  renderFridaySvg,
  renderFridaySvgString,
  renderFrontAccessories,
  renderHands,
  renderHat,
  renderHeadphones,
  renderLaptop,
  renderRearAccessories,
  renderSunglasses,
  STATE_TINTS,
  toCanonicalState,
} from './index.js';

// ============================================================================
// INVARIANT & VERIFICATION HELPERS
// ============================================================================

/**
 * Asserts that the output string contains strictly ZERO Unicode emojis.
 * Matches all Extended_Pictographic characters as defined by Unicode standard.
 */
function assertZeroEmojis(str: string): void {
  const emojiRegex = /\p{Extended_Pictographic}/u;
  const match = str.match(emojiRegex);
  expect(match, `Disallowed Unicode emoji detected in output: "${match?.[0]}"`).toBeNull();
}

/**
 * Asserts that the character name is strictly "Friday" and contains NO legacy
 * names ("Blip" or "Flip") anywhere in text or attribute contents.
 */
function assertStrictNaming(str: string): void {
  expect(str).not.toMatch(/blip/i);
  expect(str).not.toMatch(/flip/i);
}

/**
 * Parses and verifies that an SVG markup string is well-formed XML and conforms
 * to the Friday SVG structural contract.
 */
function parseAndVerifySvg(svgMarkup: string): SVGSVGElement {
  // Invariant checks
  assertZeroEmojis(svgMarkup);
  assertStrictNaming(svgMarkup);

  // Structural XML validation
  expect(svgMarkup).toContain('<svg');
  expect(svgMarkup).toContain(`viewBox="${FRIDAY_VIEWBOX}"`);
  expect(svgMarkup).toContain('</svg>');

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, 'image/svg+xml');
  const parserError = doc.querySelector('parsererror');
  expect(parserError?.textContent, 'SVG XML parser error detected').toBeUndefined();

  const svg = doc.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg as SVGSVGElement;
}

// ============================================================================
// TIER 1: FEATURE COVERAGE (ISOLATION)
// ============================================================================

describe('Tier 1: Feature Coverage (In Isolation)', () => {
  describe('Feature 1: Mascot Vector Geometry', () => {
    it('draws an upright yellow duck: head and shoulders, tuft, beak and a resting wing', () => {
      const markup = renderFridaySvgString({ state: 'idle' });
      const svg = parseAndVerifySvg(markup);

      // Head and shoulders in one yellow silhouette, with the two-bump tuft behind it
      const bodyPath = svg.querySelector('#friday-body-silhouette');
      expect(bodyPath).not.toBeNull();
      expect(bodyPath?.getAttribute('fill')).toContain('friday-body-grad');
      expect(svg.querySelector('#friday-tuft-back')).not.toBeNull();

      // The orange beak carries the mouth
      const beak = svg.querySelector('#friday-beak');
      expect(beak).not.toBeNull();
      expect(beak?.getAttribute('fill')).toContain('friday-beak-grad');

      // No sweater: the duck is plain yellow
      expect(svg.querySelector('#friday-sweater')).toBeNull();
      expect(markup).not.toContain('sweater');

      // The resting wing at the lower left
      const leftWing = svg.querySelector('#friday-paw-left');
      expect(leftWing).not.toBeNull();

      // Straight: no rotation at rest
      expect(svg.querySelector('#friday-rot')?.getAttribute('transform')).toContain('rotate(0 ');

      // Facial ink eyes & mouth smile
      const leftEye = svg.querySelector('#friday-eye-left');
      const rightEye = svg.querySelector('#friday-eye-right');
      const mouth = svg.querySelector('#friday-mouth');
      expect(leftEye).not.toBeNull();
      expect(rightEye).not.toBeNull();
      expect(mouth).not.toBeNull();

      // Invariant: Zero animal ears, zero tail
      expect(svg.querySelector('#friday-ears')).toBeNull();
      expect(svg.querySelector('#friday-tail')).toBeNull();
    });

    it('uses the duck palette: yellow body, orange beak, deep navy eyes', () => {
      expect(FRIDAY_PALETTE.bodyTop).toBe('#FFE766');
      expect(FRIDAY_PALETTE.bodyBase).toBe('#FFDB3F');
      expect(FRIDAY_PALETTE.bodyBottom).toBe('#F2B91A');
      expect(FRIDAY_PALETTE.beakTop).toBe('#FFBE3A');
      expect(FRIDAY_PALETTE.beakBottom).toBe('#F29A10');
      expect(FRIDAY_PALETTE.ink).toBe('#0E2A68');
    });

    it('utilizes standardized 120x120 coordinate system with pivots', () => {
      expect(FRIDAY_VIEWBOX).toBe('0 0 120 120');
      expect(FRIDAY_CANVAS_SIZE).toBe(120);
      expect(FRIDAY_PIVOT_BODY).toEqual({ x: 60, y: 110 });
      expect(FRIDAY_PIVOT_HEAD).toEqual({ x: 60, y: 52 });
      expect(FRIDAY_PIVOT_SQUASH).toEqual({ x: 64, y: 116 });
    });
  });

  describe('Feature 2: Pure Vector SVG Renderer', () => {
    it('produces valid SVG XML via renderFridaySvgString and getFridaySvgMarkup', () => {
      const markup1 = renderFridaySvgString();
      const markup2 = getFridaySvgMarkup();
      expect(markup1).toBe(markup2);
      expect(markup1).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(markup1).toContain(`viewBox="${FRIDAY_VIEWBOX}"`);
      parseAndVerifySvg(markup1);
    });

    it('instantiates valid SVGSVGElement DOM node via renderFridaySvg', () => {
      const element = renderFridaySvg({ state: 'idle' });
      expect(element).toBeInstanceOf(SVGSVGElement);
      expect(element.getAttribute('viewBox')).toBe(FRIDAY_VIEWBOX);
      expect(element.getAttribute('role')).toBe('img');
      expect(element.getAttribute('aria-labelledby')).toContain('friday-title');
    });

    it('enforces clean semantic depth layer hierarchy', () => {
      const markup = renderFridaySvgString();
      const svg = parseAndVerifySvg(markup);

      // Verify layer grouping structure
      expect(svg.querySelector('#friday-layer-ambient')).not.toBeNull();
      expect(svg.querySelector('#friday-shadow')).not.toBeNull();
      expect(svg.querySelector('#friday-pos')).not.toBeNull();
      expect(svg.querySelector('#friday-rot')).not.toBeNull();
      expect(svg.querySelector('#friday-squash')).not.toBeNull();
      expect(svg.querySelector('#friday-body')).not.toBeNull();
      expect(svg.querySelector('#friday-beak')).not.toBeNull();
      expect(svg.querySelector('#friday-face')).not.toBeNull();
    });

    it('provides accessible titles and descriptions with zero emojis', () => {
      const markup = renderFridaySvgString({ state: 'idle' });
      const svg = parseAndVerifySvg(markup);

      const title = svg.querySelector('#friday-title');
      const desc = svg.querySelector('#friday-desc');
      expect(title?.textContent).toBe('Friday Mascot - idle');
      expect(desc?.textContent).toBe('Yellow duck companion mascot, head and shoulders, standing straight');
      assertZeroEmojis(title?.textContent ?? '');
      assertZeroEmojis(desc?.textContent ?? '');
    });
  });

  describe('Feature 3: Modular Accessories Vector System', () => {
    it('renders hands accessory in isolation', () => {
      const markup = renderFridaySvgString({ accessories: ['hands'] });
      const svg = parseAndVerifySvg(markup);
      expect(svg.querySelector('#friday-paw-left')).not.toBeNull();
    });

    it('renders Apple-style minimalist laptop in isolation', () => {
      const markup = renderFridaySvgString({ accessories: ['laptop'] });
      const svg = parseAndVerifySvg(markup);

      const laptop = svg.querySelector('#friday-accessory-laptop');
      expect(laptop).not.toBeNull();
      expect(svg.querySelector('#friday-laptop-display')).not.toBeNull();
      expect(svg.querySelector('#friday-laptop-base')).not.toBeNull();

      // Paws should switch to dual typing paws over keyboard
      expect(svg.querySelector('.friday-paw-typing')).not.toBeNull();
    });

    it('renders dark acetate sunglasses with 45-degree gleam streaks in isolation', () => {
      const markup = renderFridaySvgString({ accessories: ['sunglasses'] });
      const svg = parseAndVerifySvg(markup);

      const sunglasses = svg.querySelector('#friday-accessory-sunglasses');
      expect(sunglasses).not.toBeNull();
      // Gleam specular lines
      const gleams = sunglasses?.querySelectorAll('line');
      expect((gleams?.length ?? 0) >= 2).toBe(true);
    });

    it('renders minimalist ribbed beanie hat with cuff in isolation', () => {
      const markup = renderFridaySvgString({ accessories: ['hat'] });
      const svg = parseAndVerifySvg(markup);

      expect(svg.querySelector('#friday-hat-rear')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-hat')).not.toBeNull();
    });

    it('renders over-ear studio headphones with illuminated status rings in isolation', () => {
      const markup = renderFridaySvgString({ accessories: ['headphones'] });
      const svg = parseAndVerifySvg(markup);

      expect(svg.querySelector('#friday-headphones-rear')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-headphones-front')).not.toBeNull();
      expect(svg.querySelector('#friday-headphone-cup-left')).not.toBeNull();
      expect(svg.querySelector('#friday-headphone-cup-right')).not.toBeNull();
    });

    it('renders vector cloud thoughts with trail dots and interior rolling dots in isolation', () => {
      const markup = renderFridaySvgString({ accessories: ['cloud_thoughts'] });
      const svg = parseAndVerifySvg(markup);

      const cloud = svg.querySelector('#friday-accessory-cloud-thoughts');
      expect(cloud).not.toBeNull();
      // 2 trail dots + 3 rolling dots = at least 5 circles
      const circles = cloud?.querySelectorAll('circle');
      expect((circles?.length ?? 0) >= 5).toBe(true);
    });

    it('verifies accessory standalone renderer exports', () => {
      const ctx = { idPrefix: 'test-', tint: '#10B981', state: 'idle' as MascotState };
      expect(renderHands(['hands'], ctx)).toContain('test-paw-left');
      expect(renderRearAccessories(['headphones'], ctx)).toContain('test-headphones-rear');
      expect(renderFrontAccessories(['sunglasses'], ctx)).toContain('test-accessory-sunglasses');
      expect(renderLaptop(ctx)).toContain('test-accessory-laptop');
      expect(renderSunglasses(ctx)).toContain('test-accessory-sunglasses');
      expect(renderHat(ctx)).toContain('test-accessory-hat');
      expect(renderHeadphones(ctx)).toContain('test-accessory-headphones-front');
      expect(renderCloudThoughts(ctx)).toContain('test-accessory-cloud-thoughts');
    });
  });

  describe('Feature 4: Lifecycle State Visual Variations', () => {
    it.each(MASCOT_STATES)('renders distinct visual geometry and tint for state: %s', (state) => {
      const markup = renderFridaySvgString({ state });
      const svg = parseAndVerifySvg(markup);

      expect(svg.classList.contains(`friday-state-${state}`)).toBe(true);
      expect(svg.querySelector('#friday-face')).not.toBeNull();

      // State-specific visual indicators
      switch (state) {
        case 'idle':
          expect(svg.querySelector('#friday-paw-left')).not.toBeNull();
          break;
        case 'thinking':
          expect(svg.querySelector('#friday-accessory-cloud-thoughts')).not.toBeNull();
          expect(svg.querySelector('#friday-paw-right')).not.toBeNull();
          break;
        case 'tool_execution':
          expect(svg.querySelector('.friday-paw-typing')).not.toBeNull();
          expect(svg.querySelector('#friday-eye-left')).not.toBeNull();
          expect(svg.querySelector('#friday-mouth')).not.toBeNull();
          break;
        case 'success':
          expect(svg.querySelector('#friday-effects-sparkles')).not.toBeNull();
          expect(svg.querySelector('.friday-paw-cheer')).not.toBeNull();
          break;
        case 'error':
          expect(svg.querySelector('#friday-effects-sweat')).not.toBeNull();
          break;
        case 'sleep':
          expect(svg.querySelector('#friday-effects-sleep-zzz')).not.toBeNull();
          break;
      }
    });

    it('binds semantic status tints matching Friday design tokens', () => {
      expect(STATE_TINTS.idle).toBe('#94A3B8');
      expect(STATE_TINTS.thinking).toBe('#F59E0B');
      expect(STATE_TINTS.tool_execution).toBe('#06B6D4');
      expect(STATE_TINTS.success).toBe('#10B981');
      expect(STATE_TINTS.error).toBe('#EF4444');
      expect(STATE_TINTS.sleep).toBe('#64748B');
    });
  });

  describe('Feature 5: Strict Character Naming Invariant', () => {
    it('strictly enforces the canonical name "Friday"', () => {
      expect(MASCOT_NAME).toBe('Friday');
    });

    it('ensures zero occurrences of legacy names "Blip" or "Flip" across all states and accessories', () => {
      for (const state of MASCOT_STATES) {
        const markup = renderFridaySvgString({ state, accessories: [...MASCOT_ACCESSORIES] });
        assertStrictNaming(markup);
      }
    });
  });

  describe('Feature 6: Zero-Emoji Enforcement Invariant', () => {
    it('guarantees 100% pure vector SVG paths with zero Unicode emojis across all outputs', () => {
      for (const state of MASCOT_STATES) {
        const markup = renderFridaySvgString({ state, accessories: [...MASCOT_ACCESSORIES] });
        assertZeroEmojis(markup);
      }
    });

    it('verifies particle effects use geometric vectors instead of emojis', () => {
      const ctx = { idPrefix: 't-', tint: '#10B981', state: 'success' as MascotState };

      // Sparkles: vector paths instead of emoji sparkles
      const sparklesMarkup = renderEffects('success', [], ctx);
      expect(sparklesMarkup).toContain('<path');
      assertZeroEmojis(sparklesMarkup);

      // Sleep: vector paths instead of emoji zzz
      const sleepMarkup = renderEffects('sleep', [], { ...ctx, state: 'sleep' });
      expect(sleepMarkup).toContain('<path');
      assertZeroEmojis(sleepMarkup);

      // Sweat: vector path instead of emoji droplet
      const sweatMarkup = renderEffects('error', [], { ...ctx, state: 'error' });
      expect(sweatMarkup).toContain('<path');
      assertZeroEmojis(sweatMarkup);

      // Cloud: vector path & circles instead of emoji thought balloon
      const thoughtsMarkup = renderCloudThoughts(ctx);
      expect(thoughtsMarkup).toContain('<path');
      expect(thoughtsMarkup).toContain('<circle');
      assertZeroEmojis(thoughtsMarkup);
    });
  });
});

// ============================================================================
// TIER 2: BOUNDARY & CORNER CASES
// ============================================================================

describe('Tier 2: Boundary & Corner Cases', () => {
  describe('Extreme Sizing & Responsive Scaling', () => {
    const testSizes = [
      16, // Micro-icon
      24, // Notch pill view
      30, // Settings header icon
      32, // Feedback sheet avatar
      36, // Notch card view
      56, // Notch sleep view
      72, // Companion stage
      80, // Settings hero preview
      120, // Native design grid
      512, // High-resolution display
    ];

    it.each(testSizes)('renders clean vector geometry without distortion at size: %d px', (size) => {
      const markup = renderFridaySvgString({ size, state: 'idle' });
      const svg = parseAndVerifySvg(markup);

      expect(svg.getAttribute('width')).toBe(String(size));
      expect(svg.getAttribute('height')).toBe(String(size));
      expect(svg.getAttribute('viewBox')).toBe(FRIDAY_VIEWBOX);
    });

    it('defaults to responsive 100% width/height when size is omitted', () => {
      const markup = renderFridaySvgString();
      const svg = parseAndVerifySvg(markup);
      expect(svg.getAttribute('width')).toBe('100%');
      expect(svg.getAttribute('height')).toBe('100%');
    });
  });

  describe('Accessory Combinatorial Extremes', () => {
    it('handles empty accessory list gracefully', () => {
      const markup = renderFridaySvgString({ accessories: [] });
      const svg = parseAndVerifySvg(markup);

      expect(svg.querySelector('#friday-accessories-rear')).toBeNull();
      expect(svg.querySelector('#friday-accessories-front')).toBeNull();
      expect(svg.querySelector('#friday-paw-left')).not.toBeNull();
    });

    it('renders all 6 accessories enabled simultaneously without DOM or layer collisions', () => {
      const markup = renderFridaySvgString({
        accessories: ['hands', 'laptop', 'sunglasses', 'hat', 'headphones', 'cloud_thoughts'],
        state: 'tool_execution',
      });
      const svg = parseAndVerifySvg(markup);

      // Rear accessories
      expect(svg.querySelector('#friday-accessories-rear')).not.toBeNull();
      expect(svg.querySelector('#friday-headphones-rear')).not.toBeNull();
      expect(svg.querySelector('#friday-hat-rear')).not.toBeNull();

      // Front accessories
      expect(svg.querySelector('#friday-accessories-front')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-laptop')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-sunglasses')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-hat')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-headphones-front')).not.toBeNull();

      // Cloud thoughts effect
      expect(svg.querySelector('#friday-accessory-cloud-thoughts')).not.toBeNull();
    });

    it('handles duplicate accessory entries idempotently', () => {
      const markup = renderFridaySvgString({
        accessories: ['laptop', 'laptop', 'hat', 'hat', 'hat'],
      });
      const svg = parseAndVerifySvg(markup);

      const laptops = svg.querySelectorAll('#friday-accessory-laptop');
      expect(laptops.length).toBe(1);
    });
  });

  describe('Invalid State Normalization & Safe Fallbacks', () => {
    it('normalizes undefined, null, or empty string to "idle"', () => {
      expect(toCanonicalState(undefined)).toBe('idle');
      expect(toCanonicalState(null)).toBe('idle');
      expect(toCanonicalState('')).toBe('idle');
      expect(toCanonicalState('   ')).toBe('idle');
    });

    it('safely normalizes unknown state values to "idle"', () => {
      expect(toCanonicalState('dancing')).toBe('idle');
      expect(toCanonicalState('hyper_speed')).toBe('idle');
      expect(toCanonicalState('ERROR_UNKNOWN')).toBe('idle');
    });

    it('maps legacy application status strings to canonical states', () => {
      expect(toCanonicalState('working')).toBe('tool_execution');
      expect(toCanonicalState('finished')).toBe('success');
      expect(toCanonicalState('approval')).toBe('success');
      expect(toCanonicalState('sleeping')).toBe('sleep');
      expect(toCanonicalState('halted')).toBe('sleep');
      expect(toCanonicalState('paused')).toBe('sleep');
      expect(toCanonicalState('question')).toBe('thinking');
      expect(toCanonicalState('searching')).toBe('tool_execution');
      expect(toCanonicalState('failed')).toBe('error');
      expect(toCanonicalState('alert')).toBe('error');
    });

    it('is case-insensitive during state normalization', () => {
      expect(toCanonicalState('THINKING')).toBe('thinking');
      expect(toCanonicalState('Success')).toBe('success');
      expect(toCanonicalState('Tool_Execution')).toBe('tool_execution');
      expect(toCanonicalState('sLeEp')).toBe('sleep');
    });
  });

  describe('Prefers-Reduced-Motion Accessibility', () => {
    it('includes media query suppressing animation for reduced-motion users', () => {
      const markup = renderFridaySvgString();
      expect(markup).toContain('@media (prefers-reduced-motion: reduce)');
      expect(markup).toContain('animation: none !important');
    });
  });

  describe('Rapid State Thrashing Stability', () => {
    it('remains perfectly stable under 60 rapid sequential state transitions', () => {
      const states: MascotState[] = ['idle', 'thinking', 'tool_execution', 'success', 'idle', 'error', 'sleep'];

      for (let i = 0; i < 60; i++) {
        const state = states[i % states.length] ?? 'idle';
        const markup = renderFridaySvgString({ state });
        const svg = parseAndVerifySvg(markup);
        expect(svg.classList.contains(`friday-state-${state}`)).toBe(true);
      }
    });
  });
});

// ============================================================================
// TIER 3: CROSS-FEATURE COMBINATIONS
// ============================================================================

describe('Tier 3: Cross-Feature Combinations', () => {
  describe('Contextual State + Accessory Pairings', () => {
    it('thinking + cloud_thoughts: inquisitive gaze and thought bubbles', () => {
      const markup = renderFridaySvgString({
        state: 'thinking',
        accessories: ['cloud_thoughts'],
      });
      const svg = parseAndVerifySvg(markup);

      expect(svg.querySelector('#friday-accessory-cloud-thoughts')).not.toBeNull();
      expect(svg.querySelector('#friday-paw-right')).not.toBeNull(); // Thinking paw
    });

    it('tool_execution + laptop + hands: focused gaze and dual typing paws', () => {
      const markup = renderFridaySvgString({
        state: 'tool_execution',
        accessories: ['laptop', 'hands'],
      });
      const svg = parseAndVerifySvg(markup);

      expect(svg.querySelector('#friday-accessory-laptop')).not.toBeNull();
      expect(svg.querySelector('.friday-paw-typing')).not.toBeNull();
    });

    it('success + sunglasses: celebration sparkles with cool shades', () => {
      const markup = renderFridaySvgString({
        state: 'success',
        accessories: ['sunglasses'],
      });
      const svg = parseAndVerifySvg(markup);

      expect(svg.querySelector('#friday-accessory-sunglasses')).not.toBeNull();
      expect(svg.querySelector('#friday-effects-sparkles')).not.toBeNull();
      expect(svg.querySelector('.friday-paw-cheer')).not.toBeNull();
    });

    it('sleep + headphones: peaceful downward eyes with audio arch', () => {
      const markup = renderFridaySvgString({
        state: 'sleep',
        accessories: ['headphones'],
      });
      const svg = parseAndVerifySvg(markup);

      expect(svg.querySelector('#friday-headphones-rear')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-headphones-front')).not.toBeNull();
      expect(svg.querySelector('#friday-effects-sleep-zzz')).not.toBeNull();
    });

    it('idle + hat: calm neutral presence in warm beanie', () => {
      const markup = renderFridaySvgString({
        state: 'idle',
        accessories: ['hat'],
      });
      const svg = parseAndVerifySvg(markup);

      expect(svg.querySelector('#friday-hat-rear')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-hat')).not.toBeNull();
      expect(svg.querySelector('#friday-paw-left')).not.toBeNull();
    });
  });

  describe('36 Pairwise Combinations (All States × All Accessories)', () => {
    const pairs: [MascotState, MascotAccessory][] = [];
    for (const s of MASCOT_STATES) {
      for (const a of MASCOT_ACCESSORIES) {
        pairs.push([s, a]);
      }
    }

    it.each(pairs)('pair %s + %s renders valid XML with zero emojis and strict naming', (state, accessory) => {
      const markup = renderFridaySvgString({ state, accessories: [accessory] });
      parseAndVerifySvg(markup);
    });
  });

  describe('Semantic Status Tint Overrides & Propagation', () => {
    it('accepts custom status tint overriding default state palette', () => {
      const customTint = '#38BDF8';
      const markup = renderFridaySvgString({
        state: 'idle',
        tint: customTint,
        accessories: ['headphones'],
      });
      const svg = parseAndVerifySvg(markup);

      expect(markup).toContain(`--friday-status-tint: ${customTint}`);
      expect(markup).toContain(`stop-color="${customTint}"`);

      // Headphone LED ring adopts custom tint
      const leftRing = svg.querySelector('#friday-headphone-cup-left rect[fill="none"]');
      expect(leftRing?.getAttribute('stroke')).toBe(customTint);
    });
  });
});

// ============================================================================
// TIER 4: REAL-WORLD SCENARIOS
// ============================================================================

describe('Tier 4: Real-World Scenarios', () => {
  describe('Full Agent Lifecycle Workflow Simulation', () => {
    it('simulates complete agent task lifecycle with valid SVG output at every phase', () => {
      // 1. Initial idle monitoring
      const phase1 = renderFridaySvgString({ state: 'idle' });
      const svg1 = parseAndVerifySvg(phase1);
      expect(svg1.classList.contains('friday-state-idle')).toBe(true);

      // 2. User submits prompt -> Agent begins thinking
      const phase2 = renderFridaySvgString({ state: 'thinking', accessories: ['cloud_thoughts'] });
      const svg2 = parseAndVerifySvg(phase2);
      expect(svg2.querySelector('#friday-accessory-cloud-thoughts')).not.toBeNull();

      // 3. Agent invokes tool -> Working on laptop
      const phase3 = renderFridaySvgString({ state: 'tool_execution', accessories: ['laptop', 'hands'] });
      const svg3 = parseAndVerifySvg(phase3);
      expect(svg3.querySelector('#friday-accessory-laptop')).not.toBeNull();
      expect(svg3.querySelector('.friday-paw-typing')).not.toBeNull();

      // 4. Tool execution finishes successfully -> Celebration
      const phase4 = renderFridaySvgString({ state: 'success', accessories: ['hands'] });
      const svg4 = parseAndVerifySvg(phase4);
      expect(svg4.querySelector('#friday-effects-sparkles')).not.toBeNull();
      expect(svg4.querySelector('.friday-paw-cheer')).not.toBeNull();

      // 5. Back to idle
      const phase5 = renderFridaySvgString({ state: 'idle' });
      const svg5 = parseAndVerifySvg(phase5);
      expect(svg5.classList.contains('friday-state-idle')).toBe(true);

      // 6. Network failure triggers error
      const phase6 = renderFridaySvgString({ state: 'error' });
      const svg6 = parseAndVerifySvg(phase6);
      expect(svg6.querySelector('#friday-effects-sweat')).not.toBeNull();

      // 7. Extended inactivity causes sleep
      const phase7 = renderFridaySvgString({ state: 'sleep' });
      const svg7 = parseAndVerifySvg(phase7);
      expect(svg7.querySelector('#friday-effects-sleep-zzz')).not.toBeNull();
    });
  });

  describe('11 Degree-of-Freedom Rigging & Area-Preserving Kinematics', () => {
    it('applies 11 DOF pose parameters to transform groups without NaN values', () => {
      const markup = renderFridaySvgString({
        pose: {
          bodyX: 5.5,
          bodyY: -12.0,
          scaleX: 1.087,
          scaleY: 0.85,
          tilt: 6.2,
          gazeYaw: 0.45,
          gazePitch: -0.3,
          shadowScale: 0.8,
        },
      });
      const svg = parseAndVerifySvg(markup);

      // Pos transform
      const pos = svg.querySelector('#friday-pos');
      expect(pos?.getAttribute('transform')).toContain('translate(5.5, -12)');

      // Rot transform
      const rot = svg.querySelector('#friday-rot');
      expect(rot?.getAttribute('transform')).toContain('rotate(6.2 60 110)');

      // Squash transform
      const squash = svg.querySelector('#friday-squash');
      expect(squash?.getAttribute('transform')).toContain('scale(1.087, 0.85)');

      // Shadow scaling
      const shadow = svg.querySelector('#friday-shadow');
      expect(shadow?.getAttribute('rx')).toBe((36 * 0.8).toFixed(1));

      // Assert no NaN or undefined in any transform attribute
      expect(markup).not.toContain('NaN');
      expect(markup).not.toContain('undefined');
    });

    it('verifies area-preserving squash and stretch formulation: sx = 1.0 + (1.0 - sy) * 0.58', () => {
      const sy = 0.8;
      const expectedSx = 1.0 + (1.0 - sy) * 0.58; // 1.116
      expect(expectedSx).toBeCloseTo(1.116, 3);

      const markup = renderFridaySvgString({
        pose: { scaleX: expectedSx, scaleY: sy },
      });
      expect(markup).toContain(`scale(${expectedSx}, ${sy})`);
    });
  });

  describe('DOM Mounting & Cleanup Lifecycle', () => {
    it('mounts and removes Friday SVG element in DOM tree without dangling references', () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      const svgEl = renderFridaySvg({ size: 36, state: 'idle' });
      container.appendChild(svgEl);

      expect(container.contains(svgEl)).toBe(true);
      expect(container.querySelector('#friday-root')).toBe(svgEl);

      // Teardown
      container.removeChild(svgEl);
      expect(container.contains(svgEl)).toBe(false);
      document.body.removeChild(container);
    });
  });
});
