import { describe, expect, it } from 'vitest';
import { prose } from './prose.js';

const tags = (el: Element) => [...el.children].map((c) => c.tagName.toLowerCase());

describe('an agent’s answer, laid out for reading (2026-11-18)', () => {
  it('lays out headings, paragraphs, lists and code', () => {
    const el = prose(
      [
        '# How prices are revised',
        '',
        'A price is kept **per outlet**. Every change is a new row in',
        '`menu_price_revisions`.',
        '',
        '- the old price stays',
        '- the new one takes effect',
        '  from its start time',
        '',
        '1. read the row',
        '2) write the next',
        '',
        '```ts',
        'const price = revision.price; // <b>not markup</b>',
        '```',
        '### Where it is tested',
        'In the menu tests.',
      ].join('\n'),
    );
    expect(tags(el)).toEqual(['h3', 'p', 'ul', 'ol', 'pre', 'h4', 'p']);
    expect(el.querySelector('h3')?.textContent).toBe('How prices are revised');
    const p = el.querySelector('p') as HTMLElement;
    // Lines of one paragraph are joined; bold and code are elements, their marks gone.
    expect(p.textContent).toBe('A price is kept per outlet. Every change is a new row in menu_price_revisions.');
    expect(p.querySelector('strong')?.textContent).toBe('per outlet');
    expect(p.querySelector('code')?.textContent).toBe('menu_price_revisions');
    const items = [...el.querySelectorAll('ul li')].map((li) => li.textContent);
    expect(items).toEqual(['the old price stays', 'the new one takes effect from its start time']);
    expect([...el.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual(['read the row', 'write the next']);
    // Code keeps its lines and its characters, as text.
    expect(el.querySelector('pre')?.textContent).toBe('const price = revision.price; // <b>not markup</b>');
  });

  it('never turns an agent’s text into markup', () => {
    const el = prose(
      '<img src=x onerror=alert(1)> and <script>alert(2)</script>\n\n- <b>bold?</b>\n\n[link](javascript:alert(3))',
    );
    expect(el.querySelector('img, script, b, a')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.textContent).toContain('[link](javascript:alert(3))');
  });

  it('shows hidden characters as visible marks and drops terminal escapes', () => {
    const el = prose('safe\u202Etext \u001b[31mred\u001b[0m');
    expect(el.textContent).toContain('⟨U+202E⟩');
    expect(el.textContent).not.toContain('\u202E');
    expect(el.textContent).not.toContain('\u001b');
    expect(el.textContent).toContain('red');
  });

  it('leaves plain prose as paragraphs, and an unclosed fence as code to the end', () => {
    expect(tags(prose('One line.\n\nAnother, with a star * and a `tick.'))).toEqual(['p', 'p']);
    const open = prose('Before\n```\nline 1\nline 2');
    expect(tags(open)).toEqual(['p', 'pre']);
    expect(open.querySelector('pre')?.textContent).toBe('line 1\nline 2');
    expect(prose('').children).toHaveLength(0);
  });
});
