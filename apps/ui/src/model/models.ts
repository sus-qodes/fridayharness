/**
 * Models as a person chooses them (2026-11-17): a name in place of an id, only the models an agent
 * they can start could run, and a sensible one first.
 *
 * Before, every picker listed all of the catalog's ids as they are written (`z-ai/glm-5.3`,
 * `deepseek-flash`, …), most of which no agent on the machine could ever run, with the dearest
 * model first and so preselected.
 */

/** A model as `GET models` lists it; only `id` is certain. */
export interface ModelInfo {
  id: string;
  provider?: string | null;
  /** The hosts that can run it (`claude-code`, `codex`, …). */
  vendors?: readonly string[] | null;
  local?: boolean | null;
  /** `seed`: from Friday's catalog. `project`: one the project declared itself. */
  source?: string | null;
  price?: { input: number; output: number } | null;
}

/**
 * The hosts Friday starts agents of and gives a model to: a choice of model applies to their work.
 * An agent a person runs in their own editor (Antigravity, Claude Code in VS Code) chooses its own.
 */
export const MODEL_HOSTS: readonly string[] = ['claude-code', 'codex'];

const HOST_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor CLI',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  generic: 'a custom agent',
};

/** A host by the name its app goes under. */
export function hostLabel(host: string): string {
  return HOST_LABEL[host] ?? host;
}

/** The names of the models Friday ships, in the order they are offered: the everyday one first. */
const NAMES: readonly (readonly [id: string, name: string])[] = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  ['claude-fable-5-2', 'Claude Fable 5.2'],
  ['claude-fable-5-1', 'Claude Fable 5.1'],
  ['openai/gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['openai/gpt-6-astra', 'GPT-6 Astra'],
  ['openai/gpt-6-luna', 'GPT-6 Luna'],
  ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ['gemini-4-argon', 'Gemini 4 Argon'],
  ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
];
const NAME = new Map(NAMES);
const PLACE = new Map(NAMES.map(([id], i) => [id, i]));

/** A model's name; its id as it is for one this page does not know. */
export function modelName(id: string): string {
  return NAME.get(id) ?? id;
}

/** The first host of `MODEL_HOSTS` that runs the model, or null. */
export function modelHost(m: ModelInfo): string | null {
  return MODEL_HOSTS.find((h) => (m.vendors ?? []).includes(h)) ?? null;
}

/** "Claude Sonnet 5.5 (Claude Code)": the model, and the app that runs it. */
export function modelLabel(m: ModelInfo): string {
  const host = modelHost(m);
  return host ? `${modelName(m.id)} (${hostLabel(host)})` : modelName(m.id);
}

/**
 * The models worth offering: those an agent Friday starts can run, and any the project declared
 * itself (its own record is its own business). Claude Code's first, each host's everyday model
 * before its dearer ones, an unknown one last by name.
 */
export function usableModels(models: readonly ModelInfo[] | null | undefined): ModelInfo[] {
  const seen = new Set<string>();
  const out = (models ?? []).filter((m) => {
    if (typeof m?.id !== 'string' || !m.id || seen.has(m.id)) return false;
    seen.add(m.id);
    return modelHost(m) !== null || m.source === 'project';
  });
  const hostPlace = (m: ModelInfo) => {
    const i = MODEL_HOSTS.indexOf(modelHost(m) ?? '');
    return i < 0 ? MODEL_HOSTS.length : i;
  };
  return out.sort(
    (a, b) =>
      hostPlace(a) - hostPlace(b) ||
      (PLACE.get(a.id) ?? NAMES.length) - (PLACE.get(b.id) ?? NAMES.length) ||
      a.id.localeCompare(b.id),
  );
}

/** The model a picker opens on: the first of `usableModels`, which is the everyday one. */
export function defaultModel(models: readonly ModelInfo[] | null | undefined): string {
  return usableModels(models)[0]?.id ?? '';
}
