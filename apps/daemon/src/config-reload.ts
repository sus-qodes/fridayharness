import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { ConfigChanges } from '@friday/protocol';
import { changedConfigKeys, configKeyEffect, type FridayConfig, liveConfig, parseConfig } from '@friday/sdk';

/** One application of a changed config.yaml. */
export interface ConfigApplied {
  /** The configuration in force now: live keys from the file, restart-only keys as at start. */
  config: FridayConfig;
  /** The keys whose values changed with this read and are in force now. */
  applied: string[];
  /** Every changed key that keeps its start value until a restart, as the file stands now. */
  restart_needed: string[];
  /** The hash of the file as read (the same hash the board shows). */
  hash: string;
}

export interface ConfigReloader {
  /** The configuration in force; reads the file again when it changed. */
  current(): FridayConfig;
  /** What changed since Friday started, for the board and `friday status`. */
  changes(): ConfigChanges;
}

/** A parse error shown to the human is cut here: the file is theirs, the banner is not a log. */
const ERROR_CHARS = 300;

/**
 * config.yaml read again whenever it changes (plan M11.2), checked each time the daemon uses it, as
 * the policy files are (LESSONS D-43). A valid file applies at once: its live keys replace the
 * configuration in force through `onApply`, and the keys that were captured at start keep their
 * start values and are named as needing a restart. A file that does not parse never drops the
 * configuration in force: while it may be caught half written (it has not stood still for
 * `settleMs`) nothing is said; after that the error is reported until the file is valid again.
 */
export function reloadingConfig(o: {
  file: string;
  initial: FridayConfig;
  onApply: (change: ConfigApplied) => void;
  /** The file as it stands could not be applied; the configuration in force is unchanged. */
  onError?: (error: string) => void;
  /** A stricter check of a parsed file (the routing registry); a throw counts as a parse error. */
  check?: (next: FridayConfig) => void;
  now?: () => number;
  settleMs?: number;
}): ConfigReloader {
  const now = o.now ?? Date.now;
  const settleMs = o.settleMs ?? 1000;
  const started = o.initial;
  let inForce = o.initial;
  let applied: string[] = [];
  let restartNeeded: string[] = [];
  let error: string | null = null;

  /** The file as it is now: its size and modification time, or that it is missing. */
  const fileState = () => {
    try {
      const st = statSync(o.file);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'missing';
    }
  };
  let seen = fileState();
  let changed: { state: string; since: number } | null = null;

  const read = (): { config: FridayConfig; hash: string } => {
    const text = readFileSync(o.file, 'utf8');
    const config = parseConfig(text, 'config.yaml');
    o.check?.(config);
    return { config, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
  };

  return {
    current: () => {
      const state = fileState();
      if (state === seen) return inForce;
      if (changed?.state !== state) changed = { state, since: now() };
      let next: { config: FridayConfig; hash: string };
      try {
        next = read();
      } catch (e) {
        // Possibly caught half written: keep what is in force, and say nothing until it stood still.
        if (now() - changed.since < settleMs) return inForce;
        seen = state;
        changed = null;
        const message = (e as Error).message.slice(0, ERROR_CHARS);
        if (message !== error) {
          error = message;
          o.onError?.(message);
        }
        return inForce;
      }
      seen = state;
      changed = null;
      error = null;
      const config = liveConfig(started, next.config);
      const appliedNow = changedConfigKeys(inForce, config);
      const restart = changedConfigKeys(started, next.config).filter((k) => configKeyEffect(k) === 'restart');
      const restartChanged = restart.join('\n') !== restartNeeded.join('\n');
      inForce = config;
      applied = changedConfigKeys(started, config);
      restartNeeded = restart;
      // A change to comments or whitespace alone changes nothing worth recording.
      if (appliedNow.length || restartChanged) {
        o.onApply({ config, applied: appliedNow, restart_needed: restart, hash: next.hash });
      }
      return inForce;
    },
    changes: () => ({ applied: [...applied], restart_needed: [...restartNeeded], error }),
  };
}
