/**
 * The planner's model (Settings → Planner, 2026-11-17). Plans were always written by Claude Opus
 * 5.5 unless someone edited `master_brain.model` in config.yaml, a file the team shares; a person
 * who wanted the cheaper Sonnet, or the most capable model for a hard goal, had no way in the app.
 *
 * The choice is kept on this computer, beside how the person plans, since what a plan costs comes
 * out of their own account. It applies from the next plan; nothing restarts.
 */
import type { BrainStatusView } from '@friday/protocol';
import { modelName } from '../model/models.js';
import type { AppContext } from '../shell/context.js';
import { h } from '../ui/dom.js';
import { plain, select } from './common.js';

/** Friday's default, when the project names none (`master_brain.model: auto`). */
export const DEFAULT_PLANNER = 'claude-opus-5-5';

/** "Use the default": no choice of this machine's own. */
export const PLANNER_DEFAULT = '';

/** The models offered, with what each means for a plan's cost beside the default. */
export const PLANNER_MODELS: readonly { id: string; label: string }[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5: about half the cost, and faster' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2: the most capable, about twice the cost' },
];

/** The model that runs when this machine chose none: the project's, or Friday's default for `auto`. */
export function defaultPlannerModel(choice: NonNullable<BrainStatusView['model_choice']>): string {
  return choice.project && choice.project !== 'auto' ? choice.project : DEFAULT_PLANNER;
}

/** The options of the picker: the default first, the models after it, a choice made elsewhere kept. */
export function plannerModelOptions(
  choice: NonNullable<BrainStatusView['model_choice']>,
): { value: string; label: string }[] {
  const standing = defaultPlannerModel(choice);
  const fromProject = choice.project && choice.project !== 'auto';
  const options = [
    {
      value: PLANNER_DEFAULT,
      label: fromProject
        ? `The project’s setting (${modelName(plain(standing, 80))})`
        : `Friday’s default (${modelName(standing)})`,
    },
    // The default is the first line already: listing its model again would be two ways to say one thing.
    ...PLANNER_MODELS.filter((m) => m.id !== standing).map((m) => ({ value: m.id, label: m.label })),
  ];
  if (choice.here && !options.some((o) => o.value === choice.here)) {
    options.push({ value: choice.here, label: modelName(plain(choice.here, 80)) });
  }
  return options;
}

/**
 * The row of the planner page; null where a choice made here would not be the one used (no planner,
 * a model on this computer, an older Friday that does not say).
 */
export function plannerModelRow(ctx: AppContext, brain: BrainStatusView): HTMLElement | null {
  const choice = brain.model_choice;
  if (!choice?.applies) return null;
  const picker = select(plannerModelOptions(choice), choice.here ?? PLANNER_DEFAULT, (value) => {
    picker.disabled = true;
    void ctx
      .act(
        'Choose the planner’s model',
        () => ctx.api.choosePlannerModel(value || null),
        value
          ? `Plans are written by ${modelName(value)} from the next one`
          : `Plans are written by ${modelName(defaultPlannerModel(choice))} again`,
      )
      .then((done) => {
        picker.disabled = false;
        // The page is drawn again from the planner's new status; a refusal puts the old choice back.
        if (done) ctx.refresh();
        else picker.value = choice.here ?? PLANNER_DEFAULT;
      });
  });
  picker.setAttribute('aria-label', 'Planner model');
  return h(
    'div',
    { class: 'hub-row pn-planner-model' },
    h(
      'div',
      { class: 'text' },
      h('span', { class: 'title' }, 'Planner model'),
      h(
        'span',
        { class: 'detail' },
        'Which model writes the plans. Kept on this computer, and used from the next plan.',
      ),
    ),
    picker,
  );
}
