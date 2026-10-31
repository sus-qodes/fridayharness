/**
 * Friday Customer Feedback & Autonomous Oversight Sheet (Phase 3).
 *
 * An Apple-style interactive feedback modal providing instant human-in-the-loop
 * steering, ratings, and qualitative issue reporting with zero emojis,
 * pure monochrome styling, semantic status tints, and Hooke's Law spring motion.
 */

import { createFridayMascot, type FridayMascotHandle } from '../mascot/index.js';
import type { AppContext, Component } from '../shell/context.js';
import { button, h } from '../ui/dom.js';
import { icon } from '../ui/svg.js';

export type FeedbackCategory = 'feedback' | 'oversight' | 'issue';
export type Sentiment = 'exceptional' | 'solid' | 'needs-polish';

export interface FeedbackSheetOptions {
  onSubmitted?: (feedback: { category: FeedbackCategory; sentiment: Sentiment; comment: string }) => void;
}

export function feedbackSheet(
  ctx: AppContext,
  close: () => void,
  opts: FeedbackSheetOptions = {},
): Component & { title: string; size: 'md' } {
  let selectedCategory: FeedbackCategory = 'feedback';
  let selectedSentiment: Sentiment = 'exceptional';
  let mascot: FridayMascotHandle | null = null;

  const mascotHolder = h('div', { class: 'fb-avatar-holder' });
  try {
    mascot = createFridayMascot(ctx, { size: 32, interactive: true });
    mascotHolder.appendChild(mascot.el);
  } catch {
    // If mascot canvas cannot mount in headless test env, degrade gracefully
  }

  const titleGroup = h(
    'div',
    { class: 'fb-title-group' },
    h('div', { class: 'fb-sheet-title' }, 'Friday Oversight & Feedback'),
    h('div', { class: 'fb-sheet-sub' }, 'Interactive steering and agent feedback loop'),
  );

  const head = h('header', { class: 'fb-head' }, mascotHolder, titleGroup);

  // 3-Way Apple Segmented Control
  const categories: { id: FeedbackCategory; label: string }[] = [
    { id: 'feedback', label: 'Customer Feedback' },
    { id: 'oversight', label: 'Agent Oversight' },
    { id: 'issue', label: 'Issue Report' },
  ];

  const catButtons = categories.map((cat) => {
    const btn = button(cat.label, () => selectCat(cat.id), {
      class: ['fb-seg-btn', cat.id === selectedCategory ? 'active' : ''],
      ariaLabel: cat.label,
    });
    return { id: cat.id, btn };
  });

  const segmented = h(
    'div',
    { class: 'fb-seg', role: 'tablist', aria: { label: 'Feedback Category' } },
    ...catButtons.map((c) => c.btn),
  );

  function selectCat(cat: FeedbackCategory): void {
    selectedCategory = cat;
    for (const c of catButtons) {
      c.btn.classList.toggle('active', c.id === cat);
    }
  }

  // Sentiment Pills (Apple Status Dots, Zero Emojis)
  const sentiments: { id: Sentiment; label: string; dotClass: string }[] = [
    { id: 'exceptional', label: 'Exceptional', dotClass: 'dot-green' },
    { id: 'solid', label: 'Solid', dotClass: 'dot-blue' },
    { id: 'needs-polish', label: 'Needs Polish', dotClass: 'dot-amber' },
  ];

  const sentButtons = sentiments.map((s) => {
    const dot = h('span', { class: ['fb-dot', s.dotClass] });
    const text = h('span', null, s.label);
    const btn = button([dot, text], () => selectSent(s.id), {
      class: ['fb-rate-pill', s.id === selectedSentiment ? 'active' : ''],
      ariaLabel: s.label,
    });
    return { id: s.id, btn };
  });

  const sentimentRow = h(
    'div',
    { class: 'fb-ratings', role: 'radiogroup', aria: { label: 'Sentiment' } },
    ...sentButtons.map((s) => s.btn),
  );

  function selectSent(s: Sentiment): void {
    selectedSentiment = s;
    for (const item of sentButtons) {
      item.btn.classList.toggle('active', item.id === s);
    }
  }

  // Text Input
  const textarea = h('textarea', {
    class: 'fb-textarea',
    placeholder: 'Provide guidance, notes, or feedback for Friday’s autonomous execution…',
    aria: { label: 'Feedback Comment' },
  }) as HTMLTextAreaElement;

  function submit(): void {
    const comment = textarea.value.trim();
    opts.onSubmitted?.({ category: selectedCategory, sentiment: selectedSentiment, comment });

    ctx.toast({
      kind: 'success',
      text: 'Feedback delivered',
      detail: 'Friday autonomous loop updated.',
      timeoutMs: 3500,
    });

    close();
  }

  // Handle Ctrl+Enter or Cmd+Enter to submit
  function onKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  textarea.addEventListener('keydown', onKeydown);

  // Footer Actions
  const shortcutHint = h(
    'div',
    { class: 'fb-shortcut' },
    h('span', { class: 'kbd' }, '⌘'),
    h('span', { class: 'kbd' }, '↵'),
    h('span', null, 'to submit'),
  );

  const sendBtn = button([h('span', null, 'Send Feedback'), icon('chevronRight', 12)], () => submit(), {
    class: 'btn btn-primary fb-submit-btn',
  });

  const footer = h('footer', { class: 'fb-footer' }, shortcutHint, sendBtn);

  const el = h('div', { class: 'fb-sheet' }, head, segmented, sentimentRow, textarea, footer);

  return {
    el,
    title: 'Friday Oversight & Feedback',
    size: 'md',
    destroy() {
      textarea.removeEventListener('keydown', onKeydown);
      mascot?.destroy();
      mascot = null;
      el.remove();
    },
  };
}
