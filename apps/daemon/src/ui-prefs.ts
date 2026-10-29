import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { type ProjectRef, privateDirFor, writePrivateFile } from '@friday/sdk';
import type { FridayState } from '@friday/state';

/**
 * The interface's preferences, kept per project (docs/frontend/PLAN.md §6 rule 8): mute, volume,
 * motion, outfit, node positions, and `saved_at`, when the page saved them (ms), so that the page
 * keeps whichever of its own copy and this one is newer. A browser's `localStorage` belongs to an
 * origin, and the origin changes with Friday's port at every start, so the daemon keeps the
 * project's copy in its private folder (user-only), where every start finds it. Notifications are
 * not among them: a browser's permission to show them belongs to the origin.
 *
 * The daemon does not interpret them (the page checks every field when it reads them back); it
 * only bounds them: a JSON object of at most 64 KB, nested at most six deep, with anything that
 * looks like a credential masked before it is written. Preferences never hold one.
 */

export const UI_PREFS_FILE = 'ui-prefs.json';
export const UI_PREFS_MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 6;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** True when `v` holds objects or arrays nested deeper than `MAX_DEPTH` (stops looking there). */
function tooDeep(v: unknown, level = 1): boolean {
  if (!v || typeof v !== 'object') return false;
  if (level > MAX_DEPTH) return true;
  for (const x of Object.values(v)) if (tooDeep(x, level + 1)) return true;
  return false;
}

export class UiPrefs {
  constructor(
    private readonly privateDir: string,
    private readonly redactor: Pick<FridayState['redactor'], 'redact'>,
  ) {}

  /** The project's store under the per-user state folder `stateDir`: its private folder, as the daemon's. */
  static forProject(project: Pick<ProjectRef, 'project_key'>, stateDir: string, state: FridayState): UiPrefs {
    return new UiPrefs(privateDirFor(project, { FRIDAY_STATE_DIR: stateDir }), state.redactor);
  }

  /** The saved preferences; null before the first save, and for a file that is unreadable or too large. */
  read(): Record<string, unknown> | null {
    const file = path.join(this.privateDir, UI_PREFS_FILE);
    try {
      if (statSync(file).size > UI_PREFS_MAX_BYTES) return null;
      const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return isObject(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** Replaces the saved preferences; refuses anything but a bounded JSON object. */
  write(prefs: unknown): void {
    if (!isObject(prefs)) throw new FridayError('invalid_request', 'prefs must be a JSON object');
    if (tooDeep(prefs)) throw new FridayError('invalid_request', `prefs may nest at most ${MAX_DEPTH} levels`);
    const text = `${JSON.stringify(this.redactor.redact(prefs).value)}\n`;
    if (Buffer.byteLength(text) > UI_PREFS_MAX_BYTES) {
      throw new FridayError('payload_too_large', 'the preferences exceed 64 KB');
    }
    writePrivateFile(this.privateDir, UI_PREFS_FILE, text);
  }
}
