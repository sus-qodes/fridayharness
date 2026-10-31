/**
 * The Settings Hub: the full-window settings view (plan §7.10).
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
import type { UiSnapshot } from '@friday/protocol';
import { playSound } from '../audio/index.js';
import { pruneWorktrees } from '../dock/commands.js';
import { createFridayMascot } from '../mascot/index.js';
import { visible } from '../model/text.js';
import { clearSession } from '../platform/session.js';
import type { AppContext, Component, DesktopShortcut, NotificationAnswer } from '../shell/context.js';
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
  input,
  note,
  plain,
  plannerState,
  projectPath,
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
  SHORTCUT_LABELS,
  worktreesInUse,
} from './settings.js';

export type HubGroup = 'General' | 'AI & Governance' | 'System & Desktop';

export interface HubPageDef {
  id: string;
  group: HubGroup;
  icon: IconName;
  title: string;
  subtitle: string;
}

export const HUB_PAGES: HubPageDef[] = [
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

export function mountSettingsHub(ctx: AppContext): Component {
  const td = new Teardown();
  const prefs = () => ctx.store.select('prefs');
  const setPrefs = (changes: Partial<Prefs>) => ctx.store.patch('prefs', changes);
  const desktop = ctx.platform.desktop ?? null;

  // ── Root container ────────────────────────────────────────────────────────
  const root = h('div', { class: 'sh-settings-hub', id: 'hub' });

  // ── Sidebar: Brand Header with Live Friday ─────────────────────────────────
  const side = h('nav', { class: 'hub-side' });
  const brandCanvasWrap = h('div', { class: 'hub-brand-canvas-wrap' });
  const brandMascot = createFridayMascot(ctx, { size: 30, interactive: true });
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
  const groups: HubGroup[] = ['General', 'AI & Governance', 'System & Desktop'];

  for (const groupName of groups) {
    side.append(h('div', { class: 'hub-group' }, groupName));
    const pages = HUB_PAGES.filter((p) => p.group === groupName);
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
  const heroMascot = createFridayMascot(ctx, { size: 80, interactive: true });
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
    const valid = HUB_PAGES.some((p) => p.id === tabId);
    const target = valid ? tabId : 'look';
    if (ctx.store.select('ui').settingsTab !== target) {
      ctx.store.patch('ui', { settingsTab: target });
    } else {
      renderActiveTab(target);
    }
  }

  function renderActiveTab(tabId: string): void {
    currentTab = tabId;
    const def = HUB_PAGES.find((p) => p.id === tabId) ?? HUB_PAGES[0];
    if (!def) return;

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
            : result === 'denied'
              ? nativeNotify
                ? 'Windows refused notifications for Friday; allow them in Windows Settings → System → Notifications, then turn this on again.'
                : 'The browser refused notifications for this page; allow them in its site settings, then turn this on again.'
              : 'Notifications were not allowed; turn this on again to be asked once more.';
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
      const shell = desktop;
      const testBtn = button([icon('bell', 14), 'Send a test notification'], () => void testNotification(), {
        class: 'hub-btn',
      });
      const testState = h('div', { class: 'detail', style: { marginTop: '4px' } });

      async function testNotification() {
        testBtn.disabled = true;
        testState.textContent = '';
        const taken = await ctx.act('Send a test notification', () => shell.testNotification());
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
          h('span', { class: 'title' }, 'Character sound preview'),
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
    const local = brain?.provider === 'local';
    let budget = Number.isFinite(brain?.daily_budget_usd) ? (brain?.daily_budget_usd as number) : 5;
    const stepsList = h('ol', { class: 'pn-list' });
    // The daily budget the `allow-remote` command and the desktop's spending dialog use.
    const budgetInput = input({ type: 'number', min: '0', step: '1', value: String(budget) });
    budgetInput.addEventListener('input', () => {
      const v = clampNumber(budgetInput.value, 0, 100_000);
      if (v !== null) {
        budget = v;
        renderSteps();
      }
    });
    const openConfig = button(
      [icon('file', 14), 'Open config.yaml in VS Code'],
      () => {
        if (rootPath) ctx.platform.openInEditor(projectPath(rootPath, '.friday/config.yaml'));
      },
      { class: 'hub-btn' },
    );
    openConfig.disabled = !rootPath;
    // The desktop app does the first two steps with its own dialogs: the key goes into Windows'
    // password prompt and only the provider's name passes through the page (FD-26).
    const native = ctx.platform.desktop ?? null;
    const keyBtn = button([icon('shield', 14), 'Store the key…'], () => void storeKey(), { class: 'hub-btn' });
    const spendBtn = button('', () => void allowSpending(), { class: 'hub-btn' });
    // A cancelled dialog answers false: nothing changed, nothing to say. Once done, the board is read
    // again, and the page follows the planner's new state (below).
    async function storeKey() {
      if (!native) return;
      keyBtn.disabled = true;
      const done = await ctx.act('Store the provider key', () => native.storeKey('anthropic'));
      if (done) {
        ctx.toast({ kind: 'success', text: 'The key is stored' });
        ctx.refresh();
      }
      if (!td.done) keyBtn.disabled = false;
    }
    async function allowSpending() {
      if (!native) return;
      spendBtn.disabled = true;
      const amount = budget;
      const done = await ctx.act('Allow this clone to spend', () => native.allowSpending(amount));
      if (done) {
        ctx.toast({ kind: 'success', text: `This clone may spend up to ${usd(amount)} a day` });
        ctx.refresh();
      }
      if (!td.done) spendBtn.disabled = false;
    }
    function renderSteps() {
      replace(
        stepsList,
        rootPath
          ? h('li', null, 'Go to the project folder:', copyLine(ctx, `cd "${rootPath}"`, 'folder command'))
          : null,
        plannerSteps(brain, budget).map((s) => h('li', null, s.text, s.command ? copyLine(ctx, s.command) : null)),
      );
      // Each native step is offered while it is still needed; a planner on this machine needs neither.
      keyBtn.hidden = local || brain?.key === 'not needed' || (!!brain?.remote && brain.key !== 'missing');
      spendBtn.hidden = local || !!brain?.approved_here;
      replace(spendBtn, icon('check', 14), `Allow spending up to ${usd(budget)} a day…`);
    }
    renderSteps();

    const actionParts: (HTMLElement | null)[] = [
      h('div', { class: 'hub-card-title' }, 'Configuration & Spending Bounds'),
      note(
        local
          ? 'The planner runs on this machine, with no key and no spending budget. To make it ready, run this in a terminal in the project folder:'
          : 'You can always write plans yourself. To let the Master Brain plan, run these in a terminal in the project folder:',
      ),
      local ? null : field('Daily budget (USD) for the command below', budgetInput).el,
      native && !local
        ? h(
            'div',
            { class: 'pn-planner-native' },
            note(
              'The desktop app can do the first two steps with its own dialogs; the key goes into Windows’ password prompt, never into this page.',
            ),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, keyBtn, spendBtn),
          )
        : null,
      stepsList,
      h('div', { style: { display: 'flex', gap: '8px' } }, openConfig),
    ];
    cardActions.append(...actionParts.filter((x): x is HTMLElement => x !== null));

    // The steps are offered while the planner is not ready, as in the Settings drawer.
    return st.ready ? [cardStatus] : [cardStatus, cardActions];
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

    async function trustPolicy(hash: string, items: ReturnType<typeof readLoosening>['items']) {
      // The question lists exactly what is trusted, so nothing is trusted unseen.
      const ok = await ctx.confirm({
        title: 'Trust security loosening on this clone?',
        body: [
          ...items.map((l) => `${visible(l.setting)}: ${visible(l.from)} → ${visible(l.to)} (${visible(l.source)})`),
          `Friday records trust in exactly this list (hash ${visible(hash)}); if policy files change, it asks again.`,
        ],
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
      title:
        'Removes the worktrees of finished tasks that hold no uncommitted work (the same as Prune clean worktrees in the palette)',
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
          h(
            'span',
            { class: 'detail' },
            'Each running attempt works in its own worktree; a released one is kept until it is cleaned up.',
          ),
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
      if (!desktop || !restartBtn) return;
      restartBtn.disabled = true;
      const done = await ctx.act('Restart Friday', () => desktop.restart());
      if (done) ctx.toast({ kind: 'success', text: 'Friday is restarting' });
      if (!td.done) restartBtn.disabled = false;
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
        body: [
          'Friday stops for this project: agents it started disconnect, and nothing is assigned or verified until it runs again.',
          'Work in worktrees is kept. Start it again from its shortcut, the desktop app, or friday run.',
        ],
        confirmLabel: 'Stop Friday',
        danger: true,
      });
      if (!ok) return;
      stopBtn.disabled = true;
      const r = await ctx.act('Stop Friday', () => ctx.api.stopDaemon(), 'Friday daemon is stopping');
      if (!td.done && !r) stopBtn.disabled = false;
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
    if (inBrowser)
      cardLifecycle.append(
        note(
          'This page signed in with a one-time link; the session ends after 12 hours, when Friday restarts, or when you log out.',
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
    // Each shortcut by what it does, and why one is not active, as the shell reports it (FD-16).
    const renderShortcuts = (items: DesktopShortcut[]) => {
      if (td.done) return;
      replace(
        shortcutList,
        items.map((s) => {
          const label = SHORTCUT_LABELS[s.id] ?? plain(s.id, 40);
          const accel = input({ value: s.accel, class: 'hub-keycap', aria: { label: `Keys for: ${label}` } });
          const saveBtn = button('Set', () => void setKey(s.id, accel.value.trim()), {
            class: 'hub-btn small',
          });
          return h(
            'div',
            { class: 'hub-row', style: { padding: '4px 0' } },
            h(
              'div',
              { class: 'text' },
              h('span', { class: 'title' }, label),
              s.state === 'registered'
                ? null
                : h(
                    'span',
                    { class: 'detail' },
                    `Not active: ${plain(s.state.replace(/_/g, ' '), 40)}${s.note ? `. ${plain(s.note, 200)}` : ''}`,
                  ),
            ),
            h('div', { style: { display: 'flex', gap: '6px' } }, accel, saveBtn),
          );
        }),
      );
    };
    desktop
      .shortcuts()
      .then(renderShortcuts)
      .catch(() => {
        if (!td.done) replace(shortcutList, note('Could not read desktop hotkeys.'));
      });

    // The list is drawn again from what the shell answers, so a shortcut it could not register says so.
    async function setKey(id: string, accel: string) {
      if (!accel || !desktop) return;
      const r = await ctx.act('Change shortcut', () => desktop.setShortcut(id, accel), 'Shortcut updated');
      if (r) renderShortcuts(r);
    }

    // Starting at sign-in: the box is usable once the shell has said what it is, and always shows
    // the shell's answer, so a refused change is put back.
    const startState = h('div', { class: 'detail', aria: { live: 'polite' } });
    const startBox = checkbox('Start Friday when I sign in to Windows', false, (on) => void setStart(on));
    const startInput = startBox.querySelector('input') as HTMLInputElement;
    startInput.disabled = true;
    desktop.autostart().then(
      (on) => {
        if (td.done) return;
        startInput.checked = on;
        startInput.disabled = false;
      },
      () => {
        if (td.done) return;
        startInput.disabled = false;
        startState.textContent = 'The desktop app did not say whether it starts when you sign in.';
      },
    );

    async function setStart(on: boolean) {
      if (!desktop) return;
      startInput.disabled = true;
      startState.textContent = '';
      const r = await ctx.act(
        'Change starting at sign-in',
        () => desktop.setAutostart(on),
        (now) => (now ? 'Friday starts when you sign in to Windows' : 'Friday no longer starts when you sign in'),
      );
      if (td.done) return;
      startInput.disabled = false;
      startInput.checked = r ?? !on;
    }

    card.append(
      h('div', { class: 'hub-card-title' }, 'Global Windows Shortcuts'),
      note('Hotkeys trigger anywhere in Windows while Friday Desktop runs:'),
      shortcutList,
      h('div', { class: 'hub-divider' }),
      h('div', { class: 'hub-row' }, startBox),
      startState,
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

  // The planner page is drawn again when the planner's state changes (a key stored, spending
  // allowed, a provider configured), not on every board change, so a budget being typed stays.
  let brainSeen = JSON.stringify(ctx.store.select('board')?.brain ?? null);
  td.add(
    ctx.store.subscribe('board', (board) => {
      const now = JSON.stringify(board?.brain ?? null);
      if (now === brainSeen) return;
      brainSeen = now;
      if (currentTab === 'planner') renderActiveTab('planner');
    }),
  );
  // The Friday and About pages are drawn again when what they show changes: the worktrees in use,
  // the project's versions, folder and address.
  const facts = (board: UiSnapshot | null | undefined) =>
    JSON.stringify([worktreesInUse(board), board?.project ?? null, board?.ui_api ?? null]);
  let factsSeen = facts(ctx.store.select('board'));
  td.add(
    ctx.store.subscribe('board', (board) => {
      const now = facts(board);
      if (now === factsSeen) return;
      factsSeen = now;
      if (currentTab === 'friday' || currentTab === 'about') renderActiveTab(currentTab);
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
