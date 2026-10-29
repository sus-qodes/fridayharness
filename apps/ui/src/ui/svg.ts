/** SVG builders and the icon set, made with `createElementNS` only (plan FD-20). */

const NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (SVGElement | string | null | undefined | false)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (/^on/i.test(k) || k === 'href' || k === 'xlink:href') throw new Error(`attribute ${k} is not allowed`);
    el.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (!child) continue;
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else el.appendChild(child);
  }
  return el;
}

/** Stroke icons on a 24×24 grid. */
const PATHS = {
  target: [
    'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20',
    'M12 6a6 6 0 1 0 0 12a6 6 0 1 0 0-12',
    'M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  ],
  bolt: ['M13 2L4 14h7l-1 8l9-12h-7z'],
  hourglass: ['M6 2h12', 'M6 22h12', 'M7 2c0 6 10 6 10 10s-10 4-10 10', 'M17 2c0 6-10 6-10 10s10 4 10 10'],
  check: ['M5 12l5 5L20 7'],
  cross: ['M6 6l12 12', 'M18 6L6 18'],
  rework: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
  eye: ['M2 12s4-7 10-7s10 7 10 7s-4 7-10 7S2 12 2 12', 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6'],
  swap: ['M7 7h13l-4-4', 'M17 17H4l4 4'],
  shield: ['M12 2l8 3v6c0 5-3.5 9.5-8 11c-4.5-1.5-8-6-8-11V5z'],
  robot: ['M8 3h8', 'M12 3v3', 'M5 8h14v11H5z', 'M9 13h.01', 'M15 13h.01', 'M2 12v3', 'M22 12v3'],
  gear: [
    'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
    'M12 2v3',
    'M12 19v3',
    'M2 12h3',
    'M19 12h3',
    'M4.9 4.9l2.1 2.1',
    'M17 17l2.1 2.1',
    'M4.9 19.1L7 17',
    'M17 7l2.1-2.1',
  ],
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14', 'M21 21l-5-5'],
  plus: ['M12 5v14', 'M5 12h14'],
  pause: ['M8 5v14', 'M16 5v14'],
  play: ['M7 4l13 8l-13 8z'],
  stop: ['M6 6h12v12H6z'],
  halt: ['M8 2h8l6 6v8l-6 6H8l-6-6V8z', 'M12 7v6', 'M12 16v.5'],
  fit: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  zoomIn: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14', 'M21 21l-5-5', 'M11 8v6', 'M8 11h6'],
  zoomOut: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14', 'M21 21l-5-5', 'M8 11h6'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  expand: ['M14 4h6v6', 'M10 20H4v-6', 'M20 4l-7 7', 'M4 20l7-7'],
  file: ['M6 2h8l4 4v16H6z', 'M14 2v4h4'],
  graph: [
    'M6 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
    'M18 4a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
    'M18 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
    'M8 8l8-2',
    'M7.5 9.5l9 7.5',
  ],
  memory: ['M4 6h16v12H4z', 'M8 6V4', 'M12 6V4', 'M16 6V4', 'M8 20v-2', 'M12 20v-2', 'M16 20v-2'],
  terminal: ['M4 5h16v14H4z', 'M7 9l3 3l-3 3', 'M12 15h5'],
  question: ['M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14', 'M12 18v.5'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  sound: ['M4 9h4l5-4v14l-5-4H4z', 'M16 9a4 4 0 0 1 0 6', 'M19 6a8 8 0 0 1 0 12'],
  mute: ['M4 9h4l5-4v14l-5-4H4z', 'M17 9l5 6', 'M22 9l-5 6'],
  branch: ['M6 3v12', 'M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M18 6a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M18 12c0 4-6 3-12 6'],
  message: ['M4 5h16v11H8l-4 4z'],
  goal: ['M5 21V4', 'M5 4h11l-2 4l2 4H5'],
  logout: ['M10 4H5v16h5', 'M14 8l4 4l-4 4', 'M18 12H9'],
  chevronDown: ['M6 9l6 6l6-6'],
  chevronRight: ['M9 6l6 6l-6 6'],
  dot: ['M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof PATHS;

/** An inline icon; decorative unless a label is given. */
export function icon(name: IconName, size = 16, label?: string): SVGSVGElement {
  const el = s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: 'icon',
    },
    ...PATHS[name].map((d) => s('path', { d })),
  );
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
    el.prepend(s('title', {}, label));
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  return el;
}
