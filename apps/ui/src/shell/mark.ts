/** Friday's product mark: the mascot — a squishy cream silhouette (ears, egg body, ink eyes). */
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
    s('path', {
      d: 'M7.2 9.4 Q5.8 3.8 10 6.2 Z',
      class: 'sh-mark-ear',
    }),
    s('path', {
      d: 'M16.8 9.4 Q18.2 3.8 14 6.2 Z',
      class: 'sh-mark-ear',
    }),
    s('ellipse', { cx: 12, cy: 14, rx: 7.6, ry: 6.6, class: 'sh-mark-body' }),
    s('rect', { x: 8.7, y: 12.2, width: 2, height: 3.6, rx: 1, class: 'sh-mark-eye' }),
    s('rect', { x: 13.3, y: 12.2, width: 2, height: 3.6, rx: 1, class: 'sh-mark-eye' }),
    s('ellipse', { cx: 7.9, cy: 16.2, rx: 1.5, ry: 0.8, class: 'sh-mark-blush' }),
    s('ellipse', { cx: 16.1, cy: 16.2, rx: 1.5, ry: 0.8, class: 'sh-mark-blush' }),
  );
}
