import { describe, expect, it, vi } from 'vitest';
import { makeContext } from '../test/context.js';
import { feedbackSheet } from './feedback-sheet.js';

describe('feedbackSheet', () => {
  it('renders categories, sentiments, textarea, and footer', () => {
    const ctx = makeContext();
    const close = vi.fn();
    const sheet = feedbackSheet(ctx, close);

    expect(sheet.title).toBe('Friday Oversight & Feedback');
    expect(sheet.size).toBe('md');

    const catButtons = Array.from(sheet.el.querySelectorAll('.fb-seg-btn'));
    expect(catButtons).toHaveLength(3);
    expect(catButtons[0]?.textContent).toBe('Customer Feedback');
    expect(catButtons[1]?.textContent).toBe('Agent Oversight');
    expect(catButtons[2]?.textContent).toBe('Issue Report');

    const ratePills = Array.from(sheet.el.querySelectorAll('.fb-rate-pill'));
    expect(ratePills).toHaveLength(3);
    expect(ratePills[0]?.textContent).toContain('Exceptional');
    expect(ratePills[1]?.textContent).toContain('Solid');
    expect(ratePills[2]?.textContent).toContain('Needs Polish');

    const textarea = sheet.el.querySelector('textarea.fb-textarea');
    expect(textarea).not.toBeNull();

    sheet.destroy();
  });

  it('selects category and sentiment on click', () => {
    const ctx = makeContext();
    const close = vi.fn();
    const onSubmitted = vi.fn();
    const sheet = feedbackSheet(ctx, close, { onSubmitted });

    const catButtons = Array.from(sheet.el.querySelectorAll<HTMLButtonElement>('.fb-seg-btn'));
    catButtons[1]?.click(); // 'Agent Oversight'
    expect(catButtons[1]?.classList.contains('active')).toBe(true);
    expect(catButtons[0]?.classList.contains('active')).toBe(false);

    const ratePills = Array.from(sheet.el.querySelectorAll<HTMLButtonElement>('.fb-rate-pill'));
    ratePills[2]?.click(); // 'Needs Polish'
    expect(ratePills[2]?.classList.contains('active')).toBe(true);
    expect(ratePills[0]?.classList.contains('active')).toBe(false);

    const textarea = sheet.el.querySelector<HTMLTextAreaElement>('textarea.fb-textarea');
    expect(textarea).not.toBeNull();
    if (textarea) textarea.value = 'Agent needs faster planning.';

    const submitBtn = sheet.el.querySelector<HTMLButtonElement>('.fb-submit-btn');
    expect(submitBtn).not.toBeNull();
    submitBtn?.click();

    expect(onSubmitted).toHaveBeenCalledWith({
      category: 'oversight',
      sentiment: 'needs-polish',
      comment: 'Agent needs faster planning.',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(ctx.toasts).toHaveLength(1);
    expect(ctx.toasts[0]?.kind).toBe('success');

    sheet.destroy();
  });

  it('submits on Ctrl+Enter', () => {
    const ctx = makeContext();
    const close = vi.fn();
    const onSubmitted = vi.fn();
    const sheet = feedbackSheet(ctx, close, { onSubmitted });

    const textarea = sheet.el.querySelector<HTMLTextAreaElement>('textarea.fb-textarea');
    expect(textarea).not.toBeNull();
    if (textarea) textarea.value = 'Great work!';

    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));

    expect(onSubmitted).toHaveBeenCalledWith({
      category: 'feedback',
      sentiment: 'exceptional',
      comment: 'Great work!',
    });
    expect(close).toHaveBeenCalledTimes(1);

    sheet.destroy();
  });
});
