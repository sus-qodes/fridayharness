/**
 * Friday Mascot Types & Constants.
 * Strict character naming: "Friday". Zero emojis.
 * Supports the 6 canonical lifecycle states and 6 modular accessories.
 */

export type MascotState = 'idle' | 'thinking' | 'tool_execution' | 'success' | 'error' | 'sleep';

export const MASCOT_STATES: readonly MascotState[] = [
  'idle',
  'thinking',
  'tool_execution',
  'success',
  'error',
  'sleep',
] as const;

export type MascotAccessory = 'hands' | 'laptop' | 'sunglasses' | 'hat' | 'headphones' | 'cloud_thoughts';

export const MASCOT_ACCESSORIES: readonly MascotAccessory[] = [
  'hands',
  'laptop',
  'sunglasses',
  'hat',
  'headphones',
  'cloud_thoughts',
] as const;

/** Canonical name for the mascot. */
export const MASCOT_NAME = 'Friday';

/** Default coordinate grid size (120x120) with clean integer subdivision. */
export const FRIDAY_VIEWBOX = '0 0 120 120';
export const FRIDAY_CANVAS_SIZE = 120;

/** Default transform origins and pivots. */
export const FRIDAY_PIVOT_BODY = { x: 60, y: 110 };
export const FRIDAY_PIVOT_HEAD = { x: 60, y: 52 };
export const FRIDAY_PIVOT_SQUASH = { x: 64, y: 116 };

/** Friday is a soft yellow duck: matte yellow body, orange beak, deep navy eyes. */
export const FRIDAY_PALETTE = {
  bodyTop: '#FFE766',
  bodyBase: '#FFDB3F',
  bodyBottom: '#F2B91A',
  bodySheen: 'rgba(255, 255, 255, 0.22)',
  beakTop: '#FFBE3A',
  beakBottom: '#F29A10',
  beakLine: '#B65E00',
  ink: '#0E2A68',
  shadow: 'rgba(0, 0, 0, 0.22)',
} as const;

/** Semantic status accent tints for the 6 lifecycle states. */
export const STATE_TINTS: Record<MascotState, string> = {
  idle: '#94A3B8',
  thinking: '#F59E0B',
  tool_execution: '#06B6D4',
  success: '#10B981',
  error: '#EF4444',
  sleep: '#64748B',
};

/**
 * 11 Degree-of-Freedom rigging pose parameters for Hooke's Law physics and kinematics.
 */
export interface FridayPose {
  bodyX?: number;
  bodyY?: number;
  scaleX?: number;
  scaleY?: number;
  tilt?: number; // degrees
  gazeYaw?: number; // normalized horizontal offset [-1..1]
  gazePitch?: number; // normalized vertical offset [-1..1]
  eyeLid?: number; // eyelid coverage [0..1]
  pawX?: number;
  pawY?: number;
  pawAngle?: number; // degrees
  shadowScale?: number;
}

/** Configuration options for rendering pure Friday SVG vector markup. */
export interface FridaySvgOptions {
  state?: MascotState;
  accessories?: MascotAccessory[];
  size?: number; // Render width/height if scaling is requested
  tint?: string; // Optional custom status tint overriding STATE_TINTS
  pose?: FridayPose;
  className?: string;
  idPrefix?: string; // Unique prefix for SVG gradients/clips to avoid DOM collisions
  title?: string;
  description?: string;
  animated?: boolean;
}

/** Options for creating an interactive or embedded Friday Mascot instance. */
export interface FridayMascotOptions {
  size?: number; // default: 36
  state?: MascotState; // default: 'idle'
  accessories?: MascotAccessory[];
  interactive?: boolean; // default: true
  tint?: string; // semantic accent
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

/** Public control handle for the mascot component. */
export interface FridayMascotHandle {
  readonly el: HTMLElement;
  setState(state: MascotState): void;
  getState(): MascotState;
  setAccessories(accessories: MascotAccessory[]): void;
  getAccessories(): MascotAccessory[];
  setSize(size: number): void;
  setTint(tint: string | undefined): void;
  triggerImpulse(forceX: number, forceY: number): void;
  destroy(): void;
}

/** Maps any input status string to one of the 6 canonical Friday lifecycle states. */
export function toCanonicalState(state: string | undefined | null): MascotState {
  if (!state) return 'idle';
  const normalized = state.toLowerCase().trim();
  switch (normalized) {
    case 'thinking':
    case 'question':
      return 'thinking';
    case 'tool_execution':
    case 'working':
    case 'searching':
      return 'tool_execution';
    case 'success':
    case 'approval':
    case 'finished':
      return 'success';
    case 'error':
    case 'alert':
    case 'failed':
      return 'error';
    case 'sleep':
    case 'sleeping':
    case 'halted':
    case 'paused':
      return 'sleep';
    default:
      return 'idle';
  }
}
