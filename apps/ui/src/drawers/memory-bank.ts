/**
 * The memory bank drawer (plan §7.4, handoff Part 05 §5, ERRATA F25): search over the project's
 * memory (`GET memory?query=`), kind and scope filters applied to the results shown (the route has no
 * scope filter), authority badges with human-approved decisions pinned first, a recency bar from the
 * result's weight and the authority's half-life, and the memories that need review with Approve and
 * Retract. Memory text is written by agents: shown as text, review items with visible marks.
 */
import type { MemoryHit } from '../api/client.js';
import { hasHidden, visible } from '../model/text.js';
import type { AppContext, Component, DrawerRequest } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { cleanText, humanize, plural, shortId, timeAgo, truncate } from '../ui/format.js';
import { icon, s } from '../ui/svg.js';
import { badge, empty, errorNote, loading, meter } from './common.js';
import {
  authorityLook,
  filterMemories,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  recencyBar,
  sortMemories,
} from './memory-model.js';

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_LIMIT = 40;
const CONTENT_PREVIEW = 600;

/** A pushpin (svg.ts has none): human-approved memories are pinned. */
function pinIcon(): SVGSVGElement {
  return s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 12,
      height: 12,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: 'icon',
      role: 'img',
      'aria-label': 'Pinned',
    },
    s('title', {}, 'Pinned'),
    s('path', { d: 'M9 3h6l-1 6l4 4H6l4-4z' }),
    s('path', { d: 'M12 13v8' }),
  );
}

export function createMemoryBank(ctx: AppContext, _request: DrawerRequest): Component & { title: string } {
  let destroyed = false;
  let results: MemoryHit[] = [];
  let reviewItems: MemoryHit[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let token = 0;
  const filter = { kind: '', scope: '' };

  const search = h('input', {
    class: 'input dr-mem-search',
    type: 'search',
    placeholder: 'Search memories',
    autocomplete: 'off',
    aria: { label: 'Search memories' },
    on: {
      input: () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void runSearch();
        }, SEARCH_DEBOUNCE_MS);
      },
      keydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (timer !== null) clearTimeout(timer);
          timer = null;
          void runSearch();
        }
      },
    },
  });
  const kindSelect = h(
    'select',
    {
      class: 'select dr-mem-kind',
      aria: { label: 'Kind' },
      on: {
        change: () => {
          filter.kind = kindSelect.value;
          renderResults();
        },
      },
    },
    h('option', { value: '' }, 'All kinds'),
    MEMORY_KINDS.map((k) => h('option', { value: k }, humanize(k))),
  );
  const scopeSelect = h(
    'select',
    {
      class: 'select dr-mem-scope',
      aria: { label: 'Scope' },
      on: {
        change: () => {
          filter.scope = scopeSelect.value;
          renderResults();
        },
      },
    },
    h('option', { value: '' }, 'All scopes'),
    MEMORY_SCOPES.map((k) => h('option', { value: k }, humanize(k))),
  );
  const review = h('div', { class: 'dr-mem-review' });
  const count = h('div', { class: 'dr-mem-count muted', role: 'status', aria: { live: 'polite' } });
  const list = h('ul', { class: 'dr-mem-list', aria: { label: 'Memories' } });
  const el = h(
    'div',
    { class: 'dr-memory' },
    h('div', { class: 'dr-mem-bar' }, search, h('div', { class: 'row' }, kindSelect, scopeSelect)),
    h('p', { class: 'field-hint' }, 'The kind and scope filters apply to the results shown below.'),
    review,
    count,
    list,
  );

  function card(m: MemoryHit, forReview: boolean): HTMLElement {
    const look = authorityLook(m.authority);
    const bar = recencyBar(m, ctx.now());
    const pinned = m.authority === 'human-approved';
    const text = (v: string) => (forReview ? visible(v) : cleanText(v));
    const content = text(m.content);
    const long = Array.from(content).length > CONTENT_PREVIEW;
    const body = h('p', { class: 'dr-mem-content dr-prewrap' }, long ? truncate(content, CONTENT_PREVIEW) : content);
    const kids = [
      h(
        'div',
        { class: 'row-wrap dr-mem-meta' },
        pinned ? h('span', { class: 'dr-pin', title: 'Human-approved: pinned, never fades' }, pinIcon()) : null,
        badge(humanize(m.kind), 'info'),
        badge(look.label, look.tone),
        badge(`${humanize(m.scope_type)}${m.scope_id ? ` ${shortId(m.scope_id)}` : ''}`, 'muted'),
        m.needs_review ? badge('Needs review', 'warn') : null,
        m.status !== 'active' ? badge(humanize(m.status), 'muted') : null,
        h('span', { class: 'spacer' }),
        typeof m.score === 'number' ? h('span', { class: 'muted dr-mem-score' }, `score ${m.score.toFixed(2)}`) : null,
      ),
      h('div', { class: 'dr-mem-subject' }, text(m.subject)),
      forReview && (hasHidden(m.subject) || hasHidden(m.content))
        ? h('div', { class: 'hidden-warning' }, 'This memory holds hidden characters, shown as ⟨U+…⟩ marks.')
        : null,
      body,
      long
        ? button(
            'Show all',
            (e) => {
              body.textContent = content;
              (e.currentTarget as HTMLElement).remove();
            },
            { class: 'btn btn-ghost dr-more' },
          )
        : null,
      m.tags.length
        ? h(
            'div',
            { class: 'row-wrap' },
            m.tags.map((t) => h('span', { class: 'pill dr-tag' }, `#${text(t)}`)),
          )
        : null,
      h(
        'div',
        { class: 'dr-mem-recency' },
        meter(bar.fraction, `Recency: ${bar.label}`, bar.permanent ? 'strong' : 'info'),
        h(
          'span',
          { class: 'muted' },
          bar.label,
          bar.weight !== null ? ` · weight ${bar.weight.toFixed(2)}` : '',
          ` · updated ${timeAgo(m.updated_at, ctx.now())}`,
        ),
      ),
    ];
    if (forReview) {
      kids.push(
        h(
          'div',
          { class: 'row dr-mem-actions' },
          button([icon('check', 14), 'Approve'], () => void approve(m), { class: 'btn btn-primary' }),
          button([icon('cross', 14), 'Retract'], () => void retract(m), { class: 'btn btn-danger' }),
        ),
      );
    }
    return h('li', { class: ['dr-mem', pinned && 'dr-mem-pinned', forReview && 'dr-mem-forreview'] }, kids);
  }

  function renderResults(): void {
    const shown = sortMemories(filterMemories(results, filter));
    const hidden = results.length - shown.length;
    replace(
      count,
      plural(shown.length, 'memory', 'memories'),
      hidden > 0 ? ` (${hidden} hidden by the filters)` : '',
      results.length >= SEARCH_LIMIT ? ` · the first ${SEARCH_LIMIT} matches` : '',
    );
    replace(list, shown.length ? shown.map((m) => card(m, false)) : h('li', null, empty('No memories match.')));
  }

  function renderReview(): void {
    if (!reviewItems.length) {
      replace(review);
      return;
    }
    replace(
      review,
      h('h3', { class: 'section-title' }, `Needs review (${reviewItems.length})`),
      h(
        'ul',
        { class: 'dr-mem-list' },
        reviewItems.map((m) => card(m, true)),
      ),
    );
  }

  async function runSearch(): Promise<void> {
    const mine = ++token;
    replace(list, h('li', null, loading('Searching…')));
    try {
      const r = await ctx.api.memory(search.value.trim(), { limit: SEARCH_LIMIT });
      if (destroyed || mine !== token) return;
      results = r.memories ?? [];
      renderResults();
    } catch (e) {
      if (destroyed || mine !== token) return;
      results = [];
      replace(count);
      replace(list, h('li', null, errorNote('Could not search the memory', e)));
    }
  }

  async function loadReview(): Promise<void> {
    try {
      const r = await ctx.api.memoryReview();
      if (destroyed) return;
      reviewItems = r.memories ?? [];
      renderReview();
    } catch (e) {
      if (!destroyed) replace(review, errorNote('Could not read the memories that need review', e));
    }
  }

  async function approve(m: MemoryHit): Promise<void> {
    const r = await ctx.act('Approve the memory', () => ctx.api.approveMemory(m.memory_id), 'Memory approved');
    if (r !== undefined && !destroyed) {
      void loadReview();
      void runSearch();
    }
  }

  async function retract(m: MemoryHit): Promise<void> {
    const ok = await ctx.confirm({
      title: 'Retract this memory?',
      body: [`“${truncate(visible(m.subject), 160)}”`, 'Agents will no longer be given it. The record is kept.'],
      confirmLabel: 'Retract',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    const r = await ctx.act(
      'Retract the memory',
      () => ctx.api.retractMemory(m.memory_id, 'retracted in the memory bank'),
      'Memory retracted',
    );
    if (r !== undefined && !destroyed) {
      void loadReview();
      void runSearch();
    }
  }

  void loadReview();
  void runSearch();

  return {
    el,
    title: 'Project memory',
    destroy() {
      destroyed = true;
      token++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      el.remove();
    },
  };
}
