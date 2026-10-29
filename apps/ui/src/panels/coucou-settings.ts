/**
 * Coucou-style Settings Hub (Coucou parity, plan §7.10).
 * Features:
 * - Round left panel layout (.hub-side) with 3 categorized groups:
 *   1. General (Look & Friday, Notifications, Sound)
 *   2. AI & Governance (Planner, Routing & Pins, Policy & Trust)
 *   3. System & Desktop (Friday Engine, Desktop Shell, About)
 * - Animated Friday mascot in the brand header and hero banner
 * - Live daemon status indicator dot and address at bottom
 * - Right floating squircle panel (.hub-panel) with category hero header
 * - 14px rounded cards with hairline borders (.hub-card)
 */
import type { BrainStatusView, UiSnapshot } from '@friday/protocol';
import type { PolicyView } from '../api/client.js';
import { playSound } from '../audio/index.js';
import { pruneWorktrees } from '../dock/commands.js';
import { createMascot } from '../mascot/index.js';
import { visible } from '../model/text.js';
import { clearSession } from '../platform/session.js';
import type { AppContext, Component, DesktopCommands, DesktopShortcut, NotificationAnswer } from '../shell/context.js';
import { UI_API, UI_VERSION } from '../shell/version.js';
import type { Prefs } from '../store/state.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { usd } from '../ui/format.js';
import { type IconName, icon } from '../ui/svg.js';
import {
  badge,
  checkbox,
  copyLine,
  errorOf,
  field,
  fold,
  input,
  note,
  plain,
  plannerState,
  segmented,
  select,
  Teardown,
} from './common.js';
import { routingPins } from './routing-pins.js';
import {
  clampNumber,
  NOTCH_LIMITS,
  OUTFITS,
  pageActions,
  plannerSteps,
  readLoosening,
  worktreesInUse,
} from './settings.js';

export type CoucouGroup = 'General' | 'AI & Governance' | 'System & Desktop';

export interface CoucouPageDef {
  id: string;
  group: CoucouGroup;
  icon: IconName;
  title: string;
  subtitle: string;
}

export const COUCOU_PAGES: CoucouPageDef[] = [
  // General
  {
    id: 'look',
    group: 'General',
    icon: 'palette',
    title: 'Look & Friday',
    subtitle: 'Friday wardrobe outfits, reduced motion, and Notch auto-collapse timings.',
  },
  {
    id: 'notifications',
    group: 'General',
    icon: 'bell',
    title: 'Notifications',
    subtitle: 'System alerts and desktop notifications for approvals, questions, and task failures.',
  },
  {
    id: 'sound',
    group: 'General',
    icon: 'sound',
    title: 'Sound',
    subtitle: 'Synthesizer audio cues, reaction chirps, and output master volume.',
  },

  // AI & Governance
  {
    id: 'planner',
    group: 'AI & Governance',
    icon: 'brain',
    title: 'Planner',
    subtitle: 'Anthropic planner model status, terminal key storage, and daily spending budget limits.',
  },
  {
    id: 'routing',
    group: 'AI & Governance',
    icon: 'compass',
    title: 'Routing & Pins',
    subtitle: 'Task-to-model routing rules, role pins, and reasoning fallbacks.',
  },
  {
    id: 'policy',
    group: 'AI & Governance',
    icon: 'shield',
    title: 'Policy & Trust',
    subtitle: 'Workspace security loosening, file permission bounds, and SHA-256 trust validation.',
  },

  // System & Desktop
  {
    id: 'friday',
    group: 'System & Desktop',
    icon: 'terminal',
    title: 'Friday Engine',
    subtitle: 'Active git worktrees, clean-up pruning, daemon controls, and session state.',
  },
  {
    id: 'desktop',
    group: 'System & Desktop',
    icon: 'desktop',
    title: 'Desktop Shell',
    subtitle: 'Global Windows hotkeys, background execution, and start at sign-in configuration.',
  },
  {
    id: 'about',
    group: 'System & Desktop',
    icon: 'info',
    title: 'About Friday',
    subtitle: 'System versions, daemon port address, local workspace root, and protocol specifications.',
  },
];

export function mountCoucouSettingsHub(ctx: AppContext): Component {
  const td = new Teardown();
  const prefs = () => ctx.store.select('prefs');
  const setPrefs = (changes: Partial<Prefs>) => ctx.store.patch('prefs', changes);
  const desktop = ctx.platform.desktop ?? null;

  // ── Root container ────────────────────────────────────────────────────────
  const root = h('div', { class: 'sh-settings-hub', id: 'hub' });

  // ── Sidebar: Brand Header with Live Friday ─────────────────────────────────
  const side = h('nav', { class: 'hub-side' });
  const brandCanvasWrap = h('div', { class: 'hub-brand-canvas-wrap' });
  const brandMascot = createMascot(ctx, { size: 30, interactive: true });
  td.add(() => brandMascot.destroy());
  brandCanvasWrap.append(brandMascot.el);

  const brand = h(
    'div',
    { class: 'hub-brand' },
    brandCanvasWrap,
    h('span', { class: 'hub-brand-text' }, 'Friday'),
    h('span', { class: 'hub-brand-badge' }, 'Studio'),
  );
  side.append(brand);

  // ── Sidebar: Categorized Page Groups ──────────────────────────────────────
  const navButtons = new Map<string, HTMLButtonElement>();
  const groups: CoucouGroup[] = ['General', 'AI & Governance', 'System & Desktop'];

  for (const groupName of groups) {
    side.append(h('div', { class: 'hub-group' }, groupName));
    const pages = COUCOU_PAGES.filter((p) => p.group === groupName);
    for (const page of pages) {
      const btn = button([icon(page.icon, 16), h('span', null, page.title)], () => selectTab(page.id), {
        class: 'hub-item',
        dataset: { tab: page.id },
      });
      navButtons.set(page.id, btn);
      side.append(btn);
    }
  }

  // ── Sidebar: Bottom Status and Version ────────────────────────────────────
  const statusDot = h('i', { class: 'dot' });
  const statusText = h('span', null, 'Connecting…');
  const statusLine = h('div', { class: 'hub-status' }, statusDot, statusText);
  const versionLine = h('div', { class: 'hub-version' }, `Friday ${UI_VERSION} · API ${UI_API}`);

  side.append(h('div', { class: 'spacer' }), statusLine, versionLine);

  function renderStatus(): void {
    const sys = ctx.store.select('system');
    const board = ctx.store.select('board');
    const port = board?.project.port ? `127.0.0.1:${board.project.port}` : '';

    if (sys.connection === 'live') {
      statusDot.style.background = 'var(--hub-green)';
      statusDot.style.color = 'var(--hub-green)';
      statusText.textContent = port ? `Ready · ${port}` : 'Ready · Connected';
    } else if (sys.connection === 'reconnecting') {
      statusDot.style.background = 'var(--hub-amber)';
      statusDot.style.color = 'var(--hub-amber)';
      statusText.textContent = `Reconnecting (${sys.attempts})…`;
    } else {
      statusDot.style.background = 'var(--hub-red)';
      statusDot.style.color = 'var(--hub-red)';
      statusText.textContent = sys.lastError ? 'Offline' : 'Disconnected';
    }
  }

  td.add(ctx.store.subscribe('system', renderStatus));
  td.add(ctx.store.subscribe('board', renderStatus));
  renderStatus();

  // ── Right Floating Panel ──────────────────────────────────────────────────
  const heroTitle = h('h1', null, '');
  const heroSubtitle = h('p', null, '');
  const heroCopy = h('div', { class: 'hub-hero-copy' }, heroTitle, heroSubtitle);

  const heroMascotWrap = h('div', { class: 'hub-hero-mascot' });
  const heroMascot = createMascot(ctx, { size: 80, interactive: true });
  td.add(() => heroMascot.destroy());
  heroMascotWrap.append(heroMascot.el);

  const heroBanner = h('div', { class: 'hub-hero' }, heroCopy, heroMascotWrap);
  const cardsContainer = h('div', { id: 'settings-root', class: 'hub-cards' });
  const pageContainer = h('div', { class: 'hub-page' }, heroBanner, cardsContainer);
  const scrollContainer = h('div', { class: 'hub-scroll' }, pageContainer);
  const panel = h('main', { class: 'hub-panel' }, scrollContainer);

  root.append(side, panel);

  // ── Settings Cards Renderers ──────────────────────────────────────────────
  let currentTab = 'look';

  function selectTab(tabId: string): void {
    const valid = COUCOU_PAGES.some((p) => p.id === tabId);
    const target = valid ? tabId : 'look';
    if (ctx.store.select('ui').settingsTab !== target) {
      ctx.store.patch('ui', { settingsTab: target });
    } else {
      renderActiveTab(target);
    }
  }

  function renderActiveTab(tabId: string): void {
    currentTab = tabId;
    const def = COUCOU_PAGES.find((p) => p.id === tabId) ?? COUCOU_PAGES[0];

    // Highlight sidebar item
    for (const [id, btn] of navButtons) {
      btn.classList.toggle('on', id === def.id);
    }

    // Update Hero banner
    setText(heroTitle, def.title);
    setText(heroSubtitle, def.subtitle);

    // Render cards for selected tab directly into the cardsContainer
    const cards = renderTabCards(def.id);
    replace(cardsContainer, ...cards);
    scrollContainer.scrollTop = 0;
  }

  function renderTabCards(tabId: string): HTMLElement[] {
    switch (tabId) {
      case 'look':
        return renderLookTab();
      case 'notifications':
        return renderNotificationsTab();
      case 'sound':
        return renderSoundTab();
      case 'planner':
        return renderPlannerTab();
      case 'routing':
        return renderRoutingTab();
      case 'policy':
        return renderPolicyTab();
      case 'friday':
        return renderFridayTab();
      case 'desktop':
        return renderDesktopTab();
      case 'about':
        return renderAboutTab();
      default:
        return renderLookTab();
    }
  }

  // ── 1. Look & Friday Tab ───────────────────────────────────────────────────
  function renderLookTab(): HTMLElement[] {
    const cardFriday = h('div', { class: 'hub-card' });
    const outfitSelect = select(OUTFITS, prefs().outfit, (v) => setPrefs({ outfit: v }));
    cardFriday.append(
      h('div', { class: 'hub-card-title' }, 'Friday Wardrobe'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Character Outfit'),
          h('span', { class: 'detail' }, 'Choose headwear and glasses for Friday across the Studio and island'),
        ),
        outfitSelect,
      ),
    );

    const cardMotion = h('div', { class: 'hub-card' });
    const motionSegmented = segmented<Prefs['motion']>(
      'Reduced motion',
      [
        { value: 'system', label: 'As the system' },
        { value: 'reduce', label: 'On' },
        { value: 'full', label: 'Off' },
      ],
      prefs().motion,
      (v) => setPrefs({ motion: v }),
    );
    cardMotion.append(
      h('div', { class: 'hub-card-title' }, 'Motion & Animations'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Reduced Motion'),
          h('span', { class: 'detail' }, 'Limit canvas spring physics and particles for low latency or accessibility'),
        ),
        motionSegmented,
      ),
    );

    const cardNotch = h('div', { class: 'hub-card' });
    const collapseInput = input({
      type: 'number',
      min: String(NOTCH_LIMITS.collapse.min),
      max: String(NOTCH_LIMITS.collapse.max),
      step: '1',
      value: String(prefs().notchAutoCollapseS),
      class: 'hub-keycap',
    });
    collapseInput.addEventListener('change', () => {
      const v = clampNumber(collapseInput.value, NOTCH_LIMITS.collapse.min, NOTCH_LIMITS.collapse.max);
      if (v === null) collapseInput.value = String(prefs().notchAutoCollapseS);
      else {
        collapseInput.value = String(Math.round(v));
        setPrefs({ notchAutoCollapseS: Math.round(v) });
      }
    });

    const hideInput = input({
      type: 'number',
      min: String(NOTCH_LIMITS.hide.min),
      max: String(NOTCH_LIMITS.hide.max),
      step: '1',
      value: String(prefs().notchHideS),
      class: 'hub-keycap',
    });
    hideInput.addEventListener('change', () => {
      const v = clampNumber(hideInput.value, NOTCH_LIMITS.hide.min, NOTCH_LIMITS.hide.max);
      if (v === null) hideInput.value = String(prefs().notchHideS);
      else {
        hideInput.value = String(Math.round(v));
        setPrefs({ notchHideS: Math.round(v) });
      }
    });

    cardNotch.append(
      h('div', { class: 'hub-card-title' }, 'Dynamic Island Timings'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Auto-collapse Delay'),
          h('span', { class: 'detail' }, `Seconds before expanded cards fold back to the pill (1–120s)`),
        ),
        collapseInput,
      ),
      h('div', { class: 'hub-divider' }),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Auto-hide Delay'),
          h('span', { class: 'detail' }, `Seconds before the idle island hides to notch edge (5–600s)`),
        ),
        hideInput,
      ),
    );

    return [cardFriday, cardMotion, cardNotch];
  }

  // ── 2. Notifications Tab ──────────────────────────────────────────────────
  function renderNotificationsTab(): HTMLElement[] {
    const card = h('div', { class: 'hub-card' });
    const nativeNotify = ctx.platform.kind === 'tauri';
    const notifyWhen = nativeNotify ? 'while the Notch is hidden or the screen is locked' : 'while this tab is hidden';
    const notifyState = h('div', { class: 'hub-row detail' });

    const notifyBox = checkbox(`Notify me ${notifyWhen}`, prefs().notifications, (on) => void setNotifications(on));
    const notifyInput = notifyBox.querySelector('input') as HTMLInputElement;

    async function setNotifications(on: boolean) {
      notifyState.textContent = '';
      if (!on) {
        setPrefs({ notifications: false });
        return;
      }
      let result: NotificationAnswer = 'default';
      try {
        result = await ctx.platform.requestNotifications();
      } catch {
        result = 'denied';
      }
      if (td.done) return;
      if (result === 'granted') {
        setPrefs({ notifications: true });
        notifyState.textContent = nativeNotify
          ? `Friday asks Windows to notify you of approvals, questions, plans, blocked agents and failures ${notifyWhen}. Send a test notification below.`
          : `Friday notifies you of approvals, questions, plans, blocked agents and failures ${notifyWhen}.`;
      } else {
        notifyInput.checked = false;
        setPrefs({ notifications: false });
        notifyState.textContent =
          result === 'unsupported'
            ? 'This environment does not support notifications.'
            : 'Notifications were not allowed; grant permission in system settings.';
      }
    }

    card.append(
      h('div', { class: 'hub-card-title' }, 'Desktop Alerts'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'System Notifications'),
          h('span', { class: 'detail' }, 'Receive alerts for human-in-the-loop approvals, escalations and completions'),
        ),
        notifyBox,
      ),
    );

    if (desktop) {
      const testBtn = button([icon('bell', 14), 'Send a test notification'], () => void testNotification(), {
        class: 'hub-btn',
      });
      const testState = h('div', { class: 'detail', style: { marginTop: '4px' } });

      async function testNotification() {
        testBtn.disabled = true;
        testState.textContent = '';
        const taken = await ctx.act('Send a test notification', () => desktop.testNotification());
        if (td.done) return;
        testBtn.disabled = false;
        if (taken === true) {
          testState.textContent = 'Notification handed to Windows notification center.';
        } else {
          testState.textContent = 'Could not deliver notification to Windows.';
        }
      }

      card.append(
        h('div', { class: 'hub-divider' }),
        h(
          'div',
          { class: 'hub-row' },
          h(
            'div',
            { class: 'text' },
            h('span', { class: 'title' }, 'Test Desktop Integration'),
            h('span', { class: 'detail' }, 'Verify that Windows action center displays toasts properly'),
            testState,
          ),
          testBtn,
        ),
      );
    }

    return [card];
  }

  // ── 3. Sound Tab ──────────────────────────────────────────────────────────
  function renderSoundTab(): HTMLElement[] {
    const card = h('div', { class: 'hub-card' });
    const volume = input({
      type: 'range',
      min: '0',
      max: '1',
      step: '0.01',
      value: String(prefs().volume),
      style: { width: '140px' },
    });
    volume.addEventListener('input', () => {
      const v = clampNumber(volume.value, 0, 1);
      if (v !== null) setPrefs({ volume: v });
    });

    const testChimeBtn = button(
      [icon('sound', 14), 'Play test chime'],
      () => {
        playSound('approval', { force: true });
      },
      { class: 'hub-btn' },
    );

    card.append(
      h('div', { class: 'hub-card-title' }, 'Audio Feedback'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Sound Effects'),
          h('span', { class: 'detail' }, 'Chimes for tool completions, approvals, questions and mascot chirps'),
        ),
        checkbox('Play sounds', !prefs().muted, (on) => setPrefs({ muted: !on })),
      ),
      h('div', { class: 'hub-divider' }),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Master Volume'),
          h('span', { class: 'detail' }, 'Adjust volume level of audio cues'),
        ),
        volume,
      ),
      h('div', { class: 'hub-divider' }),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Coucou Audio Preview'),
          h('span', { class: 'detail' }, 'Test the authentic tactile audio chime'),
        ),
        testChimeBtn,
      ),
    );

    return [card];
  }

  // ── 4. Planner Tab ────────────────────────────────────────────────────────
  function renderPlannerTab(): HTMLElement[] {
    const cardStatus = h('div', { class: 'hub-card' });
    const brain = ctx.store.select('board')?.brain ?? null;
    const st = plannerState(brain);

    cardStatus.append(
      h('div', { class: 'hub-card-title' }, 'Autonomous Planner Status'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Provider Readiness'),
          h('span', { class: 'detail' }, st.text),
        ),
        badge(st.ready ? 'ready' : 'not ready', st.ready ? 'good' : 'warn'),
      ),
    );

    if (brain) {
      const kv = h(
        'dl',
        { class: 'hub-kv' },
        h('dt', null, 'Provider'),
        h('dd', null, `${plain(brain.provider, 40)} · ${plain(brain.model, 80)}${brain.remote ? ' (remote)' : ''}`),
        h('dt', null, 'Key Status'),
        h('dd', null, brain.key),
        h('dt', null, 'Spent Today'),
        h(
          'dd',
          null,
          `${usd(brain.spent_today_usd)} of ${Number.isFinite(brain.daily_budget_usd) ? usd(brain.daily_budget_usd) : 'no limit'}`,
        ),
      );
      cardStatus.append(h('div', { class: 'hub-divider' }), kv);
    }

    const cardActions = h('div', { class: 'hub-card' });
    const rootPath = ctx.store.select('board')?.project.root ?? '';
    const budget = Number.isFinite(brain?.daily_budget_usd) ? (brain?.daily_budget_usd as number) : 5;
    const steps = plannerSteps(brain, budget);

    const stepsList = h(
      'ul',
      { class: 'pn-list' },
      rootPath ? h('li', null, 'Project folder: ', copyLine(ctx, `cd "${rootPath}"`)) : null,
      steps.map((s) => h('li', null, s.text, s.command ? copyLine(ctx, s.command) : null)),
    );

    cardActions.append(
      h('div', { class: 'hub-card-title' }, 'Configuration & Spending Bounds'),
      note('Anthropic credentials and daily spending limits are managed securely:'),
      stepsList,
    );

    return [cardStatus, cardActions];
  }

  // ── 5. Routing & Pins Tab ─────────────────────────────────────────────────
  function renderRoutingTab(): HTMLElement[] {
    const card = h('div', { class: 'hub-card' });
    const pins = routingPins(ctx, td);
    pins.load();

    card.append(
      h('div', { class: 'hub-card-title' }, 'Model Assignment & Routing'),
      note(
        'Friday assigns each task to the most appropriate AI model. Pins force specific roles or tasks to dedicated models.',
      ),
      pins.el,
    );

    return [card];
  }

  // ── 6. Policy & Trust Tab ─────────────────────────────────────────────────
  function renderPolicyTab(): HTMLElement[] {
    const card = h('div', { class: 'hub-card' });
    const policyBox = h('div', { class: 'text' }, h('span', { class: 'detail' }, 'Reading security policy…'));

    async function loadPolicy() {
      try {
        const view = await ctx.api.policy();
        if (td.done) return;
        renderPolicyContent(readLoosening(view));
      } catch (e) {
        if (td.done) return;
        const err = errorOf(e);
        replace(policyBox, h('div', { class: 'field-error' }, `Could not read policy: ${plain(err.message, 300)}`));
      }
    }

    function renderPolicyContent(p: ReturnType<typeof readLoosening>) {
      if (p.items.length === 0) {
        replace(
          policyBox,
          h('div', { class: 'detail' }, "Nothing in the project's policy files loosens Friday's security defaults."),
        );
        return;
      }

      const list = h(
        'ul',
        { class: 'pn-list' },
        p.items.map((l) =>
          h(
            'li',
            { class: 'pn-item' },
            h('span', { class: 'mono' }, visible(l.setting)),
            h('span', null, `${visible(l.from)} → ${visible(l.to)}`),
            h('span', { class: 'muted pn-grow' }, visible(l.source)),
          ),
        ),
      );

      const trustBtn =
        p.trusted || !p.hash
          ? null
          : button([icon('shield', 14), 'Trust this list'], () => void trustPolicy(p.hash as string, p.items), {
              class: 'hub-btn primary',
            });

      replace(
        policyBox,
        h(
          'div',
          { class: 'hub-row' },
          h(
            'div',
            { class: 'text' },
            h('span', { class: 'title' }, p.trusted ? 'Policy Trusted' : 'Pending Trust Verification'),
            p.hash ? h('span', { class: 'mono detail' }, `SHA-256: ${visible(p.hash)}`) : null,
          ),
          p.trusted ? badge('trusted', 'good') : badge('untrusted', 'warn'),
        ),
        note('Tracked files loosen sandbox defaults. They apply only once trusted on this clone.'),
        list,
        trustBtn ? h('div', { style: { marginTop: '12px' } }, trustBtn) : null,
      );
    }

    async function trustPolicy(hash: string, items: unknown[]) {
      const ok = await ctx.confirm({
        title: 'Trust security loosening on this clone?',
        body: ['Friday records trust in this exact hash; if policy files change, it asks again.'],
        confirmLabel: 'Trust Policy',
        danger: true,
      });
      if (!ok) return;
      const r = await ctx.act(
        'Trust policy',
        () => ctx.api.trustPolicy(hash),
        'Trusted: loosening applies on this clone',
      );
      if (r && !td.done) {
        renderPolicyContent(readLoosening(r));
        ctx.refresh();
      }
    }

    void loadPolicy();

    card.append(h('div', { class: 'hub-card-title' }, 'Workspace Security Policy'), policyBox);
    return [card];
  }

  // ── 7. Friday Engine Tab ──────────────────────────────────────────────────
  function renderFridayTab(): HTMLElement[] {
    const cardWorktrees = h('div', { class: 'hub-card' });
    const count = worktreesInUse(ctx.store.select('board'));
    const cleanBtn = button([icon('branch', 14), 'Clean up released worktrees'], () => void cleanUp(), {
      class: 'hub-btn',
    });

    async function cleanUp() {
      cleanBtn.disabled = true;
      await pruneWorktrees(ctx);
      if (!td.done) cleanBtn.disabled = false;
    }

    cardWorktrees.append(
      h('div', { class: 'hub-card-title' }, 'Git Worktree Management'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, `Active Worktrees (${count})`),
          h('span', { class: 'detail' }, 'Running task attempts execute in dedicated isolated worktrees'),
        ),
        cleanBtn,
      ),
    );

    const cardLifecycle = h('div', { class: 'hub-card' });
    const inBrowser = ctx.platform.kind === 'browser';

    const restartBtn = desktop
      ? button([icon('rework', 14), 'Restart Friday'], () => void restart(), { class: 'hub-btn' })
      : null;
    async function restart() {
      if (!desktop) return;
      const done = await ctx.act('Restart Friday', () => desktop.restart());
      if (done) ctx.toast({ kind: 'success', text: 'Friday is restarting' });
    }

    const logoutBtn = inBrowser
      ? button([icon('logout', 14), 'Log out'], () => void logout(), { class: 'hub-btn' })
      : null;
    async function logout() {
      const r = await ctx.act('Log out', () => ctx.api.logout());
      if (r) {
        clearSession();
        pageActions.reload();
      }
    }

    const stopBtn = button([icon('stop', 14), 'Stop Friday'], () => void stopDaemon(), { class: 'hub-btn danger' });
    async function stopDaemon() {
      const ok = await ctx.confirm({
        title: 'Stop Friday Daemon?',
        body: ['Active agents will disconnect. Work in progress is safely preserved in worktrees.'],
        confirmLabel: 'Stop Friday',
        danger: true,
      });
      if (!ok) return;
      await ctx.act('Stop Friday', () => ctx.api.stopDaemon(), 'Friday daemon is stopping');
    }

    cardLifecycle.append(
      h('div', { class: 'hub-card-title' }, 'Daemon Lifecycle'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Engine Controls'),
          h('span', { class: 'detail' }, 'Manage background server processes and active sessions'),
        ),
        h('div', { style: { display: 'flex', gap: '8px' } }, restartBtn, logoutBtn, stopBtn),
      ),
    );

    return [cardWorktrees, cardLifecycle];
  }

  // ── 8. Desktop Shell Tab ──────────────────────────────────────────────────
  function renderDesktopTab(): HTMLElement[] {
    const card = h('div', { class: 'hub-card' });

    if (!desktop) {
      card.append(
        h('div', { class: 'hub-card-title' }, 'Desktop Shell'),
        note('Desktop shortcuts and system autostart are active when running inside Friday Desktop (Tauri).'),
      );
      return [card];
    }

    const shortcutList = h('div', { class: 'pn-shortcuts' }, note('Reading registered hotkeys…'));
    desktop
      .shortcuts()
      .then((items) => {
        if (td.done) return;
        replace(
          shortcutList,
          items.map((s) => {
            const accel = input({ value: s.accel, class: 'hub-keycap' });
            const saveBtn = button('Set', () => void setKey(s.id, accel.value.trim()), {
              class: 'hub-btn small',
            });
            return h(
              'div',
              { class: 'hub-row', style: { padding: '4px 0' } },
              h('div', { class: 'text' }, h('span', { class: 'title' }, s.id), h('span', { class: 'detail' }, s.state)),
              h('div', { style: { display: 'flex', gap: '6px' } }, accel, saveBtn),
            );
          }),
        );
      })
      .catch(() => {
        if (!td.done) replace(shortcutList, note('Could not read desktop hotkeys.'));
      });

    async function setKey(id: string, accel: string) {
      if (!accel || !desktop) return;
      await ctx.act('Change shortcut', () => desktop.setShortcut(id, accel), 'Shortcut updated');
    }

    const startBox = checkbox('Start Friday when I sign in to Windows', false, (on) => void setStart(on));
    const startInput = startBox.querySelector('input') as HTMLInputElement;
    desktop.autostart().then((on) => {
      if (!td.done) startInput.checked = on;
    });

    async function setStart(on: boolean) {
      if (!desktop) return;
      await ctx.act('Set autostart', () => desktop.setAutostart(on));
    }

    card.append(
      h('div', { class: 'hub-card-title' }, 'Global Windows Shortcuts'),
      note('Hotkeys trigger anywhere in Windows while Friday Desktop runs:'),
      shortcutList,
      h('div', { class: 'hub-divider' }),
      h('div', { class: 'hub-row' }, startBox),
    );

    return [card];
  }

  // ── 9. About Friday Tab ───────────────────────────────────────────────────
  function renderAboutTab(): HTMLElement[] {
    const card = h('div', { class: 'hub-card' });
    const b = ctx.store.select('board');
    const p = b?.project;

    const kv = h(
      'dl',
      { class: 'hub-kv' },
      h('dt', null, 'Friday Daemon'),
      h('dd', null, p ? plain(p.daemon_version, 40) : '—'),
      h('dt', null, 'Interface Studio'),
      h(
        'dd',
        null,
        `${UI_VERSION} · API ${UI_API}${b && b.ui_api !== UI_API ? ` (Friday speaks ${String(b.ui_api)})` : ''}`,
      ),
      h('dt', null, 'Active Project'),
      h('dd', null, p ? visible(plain(p.name, 120)) : '—'),
      h('dt', null, 'Workspace Root'),
      h('dd', { class: 'mono' }, p ? visible(p.root) : '—'),
      h('dt', null, 'Daemon Address'),
      h('dd', { class: 'mono' }, p ? `127.0.0.1:${p.port}` : '—'),
      h('dt', null, 'Worktrees in use'),
      h('dd', null, String(worktreesInUse(b))),
    );

    card.append(h('div', { class: 'hub-card-title' }, 'System & Architecture'), kv);
    return [card];
  }

  // ── Sync with Store ui.settingsTab ────────────────────────────────────────
  td.add(
    ctx.store.subscribe('ui', (ui) => {
      const target = ui.settingsTab ?? 'look';
      if (target !== currentTab) {
        renderActiveTab(target);
      }
    }),
  );

  const initialTab = ctx.store.select('ui').settingsTab ?? 'look';
  renderActiveTab(initialTab);

  return {
    el: root,
    destroy() {
      td.run();
      root.remove();
    },
  };
}
