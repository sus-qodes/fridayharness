/**
 * Friday, the app's mascot: a squishy little creature — one cream silhouette (a soft egg of a
 * body with two rounded ears and a small tail) with ink eyes and a blush, drawn in code. The
 * state's tint washes up the body and lights a soft halo behind it. Drawn on a 96 × 96 design
 * grid that the caller scales to the canvas.
 */
import type { Pose } from './engine.js';
import { drawEye, type Pen } from './eyes.js';
import { CX, CY, DESIGN, type FaceLayout, faceLayout, parseColor, R, type Rgb, rgbString } from './geometry.js';
import { drawOutfitBehind, drawOutfitFront, type Outfit } from './outfits.js';
import { drawParticles } from './particles.js';
import type { TintToken } from './states.js';

/** The mascot's name: one constant. */
export const MASCOT_NAME = 'Friday';

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

/** Colours the mascot uses, read from `styles/tokens.css` (with the same values as fallbacks). */
export interface Palette {
  bodyTop: string;
  bodyBottom: string;
  ink: string;
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
  '--mascot-body-top': '#f6f1e7',
  '--mascot-body-bottom': '#d9cfbe',
  '--mascot-ink': '#1a1412',
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
    bodyTop: get('--mascot-body-top'),
    bodyBottom: get('--mascot-body-bottom'),
    ink: get('--mascot-ink'),
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
  g.globalAlpha = 0.3 * pose.shadow;
  g.fillStyle = pal.ink;
  g.beginPath();
  g.ellipse(CX, CY + R * 1.25, R * 0.82 * pose.shadow, R * 0.13 * pose.shadow, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** A soft state-coloured halo behind the body — the creature's mood light. */
function drawHalo(g: Ctx2D, pose: Pose): void {
  if (pose.light <= 0.05) return;
  g.save();
  const grad = g.createRadialGradient(CX, CY - R * 0.1, R * 0.3, CX, CY - R * 0.1, R * 1.7);
  if (grad) {
    grad.addColorStop(0, rgbString(pose.tint, 0.22 * pose.light));
    grad.addColorStop(1, rgbString(pose.tint, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(CX, CY - R * 0.1, R * 1.7, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** Little paws that show when the body leaves the ground (a jump, an excited hop). */
function drawPaws(g: Ctx2D, pose: Pose, pal: Palette): void {
  if (pose.lift > 1) {
    g.save();
    g.fillStyle = pal.bodyBottom;
    g.beginPath();
    g.arc(CX - R * 0.72, CY + R * 0.28, R * 0.15, 0, Math.PI * 2);
    g.arc(CX + R * 0.72, CY + R * 0.28, R * 0.15, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}

/**
 * The body: a squishy egg — a superellipse whose girth widens toward the bottom, so the
 * silhouette stays one shape: narrower crown, chubby base.
 */
function bodyPath(g: Ctx2D): void {
  const rx = R * 1.16;
  const ry = R * 0.94;
  const n = 64;
  const e = 0.82; // superellipse exponent (1 = ellipse, >1 = squarer)
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // `sa` is −1 at the crown and +1 at the base: the base is ~10% wider than the crown.
    const girth = 1 + 0.1 * sa;
    const px0 = rx * girth * (ca >= 0 ? ca ** e : -((-ca) ** e));
    const py0 = ry * (sa >= 0 ? sa ** e : -((-sa) ** e));
    if (i === 0) g.moveTo(CX + px0, CY + py0);
    else g.lineTo(CX + px0, CY + py0);
  }
  g.closePath();
}

function drawTail(g: Ctx2D, pal: Palette, pose: Pose): void {
  g.save();
  g.fillStyle = pal.bodyBottom;
  g.beginPath();
  const wag = pose.earX * 0.12;
  g.ellipse(CX + R * 1.12, CY + R * 0.22 + pose.earY * 0.1, R * 0.24, R * 0.13, -0.5 + wag, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** Two rounded ears on the crown; the engine's lag springs make them trail the head's motion. */
function drawEars(g: Ctx2D, pose: Pose, pal: Palette): void {
  for (const side of [-1, 1] as const) {
    const lag = pose.earX * 0.045 * side + pose.earY * 0.012;
    g.save();
    g.translate(CX + side * R * 0.5 + pose.earX * 0.5, CY - R * 0.62 + pose.earY * 0.4);
    g.rotate(side * 0.22 + lag);
    const w = R * 0.34;
    const h = R * 0.62;
    g.beginPath();
    g.moveTo(-w, h * 0.5);
    g.quadraticCurveTo(-w * 0.7, -h * 0.75, 0, -h);
    g.quadraticCurveTo(w * 0.85, -h * 0.7, w, h * 0.5);
    g.quadraticCurveTo(0, h * 0.86, -w, h * 0.5);
    g.closePath();
    g.fillStyle = pal.bodyTop;
    g.fill();
    // Inner ear picks up the state's tint.
    g.beginPath();
    g.moveTo(-w * 0.45, h * 0.28);
    g.quadraticCurveTo(-w * 0.35, -h * 0.5, 0, -h * 0.72);
    g.quadraticCurveTo(w * 0.45, -h * 0.45, w * 0.5, h * 0.28);
    g.quadraticCurveTo(0, h * 0.52, -w * 0.45, h * 0.28);
    g.closePath();
    g.fillStyle = rgbString(pose.tint, 0.35 * Math.max(0.3, pose.light));
    g.fill();
    g.restore();
  }
}

function drawBody(g: Ctx2D, pose: Pose, pal: Palette): void {
  bodyPath(g);

  // Cream gradient over the whole silhouette — the character's two base colours.
  const grad = g.createLinearGradient(CX + R * 0.7, CY - R * 0.9, CX - R * 0.6, CY + R * 0.95);
  if (grad) {
    grad.addColorStop(0, pal.bodyTop);
    grad.addColorStop(1, pal.bodyBottom);
    g.fillStyle = grad;
  }
  g.fill();

  // The state's tint washes up from the base.
  g.save();
  g.clip();
  const tintGrad = g.createLinearGradient(CX, CY + R, CX, CY - R * 0.4);
  if (tintGrad) {
    tintGrad.addColorStop(0, rgbString(pose.tint, 0.5));
    tintGrad.addColorStop(1, rgbString(pose.tint, 0));
    g.fillStyle = tintGrad;
    g.fill();
  }
  // A soft specular on the crown: what squishy looks like.
  g.globalAlpha = 0.5;
  g.fillStyle = pal.white;
  g.beginPath();
  g.ellipse(CX - R * 0.38, CY - R * 0.5, R * 0.34, R * 0.18, -0.5, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Delicate rim.
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  g.stroke();
}

function drawEyes(g: Ctx2D, pose: Pose, face: FaceLayout, pal: Palette): void {
  g.save();
  const eyeColor = pose.eyes === 'heart' ? pal.blush : pal.ink;
  g.fillStyle = eyeColor;
  g.strokeStyle = eyeColor;
  drawEye(g, pose.eyes, face.left.x, face.left.y, face.left.w, face.left.h, -1, pose.lid);
  drawEye(g, pose.eyes, face.right.x, face.right.y, face.right.w, face.right.h, 1, pose.lid);
  g.restore();
}

function drawBlush(g: Ctx2D, pose: Pose): void {
  const blushAlpha = Math.max(pose.blush, 0.35) * 0.6;
  g.save();
  g.fillStyle = `rgba(255, 120, 150, ${blushAlpha})`;
  const y = CY + R * 0.2 + pose.pitch * 6;
  const shift = pose.yaw * 10;
  for (const side of [-1, 1] as const) {
    const x = CX + side * (R * 0.56) + shift;
    g.beginPath();
    g.ellipse(x, y, R * 0.19, R * 0.1, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** A tiny smile that only shows while the eyes are delighted. */
function drawMouth(g: Ctx2D, pose: Pose, pal: Palette): void {
  if (pose.eyes !== 'happy' && pose.eyes !== 'star' && pose.eyes !== 'heart') return;
  g.save();
  g.strokeStyle = pal.ink;
  g.lineWidth = 1.4;
  g.lineCap = 'round';
  g.beginPath();
  const mx = CX + pose.yaw * 3;
  const my = CY + R * 0.38 + pose.pitch * 3;
  g.arc(mx, my - R * 0.04, R * 0.14, Math.PI * 0.15, Math.PI * 0.85);
  g.stroke();
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
    g.fillStyle = pal.ink;
    g.fill();
    g.lineWidth = 1.1;
    g.stroke();
    g.fillStyle = rgbString(pose.tint, 1);
    g.strokeStyle = rgbString(pose.tint, 1);
    if (pose.badge === 'bang') {
      g.beginPath();
      g.rect(0 - 0.9, -1.2 - 2.6, 1.8, 5.2);
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

/** Clears the canvas and draws the mascot in `pose`. */
export function drawMascot(g: Ctx2D, pose: Pose, o: DrawOptions): void {
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

  drawHalo(g, pose);
  drawOutfitBehind(g, o.outfit, pose, pal, scale);
  drawTail(g, pal, pose);
  drawEars(g, pose, pal);
  drawBody(g, pose, pal);
  drawPaws(g, pose, pal);
  drawEyes(g, pose, face, pal);
  drawBlush(g, pose);
  drawMouth(g, pose, pal);
  drawOutfitFront(g, o.outfit, pose, pal, scale, face);
  g.restore();

  // Particles and the badge stay upright.
  drawParticles(g, pose.particles, CX, CY - pose.lift);
  drawBadge(g, pose, pal, scale, o.size);
}

function sane(scale: number): number {
  return Number.isFinite(scale) ? Math.min(1.6, Math.max(0.4, scale)) : 1;
}
