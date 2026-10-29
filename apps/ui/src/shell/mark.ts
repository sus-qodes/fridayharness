/** Friday's product mark: Blip's face (a visor with two LED eyes and an antenna light; FD-12). */
import { s } from '../ui/svg.js';

export function productMark(size = 22, extraClass?: string): SVGSVGElement {
  return s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      class: extraClass ? `sh-mark ${extraClass}` : 'sh-mark',
      'aria-hidden': 'true',
    },
    s('line', { x1: 12, y1: 2.5, x2: 12, y2: 5.5, class: 'sh-mark-antenna' }),
    s('circle', { cx: 12, cy: 2.5, r: 1.4, class: 'sh-mark-light' }),
    s('rect', { x: 3, y: 5.5, width: 18, height: 14, rx: 5, class: 'sh-mark-shell' }),
    s('rect', { x: 5.5, y: 8.5, width: 13, height: 8, rx: 3, class: 'sh-mark-visor' }),
    s('rect', { x: 8, y: 10.5, width: 2.2, height: 4, rx: 1.1, class: 'sh-mark-eye' }),
    s('rect', { x: 13.8, y: 10.5, width: 2.2, height: 4, rx: 1.1, class: 'sh-mark-eye' }),
  );
}
