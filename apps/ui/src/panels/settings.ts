/**
 * Settings (plan §7.10, review §4 to §6), grouped so that what a person touches most comes first:
 * Notifications (with the desktop app's test notification); Sound; Look and Notch (the Notch
 * timings under an Advanced fold); the Planner's state with the exact terminal steps, and in the
 * desktop app its native dialogs (a key and spending consent never pass through the page, FD-26);
 * Routing, the home of the pins and the mode word; the Policy's loosening and Trust (sending
 * exactly the hash shown); Friday itself (the worktrees in use and their clean-up, a restart in the
 * desktop app, logging out in a browser, stopping Friday); the Desktop app's shortcuts and start at
 * sign-in; About (the address, the folder, the versions). `request.tab` names a section to open at.
 */
import type { BrainStatusView, UiSnapshot } from '@friday/protocol';
import type { PolicyView } from '../api/client.js';
import { pruneWorktrees } from '../dock/commands.js';
import { visible } from '../model/text.js';
import { clearSession } from '../platform/session.js';
import type {
  AppContext,
  Component,
  DesktopCommands,
  DesktopShortcut,
  DrawerRequest,
  NotificationAnswer,
} from '../shell/context.js';
import { UI_API, UI_VERSION } from '../shell/version.js';
import type { Prefs } from '../store/state.js';
import { button, h, replace } from '../ui/dom.js';
import { usd } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import {
  badge,
  checkbox,
  copyLine,
  errorOf,
  field,
  fold,
  input,
  note,
  panel,
  plain,
  plannerState,
  projectPath,
  segmented,
  select,
  Teardown,
} from './common.js';
import { routingPins } from './routing-pins.js';

/** Page actions a test replaces (a reload would end the test page). */
export const pageActions = {
  reload(): void {
    location.reload();
  },
};

export const OUTFITS: readonly { value: Prefs['outfit']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'headphones', label: 'Headphones' },
  { value: 'visor', label: 'Visor glasses' },
  { value: 'winter', label: 'Winter hat' },
  { value: 'witch', label: 'Witch hat' },
  { value: 'sunglasses', label: 'Sunglasses' },
];

export const NOTCH_LIMITS = { collapse: { min: 1, max: 120 }, hide: { min: 5, max: 600 } } as const;

/** The sections, in the order shown; `request.tab` names one. "desktop" exists in the desktop app only. */
export const SETTINGS_SECTIONS = [
  'notifications',
  'sound',
  'look',
  'planner',
  'routing',
  'policy',
  'friday',
  'desktop',
  'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** A number from a field, clamped; null when it is not a number. */
export function clampNumber(text: string, min: number, max: number): number | null {
  const n = Number(text);
  if (!text.trim() || !Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export interface Loosening {
  source: string;
  setting: string;
  from: string;
  to: string;
}

/** The policy's loosening, its hash and whether this clone trusts it, from either shape the route may answer. */
export function readLoosening(view: PolicyView | null | undefined): {
  items: Loosening[];
  hash: string | null;
  trusted: boolean;
} {
  const p = (view?.policy ?? {}) as Record<string, unknown>;
  const raw = p.loosening;
  const item = (v: unknown): Loosening => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === 'string' ? x : x === undefined || x === null ? '' : String(x));
    return { source: s(o.source), setting: s(o.setting), from: s(o.from), to: s(o.to) };
  };
  if (Array.isArray(raw)) {
    return {
      items: raw.map(item),
      hash: typeof p.loosening_hash === 'string' ? p.loosening_hash : null,
      trusted: p.trusted === true,
    };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { items?: unknown; hash?: unknown; trusted?: unknown };
    return {
      items: Array.isArray(o.items) ? o.items.map(item) : [],
      hash: typeof o.hash === 'string' ? o.hash : null,
      trusted: o.trusted === true,
    };
  }
  return { items: [], hash: null, trusted: p.trusted === true };
}

/** The terminal steps that make the planner ready (FD-26: never in the page). */
export function plannerSteps(
  brain: BrainStatusView | null | undefined,
  budget: number,
): { text: string; command?: string }[] {
  const steps: { text: string; command?: string }[] = [];
  if (!brain?.remote || brain.key === 'missing')
    steps.push({
      text: 'Store your Anthropic API key (the terminal asks for it; it never passes through this page):',
      command: 'friday secrets set anthropic',
    });
  if (!brain?.approved_here)
    steps.push({
      text: 'Allow this clone to spend, with a daily budget in dollars:',
      command: `friday brain allow-remote --budget ${budget}`,
    });
  if (!brain?.allow_remote)
    steps.push({
      text: 'In .friday/config.yaml set providers.anthropic.allow_remote: true (the project asks for remote planning).',
    });
  steps.push({ text: 'Restart Friday: it reads its configuration when it starts.' });
  return steps;
}

const LIVE_RUN = new Set(['STARTING', 'ACTIVE', 'SUSPENDED']);

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Worktrees in use by running attempts: live runs whose workspace is ready and lies outside the main
 * checkout, counted once per folder (plan §7.3 header metrics, ERRATA F37). The one rule for the
 * number: the header showed it before M9k and no longer counts it; Settings → Friday and About do,
 * beside the one action on worktrees.
 */
export function worktreesInUse(board: UiSnapshot | null | undefined): number {
  if (!board) return 0;
  const root = normalizePath(board.project.root ?? '');
  const roots = new Set<string>();
  for (const run of Object.values(board.runs ?? {})) {
    if (!run || !LIVE_RUN.has(run.status) || run.workspace !== 'ready' || !run.execution_root) continue;
    const r = normalizePath(run.execution_root);
    if (r && r !== root) roots.add(r);
  }
  return roots.size;
}

/** What each desktop shortcut does (the shell's ids, FD-16). */
const SHORTCUT_LABELS: Record<string, string> = {
  notch: 'Open the Notch and give it the keyboard',
  studio: 'Show the Studio',
  halt: 'Open the halt dialog',
};

/** What only the desktop app offers, placed in the sections where each belongs. */
interface DesktopBits {
  /** Restart Friday (Settings → Friday). */
  restartBtn: HTMLButtonElement;
  /** Send a test notification and what it said (Settings → Notifications). */
  testBtn: HTMLButtonElement;
  testState: HTMLElement;
  /** The Desktop app section: the global shortcuts, each changeable, and starting at sign-in. */
  section: HTMLElement;
}

function desktopBits(ctx: AppContext, desktop: DesktopCommands, td: Teardown): DesktopBits {
  const list = h('div', { class: 'pn-shortcuts' }, note('Reading the shortcuts…'));
  const render = (items: DesktopShortcut[]) => {
    if (td.done) return;
    replace(
      list,
      items.map((s) => {
        const accel = input({ value: s.accel, aria: { label: `Keys for: ${SHORTCUT_LABELS[s.id] ?? s.id}` } });
        const save = button('Set', () => void set(s.id, accel.value.trim()), { class: 'btn' });
        return h(
          'div',
          { class: 'pn-shortcut' },
          h('div', { class: 'field-label' }, SHORTCUT_LABELS[s.id] ?? plain(s.id, 40)),
          h('div', { class: 'row' }, accel, save),
          s.state === 'registered'
            ? null
            : note(`Not active: ${plain(s.state.replace(/_/g, ' '), 40)}${s.note ? `. ${plain(s.note, 200)}` : ''}`),
        );
      }),
    );
  };
  async function set(id: string, accel: string) {
    if (!accel) return;
    const r = await ctx.act('Change the shortcut', () => desktop.setShortcut(id, accel), 'Shortcut changed');
    if (r) render(r);
  }
  desktop
    .shortcuts()
    .then(render)
    .catch(() => {
      if (!td.done) replace(list, note('The desktop app did not say which shortcuts it has.'));
    });
  const restartBtn = button([icon('rework', 14), 'Restart Friday'], () => void restart(), { class: 'btn' });
  async function restart() {
    restartBtn.disabled = true;
    // The shell asks natively first (a cancel answers false: nothing to say); the page reads the
    // board again once Friday is back.
    const done = await ctx.act('Restart Friday', () => desktop.restart());
    if (done) ctx.toast({ kind: 'success', text: 'Friday is restarting' });
    if (!td.done) restartBtn.disabled = false;
  }
  // A test notification (plan §8.7): the shell can tell only whether it handed the notification to
  // Windows, never whether it appeared, so the answer says no more than that.
  const testState = h('div', { class: 'field-hint', aria: { live: 'polite' } });
  const testBtn = button([icon('bell', 14), 'Send a test notification'], () => void testNotification(), {
    class: 'btn',
  });
  async function testNotification() {
    testBtn.disabled = true;
    testState.textContent = '';
    const taken = await ctx.act('Send a test notification', () => desktop.testNotification());
    if (td.done) return;
    testBtn.disabled = false;
    if (taken === true)
      testState.textContent =
        'Friday handed a test notification to Windows. If none appeared, Windows is holding Friday’s notifications back: Do Not Disturb, Focus, the app’s own notification setting (Windows Settings → System → Notifications), or a copy of the app started without its Start-menu shortcut.';
    else if (taken === false)
      testState.textContent =
        'Friday could not prepare the notification, so Windows was not asked. Restart the desktop app and send another test.';
  }
  // Start at sign-in (plan §8.3): opt-in, a per-user Run entry the shell writes and removes.
  const startState = h('div', { class: 'field-hint', aria: { live: 'polite' } });
  const startBox = checkbox('Start Friday when I sign in', false, (on) => void setStart(on));
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
  const section = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-desktop' },
    h('h3', { class: 'section-title' }, 'Desktop app'),
    note('Shortcuts work anywhere in Windows while the app runs, for example Ctrl+Alt+Shift+F.'),
    list,
    startBox,
    startState,
  );
  return { restartBtn, testBtn, testState, section };
}

export function settingsDrawer(ctx: AppContext, request: DrawerRequest): Component & { title: string } {
  const td = new Teardown();
  const prefs = () => ctx.store.select('prefs');
  const set = (changes: Partial<Prefs>) => ctx.store.patch('prefs', changes);
  const desktop = ctx.platform.desktop ? desktopBits(ctx, ctx.platform.desktop, td) : null;

  // ---- notifications: the platform asks (a browser its Notification API; the desktop app sends its own)
  const nativeNotify = ctx.platform.kind === 'tauri';
  const notifyWhen = nativeNotify ? 'while the Notch is hidden or the screen is locked' : 'while this tab is hidden';
  const notifyState = h('div', { class: 'field-hint', aria: { live: 'polite' } });
  const notifyBox = checkbox(`Notify me ${notifyWhen}`, prefs().notifications, (on) => void setNotifications(on));
  const notifyInput = notifyBox.querySelector('input') as HTMLInputElement;
  async function setNotifications(on: boolean) {
    notifyState.textContent = '';
    if (!on) {
      set({ notifications: false });
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
      set({ notifications: true });
      // The desktop app cannot see whether Windows shows them: the test below says what it can.
      notifyState.textContent = nativeNotify
        ? `Friday asks Windows to notify you of approvals, questions, plans, blocked agents and failures ${notifyWhen}. Send a test notification (below) to see whether Windows shows them.`
        : `Friday notifies you of approvals, questions, plans, blocked agents and failures ${notifyWhen}.`;
    } else {
      notifyInput.checked = false;
      set({ notifications: false });
      notifyState.textContent =
        result === 'unsupported'
          ? 'This browser has no notifications.'
          : result === 'denied'
            ? 'The browser refused notifications for this page; allow them in its site settings, then turn this on again.'
            : 'The browser did not allow notifications; turn this on again to be asked once more.';
    }
  }
  const notifications = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-notifications' },
    h('h3', { class: 'section-title' }, 'Notifications'),
    notifyBox,
    notifyState,
    desktop ? h('div', { class: 'pn-actions pn-actions-start' }, desktop.testBtn) : null,
    desktop?.testState ?? null,
  );

  // ---- sound
  const volume = input({
    type: 'range',
    min: '0',
    max: '1',
    step: '0.01',
    value: String(prefs().volume),
    aria: { label: 'Volume' },
  });
  volume.addEventListener('input', () => {
    const v = clampNumber(volume.value, 0, 1);
    if (v !== null) set({ volume: v });
  });
  const sound = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-sound' },
    h('h3', { class: 'section-title' }, 'Sound'),
    checkbox('Play sounds', !prefs().muted, (on) => set({ muted: !on })),
    field('Volume', volume).el,
  );

  // ---- look and Notch
  const motion = segmented<Prefs['motion']>(
    'Reduced motion',
    [
      { value: 'system', label: 'As the system' },
      { value: 'reduce', label: 'On' },
      { value: 'full', label: 'Off' },
    ],
    prefs().motion,
    (v) => set({ motion: v }),
  );
  const outfit = select(OUTFITS, prefs().outfit, (v) => set({ outfit: v }));
  const collapse = input({
    type: 'number',
    min: String(NOTCH_LIMITS.collapse.min),
    max: String(NOTCH_LIMITS.collapse.max),
    step: '1',
    value: String(prefs().notchAutoCollapseS),
  });
  collapse.addEventListener('change', () => {
    const v = clampNumber(collapse.value, NOTCH_LIMITS.collapse.min, NOTCH_LIMITS.collapse.max);
    if (v === null) collapse.value = String(prefs().notchAutoCollapseS);
    else {
      collapse.value = String(Math.round(v));
      set({ notchAutoCollapseS: Math.round(v) });
    }
  });
  const hide = input({
    type: 'number',
    min: String(NOTCH_LIMITS.hide.min),
    max: String(NOTCH_LIMITS.hide.max),
    step: '1',
    value: String(prefs().notchHideS),
  });
  hide.addEventListener('change', () => {
    const v = clampNumber(hide.value, NOTCH_LIMITS.hide.min, NOTCH_LIMITS.hide.max);
    if (v === null) hide.value = String(prefs().notchHideS);
    else {
      hide.value = String(Math.round(v));
      set({ notchHideS: Math.round(v) });
    }
  });
  // The timings are numbers only a tinkerer wants (review §5): under a fold, still in the page.
  const advanced = fold(
    'Advanced',
    { class: 'pn-notch-advanced' },
    h(
      'div',
      { class: 'pn-grid2' },
      field('Fold the Notch after (seconds)', collapse, { hint: 'once the pointer leaves an open card' }).el,
      field('Hide the Notch after (seconds)', hide, { hint: 'idle time before the pill becomes a strip' }).el,
    ),
  );
  const look = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-look' },
    h('h3', { class: 'section-title' }, 'Look and Notch'),
    h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Reduced motion'), motion),
    field('Mascot outfit', outfit).el,
    checkbox('Show finished goals on the board', prefs().showFinished, (on) => set({ showFinished: on })),
    advanced,
  );

  // ---- planner
  const plannerHead = h('div', { class: 'pn-planner' });
  const stepsBox = h('ol', { class: 'pn-steps' });
  let budget = 5;
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
      const root = ctx.store.select('board')?.project.root;
      if (root) ctx.platform.openInEditor(projectPath(root, '.friday/config.yaml'));
    },
    { class: 'btn' },
  );
  // The desktop app does the first two steps with its own dialogs: the key goes into Windows'
  // password prompt and only the provider's name passes through the page (FD-26).
  const native = ctx.platform.desktop ?? null;
  const keyBtn = button([icon('shield', 14), 'Store the key…'], () => void storeKey(), { class: 'btn' });
  const spendBtn = button('', () => void allowSpending(), { class: 'btn' });
  const nativeBox = native
    ? h(
        'div',
        { class: 'pn-planner-native' },
        note(
          'The desktop app can do the first two steps with its own dialogs; the key goes into Windows’ password prompt, never into this page.',
        ),
        h('div', { class: 'pn-actions pn-actions-start' }, keyBtn, spendBtn),
      )
    : null;
  // A cancelled dialog answers false: nothing changed, nothing to say. Once done, the board is read
  // again so the planner's state follows.
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
  const fixBox = h(
    'div',
    { class: 'pn-planner-fix' },
    note(
      'You can always write plans yourself. To let the Master Brain plan, run these in a terminal in the project folder:',
    ),
    field('Daily budget (USD) for the command below', budgetInput).el,
    nativeBox,
    stepsBox,
    h('div', { class: 'pn-actions pn-actions-start' }, openConfig),
  );
  function renderSteps() {
    const board = ctx.store.select('board');
    const root = board?.project.root ?? '';
    const brain = board?.brain ?? null;
    replace(
      stepsBox,
      root ? h('li', null, 'Go to the project folder:', copyLine(ctx, `cd "${root}"`, 'folder command')) : null,
      plannerSteps(brain, budget).map((s) => h('li', null, s.text, s.command ? copyLine(ctx, s.command) : null)),
    );
    openConfig.disabled = !root;
    // The same steps as the commands above, offered while each is still needed: a planner that
    // needs no key (a model on this machine) is offered none.
    keyBtn.hidden = brain?.key === 'not needed' || (!!brain?.remote && brain.key !== 'missing');
    spendBtn.hidden = !!brain?.approved_here;
    replace(spendBtn, icon('check', 14), `Allow spending up to ${usd(budget)} a day…`);
  }
  function renderPlanner() {
    const brain = ctx.store.select('board')?.brain ?? null;
    const st = plannerState(brain);
    replace(
      plannerHead,
      h(
        'div',
        { class: 'row' },
        badge(st.ready ? 'ready' : 'not ready', st.ready ? 'good' : 'warn'),
        h('span', null, st.text),
      ),
      brain
        ? h(
            'dl',
            { class: 'pn-kv' },
            h('dt', null, 'Provider'),
            h('dd', null, `${plain(brain.provider, 40)} · ${plain(brain.model, 80)}${brain.remote ? ' (remote)' : ''}`),
            h('dt', null, 'Key'),
            h('dd', null, brain.key),
            h('dt', null, 'Spent today'),
            h(
              'dd',
              null,
              `${usd(brain.spent_today_usd)} of ${Number.isFinite(brain.daily_budget_usd) ? usd(brain.daily_budget_usd) : 'no limit'}`,
            ),
          )
        : null,
    );
    fixBox.hidden = st.ready;
    renderSteps();
  }
  const planner = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-planner' },
    h('h3', { class: 'section-title' }, 'Planner'),
    plannerHead,
    fixBox,
  );

  // ---- routing: the pins' home (review decision 2), with the mode word the daemon reports
  const pins = routingPins(ctx, td);
  const routing = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-routing' },
    h('h3', { class: 'section-title' }, 'Routing'),
    note(
      'Friday picks each task’s model from routing. A pin makes it route a role, a task or a kind of task to one model; the routing question card and the Start an agent dialog lead here.',
    ),
    pins.el,
  );

  // ---- policy
  const policyBox = h('div', { class: 'pn-policy' }, h('div', { class: 'muted' }, 'Reading the policy…'));
  async function loadPolicy() {
    try {
      const view = await ctx.api.policy();
      if (td.done) return;
      renderPolicy(readLoosening(view));
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      replace(
        policyBox,
        h(
          'div',
          { class: 'field-error' },
          `Could not read the policy: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`,
        ),
      );
    }
  }
  function renderPolicy(p: ReturnType<typeof readLoosening>) {
    if (p.items.length === 0) {
      replace(
        policyBox,
        h('div', { class: 'muted' }, "Nothing in the project's policy files loosens Friday's defaults."),
      );
      return;
    }
    const hash = p.hash;
    replace(
      policyBox,
      h(
        'div',
        { class: 'row' },
        p.trusted ? badge('trusted here', 'good') : badge('not trusted here', 'warn'),
        hash ? h('span', { class: 'mono muted' }, visible(hash)) : null,
      ),
      note(
        "The project's tracked files loosen these settings; they apply on this clone only once you trust exactly this list.",
      ),
      h(
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
      ),
      p.trusted || !hash
        ? null
        : h(
            'div',
            { class: 'pn-actions pn-actions-start' },
            button([icon('shield', 14), 'Trust this list'], () => void trust(hash, p.items), {
              class: 'btn btn-primary',
            }),
          ),
    );
  }
  async function trust(hash: string, items: Loosening[]) {
    const ok = await ctx.confirm({
      title: 'Trust this loosening on this clone?',
      body: [
        ...items.map((l) => `${visible(l.setting)}: ${visible(l.from)} → ${visible(l.to)} (${visible(l.source)})`),
        `Friday records trust in exactly this list (hash ${visible(hash)}); if the files change, it asks again.`,
      ],
      confirmLabel: 'Trust it',
      danger: true,
    });
    if (!ok) return;
    const r = await ctx.act(
      'Trust the policy',
      () => ctx.api.trustPolicy(hash),
      'Trusted: the loosening applies on this clone',
    );
    if (r && !td.done) {
      renderPolicy(readLoosening(r));
      ctx.refresh();
    }
  }
  const policy = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-policy' },
    h('h3', { class: 'section-title' }, 'Policy'),
    policyBox,
  );

  // ---- Friday: the worktrees in use and their clean-up, restart, log out, stop
  const worktreesCount = h('strong', { class: 'pn-worktrees-count' }, '0');
  const cleanBtn = button([icon('branch', 14), 'Clean up released worktrees'], () => void cleanUp(), {
    class: 'btn',
    title:
      'Removes the worktrees of finished tasks that hold no uncommitted work (the same as Prune clean worktrees in the palette)',
  });
  async function cleanUp() {
    cleanBtn.disabled = true;
    // The palette's prune: the same call, the same toast listing what was removed and what was kept.
    await pruneWorktrees(ctx);
    if (!td.done) cleanBtn.disabled = false;
  }
  function renderWorktrees() {
    worktreesCount.textContent = String(worktreesInUse(ctx.store.select('board')));
  }
  const logoutBtn = button([icon('logout', 14), 'Log out'], () => void logout(), { class: 'btn' });
  async function logout() {
    logoutBtn.disabled = true;
    const r = await ctx.act('Log out', () => ctx.api.logout());
    if (td.done) return;
    logoutBtn.disabled = false;
    if (!r) return;
    clearSession();
    pageActions.reload();
  }
  const inBrowser = ctx.platform.kind === 'browser';
  const stopBtn = button([icon('stop', 14), 'Stop Friday'], () => void stop(), { class: 'btn btn-danger' });
  async function stop() {
    const ok = await ctx.confirm({
      title: 'Stop Friday?',
      body: [
        'Friday stops for this project: agents it started disconnect, and nothing is assigned or verified until it runs again.',
        'Work in worktrees is kept. Start it again from its shortcut, the desktop app, or friday run.',
      ],
      confirmLabel: 'Stop Friday',
      danger: true,
    });
    if (!ok) return;
    stopBtn.disabled = true;
    const r = await ctx.act('Stop Friday', () => ctx.api.stopDaemon(), 'Friday is stopping');
    if (!td.done && !r) stopBtn.disabled = false;
  }
  const friday = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-friday' },
    h('h3', { class: 'section-title' }, 'Friday'),
    h(
      'div',
      { class: 'row pn-worktrees' },
      h('span', null, 'Worktrees in use: ', worktreesCount),
      h('span', { class: 'spacer' }),
      cleanBtn,
    ),
    note('Each running attempt works in its own worktree; a released one is kept until it is cleaned up.'),
    inBrowser
      ? note(
          'This page signed in with a one-time link; the session ends after 12 hours, when Friday restarts, or when you log out.',
        )
      : null,
    h(
      'div',
      { class: 'pn-actions pn-actions-start' },
      desktop?.restartBtn ?? null,
      inBrowser ? logoutBtn : null,
      stopBtn,
    ),
  );

  // ---- about: the address and the folder that left the header (review §6), and the versions
  const aboutBox = h('dl', { class: 'pn-kv' });
  function renderAbout() {
    const b = ctx.store.select('board');
    const p = b?.project;
    replace(
      aboutBox,
      h('dt', null, 'Friday'),
      h('dd', null, p ? plain(p.daemon_version, 40) : '—'),
      h('dt', null, 'Interface'),
      h(
        'dd',
        null,
        `${UI_VERSION} · API ${UI_API}${b && b.ui_api !== UI_API ? ` (Friday speaks ${String(b.ui_api)})` : ''}`,
      ),
      h('dt', null, 'Project'),
      h('dd', null, p ? visible(plain(p.name, 120)) : '—'),
      h('dt', null, 'Folder'),
      h('dd', { class: 'mono' }, p ? visible(p.root) : '—'),
      h('dt', null, 'Address'),
      h('dd', { class: 'mono' }, p ? `127.0.0.1:${p.port}` : '—'),
      h('dt', null, 'Worktrees in use'),
      h('dd', null, String(worktreesInUse(b))),
    );
  }
  const about = h(
    'section',
    { class: 'pn-section', id: 'pn-settings-about' },
    h('h3', { class: 'section-title' }, 'About'),
    aboutBox,
  );

  const sections: Record<SettingsSection, HTMLElement | null> = {
    notifications,
    sound,
    look,
    planner,
    routing,
    policy,
    friday,
    desktop: desktop?.section ?? null,
    about,
  };
  const el = panel('pn-settings', ...SETTINGS_SECTIONS.map((s) => sections[s]));

  renderPlanner();
  renderWorktrees();
  renderAbout();
  void loadPolicy();
  pins.load();
  td.add(
    ctx.store.subscribe('board', () => {
      renderPlanner();
      renderWorktrees();
      renderAbout();
    }),
  );
  const target = request.tab ? (sections[request.tab as SettingsSection] ?? null) : null;
  if (target) {
    queueMicrotask(() => {
      if (!td.done && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
    });
  }

  return {
    title: 'Settings',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
