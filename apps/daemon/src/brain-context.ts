import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import type { Redactor } from '@friday/events';
import { canonicalize, sensitiveClassOf } from '@friday/policy';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';

const MAX_FILES = 400;
const MAX_DOC_CHARS = 6000;
const MAX_TOTAL = 60_000;

function git(root: string, args: string[]): string | null {
  try {
    // Never take git's optional index lock: an agent may be committing in the same checkout (M4a).
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    }).trimEnd();
  } catch {
    return null;
  }
}

/** Where a document came from and why it was or was not sent (for logs and tests). */
export interface ContextSource {
  path: string;
  included: boolean;
  reason: string;
}

/**
 * Reads one repository document for the planner, only when it is safe to send (review F03): a
 * regular file whose real path stays inside the project, not a protected file, at most
 * `MAX_DOC_CHARS` read from disk.
 */
function doc(root: string, rel: string, stateDir: string | undefined): { text: string | null; source: ContextSource } {
  const file = path.join(root, rel);
  const skip = (reason: string) => ({ text: null, source: { path: rel, included: false, reason } });
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return skip('absent');
  }
  const c = canonicalize(file, { projectRoot: root, ...(stateDir ? { stateDir } : {}) });
  if (c.linked && c.realRelative === null) return skip(`links outside the project (${c.real})`);
  const hit = sensitiveClassOf(file, { projectRoot: root, ...(stateDir ? { stateDir } : {}) }, 'read');
  if (hit) return skip(`protected (${hit.class})`);
  if (!st.isFile() && !st.isSymbolicLink()) return skip('not a regular file');
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_DOC_CHARS * 4);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const cut = text.length > MAX_DOC_CHARS || n === buf.length;
      return {
        text: cut ? `${text.slice(0, MAX_DOC_CHARS)}\n…(truncated)` : text,
        source: { path: rel, included: true, reason: c.linked ? `link to ${c.realRelative}` : 'repository document' },
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return skip('unreadable');
  }
}

export interface BrainContextOptions {
  /** Masks known credentials and the daemon's own tokens in everything sent out (review F03). */
  redactor: Redactor;
  /** Friday's per-user state directory: never read, also not through a link. */
  stateDir?: string;
  /** Receives what was included and skipped. */
  onSources?: (sources: ContextSource[]) => void;
}

/**
 * The stable part of the Master Brain's context (spec Part 03 §3, M1 compiler level until M4):
 * repository layout and history, the project's own docs and decisions, configured scopes,
 * checks and reservations, and the agents' roles. It is sent first and cached by the provider,
 * so it holds nothing that changes with every event (task states go in the per-call prompt).
 *
 * This is the outbound boundary for planning (review F03): every part is bounded, documents are
 * read only through real paths inside the project and never from protected locations, and the
 * whole text passes the event redactor before it can leave the machine. The provider then marks
 * it as untrusted source material below Friday's own rules.
 */
export function buildBrainContext(state: FridayState, project: ProjectRef, opts: BrainContextOptions): string {
  const root = project.root;
  const cfg = project.config;
  const parts: string[] = [`# Project "${project.name}" (${project.project_id})`];
  const sources: ContextSource[] = [];

  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  const log = git(root, ['log', '-8', '--format=%h %s']);
  const files = (git(root, ['ls-files']) ?? '').split('\n').filter(Boolean);
  parts.push(
    head ? `## Repository\nHEAD ${head}\nRecent commits:\n${log ?? ''}` : '## Repository\nNo git history is available.',
  );
  if (files.length) {
    const shown = files.slice(0, MAX_FILES);
    parts.push(
      `## Tracked files (${files.length}${files.length > MAX_FILES ? `, first ${MAX_FILES}` : ''})\n${shown.join('\n')}`,
    );
  }
  for (const rel of [
    'README.md',
    'DECISIONS.md',
    'docs/DECISIONS.md',
    'ARCHITECTURE.md',
    'docs/ARCHITECTURE.md',
    'CLAUDE.md',
  ]) {
    const { text, source } = doc(root, rel, opts.stateDir);
    if (source.reason !== 'absent') sources.push(source);
    if (text) parts.push(`## ${rel}\n${text}`);
  }

  const scopes = Object.entries(cfg.scopes);
  if (scopes.length) {
    parts.push(
      `## Named scopes (.friday/config.yaml)\n${scopes.map(([name, s]) => `- ${name}: write ${s.write.join(', ') || '(none)'}; read ${s.read.join(', ') || '(any)'}`).join('\n')}`,
    );
  }
  if (cfg.verification.checks.length) {
    parts.push(
      `## Verification checks (run by "friday verify")\n${cfg.verification.checks.map((c) => `- ${c.name} (${c.kind}): ${[c.command, ...c.args].join(' ')}`).join('\n')}`,
    );
  }
  if (cfg.reservations.required.length) {
    parts.push(
      `## Conflict-prone files (one writer at a time)\n${cfg.reservations.required.map((r) => `- ${r}`).join('\n')}`,
    );
  }
  const agents = state.q.agents(project.project_id).filter((a) => a.status !== 'TERMINATED');
  if (agents.length) {
    const roles = [...new Set(agents.map((a) => `${a.agent_key} (${a.role})`))].sort();
    parts.push(`## Agents that have attached to this project\n${roles.map((r) => `- ${r}`).join('\n')}`);
  }
  opts.onSources?.(sources);
  const joined = parts.join('\n\n');
  const bounded = joined.length > MAX_TOTAL ? `${joined.slice(0, MAX_TOTAL)}\n…(truncated)` : joined;
  return opts.redactor.redactString(bounded).value;
}
