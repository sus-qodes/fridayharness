/**
 * The island's views (plan §7.8, handoff Part 01 §5): the hidden strip, the compact pill, the
 * expanded card and the greeting. Cards built by other areas (approvals, questions, waiting
 * agents, the goal line, the mascot) come in through `NotchSlots`, so the Notch imports none of
 * them. Every daemon string is a text node; file and branch names keep visible escapes.
 *
 * The card exists only in the desktop Notch window. In a browser page the pill is the whole Notch
 * (review §4, owner decision 1): the rail beside it shows every waiting item in full, so the pill's
 * parts are doors instead: the task's tag opens its inspector, the file ticker the diff, the
 * waiting chip the rail.
 */
import type { ApprovalRow, EscalationView, SnapshotTask } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component } from '../shell/context.js';
import { button, h, replace, setText, setVar, toggleClass } from '../ui/dom.js';
import { cleanText, plural, truncate } from '../ui/format.js';
import { icon, s } from '../ui/svg.js';
import { itemSignature, type NotchModel, statsText, type WaitingItem } from './derive.js';

/** The cards the Notch shows, built by their own areas. */
export interface NotchSlots {
  approval(ctx: AppContext, a: ApprovalRow, opts: { compact: boolean }): Component;
  question(ctx: AppContext, e: EscalationView, opts: { compact: boolean; onLater: () => void }): Component;
  waiting(ctx: AppContext, t: SnapshotTask, opts: { compact: boolean }): Component;
  /** The goal line of the desktop card ("Describe a goal…"). */
  quickPrompt(ctx: AppContext, opts: { onDone: () => void }): Component;
  mascot(ctx: AppContext, opts: { size: number }): Component;
}

/** What the views ask the host to do. */
export interface ViewHandlers {
  /** Open the card (a click on the pill or the strip, in the window). */
  open(): void;
  /** The ticker's file: the diff drawer. */
  openDiff(taskId: string, path: string): void;
  /** "Open this in Studio" (header) or `Space` on the card: the current item, else the active task. */
  openStudio(): void;
  /** The footer's "Open Studio" button. */
  openStudioGeneral(): void;
  /** A notice's button: where this item is decided in the Studio. */
  openItem(item: WaitingItem): void;
  /** The active task's summary (card) or its tag (pill in a page): its inspector. */
  inspect(taskId: string): void;
  /** The pill's waiting chip in a page: the rail, where every item is shown in full. */
  focusWaiting(): void;
  /** "Later" and `Esc`: fold the card. */
  later(): void;
  settings(): void;
  toggleMute(): void;
  /** The pager: the previous (−1) or next (+1) waiting item. */
  page(delta: number): void;
  /** The goal line created a goal. */
  promptDone(): void;
}

export interface NotchView {
  readonly el: HTMLElement;
  /** Where the mascot slot goes, and its size; null for the strip. */
  readonly mascotHolder: HTMLElement | null;
  readonly mascotSize: number;
  update(m: NotchModel, index: number): void;
  /** Where keyboard focus goes when this view replaces one that had it. */
  focusTarget(): HTMLElement | null;
  destroy(): void;
}

const INTERACTIVE = 'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="option"]';

/** True when `Space` on this element belongs to the element itself (a button, a field, a chip). */
export function isInteractive(target: EventTarget | null, root: HTMLElement): boolean {
  if (!(target instanceof Element) || target === root) return false;
  const hit = target.closest(INTERACTIVE);
  return !!hit && root.contains(hit);
}

function chevronLeft(): SVGSVGElement {
  return s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 14,
      height: 14,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: 'icon',
      'aria-hidden': 'true',
    },
    s('path', { d: 'M15 6l-6 6l6 6' }),
  );
}

// ---- hidden ---------------------------------------------------------------------------------

export function hiddenView(handlers: ViewHandlers): NotchView {
  const strip = button('', () => handlers.open(), { class: 'nt-strip', ariaLabel: 'Show the Notch' });
  const el = h('div', { class: 'nt-view nt-view-hidden', hidden: true }, strip);
  return {
    el,
    mascotHolder: null,
    mascotSize: 0,
    update: () => undefined,
    focusTarget: () => strip,
    destroy: () => el.remove(),
  };
}

// ---- compact --------------------------------------------------------------------------------

export interface CompactOptions {
  /** True in the window: the pill opens the card. False in a page: its parts are doors. */
  card: boolean;
}

export function compactView(handlers: ViewHandlers, opts: CompactOptions = { card: true }): NotchView {
  const mascot = h('span', { class: 'nt-mascot nt-mascot-24', aria: { hidden: 'true' } });
  const tag = h('span', { class: 'nt-tag mono' });
  let activeTask: string | null = null;
  const open = button(
    [mascot, tag, opts.card ? h('span', { class: 'nt-chev' }, icon('chevronDown', 12)) : null],
    () => {
      if (opts.card) handlers.open();
      else if (activeTask) handlers.inspect(activeTask);
    },
    { class: 'nt-compact-open', ariaLabel: opts.card ? 'Open the Notch' : 'Friday' },
  );
  const file = h('span', { class: 'nt-ticker-file mono' });
  const add = h('span', { class: 'nt-add mono' });
  const del = h('span', { class: 'nt-del mono' });
  let target: { taskId: string; path: string } | null = null;
  const ticker = button(
    [file, add, del],
    () => {
      if (target) handlers.openDiff(target.taskId, target.path);
    },
    { class: 'nt-ticker', hidden: true },
  );
  // In the window the chip opens the card at its items; in a page it hands the keyboard to the rail.
  const chip = button('', () => (opts.card ? handlers.open() : handlers.focusWaiting()), {
    class: 'nt-chip',
    hidden: true,
    title: opts.card ? 'Open the Notch' : 'Show what waits for you',
  });
  const el = h('div', { class: 'nt-view nt-compact', hidden: true }, open, ticker, chip);

  return {
    el,
    mascotHolder: mascot,
    mascotSize: 24,
    update(m) {
      const a = m.active;
      activeTask = a ? a.task.task_id : null;
      setText(tag, a ? a.tag : m.project);
      tag.dataset.status = a ? a.task.status : 'none';
      setVar(tag, '--nt-tag-color', a ? a.status.color : 'var(--color-slate-400)');
      tag.title = a ? `${a.status.label}: ${a.summary}` : m.project;
      if (opts.card) {
        open.setAttribute('aria-label', a ? `Open the Notch: ${a.tag}, ${a.status.label}` : 'Open the Notch');
      } else {
        // Without an active task the tag names the project and opens nothing. Said with
        // `aria-disabled`, not `disabled`: a disabled button is drawn faded, and an idle board is
        // not a fault.
        open.setAttribute('aria-disabled', String(!a));
        open.tabIndex = a ? 0 : -1;
        toggleClass(open, 'nt-compact-idle', !a);
        open.setAttribute('aria-label', a ? `Inspect ${a.tag}: ${a.status.label}` : `Friday: ${m.project}`);
      }

      const waiting = m.items.length;
      chip.hidden = waiting === 0;
      setText(chip, `${waiting} waiting`);
      chip.setAttribute('aria-label', `${waiting} waiting for you${opts.card ? '' : ': show the list'}`);

      const f = a?.file ?? null;
      const show = !!(a && f) && waiting === 0;
      ticker.hidden = !show;
      if (a && f && show) {
        target = { taskId: a.task.task_id, path: f.path };
        setText(file, f.name);
        if (a.stats) {
          setText(add, `+${a.stats.added}`);
          setText(del, `−${a.stats.removed}`);
        } else {
          setText(add, statsText(null));
          setText(del, '');
        }
        ticker.title = visible(f.path);
        ticker.setAttribute('aria-label', `Open the diff of ${f.name} (${statsText(a.stats)})`);
      } else {
        target = null;
      }
    },
    focusTarget: () => (open.getAttribute('aria-disabled') === 'true' ? (chip.hidden ? null : chip) : open),
    destroy: () => el.remove(),
  };
}

// ---- expanded -------------------------------------------------------------------------------

export interface ExpandedView extends NotchView {
  /** The most the card may grow before its body scrolls (CSS custom property). */
  setMaxHeight(px: number): void;
  /** The mounted item's key and signature (tests). */
  readonly currentItem: string | null;
}

/**
 * The card's own notice for an item no area builds a card for: a proposed plan, a message that
 * waits for a reply, memories to review, an untrusted policy. One line each, and the door to where
 * it is decided.
 */
function noticeItem(item: WaitingItem, handlers: ViewHandlers): HTMLElement | null {
  let title: string;
  let line: string;
  let door: string;
  if (item.kind === 'plan') {
    title = `Proposed plan v${item.version}`;
    line = truncate(cleanText(item.request), 120);
    door = 'Open the plan review';
  } else if (item.kind === 'message') {
    const m = item.message;
    const from = m.from.kind === 'agent' ? (m.from.agent_key ?? m.from.id) : m.from.kind;
    title = 'A message waits for your reply';
    line = `${visible(from)} · ${truncate(cleanText(m.subject ?? m.preview), 120)}`;
    door = 'Open Messages';
  } else if (item.kind === 'memory') {
    title = `${plural(item.count, 'memory', 'memories')} ${item.count === 1 ? 'needs' : 'need'} review`;
    line = 'Agents recorded them; approve or retract each.';
    door = 'Open Project memory';
  } else if (item.kind === 'policy') {
    title = 'Policy change not yet trusted';
    line = "The project's files loosen Friday's defaults; nothing of it applies until you trust it.";
    door = 'Open Settings → Policy';
  } else return null;
  return h(
    'div',
    { class: ['nt-notice', `nt-notice-${item.kind}`] },
    h('p', { class: 'nt-notice-title' }, title),
    h('p', { class: 'nt-notice-line muted' }, line),
    button(door, () => handlers.openItem(item), { class: 'btn btn-ghost nt-notice-door' }),
  );
}

export function expandedView(ctx: AppContext, slots: NotchSlots, handlers: ViewHandlers): ExpandedView {
  // Header: mascot, project and connection, Open this in Studio.
  const mascot = h('span', { class: 'nt-mascot nt-mascot-36', aria: { hidden: 'true' } });
  const project = h('span', { class: 'nt-project' });
  const dot = h('span', { class: 'nt-dot', aria: { hidden: 'true' } });
  const connLabel = h('span', { class: 'nt-conn' });
  const studio = button(icon('expand', 16), () => handlers.openStudio(), {
    class: 'btn btn-icon btn-ghost nt-studio',
    ariaLabel: 'Open this in Studio (Space)',
    title: 'Open this in Studio (Space)',
  });
  const header = h(
    'header',
    { class: 'nt-head' },
    mascot,
    h('div', { class: 'nt-head-text' }, project, h('span', { class: 'nt-conn-row' }, dot, connLabel)),
    studio,
  );

  // The active task.
  const bDot = h('span', { class: 'nt-banner-dot', aria: { hidden: 'true' } });
  const bStatus = h('span', { class: 'nt-banner-status' });
  const bTag = h('span', { class: 'nt-banner-tag mono' });
  let bTask: string | null = null;
  const bSummary = button(
    '',
    () => {
      if (bTask) handlers.inspect(bTask);
    },
    { class: 'nt-banner-summary', title: 'Inspect this task' },
  );
  const bAgent = h('span', { class: 'nt-meta-agent' });
  const bBranch = h('span', { class: 'nt-meta-branch mono' });
  const bChecks = h('span', { class: 'nt-meta-checks' });
  const bStats = h('span', { class: 'nt-meta-stats mono' });
  const banner = h(
    'div',
    { class: 'nt-banner', hidden: true },
    h('div', { class: 'nt-banner-top' }, bDot, bStatus, bTag, bSummary),
    h('div', { class: 'nt-banner-meta' }, bAgent, bBranch, bChecks, bStats),
  );

  // The waiting items, one at a time, with a pager.
  const pagerLabel = h('span', { class: 'nt-pager-label' });
  const prev = button(chevronLeft(), () => handlers.page(-1), {
    class: 'btn btn-icon btn-ghost nt-pager-btn',
    ariaLabel: 'Previous waiting item',
  });
  const next = button(icon('chevronRight', 14), () => handlers.page(1), {
    class: 'btn btn-icon btn-ghost nt-pager-btn',
    ariaLabel: 'Next waiting item',
  });
  const pager = h('div', { class: 'nt-pager', hidden: true }, pagerLabel, h('span', { class: 'spacer' }), prev, next);
  const itemHolder = h('div', { class: 'nt-item' });
  const arriving = h('p', { class: 'nt-arriving', hidden: true }, 'A request just arrived…');
  const empty = h('p', { class: 'nt-empty muted', hidden: true }, 'Nothing needs you right now.');
  const body = h('div', { class: 'nt-body scroll' }, banner, pager, itemHolder, arriving, empty);

  // The goal line lives as long as the card, so typed text survives a fold.
  const prompt = slots.quickPrompt(ctx, { onDone: () => handlers.promptDone() });
  const promptHolder = h('div', { class: 'nt-prompt' }, prompt.el);

  // Footer: settings, mute, Open Studio.
  const settings = button([icon('gear', 14), 'Settings'], () => handlers.settings(), {
    class: 'btn btn-ghost nt-foot-btn',
  });
  const mute = button('', () => handlers.toggleMute(), { class: 'btn btn-ghost nt-foot-btn nt-mute' });
  const studioFoot = button([icon('expand', 14), 'Open Studio'], () => handlers.openStudioGeneral(), {
    class: 'btn btn-ghost nt-foot-btn',
  });
  const footer = h('footer', { class: 'nt-foot' }, settings, mute, h('span', { class: 'spacer' }), studioFoot);

  const el = h(
    'section',
    { class: 'nt-view nt-expanded', hidden: true, tabIndex: -1, aria: { label: 'Friday Notch' } },
    header,
    body,
    promptHolder,
    footer,
  );

  let current: { sig: string; comp: Component | null } | null = null;
  let lastMuted: boolean | null = null;

  function mountItem(item: WaitingItem | null): void {
    const sig = item ? itemSignature(item) : '';
    if ((current?.sig ?? '') === sig) return;
    current?.comp?.destroy();
    current = null;
    itemHolder.replaceChildren();
    if (!item) return;
    let comp: Component | null = null;
    try {
      if (item.kind === 'approval') comp = slots.approval(ctx, item.approval, { compact: true });
      else if (item.kind === 'question')
        comp = slots.question(ctx, item.escalation, { compact: true, onLater: () => handlers.later() });
      else if (item.kind === 'waiting') comp = slots.waiting(ctx, item.task, { compact: true });
      if (comp) itemHolder.append(comp.el);
      else {
        const notice = noticeItem(item, handlers);
        if (notice) itemHolder.append(notice);
      }
    } catch {
      comp = null;
      itemHolder.append(
        h('p', { class: 'nt-item-error' }, 'This item could not be shown here; open it in the Studio.'),
      );
    }
    current = { sig, comp };
  }

  return {
    el,
    mascotHolder: mascot,
    mascotSize: 36,
    get currentItem() {
      return current ? (current.sig.split('\u0000')[0] ?? null) : null;
    },
    setMaxHeight(px) {
      setVar(el, '--nt-max-h', `${Math.max(0, Math.round(px))}px`);
    },
    update(m, index) {
      el.setAttribute('aria-label', `Friday Notch: ${m.project}`);
      setText(project, m.project);
      dot.dataset.tone = m.connection.tone;
      setText(connLabel, m.connection.label);

      const a = m.active;
      banner.hidden = !a;
      toggleClass(banner, 'nt-banner-slim', m.items.length > 0);
      if (a) {
        bTask = a.task.task_id;
        setVar(banner, '--nt-status-color', a.status.color);
        setText(bStatus, a.status.label);
        setText(bTag, a.tag);
        setText(bSummary, a.summary);
        bSummary.setAttribute('aria-label', `Inspect ${a.tag}: ${a.summary}`);
        setText(bAgent, a.agentKey ?? 'no agent');
        setText(bBranch, a.branch ?? '');
        bBranch.hidden = !a.branch;
        setText(bChecks, a.checks.text);
        setText(bStats, a.file ? `${statsText(a.stats)} ${a.file.name}` : statsText(a.stats));
      } else {
        bTask = null;
      }

      const n = m.items.length;
      const i = n === 0 ? 0 : Math.min(n - 1, Math.max(0, index));
      pager.hidden = n <= 1;
      setText(pagerLabel, `Waiting for you · ${i + 1} of ${n}`);
      prev.disabled = i <= 0;
      next.disabled = i >= n - 1;
      mountItem(m.items[i] ?? null);
      arriving.hidden = !(m.fsm.pinned && n === 0);
      empty.hidden = n > 0 || m.fsm.pinned;

      if (lastMuted !== m.muted) {
        lastMuted = m.muted;
        replace(mute, icon(m.muted ? 'mute' : 'sound', 14), m.muted ? 'Muted' : 'Sound');
        mute.setAttribute('aria-pressed', String(m.muted));
        mute.title = m.muted ? 'Sound is off: turn it on' : 'Sound is on: mute it';
      }
    },
    focusTarget: () => el,
    destroy() {
      current?.comp?.destroy();
      current = null;
      prompt.destroy();
      el.remove();
    },
  };
}

/**
 * Stands in for the card where there is none (a browser page): the state table stays complete,
 * nothing is built, and nothing is shown.
 */
export function absentView(): NotchView {
  const el = h('div', { class: 'nt-view nt-view-absent', hidden: true });
  return {
    el,
    mascotHolder: null,
    mascotSize: 0,
    update: () => undefined,
    focusTarget: () => null,
    destroy: () => el.remove(),
  };
}

// ---- greeting -------------------------------------------------------------------------------

export function greetingView(): NotchView {
  const mascot = h('span', { class: 'nt-mascot nt-mascot-56', aria: { hidden: 'true' } });
  const title = h('p', { class: 'nt-greet-title' });
  const sub = h('p', { class: 'nt-greet-sub' });
  const el = h(
    'div',
    { class: 'nt-view nt-greeting', hidden: true, role: 'status', aria: { live: 'polite' } },
    mascot,
    h('div', { class: 'nt-greet-text' }, title, sub),
  );
  return {
    el,
    mascotHolder: mascot,
    mascotSize: 56,
    update(m) {
      const celebrate = m.fsm.greeting === 'celebrate';
      toggleClass(el, 'nt-celebrate', celebrate);
      if (celebrate) {
        setText(title, 'Goal completed');
        setText(sub, m.celebration ?? m.project);
      } else {
        setText(title, 'Welcome to Friday');
        const waiting = m.items.length;
        setText(sub, `${m.project} · ${m.running} running${waiting ? ` · ${waiting} waiting for you` : ''}`);
      }
    },
    focusTarget: () => null,
    destroy: () => el.remove(),
  };
}
