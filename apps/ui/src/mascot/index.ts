/**
 * Friday Mascot System.
 * Canonical character name: "Friday". Strictly zero emojis.
 * Full SVG vector engine, modular accessories, and lifecycle state variations.
 */

// Modular accessories & particle effects
export {
  renderCloudThoughts,
  renderEffects,
  renderFrontAccessories,
  renderHands,
  renderHat,
  renderHatFront,
  renderHatRear,
  renderHeadphones,
  renderHeadphonesFront,
  renderHeadphonesRear,
  renderLaptop,
  renderRearAccessories,
  renderSunglasses,
} from './accessories.js';
// Native DOM Mascot Component
export {
  createFridayMascot,
  type FridayMascotHandle,
  type FridayMascotOptions,
} from './component.js';
// Legacy canvas exports (backward compatibility with existing Notch & tests)
export { createMascot, type MascotHandle, type MascotOptions, setCursor } from './mascot.js';
// State kinetics & 11-DOF motion controller
export {
  applyPoseToSvg,
  computeStateHarmonics,
  isPrefersReducedMotion,
  MascotMotionController,
  type MascotMotionOptions,
  STATE_BASE_POSES,
} from './motion.js';
// Hooke's Law spring physics & 11-DOF rig solver
export {
  AREA_PRESERVE_FACTOR,
  BODY_PIVOT,
  computeAreaPreservingScaleX,
  computeSquashStretch,
  ERROR_DROOP_CONFIG,
  HookeSpring,
  MAX_DT,
  MascotRigSolver,
  REST_DELTA,
  REST_SPEED,
  type SpringChannelState,
  type SpringConfig,
  SQUASH_PIVOT,
  STATE_SPRING_CONFIGS,
  SUBSTEP,
} from './physics.js';
export { selectCanonicalState, selectState } from './states.js';
// Vector SVG renderer & markup
export {
  getFridaySvgMarkup,
  renderFridaySvg,
  renderFridaySvgString,
} from './svg.js';
// Canonical types, constants, and palette
export {
  FRIDAY_CANVAS_SIZE,
  FRIDAY_PALETTE,
  FRIDAY_PIVOT_BODY,
  FRIDAY_PIVOT_HEAD,
  FRIDAY_PIVOT_SQUASH,
  FRIDAY_VIEWBOX,
  type FridayPose,
  type FridaySvgOptions,
  MASCOT_ACCESSORIES,
  MASCOT_NAME,
  MASCOT_STATES,
  type MascotAccessory,
  type MascotState,
  STATE_TINTS,
  toCanonicalState,
} from './types.js';
