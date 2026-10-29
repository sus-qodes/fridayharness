/**
 * Blip's outfits (plan §7.9, handoff Part 02 §7): headphones, visor glasses, a winter hat, a witch
 * hat and sunglasses, chosen in Settings (`prefs.outfit`). Each is drawn in two passes: the part
 * behind the head before it, the part in front after the face. Same design grid as the character.
 */
import type { Prefs } from '../store/state.js';
import type { Ctx2D, Palette } from './character.js';
import type { Pose } from './engine.js';
import { roundRectPath } from './eyes.js';
import { CX, CY, type FaceLayout, R, rgbString } from './geometry.js';

export type Outfit = Prefs['outfit'];

export const OUTFITS: readonly Outfit[] = ['none', 'headphones', 'visor', 'winter', 'witch', 'sunglasses'];

export function isOutfit(value: unknown): value is Outfit {
  return typeof value === 'string' && (OUTFITS as readonly string[]).includes(value);
}

const BRIM_Y = CY - R * 0.8;

export function drawOutfitBehind(g: Ctx2D, outfit: Outfit, _pose: Pose, pal: Palette, _px: number): void {
  switch (outfit) {
    case 'headphones':
      // The band passes behind the antenna, over the top of the head.
      g.save();
      g.beginPath();
      g.lineWidth = R * 0.16;
      g.lineCap = 'round';
      g.strokeStyle = pal.slate600;
      g.arc(CX, CY + 1, R * 1.16, Math.PI * 1.06, Math.PI * 1.94, false);
      g.stroke();
      g.restore();
      break;
    case 'witch':
      // The far half of the brim.
      g.save();
      g.beginPath();
      g.ellipse(CX, BRIM_Y, R * 1.45, R * 0.3, 0, Math.PI, Math.PI * 2);
      g.fillStyle = pal.shell;
      g.fill();
      g.restore();
      break;
    default:
      break;
  }
}

export function drawOutfitFront(
  g: Ctx2D,
  outfit: Outfit,
  pose: Pose,
  pal: Palette,
  px: number,
  face: FaceLayout,
): void {
  switch (outfit) {
    case 'headphones':
      for (const side of [-1, 1] as const) {
        const x = CX + side * (R + 2.6) - pose.yaw * 1.6;
        g.save();
        g.beginPath();
        roundRectPath(g, x, CY + 1, R * 0.46, R * 0.92, R * 0.2);
        g.fillStyle = pal.slate600;
        g.fill();
        // A ring that glows with the antenna light.
        g.shadowColor = rgbString(pose.tint, 0.8);
        g.shadowBlur = Math.max(0, (1 + 3 * pose.light) * px);
        g.beginPath();
        roundRectPath(g, x, CY + 1, R * 0.26, R * 0.6, R * 0.12);
        g.lineWidth = 1.1;
        g.strokeStyle = rgbString(pose.tint, 0.4 + 0.5 * pose.light);
        g.stroke();
        g.restore();
      }
      break;
    case 'visor': {
      const v = face.visor;
      const y = (face.left.y + face.right.y) / 2;
      g.save();
      g.beginPath();
      roundRectPath(g, v.x, y, v.w * 1.08, R * 0.6, R * 0.16);
      g.fillStyle = rgbString(pose.tint, 0.14);
      g.fill();
      g.shadowColor = rgbString(pose.tint, 0.9);
      g.shadowBlur = Math.max(0, 2.5 * px);
      g.lineWidth = 1.1;
      g.strokeStyle = rgbString(pose.tint, 0.85);
      g.stroke();
      g.beginPath();
      g.lineWidth = 0.8;
      g.strokeStyle = pal.white;
      g.globalAlpha = 0.4;
      g.moveTo(v.x - v.w * 0.42, y - R * 0.22);
      g.lineTo(v.x + v.w * 0.42, y - R * 0.22);
      g.stroke();
      g.restore();
      break;
    }
    case 'winter': {
      g.save();
      // A knit dome over the top of the head (it covers the antenna).
      g.beginPath();
      g.moveTo(CX - R * 1.04, CY - R * 0.55);
      g.bezierCurveTo(CX - R * 1.04, CY - R * 1.62, CX + R * 1.04, CY - R * 1.62, CX + R * 1.04, CY - R * 0.55);
      g.closePath();
      g.fillStyle = pal.crimson;
      g.globalAlpha = 0.92;
      g.fill();
      g.globalAlpha = 0.18;
      g.strokeStyle = pal.white;
      g.lineWidth = 0.8;
      for (let i = -3; i <= 3; i++) {
        g.beginPath();
        g.moveTo(CX + i * R * 0.26, CY - R * 0.6);
        g.lineTo(CX + i * R * 0.2, CY - R * 1.2 + Math.abs(i) * R * 0.08);
        g.stroke();
      }
      g.globalAlpha = 1;
      // The cuff and the bobble.
      g.beginPath();
      roundRectPath(g, CX, CY - R * 0.6, R * 2.16, R * 0.34, R * 0.17);
      g.fillStyle = pal.slate200;
      g.fill();
      g.beginPath();
      g.arc(CX + pose.antennaX * 0.5, CY - R * 1.42 + pose.antennaY * 0.5, R * 0.22, 0, Math.PI * 2);
      g.fill();
      g.restore();
      break;
    }
    case 'witch': {
      g.save();
      const tipX = CX + R * 0.42 + pose.antennaX * 0.6;
      const tipY = CY - R * 2.2 + pose.antennaY * 0.4;
      g.beginPath();
      g.moveTo(CX - R * 0.78, BRIM_Y);
      g.quadraticCurveTo(CX - R * 0.2, CY - R * 1.5, tipX, tipY);
      g.quadraticCurveTo(CX + R * 0.32, CY - R * 1.4, CX + R * 0.78, BRIM_Y);
      g.closePath();
      g.fillStyle = pal.shell;
      g.fill();
      g.lineWidth = 0.8;
      g.strokeStyle = pal.shellHighlight;
      g.stroke();
      // The band.
      g.beginPath();
      g.moveTo(CX - R * 0.74, BRIM_Y - R * 0.12);
      g.lineTo(CX + R * 0.74, BRIM_Y - R * 0.12);
      g.lineWidth = R * 0.18;
      g.strokeStyle = pal.violet;
      g.stroke();
      // The near half of the brim.
      g.beginPath();
      g.ellipse(CX, BRIM_Y, R * 1.45, R * 0.3, 0, 0, Math.PI);
      g.fillStyle = pal.shell;
      g.fill();
      g.strokeStyle = pal.shellHighlight;
      g.lineWidth = 0.8;
      g.stroke();
      g.restore();
      break;
    }
    case 'sunglasses': {
      g.save();
      for (const eye of [face.left, face.right]) {
        g.beginPath();
        roundRectPath(g, eye.x, eye.y, R * 0.56, R * 0.44, R * 0.14);
        g.fillStyle = pal.visor;
        g.globalAlpha = 0.94;
        g.fill();
        g.globalAlpha = 1;
        g.lineWidth = 1;
        g.strokeStyle = pal.slate400;
        g.stroke();
        // Mirrored glints.
        g.beginPath();
        g.globalAlpha = 0.4;
        g.lineWidth = 0.8;
        g.strokeStyle = pal.white;
        g.moveTo(eye.x - R * 0.16, eye.y + R * 0.06);
        g.lineTo(eye.x - R * 0.04, eye.y - R * 0.12);
        g.moveTo(eye.x - R * 0.04, eye.y + R * 0.1);
        g.lineTo(eye.x + R * 0.08, eye.y - R * 0.08);
        g.stroke();
        g.globalAlpha = 1;
      }
      g.beginPath();
      g.lineWidth = 1;
      g.strokeStyle = pal.slate400;
      g.moveTo(face.left.x + R * 0.28, face.left.y - R * 0.06);
      g.lineTo(face.right.x - R * 0.28, face.right.y - R * 0.06);
      g.stroke();
      g.restore();
      break;
    }
    default:
      break;
  }
}
