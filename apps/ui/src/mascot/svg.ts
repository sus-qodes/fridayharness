/**
 * Pure SVG Vector Engine & Renderer for Friday Mascot.
 * 120x120 viewBox coordinate system with clean semantic depth grouping:
 * scene -> shadow -> position -> rotation -> squash -> rear-accessories -> body -> sweater -> face -> paw -> front-accessories -> effects
 *
 * Strictly zero emojis. 100% pure geometric vector paths.
 */

import { renderEffects, renderFrontAccessories, renderHands, renderRearAccessories } from './accessories.js';
import {
  FRIDAY_PALETTE,
  FRIDAY_PIVOT_BODY,
  FRIDAY_PIVOT_SQUASH,
  FRIDAY_VIEWBOX,
  type FridayPose,
  type FridaySvgOptions,
  type MascotAccessory,
  type MascotState,
  STATE_TINTS,
  toCanonicalState,
} from './types.js';

/** Head and shoulders of the duck: one symmetric silhouette on the 120 x 120 grid, cut off at the bottom edge. */
const DUCK_BODY_PATH =
  'M 60 20 C 82 20 100 36 102 58 C 103 70 99 80 94 88 C 98 98 99 110 100 120 L 20 120 C 21 110 22 98 26 88 C 21 80 17 70 18 58 C 20 36 38 20 60 20 Z';

/** The two soft bumps of the tuft, a bigger one and a smaller one beside it. */
const DUCK_TUFT_PATH =
  'M 49 26 C 47 14 55 7 62 9 C 68 11 68 19 66 26 Z M 64 28 C 63 20 68 15 74 17 C 80 19 80 26 76 31 Z';

/**
 * Builds the complete SVG markup string for Friday Mascot.
 */
export function renderFridaySvgString(options: FridaySvgOptions = {}): string {
  const state: MascotState = toCanonicalState(options.state);
  // Working means typing: the laptop is part of that state, so its wings never type on thin air.
  const requested: MascotAccessory[] = options.accessories ?? [];
  const accessories: MascotAccessory[] =
    state === 'tool_execution' && !requested.includes('laptop') ? [...requested, 'laptop'] : requested;
  const tint = options.tint ?? STATE_TINTS[state];
  const prefix = options.idPrefix ?? 'friday-';
  const pose: FridayPose = options.pose ?? {};

  // Pose values with defaults
  const bodyX = pose.bodyX ?? 0;
  const bodyY = pose.bodyY ?? 0;
  const scaleX = pose.scaleX ?? 1.0;
  const scaleY = pose.scaleY ?? 1.0;
  // Friday stands straight: a tilt only comes from the motion, never from a state's resting pose.
  const tilt = pose.tilt ?? 0;
  const gazeYaw = pose.gazeYaw ?? (state === 'thinking' ? 0.35 : 0);
  const gazePitch = pose.gazePitch ?? (state === 'tool_execution' ? 0.4 : state === 'thinking' ? -0.3 : 0);
  const shadowScale = pose.shadowScale ?? 1.0;

  // Accessibility labels
  const titleText = options.title ?? `Friday Mascot - ${state}`;
  const descText = options.description ?? 'Yellow duck companion mascot, head and shoulders, standing straight';
  const titleId = `${prefix}title`;
  const descId = `${prefix}desc`;

  // Dimension attributes
  const dimAttrs =
    options.size !== undefined ? `width="${options.size}" height="${options.size}"` : 'width="100%" height="100%"';

  const classAttr = options.className
    ? `class="friday-mascot friday-state-${state} ${options.className}"`
    : `class="friday-mascot friday-state-${state}"`;

  // Render sub-components
  const accessoryCtx = {
    idPrefix: prefix,
    tint,
    state,
    hasLaptop: accessories.includes('laptop') || state === 'tool_execution',
  };

  const rearAccessoriesMarkup = renderRearAccessories(accessories, accessoryCtx);
  const frontAccessoriesMarkup = renderFrontAccessories(accessories, accessoryCtx);
  const handsMarkup = renderHands(accessories, accessoryCtx);
  const effectsMarkup = renderEffects(state, accessories, accessoryCtx);
  const faceMarkup = renderFace(state, prefix, gazeYaw, gazePitch);

  return `<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="${FRIDAY_VIEWBOX}"
     ${dimAttrs}
     ${classAttr}
     role="img"
     aria-labelledby="${titleId} ${descId}"
     id="${prefix}root"
     style="--friday-status-tint: ${tint}; overflow: visible;">
  <title id="${titleId}">${escapeXml(titleText)}</title>
  <desc id="${descId}">${escapeXml(descText)}</desc>

  <defs>
    <!-- Soft matte yellow body gradient, continuous across head, tuft and shoulders -->
    <linearGradient id="${prefix}body-grad" gradientUnits="userSpaceOnUse" x1="44" y1="8" x2="76" y2="120">
      <stop offset="0%" stop-color="${FRIDAY_PALETTE.bodyTop}"/>
      <stop offset="55%" stop-color="${FRIDAY_PALETTE.bodyBase}"/>
      <stop offset="100%" stop-color="${FRIDAY_PALETTE.bodyBottom}"/>
    </linearGradient>

    <!-- Orange beak gradient -->
    <linearGradient id="${prefix}beak-grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${FRIDAY_PALETTE.beakTop}"/>
      <stop offset="100%" stop-color="${FRIDAY_PALETTE.beakBottom}"/>
    </linearGradient>

    <!-- Radial mood glow halo -->
    <radialGradient id="${prefix}halo-grad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${tint}" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="${tint}" stop-opacity="0"/>
    </radialGradient>

    <!-- Body silhouette clipping path -->
    <clipPath id="${prefix}body-clip">
      <path d="${DUCK_BODY_PATH}"/>
    </clipPath>

    <style>
      @media (prefers-reduced-motion: reduce) {
        [data-animated] { animation: none !important; }
      }
    </style>
  </defs>

  <!-- Layer 0: Ground Contact Shadow & Mood Ambient Halo -->
  <g id="${prefix}layer-ambient">
    <ellipse id="${prefix}shadow" cx="60" cy="116" rx="${(36 * shadowScale).toFixed(1)}" ry="${(4.5 * shadowScale).toFixed(1)}" fill="#000000" opacity="${(0.25 * shadowScale).toFixed(2)}"/>
    <circle id="${prefix}mood-halo" cx="60" cy="60" r="54" fill="url(#${prefix}halo-grad)"/>
  </g>

  <!-- Layer 1: Physics Transform Rigging (Position -> Rotation -> Squash) -->
  <g id="${prefix}pos" transform="translate(${bodyX}, ${bodyY})">
    <g id="${prefix}rot" transform="rotate(${tilt} ${FRIDAY_PIVOT_BODY.x} ${FRIDAY_PIVOT_BODY.y})">
      <g id="${prefix}squash" transform="translate(${FRIDAY_PIVOT_SQUASH.x}, ${FRIDAY_PIVOT_SQUASH.y}) scale(${scaleX}, ${scaleY}) translate(-${FRIDAY_PIVOT_SQUASH.x}, -${FRIDAY_PIVOT_SQUASH.y})">

        <!-- Layer 2: Rear Accessories -->
        ${rearAccessoriesMarkup}

        <!-- Layer 3: Duck head, shoulders and the two-bump tuft -->
        <g id="${prefix}body">
          <path id="${prefix}tuft-back" d="${DUCK_TUFT_PATH}" fill="url(#${prefix}body-grad)"/>
          <path id="${prefix}body-silhouette" d="${DUCK_BODY_PATH}" fill="url(#${prefix}body-grad)"/>

          <!-- Diffuse volume highlight inside the head -->
          <g clip-path="url(#${prefix}body-clip)">
            <ellipse cx="42" cy="38" rx="26" ry="14" fill="#FFFFFF" opacity="0.2" transform="rotate(-18 42 38)"/>
          </g>
        </g>

        <!-- Layer 5: Facial Features (Eyes, Mouth, Cheek Blush) -->
        ${faceMarkup}

        <!-- Layer 6: Chubby Paws / Hands -->
        ${handsMarkup}

        <!-- Layer 7: Front Accessories (Laptop, Sunglasses, Earcups, Hat Cuff) -->
        ${frontAccessoriesMarkup}

      </g>
    </g>
  </g>

  <!-- Layer 8: Status Effects & Particles (Pure SVG paths, zero emojis) -->
  ${effectsMarkup}
</svg>`;
}

/**
 * Creates and returns an SVGSVGElement DOM element.
 */
export function renderFridaySvg(options: FridaySvgOptions = {}): SVGSVGElement {
  const xml = renderFridaySvgString(options);

  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (svg) return svg as SVGSVGElement;
  }

  throw new Error('DOMParser unavailable to instantiate SVGSVGElement.');
}

/** Alias for renderFridaySvgString for convenience. */
export const getFridaySvgMarkup = renderFridaySvgString;

/**
 * Internal facial renderer producing eyes, mouth, and blush for each lifecycle state.
 */
function renderFace(state: MascotState, prefix: string, gazeYaw: number, gazePitch: number): string {
  const gazeX = (gazeYaw * 4).toFixed(1);
  const gazeY = (gazePitch * 4).toFixed(1);
  const ink = FRIDAY_PALETTE.ink;
  const line = FRIDAY_PALETTE.beakLine;

  /** Dark oval eyes with a white sparkle, as in the reference. */
  const oval = (rx: number, ry: number, cy = 55, extra = '') => `
        <ellipse id="${prefix}eye-left" cx="42" cy="${cy}" rx="${rx}" ry="${ry}" fill="${ink}"${extra}/>
        <ellipse id="${prefix}eye-right" cx="78" cy="${cy}" rx="${rx}" ry="${ry}" fill="${ink}"${extra}/>
        <circle cx="${(42 - rx * 0.28).toFixed(1)}" cy="${(cy - ry * 0.34).toFixed(1)}" r="${(rx * 0.4).toFixed(1)}" fill="#FFFFFF"/>
        <circle cx="${(78 - rx * 0.28).toFixed(1)}" cy="${(cy - ry * 0.34).toFixed(1)}" r="${(rx * 0.4).toFixed(1)}" fill="#FFFFFF"/>
      `;

  let eyesMarkup = '';
  let mouthMarkup = '';
  /** The beak is always there; only the mouth line on it changes. */
  const beak = `
      <ellipse id="${prefix}beak" cx="60" cy="70" rx="15" ry="9.5" fill="url(#${prefix}beak-grad)"/>
      <ellipse cx="55" cy="66" rx="6" ry="2.4" fill="#FFFFFF" opacity="0.28"/>
  `;

  switch (state) {
    case 'thinking': {
      // Slightly narrower eyes and a small round "o" on the beak
      eyesMarkup = oval(5.2, 6.6, 54);
      mouthMarkup = `<ellipse id="${prefix}mouth" cx="60" cy="72" rx="2.6" ry="2.2" fill="${line}"/>`;
      break;
    }

    case 'tool_execution': {
      // Focused: a flat, steady line on the beak
      eyesMarkup = oval(5.2, 6.4, 56);
      mouthMarkup = `<path id="${prefix}mouth" d="M 54 72 Q 60 73.5 66 72" stroke="${line}" stroke-width="1.7" stroke-linecap="round" fill="none"/>`;
      break;
    }

    case 'success': {
      // Joyful closed arches and a wide open smile
      eyesMarkup = `
        <path id="${prefix}eye-left" d="M 36 58 Q 42 49 48 58" stroke="${ink}" stroke-width="3" stroke-linecap="round" fill="none"/>
        <path id="${prefix}eye-right" d="M 72 58 Q 78 49 84 58" stroke="${ink}" stroke-width="3" stroke-linecap="round" fill="none"/>
      `;
      mouthMarkup = `
        <path id="${prefix}mouth" d="M 51 69 Q 60 82 69 69 Z" fill="${line}"/>
        <path d="M 55 74 Q 60 78 65 74 Z" fill="#F43F5E"/>
      `;
      break;
    }

    case 'error': {
      // Wide startled eyes and a wobbly line
      eyesMarkup = oval(6.6, 8.6, 54);
      mouthMarkup = `<path id="${prefix}mouth" d="M 52 72 Q 55.5 69.5 60 72 Q 64.5 74.5 68 72" stroke="${line}" stroke-width="1.7" stroke-linecap="round" fill="none"/>`;
      break;
    }

    case 'sleep': {
      // Peaceful closed curves and a tiny mouth
      eyesMarkup = `
        <path id="${prefix}eye-left" d="M 36 56 Q 42 62 48 56" stroke="${ink}" stroke-width="2.8" stroke-linecap="round" fill="none"/>
        <path id="${prefix}eye-right" d="M 72 56 Q 78 62 84 56" stroke="${ink}" stroke-width="2.8" stroke-linecap="round" fill="none"/>
      `;
      mouthMarkup = `<path id="${prefix}mouth" d="M 56 72 Q 60 73.6 64 72" stroke="${line}" stroke-width="1.5" stroke-linecap="round" fill="none"/>`;
      break;
    }

    default: {
      // Calm oval eyes and the small smile on the beak
      eyesMarkup = oval(5.6, 7.4);
      mouthMarkup = `<path id="${prefix}mouth" d="M 53.5 71.5 Q 60 76 66.5 71.5" stroke="${line}" stroke-width="1.7" stroke-linecap="round" fill="none"/>`;
      break;
    }
  }

  return `
    <g id="${prefix}face" transform="translate(${gazeX}, ${gazeY})">
      <g id="${prefix}eyes">
        ${eyesMarkup}
      </g>
      ${beak}
      ${mouthMarkup}
    </g>
  `;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
