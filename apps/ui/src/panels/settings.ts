/**
 * Settings (plan §7.10): sound, notifications, motion, the mascot's outfit, Notch timings and
 * finished goals (written to `prefs`, which the shell persists); the planner's state with the exact
 * terminal steps (a key and spending consent never pass through the browser, FD-26); the policy's
 * loosening and Trust (sending exactly the hash shown); logging out; stopping Friday; about.
 */
import type { BrainStatusView } from '@friday/protocol';
import type { PolicyView } from '../api/client.js';
import { visible } from '../model/text.js';
import { clearSession } from '../platform/session.js';
import {
  type AppContext,
  type Component,
  type DesktopCommands,
  type DesktopShortcut,
  type DrawerRequest,
  openDrawer,
} from '../shell/context.js';
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
  input,
  linkButton,
  note,
  panel,
  plain,
  plannerState,
  projectPath,
  segmented,
  select,
  Teardown,
} from './common.js';

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

/** What each desktop shortcut does (the shell's ids, FD-16). */
const SHORTCUT_LABELS: Record<string, string> = {
  notch: 'Open the Notch and give it the keyboard',
  studio: 'Show the Studio',
  halt: 'Open the halt dialog',
};

/** The desktop app's section: its global shortcuts, each changeable, and a restart of Friday. */
function desktopSection(ctx: AppContext, desktop: DesktopCommands, td: Teardown): HTMLElement {
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
    // The shell asks natively first; the page reads the board again once Friday is back.
    await ctx.act('Restart Friday', () => desktop.restart(), 'Friday is restarting');
    if (!td.done) restartBtn.disabled = false;
  }
  return h(
    'section',
    { class: 'pn-section' },
    h('h3', { class: 'section-title' }, 'Desktop app'),
    note('Shortcuts work anywhere in Windows while the app runs, for example Ctrl+Alt+Shift+F.'),
    list,
    h('div', { class: 'pn-actions pn-actions-start' }, restartBtn),
  );
}

export function settingsDrawer(ctx: AppContext, request: DrawerRequest): Component & { title: string } {
  const td = new Teardown();
  const prefs = () => ctx.store.select('prefs');
  const set = (changes: Partial<Prefs>) => ctx.store.patch('prefs', changes);

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
    { class: 'pn-section' },
    h('h3', { class: 'section-title' }, 'Sound'),
    checkbox('Play sounds', !prefs().muted, (on) => set({ muted: !on })),
    field('Volume', volume).el,
  );

  // ---- notifications
  const notifyState = h('div', { class: 'field-hint', aria: { live: 'polite' } });
  const notifyBox = checkbox(
    'Notify me while this tab is hidden',
    prefs().notifications,
    (on) => void setNotifications(on),
  );
  const notifyInput = notifyBox.querySelector('input') as HTMLInputElement;
  async function setNotifications(on: boolean) {
    notifyState.textContent = '';
    if (!on) {
      set({ notifications: false });
      return;
    }
    const api = (globalThis as { Notification?: { requestPermission?: () => Promise<string>; permission?: string } })
      .Notification;
    if (!api || typeof api.requestPermission !== 'function') {
      notifyInput.checked = false;
      set({ notifications: false });
      notifyState.textContent = 'This browser has no notifications.';
      return;
    }
    let result = 'default';
    try {
      result = await api.requestPermission();
    } catch {
      result = 'denied';
    }
    if (td.done) return;
    if (result === 'granted') {
      set({ notifications: true });
      notifyState.textContent =
        'Friday notifies you of approvals, questions, plans, blocked agents and failures while the tab is hidden.';
    } else {
      notifyInput.checked = false;
      set({ notifications: false });
      notifyState.textContent =
        result === 'denied'
          ? 'The browser refused notifications for this page; allow them in its site settings, then turn this on again.'
          : 'The browser did not allow notifications; turn this on again to be asked once more.';
    }
  }
  const notifications = h(
    'section',
    { class: 'pn-section' },
    h('h3', { class: 'section-title' }, 'Notifications'),
    notifyBox,
    notifyState,
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
  const look = h(
    'section',
    { class: 'pn-section' },
    h('h3', { class: 'section-title' }, 'Look and Notch'),
    h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Reduced motion'), motion),
    field('Mascot outfit', outfit).el,
    h(
      'div',
      { class: 'pn-grid2' },
      field('Fold the Notch after (seconds)', collapse, { hint: 'once the pointer leaves an open card' }).el,
      field('Hide the Notch after (seconds)', hide, { hint: 'idle time before the pill becomes a strip' }).el,
    ),
    checkbox('Show finished goals on the board', prefs().showFinished, (on) => set({ showFinished: on })),
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
  const fixBox = h(
    'div',
    { class: 'pn-planner-fix' },
    note(
      'You can always write plans yourself. To let the Master Brain plan, run these in a terminal in the project folder:',
    ),
    ctx.platform.kind === 'tauri'
      ? note('The desktop app can also do the first two steps with its own dialogs.')
      : null,
    field('Daily budget (USD) for the command below', budgetInput).el,
    stepsBox,
    h('div', { class: 'pn-actions pn-actions-start' }, openConfig),
  );
  function renderSteps() {
    const board = ctx.store.select('board');
    const root = board?.project.root ?? '';
    replace(
      stepsBox,
      root ? h('li', null, 'Go to the project folder:', copyLine(ctx, `cd "${root}"`, 'folder command')) : null,
      plannerSteps(board?.brain ?? null, budget).map((s) =>
        h('li', null, s.text, s.command ? copyLine(ctx, s.command) : null),
      ),
    );
    openConfig.disabled = !root;
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
  const policy = h('section', { class: 'pn-section' }, h('h3', { class: 'section-title' }, 'Policy'), policyBox);

  // ---- session and Friday
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
  const session =
    ctx.platform.kind === 'browser'
      ? h(
          'section',
          { class: 'pn-section' },
          h('h3', { class: 'section-title' }, 'Session'),
          note(
            'This page signed in with a one-time link; the session ends after 12 hours, when Friday restarts, or when you log out.',
          ),
          logoutBtn,
        )
      : null;

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
  const friday = h('section', { class: 'pn-section' }, h('h3', { class: 'section-title' }, 'Friday'), stopBtn);

  // ---- the desktop app: its global shortcuts and a restart (plan §8.6)
  const desktop = ctx.platform.desktop ? desktopSection(ctx, ctx.platform.desktop, td) : null;

  // ---- about
  const aboutBox = h('dl', { class: 'pn-kv' });
  function renderAbout() {
    const p = ctx.store.select('board')?.project;
    const b = ctx.store.select('board');
    replace(
      aboutBox,
      h('dt', null, 'Friday'),
      h('dd', null, p ? plain(p.daemon_version, 40) : '—'),
      h('dt', null, 'Project'),
      h('dd', null, p ? plain(p.name, 120) : '—'),
      h('dt', null, 'Folder'),
      h('dd', { class: 'mono' }, p ? visible(p.root) : '—'),
      h('dt', null, 'Address'),
      h('dd', { class: 'mono' }, p ? `127.0.0.1:${p.port}` : '—'),
      h('dt', null, 'Interface API'),
      h('dd', null, b ? String(b.ui_api) : '—'),
    );
  }
  const about = h('section', { class: 'pn-section' }, h('h3', { class: 'section-title' }, 'About'), aboutBox);

  const routing = h(
    'section',
    { class: 'pn-section' },
    h('h3', { class: 'section-title' }, 'Routing'),
    note('Friday picks each task’s model from routing; a pin steers a role, a task or a kind of task to one model.'),
    linkButton('Open routing pins', () => openDrawer(ctx, { kind: 'agents', tab: 'pins' })),
  );

  const el = panel(
    'pn-settings',
    sound,
    notifications,
    look,
    planner,
    routing,
    policy,
    session,
    friday,
    desktop,
    about,
  );

  renderPlanner();
  renderAbout();
  void loadPolicy();
  td.add(
    ctx.store.subscribe('board', () => {
      renderPlanner();
      renderAbout();
    }),
  );
  if (request.tab === 'planner') {
    queueMicrotask(() => {
      if (!td.done && typeof planner.scrollIntoView === 'function') planner.scrollIntoView({ block: 'start' });
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
