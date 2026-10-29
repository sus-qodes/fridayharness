/**
 * What the live checks of the installed Claude Code share (`tests/scenarios/claude-spawn.live.test.ts`,
 * `tests/scenarios/token-baseline.live.test.ts`): the shape of a stream-json line, the redaction of
 * what is saved, and a look at what the owner's Claude configuration records.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Msg = Record<string, unknown> & { type?: string; subtype?: string; message?: { content?: unknown } };

/** What the owner's Claude configuration records: its folders, and its session folders (names only). */
export function claudeState(): { projects: string[]; sessions: string[] } {
  const home = os.homedir();
  let projects: string[] = [];
  try {
    const json = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')) as { projects?: object };
    projects = Object.keys(json.projects ?? {});
  } catch {
    projects = [];
  }
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  return { projects, sessions: existsSync(dir) ? readdirSync(dir) : [] };
}

/** Machine paths and account data out of what is saved, keys included. */
export function sanitize(v: unknown, swaps: [string, string][]): unknown {
  const clean = (s: string) => {
    let t = s;
    for (const [from, to] of swaps) t = t.split(from).join(to).split(from.toLowerCase()).join(to);
    // Anthropic's request and message ids point at the owner's requests.
    return t.replace(/\breq_[A-Za-z0-9]{8,}/g, 'req_<id>').replace(/\bmsg_[A-Za-z0-9]{8,}/g, 'msg_<id>');
  };
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return v.map((x) => sanitize(x, swaps));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !/email|account|organization|apiKeySource|rate_limit/i.test(k))
        .map(([k, x]) => [clean(k), sanitize(x, swaps)]),
    );
  }
  return v;
}

/**
 * The replacements that take the test workspace, the home folder and the user name out of what is
 * saved. The user name also appears outside paths (owner columns of `ls -l`, folder names Claude
 * Code derives from paths), so it goes last; a name too short to tell from other text is left.
 */
export function redactionSwaps(workspaceRoot: string): [string, string][] {
  const user = path.basename(os.homedir());
  return [
    [workspaceRoot, '<workspace>'],
    [os.homedir(), '<home>'],
    ...(user.length >= 3 ? [[user, '<user>'] as [string, string]] : []),
  ];
}
