/**
 * The routing pins (plan §7.10, review decision 2): a pin steers a role, a task or a kind of task
 * to one model. Dispatch itself is the static role registry; pins beat registry rank. Settings →
 * Routing is their home; the Agents drawer no longer shows them.
 */
import type { RoutingPinView } from '@friday/protocol';
import { TASK_KIND } from '../model/status.js';
import { visible } from '../model/text.js';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { humanize, timeAgo, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { badge, errorOf, field, input, plain, select, type Teardown } from './common.js';

export type PinScope = 'role' | 'task' | 'kind';

export interface RoutingPins {
  /** The dispatch line, the pins list and the pin form, in this order. */
  el: HTMLElement;
  /** Reads the pins and the models. */
  load(): void;
}

export function routingPins(ctx: AppContext, td: Teardown): RoutingPins {
  const dispatchLine = h(
    'div',
    { class: 'row pn-routing-mode-line' },
    h('span', { class: 'muted' }, 'Dispatch'),
    badge('static role registry', 'info'),
    h('span', { class: 'muted' }, 'pins beat registry rank; hard constraints come first'),
  );
  const pinsList = h('div', { class: 'pn-pins' }, h('div', { class: 'muted' }, 'Reading the routing pins…'));
  let models: string[] = [];
  const pinForm = h('div', { class: 'pn-pin-form' });
  const pinState: { scope: PinScope; target: string; model: string } = {
    scope: 'role',
    target: 'developer',
    model: '',
  };

  function renderPins(pins: RoutingPinView[]) {
    const live = pins.filter((p) => !p.revoked_at);
    replace(
      pinsList,
      live.length === 0
        ? h('div', { class: 'muted' }, 'No pins: Friday routes by the static role registry.')
        : h(
            'ul',
            { class: 'pn-list' },
            live.map((p) => {
              const marks = [p.sensitive ? 'sensitive' : null, p.needs_vision ? 'needs vision' : null].filter(
                (v): v is string => v !== null,
              );
              const what = p.model ? `→ ${plain(p.model, 80)}` : marks.join(', ');
              return h(
                'li',
                { class: 'pn-item' },
                badge(p.scope, 'info'),
                p.target ? h('span', { class: 'mono' }, visible(truncate(p.target, 80))) : null,
                h('span', { class: 'pn-grow' }, what),
                p.until ? h('span', { class: 'muted' }, `until ${timeAgo(p.until, ctx.now())}`) : null,
                p.note ? h('span', { class: 'muted' }, plain(p.note, 200)) : null,
                button('Unpin', () => void unpin(p), {
                  class: 'btn btn-ghost',
                  ariaLabel: `Unpin the ${p.scope} pin${p.target ? ` for ${visible(p.target)}` : ''}`,
                }),
              );
            }),
          ),
    );
  }

  async function loadPins() {
    try {
      const r = await ctx.api.pins();
      if (td.done) return;
      renderPins(Array.isArray(r?.pins) ? r.pins : []);
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      replace(
        pinsList,
        h(
          'div',
          { class: 'field-error' },
          `Could not read the pins: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`,
        ),
      );
    }
  }

  async function unpin(p: RoutingPinView) {
    const r = await ctx.act('Unpin', () => ctx.api.unpin(p.pin_id), 'Unpinned');
    if (r && !td.done) void loadPins();
  }

  function renderPinForm() {
    const board = ctx.store.select('board');
    const scope = select<PinScope>(
      [
        { value: 'role', label: 'A role' },
        { value: 'task', label: 'A task' },
        { value: 'kind', label: 'A kind of task' },
      ],
      pinState.scope,
      (v) => {
        pinState.scope = v;
        pinState.target =
          v === 'role'
            ? 'developer'
            : v === 'kind'
              ? 'implementation'
              : (board?.tasks.find((t) => !['COMPLETED', 'CANCELLED'].includes(t.status))?.task_id ?? '');
        renderPinForm();
      },
    );
    let target: HTMLElement;
    if (pinState.scope === 'kind') {
      target = select(
        Object.keys(TASK_KIND).map((k) => ({ value: k, label: humanize(k) })),
        pinState.target,
        (v) => {
          pinState.target = v;
        },
      );
    } else if (pinState.scope === 'task') {
      const tasks = (board?.tasks ?? []).filter((t) => !['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(t.status));
      target = select(
        tasks.length
          ? tasks.map((t) => ({ value: t.task_id, label: truncate(plain(t.summary, 80), 70) }))
          : [{ value: '', label: 'No open task', disabled: true }],
        pinState.target,
        (v) => {
          pinState.target = v;
        },
      );
    } else {
      const box = input({ class: 'input mono', value: pinState.target, maxLength: 32, placeholder: 'developer' });
      box.addEventListener('input', () => {
        pinState.target = box.value.trim();
      });
      target = box;
    }
    if (!pinState.model && models[0]) pinState.model = models[0];
    const model = select(
      models.length
        ? models.map((m) => ({ value: m, label: m }))
        : [{ value: '', label: 'No models known', disabled: true }],
      pinState.model,
      (v) => {
        pinState.model = v;
      },
    );
    const pinBtn = button([icon('plus', 14), 'Pin'], () => void addPin(), {
      class: 'btn',
      disabled: models.length === 0,
    });
    replace(
      pinForm,
      h('div', { class: 'pn-grid3' }, field('Pin for', scope).el, field('Which', target).el, field('Model', model).el),
      h('div', { class: 'pn-actions pn-actions-start' }, pinBtn),
    );
  }

  async function addPin() {
    if (!pinState.target || !pinState.model) {
      ctx.toast({ kind: 'warn', text: 'Choose what to pin and a model' });
      return;
    }
    const r = await ctx.act(
      'Pin a model',
      () => ctx.api.pin({ scope: pinState.scope, target: pinState.target, model: pinState.model }),
      `Pinned ${pinState.model}`,
    );
    if (r && !td.done) void loadPins();
  }

  // One answer lists the models for the pin form.
  async function loadModels() {
    try {
      const r = await ctx.api.models();
      if (td.done) return;
      models = (Array.isArray(r?.models) ? r.models : [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string');
    } catch {
      models = [];
    }
    if (td.done) return;
    renderPinForm();
  }

  renderPinForm();
  return {
    el: h('div', { class: 'pn-routing' }, dispatchLine, pinsList, pinForm),
    load() {
      void loadPins();
      void loadModels();
    },
  };
}
