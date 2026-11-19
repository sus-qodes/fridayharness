import { describe, expect, it } from 'vitest';
import { NOTCH_ELSEWHERE, ONBOARDING_STEPS, onboardingSteps } from './onboarding.js';

describe('the tour’s steps for this window (2026-11-17)', () => {
  it('points at the Notch where the page has one', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="sh-notch-layer"><div class="nt-pill"></div></div>';
    const steps = onboardingSteps(host as unknown as Document);
    expect(steps).toBe(ONBOARDING_STEPS);
    expect(steps.find((s) => s.id === 'notch')?.target).toBe('.sh-notch-layer');
  });

  it('says where the Notch is, and points at nothing, where the page has none (the desktop app)', () => {
    const host = document.createElement('div');
    // The layer is there and empty: the Notch is a window of its own.
    host.innerHTML = '<div class="sh-notch-layer"></div>';
    const steps = onboardingSteps(host as unknown as Document);
    expect(steps.map((s) => s.id)).toEqual(ONBOARDING_STEPS.map((s) => s.id));
    const notch = steps.find((s) => s.id === 'notch');
    expect(notch).toBe(NOTCH_ELSEWHERE);
    expect(notch?.target).toBeNull();
    expect(notch?.body).toContain('top edge of your screen');
    // Every other step is as it was.
    expect(steps.filter((s) => s.id !== 'notch')).toEqual(ONBOARDING_STEPS.filter((s) => s.id !== 'notch'));
    expect(onboardingSteps(null).find((s) => s.id === 'notch')).toBe(NOTCH_ELSEWHERE);
  });
});
