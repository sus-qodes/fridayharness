/**
 * The dot grid (handoff Part 03 §2.3): 24 px world spacing, opacity by zoom, fewer dots when
 * zoomed out so a frame never draws tens of thousands of them.
 */
import { type Camera, gridOpacity, gridSpacing, type Size } from './viewport.js';

/** The first dot's screen offset for a spacing: world 0 sits at the camera's translation. */
export function gridOffset(t: number, spacing: number): number {
  return ((t % spacing) + spacing) % spacing;
}

/** Draws the grid in screen coordinates (the caller cleared the canvas and set the pixel ratio). */
export function drawGrid(g: CanvasRenderingContext2D, cam: Camera, size: Size, color: string): number {
  const spacing = gridSpacing(cam.zoom);
  const ox = gridOffset(cam.x, spacing);
  const oy = gridOffset(cam.y, spacing);
  const dot = cam.zoom < 0.6 ? 1 : 1.5;
  g.save();
  g.globalAlpha = gridOpacity(cam.zoom);
  g.fillStyle = color;
  let n = 0;
  for (let x = ox; x < size.width; x += spacing) {
    for (let y = oy; y < size.height; y += spacing) {
      g.fillRect(x - dot / 2, y - dot / 2, dot, dot);
      n += 1;
    }
  }
  g.restore();
  return n;
}
