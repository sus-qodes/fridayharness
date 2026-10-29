/**
 * What `friday harness config gemini` writes into a project (plan M8b.4), and the deny rules each
 * spawned session runs with. Nothing here holds a token, a port or a machine path: every file is
 * safe to commit.
 */
import { SPAWN_RUN_ENV } from '@friday/adapter-claude';

/** Where Friday's own Gemini CLI files live, relative to the project's root. */
export const GEMINI_HARNESS_DIR = '.friday/harness/gemini';
export const GEMINI_HOOK_FILE = `${GEMINI_HARNESS_DIR}/hook.mjs`;
export const GEMINI_LAUNCH_MCP_FILE = `${GEMINI_HARNESS_DIR}/launch-mcp.mjs`;

/** The name every Friday hook carries in `.gemini/settings.json` (`hooksConfig.disabled` matches it). */
export const GEMINI_HOOK_NAME = 'friday';

/**
 * The Gemini CLI events Friday hooks, each with its timeout in milliseconds, above the launcher's
 * own budget for the Friday event it becomes (4 s for a tool call, 12 s for a session start, 2 s
 * for a session end, 8 s otherwise), so the launcher always answers before the host gives up.
 */
export const GEMINI_HOOK_EVENTS = [
  { event: 'SessionStart', friday: 'SessionStart', timeout: 15_000 },
  { event: 'BeforeTool', friday: 'PreToolUse', timeout: 5000, matcher: '.*' },
  { event: 'AfterTool', friday: 'PostToolUse', timeout: 10_000 },
  { event: 'AfterAgent', friday: 'Stop', timeout: 10_000 },
  { event: 'SessionEnd', friday: 'SessionEnd', timeout: 3000 },
] as const;

/**
 * The command Gemini CLI runs for an event. The host has no exec form: it runs the string through
 * PowerShell on Windows (bash elsewhere), in the session's working folder, which is the folder it
 * read `.gemini/settings.json` from. A path relative to that folder needs no quoting in either
 * shell. `$GEMINI_PROJECT_DIR` names the same folder, but the host substitutes it quoted (every
 * Windows path holds a colon and backslashes), and Windows PowerShell 5.1 passes a quoted string
 * followed by more text as two arguments, so `node $GEMINI_PROJECT_DIR/.friday/...` hands node the
 * folder alone and never reaches the launcher (checked on this machine, 2026-10-18).
 */
export function geminiHookCommand(event: string): string {
  return `node ${GEMINI_HOOK_FILE} gemini ${event}`;
}

/** Friday's hook groups in `.gemini/settings.json` `hooks`, by Gemini CLI event. */
export function geminiHooks(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const e of GEMINI_HOOK_EVENTS) {
    out[e.event] = [
      {
        ...('matcher' in e ? { matcher: e.matcher } : {}),
        hooks: [
          {
            type: 'command',
            name: GEMINI_HOOK_NAME,
            command: geminiHookCommand(e.event),
            timeout: e.timeout,
            description: e.event === 'BeforeTool' ? "Friday's policy check" : `Friday: ${e.event}`,
          },
        ],
      },
    ];
  }
  return out;
}

/**
 * The `friday` server in `.gemini/settings.json` `mcpServers`. `trust` skips Gemini CLI's own
 * confirmation for Friday's tools, as `friday harness config claude-code` allows `mcp__friday`:
 * the protocol behind them judges every call, and Friday's hooks give them no decision.
 */
export const GEMINI_MCP_ENTRY = {
  command: 'node',
  args: [GEMINI_LAUNCH_MCP_FILE],
  env: { FRIDAY_HARNESS: 'gemini' },
  trust: true,
};

/** `.friday/harness/gemini/launch-mcp.mjs`: tracked, machine-neutral, no secrets. */
export const GEMINI_LAUNCH_MCP = `#!/usr/bin/env node
// Friday MCP launcher, written by "friday harness config gemini". Safe to commit:
// it holds no paths or secrets. It finds this machine's Friday install via "friday setup".
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.${SPAWN_RUN_ENV}) {
  process.stderr.write('[friday] This session was started by Friday, which gives it Friday\\'s tools itself.\\n');
  process.exit(0);
}
const stateDir =
  process.env.FRIDAY_STATE_DIR ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Friday')
    : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'friday'));
let entry = process.env.FRIDAY_MCP_ENTRY;
if (!entry) {
  try {
    entry = JSON.parse(readFileSync(path.join(stateDir, 'install.json'), 'utf8')).mcp_server_entry;
  } catch {
    entry = undefined;
  }
}
if (!entry || !existsSync(entry)) {
  process.stderr.write('[friday] Friday is not set up on this machine. Run "friday setup" (after building Friday), then restart Gemini CLI.\\n');
  process.exit(1);
}
// The project is the one this file belongs to (<project>/.friday/harness/gemini), whichever folder
// Gemini CLI started the server in. A Claude Code session the terminal runs in is not this one.
process.env.FRIDAY_PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_CODE_SESSION_ID;
process.env.FRIDAY_HOST_PID ??= String(process.ppid);
await import(pathToFileURL(entry).href);
`;

export const GEMINI_HARNESS_README = `# Friday harness files for Gemini CLI

Written by \`friday harness config gemini\`. These files are safe to commit: they contain
no secrets and no machine-specific paths.

- \`hook.mjs\`: Friday's hook launcher. Gemini CLI runs it for the hooks in \`.gemini/settings.json\`.
  It checks every tool call against Friday's policy before it runs.
- \`launch-mcp.mjs\`: starts the \`friday\` MCP server from this machine's Friday install.

Start Gemini CLI from the project's root folder: it reads \`.gemini/settings.json\` only from the
folder it starts in. Remove everything Friday added with \`friday harness config gemini --remove\`.
`;

/** The block Friday keeps in `GEMINI.md`, which Gemini CLI loads into every session. */
export const GEMINI_MD_BLOCK = `<!-- friday:begin -->
## Friday
This repository is coordinated by Friday. Use the \`friday_*\` tools: start with \`friday_whoami\`,
claim a task before editing, stay in its scope, report progress, and finish with
\`friday_claim_done\` (a claim that Friday verifies). Friday's hooks decide each tool call: a
refused call is Friday's decision, so do not try it another way.
<!-- friday:end -->`;

/**
 * Tools a spawned session does not get (`--policy`, decision `deny`): each is one Friday cannot
 * judge before it acts. Every other tool call passes Friday's `BeforeTool` hook. A global deny
 * rule also keeps the tool out of what the model is offered.
 */
export const SPAWN_DENIED_TOOLS: readonly { tool: string; why: string }[] = [
  { tool: 'invoke_agent', why: 'delegates to a subagent, outside Friday' },
  { tool: 'codebase_investigator', why: 'a built-in subagent, outside Friday' },
  { tool: 'generalist', why: 'a built-in subagent, outside Friday' },
  { tool: 'cli_help', why: 'a built-in subagent, outside Friday' },
  { tool: 'ask_user', why: 'no human is in the session: the agent ends as blocked and Friday asks one' },
  { tool: 'save_memory', why: "writes the user's Gemini memory, outside the task's worktree" },
  { tool: 'activate_skill', why: 'loads instructions Friday does not see' },
  {
    tool: 'mcp_*',
    why: "the session runs only Friday's own server; another server's tool would act outside the task",
  },
];

/**
 * The policy file of a spawned session: Friday's deny rules, in Gemini CLI's TOML format, and one
 * rule above them that keeps Friday's own server (`friday`, the attempt's tools) in: the host
 * takes the highest-priority rule that matches a tool.
 */
export function spawnPolicyToml(): string {
  const lines = [
    "# Friday's rules for one Gemini CLI session its spawn adapter started (plan M8b.4).",
    "# Friday's BeforeTool hook judges every other tool call; these tools it cannot judge",
    '# before they act, so the session does not get them. Removed when the attempt ends.',
    '',
    "# Friday's tools for this attempt (ADR-0032 §8): the protocol behind each judges it.",
    '[[rule]]',
    'mcpName = "friday"',
    'decision = "allow"',
    'priority = 950',
  ];
  for (const r of SPAWN_DENIED_TOOLS) {
    lines.push(
      '',
      `# ${r.why}`,
      '[[rule]]',
      `toolName = ${JSON.stringify(r.tool)}`,
      'decision = "deny"',
      'priority = 900',
    );
  }
  return `${lines.join('\n')}\n`;
}
