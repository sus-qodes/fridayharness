/**
 * An agent's answer, laid out for reading (2026-11-18). Agents write a light Markdown: headings,
 * paragraphs, lists, code. Shown raw, a person reads pound signs and asterisks; parsed as HTML, an
 * agent's text would become markup. So the few forms that matter are read here and built as
 * elements whose content is text, never markup: headings, paragraphs, bullet and numbered lists,
 * fenced code, and inside a line `code` and **bold**. Everything else stays as it was written.
 * Hidden characters are shown as visible marks, as everywhere an agent's text is shown.
 */
import { visible } from '../model/text.js';
import { h } from './dom.js';
import { stripEscapes } from './format.js';

/** The most lines laid out; a longer text ends with a note saying so. */
const MAX_LINES = 4000;

/** `code` and **bold** inside a line, as elements; the rest as text. */
function inline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(m[1] !== undefined ? h('code', { class: 'pr-code' }, m[1]) : h('strong', null, m[2] ?? ''));
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The text as a block of elements a person reads top to bottom. */
export function prose(text: string): HTMLElement {
  const all = visible(stripEscapes(text)).replace(/\r\n?/g, '\n').split('\n');
  const lines = all.slice(0, MAX_LINES);
  const el = h('div', { class: 'pr' });
  let para: string[] = [];
  // In an object: the closures below end it, which a plain variable's narrowing would not see.
  const open: { list: { ordered: boolean; el: HTMLElement } | null } = { list: null };
  const endPara = (): void => {
    if (para.length) el.append(h('p', { class: 'pr-p' }, ...inline(para.join(' '))));
    para = [];
  };
  const endList = (): void => {
    open.list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = /^\s*```/.test(line);
    if (fence) {
      endPara();
      endList();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      el.append(h('pre', { class: 'pr-pre' }, h('code', null, code.join('\n'))));
      continue;
    }
    if (!line.trim()) {
      endPara();
      endList();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      endPara();
      endList();
      const level = (heading[1] ?? '#').length;
      el.append(h(level <= 2 ? 'h3' : 'h4', { class: 'pr-h' }, ...inline(heading[2] ?? '')));
      continue;
    }
    const item = /^\s*(?:([-*•])|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (item) {
      endPara();
      const ordered = item[2] !== undefined;
      if (!open.list || open.list.ordered !== ordered) {
        const made: HTMLElement = h(ordered ? 'ol' : 'ul', { class: 'pr-list' });
        el.append(made);
        open.list = { ordered, el: made };
      }
      open.list.el.append(h('li', null, ...inline(item[3] ?? '')));
      continue;
    }
    // A line that goes on under a list item belongs to it.
    const last = open.list?.el.lastElementChild;
    if (last && /^\s{2,}\S/.test(line)) {
      last.append(' ', ...inline(line.trim()));
      continue;
    }
    endList();
    para.push(line.trim());
  }
  endPara();
  if (all.length > MAX_LINES) {
    el.append(h('p', { class: 'pr-p muted' }, `(${all.length - MAX_LINES} more lines are not shown here)`));
  }
  return el;
}
