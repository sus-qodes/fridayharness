/**
 * Friday Modular Accessories Vector System.
 * Pure SVG vector paths and renderers for Friday's 6 modular accessories:
 * 1. hands: the duck's wings resting, typing, or cheering
 * 2. laptop: mini minimalist Apple-style notebook wedge
 * 3. sunglasses: sleek dark acetate frames with 45-degree specular gleam
 * 4. hat: minimalist ribbed beanie sitting on the duck's head
 * 5. headphones: sleek over-ear arch with illuminated status ring cups
 * 6. cloud_thoughts: subtle vector thought bubbles/cloud with trail dots
 *
 * Strictly zero emojis. All particles, sparkles, and indicators are pure SVG paths.
 */

import { FRIDAY_PALETTE, type MascotAccessory, type MascotState, STATE_TINTS } from './types.js';

export interface AccessoryRenderContext {
  idPrefix: string;
  tint: string;
  state: MascotState;
  hasLaptop?: boolean;
}

/**
 * Renders rear accessory layers (elements that must sit behind Friday's body).
 * E.g., Headphone headband arch, back of hat.
 */
export function renderRearAccessories(accessories: MascotAccessory[], ctx: AccessoryRenderContext): string {
  const parts: string[] = [];

  if (accessories.includes('headphones')) {
    parts.push(renderHeadphonesRear(ctx));
  }
  if (accessories.includes('hat')) {
    parts.push(renderHatRear(ctx));
  }

  if (parts.length === 0) return '';
  return `<g id="${ctx.idPrefix}accessories-rear">${parts.join('')}</g>`;
}

/**
 * Renders front accessory layers (elements that sit in front of Friday's body and face).
 * E.g., Laptop, sunglasses, headphone earcups, hat cuff.
 */
export function renderFrontAccessories(accessories: MascotAccessory[], ctx: AccessoryRenderContext): string {
  const parts: string[] = [];

  if (accessories.includes('hat')) {
    parts.push(renderHatFront(ctx));
  }
  if (accessories.includes('sunglasses')) {
    parts.push(renderSunglasses(ctx));
  }
  if (accessories.includes('headphones')) {
    parts.push(renderHeadphonesFront(ctx));
  }
  if (accessories.includes('laptop')) {
    parts.push(renderLaptop(ctx));
  }

  if (parts.length === 0) return '';
  return `<g id="${ctx.idPrefix}accessories-front">${parts.join('')}</g>`;
}

/**
 * Renders paw / hand configurations depending on active accessories and lifecycle state.
 */
export function renderHands(accessories: MascotAccessory[], ctx: AccessoryRenderContext): string {
  const hasLaptop = accessories.includes('laptop') || ctx.state === 'tool_execution';
  const fill = FRIDAY_PALETTE.bodyBase;
  const edge = FRIDAY_PALETTE.bodyBottom;
  const wing = (id: string, cls: string, cx: number, cy: number, rx: number, ry: number, angle: number) =>
    `<g id="${ctx.idPrefix}${id}"${cls ? ` class="${cls}"` : ''}>
        <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${edge}" stroke-width="0.8" transform="rotate(${angle} ${cx} ${cy})"/>
      </g>`;

  if (ctx.state === 'success') {
    // Both wings raised in celebration
    return `${wing('paw-left', 'friday-paw-cheer', 16, 76, 7.5, 7, -25)}
      ${wing('paw-right', 'friday-paw-cheer', 104, 76, 7.5, 7, 25)}`;
  }

  if (ctx.state === 'thinking') {
    // Left wing resting, right wing touching the cheek
    return `${restingWing(ctx)}
      ${wing('paw-right', 'friday-paw-thinking', 90, 80, 6.5, 6, -15)}`;
  }

  if (hasLaptop) {
    // Both wings over the notebook keyboard
    return `${wing('paw-left', 'friday-paw-typing', 44, 106, 7, 5.2, -10)}
      ${wing('paw-right', 'friday-paw-typing', 76, 105, 7, 5.2, 10)}`;
  }

  // The resting wing at the lower left, as in the reference image
  return restingWing(ctx);
}

/** The duck's wing: a rounded lobe at the lower left of the body. */
function restingWing(ctx: AccessoryRenderContext): string {
  return `<g id="${ctx.idPrefix}paw-left">
        <path d="M 14 120 C 12 104 21 91 38 88 C 51 88 55 100 49 110 C 46 115 45 118 45 120 Z" fill="${FRIDAY_PALETTE.bodyBase}" stroke="${FRIDAY_PALETTE.bodyBottom}" stroke-width="0.8" stroke-linejoin="round"/>
        <path d="M 22 112 C 24 102 31 96 40 95" stroke="${FRIDAY_PALETTE.bodyBottom}" stroke-width="1.1" stroke-linecap="round" fill="none" opacity="0.55"/>
      </g>`;
}

/**
 * Renders the Apple-style minimalist notebook laptop wedge.
 */
export function renderLaptop(ctx: AccessoryRenderContext): string {
  const screenGlowTint = ctx.tint || STATE_TINTS.tool_execution;

  return `
    <g id="${ctx.idPrefix}accessory-laptop" transform="translate(0 10)">
      <!-- Screen Display Lid (angled ~115 deg) -->
      <g id="${ctx.idPrefix}laptop-display">
        <rect x="36" y="72" width="48" height="24" rx="2" fill="#1E2024" stroke="#4B5563" stroke-width="0.75"/>
        <rect x="38" y="74" width="44" height="20" rx="1" fill="#0F1115"/>
        <!-- Soft backlight glow -->
        <rect x="39" y="75" width="42" height="18" rx="0.5" fill="${screenGlowTint}" opacity="0.12"/>
        <!-- Minimalist vector terminal code lines (100% pure SVG, zero emoji) -->
        <rect x="42" y="78" width="14" height="1.8" rx="0.5" fill="${screenGlowTint}" opacity="0.9"/>
        <rect x="58" y="78" width="10" height="1.8" rx="0.5" fill="#94A3B8" opacity="0.6"/>
        <rect x="44" y="82" width="22" height="1.8" rx="0.5" fill="#E2E8F0" opacity="0.75"/>
        <rect x="44" y="86" width="16" height="1.8" rx="0.5" fill="${screenGlowTint}" opacity="0.85"/>
        <rect x="42" y="90" width="8" height="1.8" rx="0.5" fill="#10B981" opacity="0.8"/>
      </g>
      <!-- Base Keyboard Chassis -->
      <g id="${ctx.idPrefix}laptop-base">
        <path d="M 32 96 L 88 96 L 85 104 L 35 104 Z" fill="#2E333D" stroke="#4B5563" stroke-width="0.75"/>
        <!-- Trackpad notch -->
        <rect x="54" y="99" width="12" height="3" rx="0.75" fill="#1E222A" opacity="0.8"/>
        <!-- Subtle base contact shadow -->
        <ellipse cx="60" cy="104.5" rx="26" ry="1.5" fill="#000000" opacity="0.3"/>
      </g>
    </g>
  `;
}

/**
 * Renders sleek dark acetate sunglasses with 45-degree specular gleam streaks.
 */
export function renderSunglasses(ctx: AccessoryRenderContext): string {
  return `
    <g id="${ctx.idPrefix}accessory-sunglasses">
      <!-- Frame shadow -->
      <g opacity="0.25">
        <rect x="29" y="47" width="26" height="18" rx="5" fill="#000000"/>
        <rect x="65" y="47" width="26" height="18" rx="5" fill="#000000"/>
      </g>
      <!-- Bridge -->
      <path d="M 54 53 Q 60 51, 66 53" stroke="#18181B" stroke-width="3" stroke-linecap="round" fill="none"/>
      <!-- Left Frame & Lens -->
      <rect x="28" y="45" width="27" height="18" rx="5" fill="#18181B"/>
      <rect x="30" y="47" width="23" height="14" rx="3.2" fill="#27272A"/>
      <line x1="46" y1="49" x2="37" y2="59" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" opacity="0.45"/>
      <line x1="50" y1="50" x2="47" y2="54" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round" opacity="0.3"/>
      <!-- Right Frame & Lens -->
      <rect x="65" y="45" width="27" height="18" rx="5" fill="#18181B"/>
      <rect x="67" y="47" width="23" height="14" rx="3.2" fill="#27272A"/>
      <line x1="83" y1="49" x2="74" y2="59" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" opacity="0.45"/>
      <line x1="87" y1="50" x2="84" y2="54" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round" opacity="0.3"/>
    </g>
  `;
}

/**
 * Renders the rear arch of the headphones.
 */
export function renderHeadphonesRear(ctx: AccessoryRenderContext): string {
  return `
    <g id="${ctx.idPrefix}headphones-rear">
      <!-- Tubular aluminum arch connecting the earcups over the head -->
      <path d="M 16 64 C 14 6, 106 6, 104 64" stroke="#94A3B8" stroke-width="3.5" stroke-linecap="round" fill="none"/>
      <path d="M 16 64 C 14 6, 106 6, 104 64" stroke="#475569" stroke-width="1.2" stroke-linecap="round" fill="none"/>
    </g>
  `;
}

/**
 * Renders the front earcups and illuminated status rings of the headphones.
 */
export function renderHeadphonesFront(ctx: AccessoryRenderContext): string {
  const haloColor = ctx.tint || STATE_TINTS.idle;

  return `
    <g id="${ctx.idPrefix}accessory-headphones-front">
      <!-- Left Earcup -->
      <g id="${ctx.idPrefix}headphone-cup-left">
        <rect x="9" y="52" width="13" height="24" rx="6.5" fill="#1E222A" stroke="#475569" stroke-width="1"/>
        <rect x="11.5" y="55" width="8" height="18" rx="4" fill="none" stroke="${haloColor}" stroke-width="1.5" opacity="0.85"/>
      </g>
      <!-- Right Earcup -->
      <g id="${ctx.idPrefix}headphone-cup-right">
        <rect x="98" y="52" width="13" height="24" rx="6.5" fill="#1E222A" stroke="#475569" stroke-width="1"/>
        <rect x="100.5" y="55" width="8" height="18" rx="4" fill="none" stroke="${haloColor}" stroke-width="1.5" opacity="0.85"/>
      </g>
    </g>
  `;
}

/**
 * Renders complete headphones accessory (both rear arch and front earcups).
 */
export function renderHeadphones(ctx: AccessoryRenderContext): string {
  return `${renderHeadphonesRear(ctx)}${renderHeadphonesFront(ctx)}`;
}

/**
 * Renders rear dome of the minimalist beanie hat.
 */
export function renderHatRear(ctx: AccessoryRenderContext): string {
  return `
    <g id="${ctx.idPrefix}hat-rear">
      <path d="M 28 36 C 28 16, 44 8, 60 8 C 76 8, 92 16, 92 36 Z" fill="#242831"/>
    </g>
  `;
}

/**
 * Renders front dome, ribbed cuff, and knit tick lines of the minimalist beanie hat.
 */
export function renderHatFront(ctx: AccessoryRenderContext): string {
  return `
    <g id="${ctx.idPrefix}accessory-hat">
      <!-- Beanie Crown -->
      <path d="M 30 34 C 30 18, 44 10, 60 10 C 76 10, 90 18, 90 34 C 80 31, 70 30, 60 30 C 50 30, 40 31, 30 34 Z" fill="#333A48"/>
      <!-- Subtle vertical knit rib ticks -->
      <line x1="45" y1="15" x2="44" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>
      <line x1="53" y1="11" x2="53" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>
      <line x1="60" y1="10" x2="60" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>
      <line x1="67" y1="11" x2="67" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>
      <line x1="75" y1="15" x2="76" y2="30" stroke="#475569" stroke-width="0.8" stroke-linecap="round"/>
      <!-- Folded Horizontal Beanie Cuff -->
      <path d="M 26 41 C 44 36, 76 36, 94 41 C 95 35, 94 32, 91 30 C 76 27, 44 27, 29 30 C 26 33, 25 37, 26 41 Z" fill="#242831" stroke="#475569" stroke-width="0.8"/>
      <!-- Top pompom -->
      <circle cx="60" cy="8" r="4" fill="#242831" stroke="#333A48" stroke-width="0.75"/>
    </g>
  `;
}

/**
 * Renders complete beanie hat accessory (both rear dome and front cuff).
 */
export function renderHat(ctx: AccessoryRenderContext): string {
  return `${renderHatRear(ctx)}${renderHatFront(ctx)}`;
}

/**
 * Renders floating thought bubbles with trail dots and interior rolling dots.
 */
export function renderCloudThoughts(ctx: AccessoryRenderContext): string {
  return `
    <g id="${ctx.idPrefix}accessory-cloud-thoughts">
      <!-- Trail Dots -->
      <circle cx="68" cy="38" r="2.5" fill="rgba(255, 255, 255, 0.85)" stroke="#94A3B8" stroke-width="0.6"/>
      <circle cx="73" cy="31" r="3.5" fill="rgba(255, 255, 255, 0.9)" stroke="#94A3B8" stroke-width="0.6"/>
      <!-- Main Cloud Body (4 tangential circular arcs) -->
      <path d="M 79 23 C 77 17, 83 12, 89 14 C 93 10, 101 11, 104 16 C 109 17, 111 23, 108 28 C 110 33, 105 38, 99 36 C 95 39, 87 38, 84 34 C 78 34, 76 28, 79 23 Z"
            fill="rgba(255, 255, 255, 0.92)" stroke="#94A3B8" stroke-width="0.8"/>
      <!-- Interior vector rolling dots (zero emojis) -->
      <circle cx="87" cy="25" r="2" fill="#475569"/>
      <circle cx="94" cy="25" r="2" fill="#475569"/>
      <circle cx="101" cy="25" r="2" fill="#475569"/>
    </g>
  `;
}

/**
 * Renders status particles and effects for the 6 lifecycle states.
 * Strictly pure geometric SVG paths. Zero Unicode emojis.
 */
export function renderEffects(state: MascotState, accessories: MascotAccessory[], ctx: AccessoryRenderContext): string {
  const parts: string[] = [];

  // If cloud_thoughts accessory is explicitly requested or in thinking state
  if (accessories.includes('cloud_thoughts') || state === 'thinking') {
    parts.push(renderCloudThoughts(ctx));
  }

  // Success: 4-point sparkle vector stars (zero emoji)
  if (state === 'success') {
    parts.push(`
      <g id="${ctx.idPrefix}effects-sparkles">
        <!-- Star 1 (upper-right) -->
        <path d="M 88 17 L 89.2 20.8 L 93 22 L 89.2 23.2 L 88 27 L 86.8 23.2 L 83 22 L 86.8 20.8 Z" fill="#10B981"/>
        <!-- Star 2 (left flank) -->
        <path d="M 18 38 L 19 41 L 22 42 L 19 43 L 18 46 L 17 43 L 14 42 L 17 41 Z" fill="#34D399"/>
        <!-- Star 3 (far right) -->
        <path d="M 104 45 L 104.8 47.2 L 107 48 L 104.8 48.8 L 104 51 L 103.2 48.8 L 101 48 L 103.2 47.2 Z" fill="#6EE7B7"/>
      </g>
    `);
  }

  // Error: Single vector sweat teardrop on forehead (zero emoji)
  if (state === 'error') {
    parts.push(`
      <g id="${ctx.idPrefix}effects-sweat" transform="translate(66 -2)">
        <path d="M 24 38 C 22 42, 21 46, 24 49 C 27 51, 30 48, 29 44 C 28 41, 25 39, 24 38 Z" fill="#38BDF8" stroke="#0284C7" stroke-width="0.6" opacity="0.9"/>
      </g>
    `);
  }

  // Sleep: Ascending vector Zzz glyph paths (zero emoji)
  if (state === 'sleep') {
    parts.push(`
      <g id="${ctx.idPrefix}effects-sleep-zzz">
        <!-- Z 1 (largest) -->
        <path d="M 80 34 L 88 34 L 81 42 L 89 42" stroke="#818CF8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <!-- Z 2 (medium) -->
        <path d="M 92 21 L 98 21 L 93 27 L 99 27" stroke="#A5B4FC" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <!-- Z 3 (small) -->
        <path d="M 101 11 L 105 11 L 102 15 L 106 15" stroke="#C7D2FE" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </g>
    `);
  }

  if (parts.length === 0) return '';
  return `<g id="${ctx.idPrefix}effects">${parts.join('')}</g>`;
}
