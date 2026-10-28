import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';

const MAX_FILES = 400;
const MAX_DOC_CHARS = 6000;
const MAX_TOTAL = 60_000;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
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

function doc(root: string, rel: string): string | null {
  const file = path.join(root, rel);
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    return text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…(truncated)` : text;
  } catch {
    return null;
  }
}

/**
 * The stable part of the Master Brain's context (spec Part 03 §3, M1 compiler level until M4):
 * repository layout and history, the project's own docs and decisions, configured scopes,
 * checks and reservations, and the agents' roles. It is sent first and cached by the provider,
 * so it holds nothing that changes with every event (task states go in the per-call prompt).
 */
export function buildBrainContext(state: FridayState, project: ProjectRef): string {
  const root = project.root;
  const cfg = project.config;
  const parts: string[] = [`# Project "${project.name}" (${project.project_id})`];

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
    const text = doc(root, rel);
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
  const text = parts.join('\n\n');
  return text.length > MAX_TOTAL ? `${text.slice(0, MAX_TOTAL)}\n…(truncated)` : text;
}
