/**
 * Blip, Friday's mascot (plan FD-12, §7.9; ERRATA F15): an original character drawn in code. A
 * small robot whose face is a screen: a rounded shell, a dark visor with two LED eyes, an antenna
 * with a light on top and a pad on each side. The state's tint lights the visor rim and the
 * antenna. Drawn on a 96 × 96 design grid that the caller scales to the canvas.
 */
import type { Pose } from './engine.js';
import { drawEye, type Pen, roundRectPath } from './eyes.js';
import { CX, CY, DESIGN, type FaceLayout, faceLayout, parseColor, R, type Rgb, rgbString } from './geometry.js';
import { drawOutfitBehind, drawOutfitFront, type Outfit } from './outfits.js';
import { drawParticles } from './particles.js';
import type { TintToken } from './states.js';

/** The mascot's name: one constant (plan FD-12). */
export const MASCOT_NAME = 'Blip';

export { CX, CY, DESIGN, type EyeBox, type FaceLayout, faceLayout, parseColor, R, rgbString } from './geometry.js';

export type Ctx2D = Pen &
  Pick<
    CanvasRenderingContext2D,
    | 'translate'
    | 'rotate'
    | 'scale'
    | 'setTransform'
    | 'clearRect'
    | 'createLinearGradient'
    | 'createRadialGradient'
    | 'globalAlpha'
    | 'fillStyle'
    | 'strokeStyle'
    | 'shadowBlur'
    | 'shadowColor'
    | 'rect'
    | 'clip'
  >;

/** Colours Blip uses, read from `styles/tokens.css` (with the same values as fallbacks). */
export interface Palette {
  shell: string;
  shellHighlight: string;
  visor: string;
  led: string;
  blush: string;
  /** For particles, badges and outfits. */
  white: string;
  slate200: string;
  slate400: string;
  slate500: string;
  slate600: string;
  cyan: string;
  emerald: string;
  amber: string;
  crimson: string;
  violet: string;
  indigo: string;
  neonBlue: string;
  /** Per state tint token, resolved. */
  tints: Record<TintToken, Rgb>;
}

const FALLBACK: Record<string, string> = {
  '--mascot-shell': '#1e293b',
  '--mascot-shell-highlight': '#334155',
  '--mascot-visor': '#05080f',
  '--mascot-led': '#22d3ee',
  '--mascot-blush': 'rgba(251, 113, 133, 0.65)',
  '--color-white': '#ffffff',
  '--color-slate-200': '#e2e8f0',
  '--color-slate-400': '#94a3b8',
  '--color-slate-500': '#64748b',
  '--color-slate-600': '#475569',
  '--color-cyan': '#06b6d4',
  '--color-emerald': '#10b981',
  '--color-amber': '#f59e0b',
  '--color-crimson': '#ef4444',
  '--color-violet': '#a855f7',
  '--color-indigo': '#6366f1',
  '--color-neon-blue': '#38bdf8',
};

const TINT_TOKENS: readonly TintToken[] = [
  '--color-slate-200',
  '--color-neon-blue',
  '--color-violet',
  '--color-indigo',
  '--color-amber',
  '--color-cyan',
  '--color-crimson',
  '--color-emerald',
  '--color-slate-500',
];

/** Only plain colour values are taken from the page (anything else falls back). */
function safeColor(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  return v && v.length < 64 && parseColor(v) ? v : fallback;
}

/** Reads the palette from the tokens on `root` (the document element by default). */
export function readPalette(root?: Element | null): Palette {
  let style: CSSStyleDeclaration | null = null;
  try {
    const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
    if (el && typeof getComputedStyle === 'function') style = getComputedStyle(el);
  } catch {
    style = null;
  }
  const get = (token: string) => safeColor(style?.getPropertyValue(token), FALLBACK[token] ?? '#ffffff');
  const tints = {} as Record<TintToken, Rgb>;
  for (const token of TINT_TOKENS)
    tints[token] = parseColor(get(token)) ?? parseColor(FALLBACK[token] ?? '#ffffff') ?? { r: 255, g: 255, b: 255 };
  return {
    shell: get('--mascot-shell'),
    shellHighlight: get('--mascot-shell-highlight'),
    visor: get('--mascot-visor'),
    led: get('--mascot-led'),
    blush: get('--mascot-blush'),
    white: get('--color-white'),
    slate200: get('--color-slate-200'),
    slate400: get('--color-slate-400'),
    slate500: get('--color-slate-500'),
    slate600: get('--color-slate-600'),
    cyan: get('--color-cyan'),
    emerald: get('--color-emerald'),
    amber: get('--color-amber'),
    crimson: get('--color-crimson'),
    violet: get('--color-violet'),
    indigo: get('--color-indigo'),
    neonBlue: get('--color-neon-blue'),
    tints,
  };
}

// ---------------------------------------------------------------------------------------------
// Drawing

/** The glow radius in device pixels for `design` design px at `px` device px per design px. */
function blur(design: number, px: number): number {
  return Math.max(0, design * px);
}

function drawShadow(g: Ctx2D, pose: Pose, pal: Palette): void {
  g.save();
  g.globalAlpha = 0.35 * pose.shadow;
  g.fillStyle = pal.visor;
  g.beginPath();
  g.ellipse(CX, CY + R * 1.25, R * 0.8 * pose.shadow, R * 0.13 * pose.shadow, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawPads(g: Ctx2D, pose: Pose, pal: Palette, px: number): void {
  if (pose.lift > 1) {
    // Bouncing Friday paws when jumping or excited
    g.save();
    g.fillStyle = '#e8e8ec';
    g.beginPath();
    g.arc(CX - R * 0.75, CY + R * 0.2, R * 0.16, 0, Math.PI * 2);
    g.arc(CX + R * 0.75, CY + R * 0.2, R * 0.16, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}

function drawAntenna(g: Ctx2D, pose: Pose, pal: Palette, px: number): void {
  // Soft ambient aura when glowing
  if (pose.light > 0.05) {
    const tipX = CX + pose.antennaX;
    const tipY = CY - R * 0.95 + pose.antennaY;
    g.save();
    g.shadowColor = rgbString(pose.tint, 0.9);
    g.shadowBlur = blur(3 + 5 * pose.light, px);
    g.beginPath();
    g.arc(tipX, tipY, R * 0.1, 0, Math.PI * 2);
    g.fillStyle = rgbString(pose.tint, 0.75);
    g.fill();
    g.restore();
  }
}

function drawShell(g: Ctx2D, pal: Palette, pose?: Pose): void {
  const rx = R * 1.14;
  const ry = R * 0.92;

  // Coucou authentic Friday superellipse body path (exponent 2.0 / 2.7)
  const n = 64;
  const expN = 2.0 / 2.7;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px0 = rx * (ca >= 0 ? ca ** expN : -((-ca) ** expN));
    const py0 = ry * (sa >= 0 ? sa ** expN : -((-sa) ** expN));
    if (i === 0) g.moveTo(CX + px0, CY + py0);
    else g.lineTo(CX + px0, CY + py0);
  }
  g.closePath();

  // Coucou Authentic Friday Body Gradient (BASE_TOP #EDEDEF to BASE_BOTTOM #C4C5CA)
  const grad = g.createLinearGradient(CX + rx * 0.7, CY - ry * 0.85, CX - rx * 0.8, CY + ry * 0.9);
  if (grad) {
    grad.addColorStop(0, '#f5f5f7');
    grad.addColorStop(0.55, '#e5e5ea');
    grad.addColorStop(1, '#c7c8ce');
    g.fillStyle = grad;
  }
  g.fill();

  if (pose) {
    // State tint illumination at base (Coucou effectiveTint)
    g.save();
    g.clip();
    const tintGrad = g.createLinearGradient(CX, CY + ry, CX, CY - ry * 0.4);
    if (tintGrad) {
      tintGrad.addColorStop(0, rgbString(pose.tint, 0.5));
      tintGrad.addColorStop(1, rgbString(pose.tint, 0));
      g.fillStyle = tintGrad;
    }
    g.fill();
    g.restore();
  }

  // Delicate white specular rim
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  g.stroke();
}

function drawVisor(g: Ctx2D, pose: Pose, face: FaceLayout, pal: Palette, px: number): void {
  // Delicate Apple glass sheen across Friday's face
  const v = face.visor;
  g.save();
  g.beginPath();
  roundRectPath(g, v.x, v.y, v.w, v.h, v.r);
  g.clip();
  g.globalAlpha = 0.04;
  g.fillStyle = pal.white;
  g.beginPath();
  g.moveTo(v.x - v.w / 2, v.y - v.h / 2);
  g.lineTo(v.x - v.w * 0.05, v.y - v.h / 2);
  g.lineTo(v.x - v.w * 0.35, v.y + v.h / 2);
  g.lineTo(v.x - v.w / 2, v.y + v.h / 2);
  g.closePath();
  g.fill();
  g.restore();
}

function drawEyes(g: Ctx2D, pose: Pose, face: FaceLayout, pal: Palette, px: number): void {
  g.save();
  const eyeColor = pose.eyes === 'heart' ? pal.blush : '#1a1412';
  g.fillStyle = eyeColor;
  g.strokeStyle = eyeColor;
  drawEye(g, pose.eyes, face.left.x, face.left.y, face.left.w, face.left.h, -1, pose.lid);
  drawEye(g, pose.eyes, face.right.x, face.right.y, face.right.w, face.right.h, 1, pose.lid);
  g.restore();
}

function drawBlush(g: Ctx2D, pose: Pose, face: FaceLayout, pal: Palette): void {
  const blushAlpha = Math.max(pose.blush, 0.35) * 0.65;
  g.save();
  g.fillStyle = `rgba(255, 120, 150, ${blushAlpha})`;
  const y = CY + R * 0.22 + pose.pitch * 6;
  const shift = pose.yaw * 10;
  for (const side of [-1, 1] as const) {
    const x = CX + side * (R * 0.58) + shift;
    g.beginPath();
    g.ellipse(x, y, R * 0.2, R * 0.1, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

function drawBadge(g: Ctx2D, pose: Pose, pal: Palette, px: number, size: number): void {
  // Badges read only when the canvas is large enough.
  if (!pose.badge || size < 32) return;
  const x = CX + R * 1.12;
  const y = CY - R * 1.12;
  g.save();
  g.shadowColor = rgbString(pose.tint, 0.7);
  g.shadowBlur = blur(2, px);
  g.fillStyle = rgbString(pose.tint, 0.95);
  g.strokeStyle = rgbString(pose.tint, 0.95);
  if (pose.badge === 'dots') {
    for (let i = 0; i < 3; i++) {
      const phase = pose.reduced ? 1 : 0.5 + 0.5 * Math.sin(pose.t * 6 - i * 0.9);
      g.globalAlpha = 0.35 + 0.65 * phase;
      g.beginPath();
      g.arc(x - 5 + i * 5, y + 2, 1.5, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    g.translate(x, y);
    if (pose.badge === 'question' && !pose.reduced) g.rotate(Math.sin(pose.t * 2) * 0.15);
    g.beginPath();
    g.arc(0, 0, 6.2, 0, Math.PI * 2);
    g.fillStyle = pal.visor;
    g.fill();
    g.lineWidth = 1.1;
    g.stroke();
    g.fillStyle = rgbString(pose.tint, 1);
    g.strokeStyle = rgbString(pose.tint, 1);
    if (pose.badge === 'bang') {
      g.beginPath();
      roundRectPath(g, 0, -1.2, 1.8, 5.2, 0.9);
      g.fill();
      g.beginPath();
      g.arc(0, 3.2, 1, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.lineWidth = 1.5;
      g.lineCap = 'round';
      g.arc(0, -1.6, 2.1, Math.PI * 1.1, Math.PI * 2.25, false);
      g.quadraticCurveTo(0, 0.4, 0, 1.2);
      g.stroke();
      g.beginPath();
      g.arc(0, 3.4, 0.95, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

export interface DrawOptions {
  /** The canvas size in CSS px (badges are skipped below 32). */
  size: number;
  /** Device px per CSS px (the backing store's ratio). */
  dpr: number;
  outfit: Outfit;
  palette: Palette;
}

/** Clears the canvas and draws Blip in `pose`. */
export function drawBlip(g: Ctx2D, pose: Pose, o: DrawOptions): void {
  const scale = (o.size / DESIGN) * o.dpr;
  if (!(scale > 0) || !Number.isFinite(scale)) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, o.size * o.dpr, o.size * o.dpr);
  g.setTransform(scale, 0, 0, scale, 0, 0);
  const pal = o.palette;
  const face = faceLayout(pose.yaw, pose.pitch);

  drawShadow(g, pose, pal);

  // The body transform: squash and stretch about the feet, tilt about the centre, lift and droop.
  g.save();
  const footY = CY + R * 0.85;
  g.translate(CX, footY - pose.lift + pose.drop);
  g.scale(sane(pose.scaleX), sane(pose.scaleY));
  g.translate(0, -R * 0.85);
  g.rotate(Number.isFinite(pose.tilt) ? pose.tilt : 0);
  g.translate(-CX, -CY);

  drawOutfitBehind(g, o.outfit, pose, pal, scale);
  drawAntenna(g, pose, pal, scale);
  drawPads(g, pose, pal, scale);
  drawShell(g, pal, pose);
  drawVisor(g, pose, face, pal, scale);
  drawEyes(g, pose, face, pal, scale);
  drawBlush(g, pose, face, pal);
  drawOutfitFront(g, o.outfit, pose, pal, scale, face);
  g.restore();

  // Particles and the badge stay upright.
  drawParticles(g, pose.particles, CX, CY - pose.lift);
  drawBadge(g, pose, pal, scale, o.size);
}

function sane(scale: number): number {
  return Number.isFinite(scale) ? Math.min(1.6, Math.max(0.4, scale)) : 1;
}
