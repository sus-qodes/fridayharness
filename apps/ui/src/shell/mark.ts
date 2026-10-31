/** Friday's product mark: the mascot, a small yellow duck (round head, two-bump tuft, orange beak). */
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
    s('ellipse', { cx: 10.8, cy: 6.4, rx: 2.1, ry: 2.5, class: 'sh-mark-tuft' }),
    s('ellipse', { cx: 14.2, cy: 7.2, rx: 1.7, ry: 1.6, class: 'sh-mark-tuft' }),
    s('ellipse', { cx: 12, cy: 13.6, rx: 8.4, ry: 7.4, class: 'sh-mark-body' }),
    s('ellipse', { cx: 8.8, cy: 12.6, rx: 1.15, ry: 1.6, class: 'sh-mark-eye' }),
    s('ellipse', { cx: 15.2, cy: 12.6, rx: 1.15, ry: 1.6, class: 'sh-mark-eye' }),
    s('ellipse', { cx: 12, cy: 16.1, rx: 3.1, ry: 2, class: 'sh-mark-beak' }),
    s('path', { d: 'M10.9 16.3 Q12 17.2 13.1 16.3', class: 'sh-mark-smile' }),
  );
}
