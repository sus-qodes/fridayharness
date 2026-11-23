/**
 * The Settings Hub: the full-window settings view (plan §7.10).
 * Features:
 * - Round left panel layout (.hub-side) with 3 categorized groups:
 *   1. General (Look & Friday, Notifications, Sound)
 *   2. AI & Governance (Planner, Models, Checks, Permissions)
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
import { looseningExact, looseningLine, looseningWords } from '../model/loosening-words.js';
import { keyWords, plannerWords } from '../model/planner-words.js';
import { visible } from '../model/text.js';
import { clearSession } from '../platform/session.js';
import type { AppContext, Component, DesktopShortcut, NotificationAnswer } from '../shell/context.js';
import { builtWords, UI_API, UI_VERSION, versionWords } from '../shell/version.js';
import type { Prefs } from '../store/state.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { cleanText, usd } from '../ui/format.js';
import { type IconName, icon } from '../ui/svg.js';
import { agentPermissionsCard } from './agent-permissions.js';
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
  projectPath,
  restartBlocked,
  segmented,
  select,
  Teardown,
} from './common.js';
import { copyFilesCard } from './copy-files.js';
import { plannerModelRow } from './planner-model.js';
import { plannerChoices, plannerRequestsCard } from './planner-choices.js';
import { plannerSpendingCard } from './planner-spending.js';
import { projectChecksCard } from './project-checks.js';
import { autoApproveSwitch, autoVerifySwitch, landingChoice, plannerQuickSetup } from './quick-setup.js';
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

export type HubGroup = 'General' | 'Planning and agents' | 'This computer';

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
    title: 'Appearance',
    subtitle: 'What Friday wears, how much moves on screen, and when the Notch folds away.',
  },
  {
    id: 'notifications',
    group: 'General',
    icon: 'bell',
    title: 'Notifications',
    subtitle: 'When Friday tells you that something waits for you.',
  },
  {
    id: 'sound',
    group: 'General',
    icon: 'sound',
    title: 'Sound',
    subtitle: 'The sounds Friday makes, and how loud they are.',
  },

  // AI & Governance
  {
    id: 'planner',
    group: 'Planning and agents',
    icon: 'brain',
    title: 'Planner',
    subtitle: 'Who writes the plans, on which model, what it may spend, and whether plans wait for you.',
  },
  {
    id: 'routing',
    group: 'Planning and agents',
    icon: 'compass',
    title: 'Models',
    subtitle: 'Which model does the work: let Friday choose, or pick one.',
  },
  {
    id: 'checks',
    group: 'Planning and agents',
    icon: 'check',
    title: 'Checks',
    subtitle: 'What Friday runs to check an agent’s work, and whether it runs on its own.',
  },
  {
    id: 'policy',
    group: 'Planning and agents',
    icon: 'shield',
    title: 'Permissions',
    subtitle: 'What agents may do without asking, and the project settings this computer trusts.',
  },

  // System & Desktop
  {
    id: 'friday',
    group: 'This computer',
    icon: 'terminal',
    title: 'Friday',
    subtitle: 'The folders Friday keeps for tasks, and restarting or stopping Friday.',
  },
  {
    id: 'desktop',
    group: 'This computer',
    icon: 'desktop',
    title: 'Desktop app',
    subtitle: 'Keyboard shortcuts that work anywhere in Windows, and starting Friday when you sign in.',
  },
  {
    id: 'about',
    group: 'This computer',
    icon: 'info',
    title: 'About',
    subtitle: 'Versions, the project’s folder, and the address Friday answers on.',
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
  const groups: HubGroup[] = ['General', 'Planning and agents', 'This computer'];

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
  const versionLine = h('div', { class: 'hub-version', title: `Interface API ${UI_API}` }, versionWords());

  side.append(h('div', { class: 'spacer' }), statusLine, versionLine);

  function renderStatus(): void {
    const sys = ctx.store.select('system');
    const board = ctx.store.select('board');
    const port = board?.project.port ? `127.0.0.1:${board.project.port}` : '';

    if (sys.connection === 'live') {
      statusDot.style.background = 'var(--hub-green)';
      statusDot.style.color = 'var(--hub-green)';
      statusText.textContent = 'Friday is running';
      statusLine.title = port ? `Friday answers on ${port}` : '';
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
  // The way back to the dialog Settings was opened from (2026-11-18): "Open the model choices" in
  // Start an agent left the person here with nothing to go back by.
  const backBar = h('div', { class: 'hub-back', hidden: true });
  const renderBack = () => {
    const back = ctx.store.select('ui').settingsBack ?? null;
    const shown = ctx.store.select('ui').activeView === 'settings' && back;
    backBar.hidden = !shown;
    if (!shown || !back) {
      backBar.replaceChildren();
      return;
    }
    backBar.replaceChildren(
      button(
        [icon('chevronLeft', 14), cleanText(back.label)],
        () => {
          ctx.store.patch('ui', { settingsBack: null, activeView: 'canvas', modal: { ...back.modal } });
        },
        { class: 'btn btn-ghost hub-back-btn', dataset: { action: 'settings-back' } },
      ),
    );
  };
  td.add(ctx.store.subscribe('ui', renderBack));
  renderBack();
  const cardsContainer = h('div', { id: 'settings-root', class: 'hub-cards' });
  const pageContainer = h('div', { class: 'hub-page' }, backBar, heroBanner, cardsContainer);
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

  /**
   * What the tab now shown subscribed to (the planner switch, the pins, the automatic-checks switch
   * follow the board). Ended when the tab is drawn again or another one is shown: they were added
   * to the hub's own teardown before, so every redraw left one more subscriber behind for as long
   * as the Studio ran (2026-11-17).
   */
  let tabTd = new Teardown();
  td.add(() => tabTd.run());

  function renderActiveTab(tabId: string): void {
    tabTd.run();
    tabTd = new Teardown();
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
      case 'checks':
        return renderChecksTab();
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
      h('div', { class: 'hub-card-title' }, 'Friday’s look'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Outfit'),
          h('span', { class: 'detail' }, 'What Friday wears, in this window and in the Notch.'),
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
      h('div', { class: 'hub-card-title' }, 'Motion'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Reduce motion'),
          h(
            'span',
            { class: 'detail' },
            'Fewer things move on screen. “As the system” follows the setting of Windows.',
          ),
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
      h('div', { class: 'hub-card-title' }, 'The Notch'),
      note('The Notch is the small Friday at the top of your screen that shows what is happening.'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Fold an open card after'),
          h('span', { class: 'detail' }, 'Seconds before a card you opened folds back (1 to 120).'),
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
          h('span', { class: 'title' }, 'Hide the Notch after'),
          h('span', { class: 'detail' }, 'Seconds with nothing happening before it hides at the top edge (5 to 600).'),
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
      h('div', { class: 'hub-card-title' }, 'Notifications'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Tell me when something waits'),
          h(
            'span',
            { class: 'detail' },
            'An approval, a question, a plan to review, an agent that is blocked, or a failure.',
          ),
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
          testState.textContent =
            'Friday handed a test notification to Windows. If none appeared, Windows is holding Friday’s notifications back: Do Not Disturb, Focus, or the app’s own setting (Windows Settings → System → Notifications).';
        } else if (taken === false) {
          testState.textContent =
            'Friday could not prepare the notification, so Windows was not asked. Restart the desktop app and send another test.';
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
            h('span', { class: 'title' }, 'Try it'),
            h('span', { class: 'detail' }, 'Sends one now, to see that Windows shows Friday’s notifications.'),
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
      [icon('sound', 14), 'Play a sound'],
      () => {
        playSound('approval', { force: true });
      },
      { class: 'hub-btn' },
    );

    card.append(
      h('div', { class: 'hub-card-title' }, 'Sounds'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Sounds'),
          h(
            'span',
            { class: 'detail' },
            'A short sound when work finishes, when an approval or a question waits, and from Friday itself.',
          ),
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
          h('span', { class: 'title' }, 'Volume'),
          h('span', { class: 'detail' }, 'How loud those sounds are.'),
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
          h('span', { class: 'title' }, 'Try it'),
          h('span', { class: 'detail' }, 'Plays the sound of an approval waiting for you.'),
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
      h('div', { class: 'hub-card-title' }, 'The planner'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Can Friday write plans?'),
          h('span', { class: 'detail' }, st.text),
        ),
        badge(st.ready ? 'ready' : 'not ready', st.ready ? 'good' : 'warn'),
      ),
    );

    if (brain) {
      const kv = h(
        'dl',
        { class: 'hub-kv' },
        h('dt', null, 'Plans are written by'),
        h('dd', { title: `${plain(brain.provider, 40)} · ${plain(brain.model, 80)}` }, plannerWords(brain)),
        h('dt', null, 'API key'),
        h('dd', null, keyWords(brain.key)),
        // A planner Friday knows no price for (Codex, a key service) is counted in requests, and
        // nothing is said in dollars. Through Claude Code the figure is what the planning would
        // cost at list prices, not a bill.
        ...(brain.requests
          ? [
              h('dt', null, 'Requests today'),
              h('dd', { dataset: { role: 'requests' } }, `${brain.requests.today} of ${brain.requests.limit}`),
            ]
          : [
              h('dt', null, brain.provider === 'claude-code' ? 'Used today (estimate)' : 'Spent today'),
              h(
                'dd',
                null,
                `${usd(brain.spent_today_usd)} of ${Number.isFinite(brain.daily_budget_usd) ? usd(brain.daily_budget_usd) : 'no limit'}`,
              ),
            ]),
      );
      cardStatus.append(h('div', { class: 'hub-divider' }), kv);
      const modelRow = plannerModelRow(ctx, brain);
      if (modelRow) cardStatus.append(h('div', { class: 'hub-divider' }), modelRow);
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
    // The project's part (2026-11-17): it was a line to write into config.yaml by hand.
    const projectBtn = button('Allow it for this project…', () => void allowForProject(), { class: 'hub-btn' });
    /** Whether the project allows planning with a key: config.yaml as it is now, or as Friday started with it. */
    const projectAllows = () =>
      !!brain?.allow_remote ||
      (ctx.store.select('board')?.config.changes?.restart_needed ?? []).includes('providers.anthropic.allow_remote');
    async function allowForProject() {
      const ok = await ctx.confirm({
        title: 'Allow planning with an Anthropic key in this project?',
        body: [
          'To plan, Friday sends the goal and a summary of the project to Anthropic, with the key stored on this computer.',
          'Whether a project allows that is the project’s own setting, in .friday/config.yaml, which your team shares. Turning it on changes that file: commit it to share it. Each person still stores their own key and allows the spending on their own computer.',
        ],
        confirmLabel: 'Allow it for this project',
      });
      if (!ok) return;
      projectBtn.disabled = true;
      const set = await ctx.act(
        'Allow planning with a key',
        () => ctx.api.editSettings({ 'providers.anthropic.allow_remote': true }),
        'The project allows it: Friday reads that when it restarts',
      );
      if (set && native && !restartBlocked(ctx)) {
        await ctx.act(
          'Restart Friday',
          () => native.restart(),
          (done) => (done ? 'Friday restarts with the new setting' : ''),
        );
      }
      if (!td.done) {
        projectBtn.disabled = false;
        ctx.refresh();
        renderSteps();
      }
    }
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
      // The provider the planner runs: the shell approves Anthropic when none is named.
      const provider = brain?.provider === 'claude-code' ? 'claude-code' : undefined;
      const done = await ctx.act('Allow planning to spend', () => native.allowSpending(amount, provider));
      if (done) {
        ctx.toast({ kind: 'success', text: `Planning may spend up to ${usd(amount)} a day on this computer` });
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
      projectBtn.hidden = local || projectAllows();
      replace(spendBtn, icon('check', 14), `Allow spending up to ${usd(budget)} a day…`);
    }
    renderSteps();

    const actionParts: (HTMLElement | null)[] = [
      h('div', { class: 'hub-card-title' }, 'Plan with an Anthropic API key'),
      note(
        local
          ? 'The planner runs on this computer, with no key and no spending limit. To make it ready, run this in a terminal in the project folder:'
          : native
            ? 'You can always write plans yourself. To let Friday plan with your own Anthropic key, take the steps below; each button does one of them.'
            : 'You can always write plans yourself. To let Friday plan with your own Anthropic key, run these in a terminal in the project folder:',
      ),
      local ? null : field('Daily spending limit (USD)', budgetInput).el,
      native && !local
        ? h(
            'div',
            { class: 'pn-planner-native' },
            note('The key goes into Windows’ own password prompt, never into this page.'),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, keyBtn, spendBtn, projectBtn),
          )
        : local
          ? null
          : h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, projectBtn),
      // In the desktop app the buttons do the steps: the commands are for someone who wants them.
      native && !local ? fold('The same steps in a terminal', {}, stepsList) : stepsList,
      h('div', { style: { display: 'flex', gap: '8px' } }, openConfig),
    ];
    cardActions.append(...actionParts.filter((x): x is HTMLElement => x !== null));

    // No API key needed: the installed Claude Code plans, signed in as it already is.
    const cardQuick = h('div', { class: 'hub-card' }, plannerQuickSetup(ctx, tabTd));
    // The key-and-terminal steps are Anthropic's: beside a planner that is (or is about to be)
    // Claude Code they led nowhere, and their button approved the wrong provider (2026-11-17).
    const viaClaudeCode = (brain?.choice?.wanted ?? brain?.provider) === 'claude-code';
    // What planning may spend, once it was allowed here: the limit, changed, and turned off.
    const spending = plannerSpendingCard(ctx, tabTd, brain);
    const cardSpending = spending ? h('div', { class: 'hub-card' }, spending) : null;
    // Whether a proposed plan waits for a person: asked wherever there is a planner at all.
    const cardApprove = brain ? h('div', { class: 'hub-card' }, autoApproveSwitch(ctx, tabTd)) : null;
    // Every way to plan in one list (2026-11-23): Codex, a key of another service and a model on
    // this computer beside Claude's two, whose own steps are shown under their rows.
    const choices = plannerChoices(ctx, tabTd, {
      'claude-code': cardQuick.firstElementChild as HTMLElement,
      anthropic: cardActions,
    });
    if (choices) {
      cardActions.classList.remove('hub-card');
      const requests = plannerRequestsCard(ctx, tabTd, brain);
      const listed: (HTMLElement | null)[] = [
        cardStatus,
        cardSpending,
        requests ? h('div', { class: 'hub-card' }, requests) : null,
        h('div', { class: 'hub-card' }, choices),
        cardApprove,
      ];
      return listed.filter((x): x is HTMLElement => x !== null);
    }
    // The switch stays once planning works through it: it is where a person turns it off again.
    const setup = st.ready
      ? viaClaudeCode
        ? [cardQuick]
        : []
      : viaClaudeCode
        ? [cardQuick]
        : [cardQuick, cardActions];
    const all: (HTMLElement | null)[] = [cardStatus, cardSpending, ...setup, cardApprove];
    return all.filter((x): x is HTMLElement => x !== null);
  }

  // ── Checks Tab: the project's own checks, and whether they run on their own ──
  function renderChecksTab(): HTMLElement[] {
    return [
      h('div', { class: 'hub-card' }, projectChecksCard(ctx, tabTd)),
      h('div', { class: 'hub-card' }, autoVerifySwitch(ctx, tabTd)),
      h('div', { class: 'hub-card' }, landingChoice(ctx, tabTd)),
      h('div', { class: 'hub-card' }, copyFilesCard(ctx, tabTd)),
    ];
  }

  // ── 5. Routing & Pins Tab ─────────────────────────────────────────────────
  function renderRoutingTab(): HTMLElement[] {
    const card = h('div', { class: 'hub-card' });
    const pins = routingPins(ctx, tabTd);
    pins.load();

    card.append(h('div', { class: 'hub-card-title' }, 'Which model does the work'), pins.el);

    return [card];
  }

  // ── 6. Policy & Trust Tab ─────────────────────────────────────────────────
  function renderPolicyTab(): HTMLElement[] {
    const card = h('div', { class: 'hub-card' });
    const policyBox = h('div', { class: 'text' }, h('span', { class: 'detail' }, 'Reading the project’s settings…'));

    async function loadPolicy() {
      try {
        const view = await ctx.api.policy();
        if (td.done) return;
        renderPolicyContent(readLoosening(view));
      } catch (e) {
        if (td.done) return;
        const err = errorOf(e);
        replace(
          policyBox,
          h('div', { class: 'field-error' }, `The settings could not be read: ${plain(err.message, 300)}`),
        );
      }
    }

    function renderPolicyContent(p: ReturnType<typeof readLoosening>) {
      if (p.items.length === 0) {
        replace(
          policyBox,
          h(
            'div',
            { class: 'detail' },
            'Nothing in this project’s settings lets Friday or an agent do more than the defaults.',
          ),
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
            // What it allows, in words; the exact setting stays beside it, since trust is in that.
            h('span', { class: 'pn-loosening-words' }, looseningWords(l) ?? looseningExact(l)),
            looseningWords(l) ? h('span', { class: 'mono muted pn-loosening-exact' }, looseningExact(l)) : null,
            h('span', { class: 'muted pn-loosening-source' }, `set in ${visible(l.source)}`),
            // Each setting stands on its own (2026-11-18): trusted here, or waiting with its own button.
            l.trusted === undefined
              ? null
              : l.trusted
                ? badge('in force', 'good')
                : button('Trust this one', () => void trustPolicy(p.hash as string, [l]), { class: 'btn' }),
          ),
        ),
      );

      const waiting = p.items.filter((l) => l.trusted !== true);
      const trustBtn =
        p.trusted || !p.hash || (p.items.every((l) => l.trusted !== undefined) && waiting.length < 2)
          ? null
          : button(
              [
                icon('shield', 14),
                waiting.length === p.items.length ? 'Trust this list' : `Trust the ${waiting.length} that wait`,
              ],
              () => void trustPolicy(p.hash as string, waiting),
              { class: 'hub-btn primary' },
            );

      replace(
        policyBox,
        h(
          'div',
          { class: 'hub-row' },
          h(
            'div',
            { class: 'text' },
            h(
              'span',
              { class: 'title' },
              p.trusted
                ? 'Trusted on this computer'
                : waiting.length < p.items.length
                  ? `${waiting.length} of ${p.items.length} wait for your trust`
                  : 'Waiting for your trust',
            ),
            h(
              'span',
              { class: 'detail', ...(p.hash ? { title: `This list’s fingerprint: ${visible(p.hash)}` } : {}) },
              p.trusted
                ? 'These apply here. A setting that is changed in the project’s files is asked about again.'
                : waiting.length < p.items.length
                  ? 'The ones marked “in force” apply here; the others do not yet.'
                  : 'None of these applies here yet.',
            ),
          ),
          p.trusted
            ? badge('trusted', 'good')
            : badge(waiting.length < p.items.length ? 'some wait' : 'not in force', 'warn'),
        ),
        note(
          'The project’s files ask for these: each lets Friday or an agent do more than it would by default. A setting applies on this computer once you trust it, and each is trusted on its own; when a file changes one, Friday asks about that one again.',
        ),
        list,
        trustBtn ? h('div', { style: { marginTop: '12px' } }, trustBtn) : null,
      );
    }

    async function trustPolicy(hash: string, items: ReturnType<typeof readLoosening>['items']) {
      // The question lists exactly what is trusted, so nothing is trusted unseen. One question:
      // the desktop asks in its own window (`confirm_and_send`), a browser asks here.
      if (!ctx.platform.desktop) {
        const ok = await ctx.confirm({
          title: items.length === 1 ? 'Trust this setting on this computer?' : 'Trust these settings on this computer?',
          body: [
            ...items.map(looseningLine),
            'Friday records trust in exactly this; if the project’s files change it, it asks again.',
          ],
          confirmLabel: items.length === 1 ? 'Trust it' : 'Trust them',
          danger: true,
        });
        if (!ok) return;
      }
      const ids = items.map((l) => l.id).filter((i): i is string => typeof i === 'string');
      const r = await ctx.act(
        'Trust the settings',
        // By their own ids where the daemon gives them; the whole list as one otherwise.
        () => (ids.length === items.length && ids.length > 0 ? ctx.api.trustSettings(ids) : ctx.api.trustPolicy(hash)),
        items.length === 1
          ? 'Trusted: it now applies on this computer'
          : 'Trusted: these settings now apply on this computer',
      );
      if (r && !td.done) {
        renderPolicyContent(readLoosening(r));
        ctx.refresh();
      }
    }

    void loadPolicy();

    card.append(h('div', { class: 'hub-card-title' }, 'What this computer trusts'), policyBox);
    // What the card lists follows what is trusted and asked for: read again when either changes
    // (the switch above just did one of them), not only when the tab is opened.
    const trustFacts = (b: UiSnapshot | null | undefined) =>
      JSON.stringify([
        b?.policy_untrusted ?? null,
        b?.verification.auto_on_completion ?? null,
        b?.verification.auto_requested ?? null,
      ]);
    let trustSeen = trustFacts(ctx.store.select('board'));
    tabTd.add(
      ctx.store.subscribe('board', (b) => {
        const now = trustFacts(b);
        if (now === trustSeen) return;
        trustSeen = now;
        void loadPolicy();
      }),
    );
    return [h('div', { class: 'hub-card' }, agentPermissionsCard(ctx, tabTd)), card];
  }

  // ── 7. Friday Engine Tab ──────────────────────────────────────────────────
  function renderFridayTab(): HTMLElement[] {
    const cardWorktrees = h('div', { class: 'hub-card' });
    const count = worktreesInUse(ctx.store.select('board'));
    const cleanBtn = button([icon('branch', 14), 'Clean up finished task folders'], () => void cleanUp(), {
      class: 'hub-btn',
      title: 'Removes the folders of finished tasks that hold no uncommitted work',
    });

    async function cleanUp() {
      cleanBtn.disabled = true;
      await pruneWorktrees(ctx);
      if (!td.done) cleanBtn.disabled = false;
    }

    cardWorktrees.append(
      h('div', { class: 'hub-card-title' }, 'Task folders'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, `Task folders in use: ${count}`),
          h(
            'span',
            { class: 'detail' },
            'Each task an agent works on gets its own copy of the project (a git worktree), so agents do not disturb each other or your own files. The folder of a finished task is kept until it is cleaned up.',
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
      if (!desktop || !restartBtn || restartBlocked(ctx)) return;
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
        title: 'Stop Friday?',
        body: [
          'Friday stops for this project: agents it started disconnect, and nothing is given to agents or checked until it runs again.',
          desktop
            ? 'The work in the task folders is kept. Start Friday again here, or from the tray’s menu.'
            : 'The work in the task folders is kept. Start Friday again from its shortcut or the desktop app.',
        ],
        confirmLabel: 'Stop Friday',
        danger: true,
      });
      if (!ok) return;
      stopBtn.disabled = true;
      const r = await ctx.act('Stop Friday', () => ctx.api.stopDaemon(), 'Friday is stopping');
      if (!td.done && !r) stopBtn.disabled = false;
    }

    cardLifecycle.append(
      h('div', { class: 'hub-card-title' }, 'Friday itself'),
      h(
        'div',
        { class: 'hub-row' },
        h(
          'div',
          { class: 'text' },
          h('span', { class: 'title' }, 'Restart or stop'),
          h(
            'span',
            { class: 'detail' },
            'Friday runs in the background for this project. Stopping it disconnects the agents it started; their work is kept.',
          ),
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
        h('div', { class: 'hub-card-title' }, 'Desktop app'),
        note(
          'Keyboard shortcuts and starting at sign-in belong to the Friday desktop app. This page is open in a browser.',
        ),
      );
      return [card];
    }

    const shortcutList = h('div', { class: 'pn-shortcuts' }, note('Reading the shortcuts…'));
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
        if (!td.done) replace(shortcutList, note('The desktop app did not say which shortcuts it has.'));
      });

    // The list is drawn again from what the shell answers, so a shortcut it could not register says so.
    async function setKey(id: string, accel: string) {
      if (!accel || !desktop) return;
      const r = await ctx.act('Change the shortcut', () => desktop.setShortcut(id, accel), 'Shortcut changed');
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
      h('div', { class: 'hub-card-title' }, 'Keyboard shortcuts'),
      note('These work anywhere in Windows while the app runs, for example Ctrl+Alt+Shift+F.'),
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
      h('dt', null, 'Friday'),
      h('dd', null, p ? plain(p.daemon_version, 40) : '—'),
      h('dt', null, 'This window'),
      h(
        'dd',
        null,
        `${UI_VERSION}${builtWords() ? ` · built ${builtWords()}` : ''} · API ${UI_API}${b && b.ui_api !== UI_API ? ` (Friday speaks ${String(b.ui_api)})` : ''}`,
      ),
      h('dt', null, 'Project'),
      h('dd', null, p ? visible(plain(p.name, 120)) : '—'),
      h('dt', null, 'Project folder'),
      h('dd', { class: 'mono' }, p ? visible(p.root) : '—'),
      h('dt', null, 'Address'),
      h('dd', { class: 'mono' }, p ? `127.0.0.1:${p.port}` : '—'),
      h('dt', null, 'Task folders in use'),
      h('dd', null, String(worktreesInUse(b))),
    );

    card.append(h('div', { class: 'hub-card-title' }, 'About this Friday'), kv);
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
  // `head` and `cursor` move with every event and are not shown: with them in, the page was drawn
  // again on every event, and a budget being typed was lost (2026-11-17).
  const brainFacts = (board: UiSnapshot | null | undefined) =>
    JSON.stringify(board?.brain ?? null, (key, value) => (key === 'head' || key === 'cursor' ? undefined : value));
  let brainSeen = brainFacts(ctx.store.select('board'));
  td.add(
    ctx.store.subscribe('board', (board) => {
      const now = brainFacts(board);
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
