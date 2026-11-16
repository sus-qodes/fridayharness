/**
 * What `friday harness config antigravity` writes into a project (plan M8b.3). Antigravity's App,
 * its CLI `agy` and its IDE read the same workspace files: `.agents/hooks.json`,
 * `.agents/mcp_config.json`, `.agents/skills/` and `AGENTS.md`. Nothing here holds a token, a port
 * or a machine path.
 */
import { LAUNCHER_BUDGET_MS, LAUNCHER_DEFAULT_BUDGET_MS } from '@friday/adapter-claude';

/** The vendor id the launcher takes as its first argument. */
export const VENDOR = 'antigravity';

/** The name of Friday's hook group in `.agents/hooks.json` (the file is an object of named groups). */
export const HOOK_GROUP = 'friday';

/** Where the tracked launcher copy lives, relative to the project root, with forward slashes. */
export const HARNESS_DIR = '.friday/harness/antigravity';
export const HOOK_PATH = `${HARNESS_DIR}/hook.mjs`;
export const LAUNCH_MCP_PATH = `${HARNESS_DIR}/launch-mcp.mjs`;

/**
 * The host events Friday configures, with each hook's timeout in seconds (Antigravity's unit).
 * Each is above the launcher's own budget for its Friday event, so the launcher answers before the
 * host gives up on it: PreToolUse 5 s over 4 s, SessionStart 15 s over 12 s, the rest 10 s over 8 s.
 * PreInvocation and PostInvocation are left out: Friday has nothing to say before each model call.
 */
export const HOOK_TIMEOUTS_S = { SessionStart: 15, PreToolUse: 5, PostToolUse: 10, Stop: 10 } as const;
export type AntigravityHookEvent = keyof typeof HOOK_TIMEOUTS_S;
export const HOOK_EVENTS = Object.keys(HOOK_TIMEOUTS_S) as AntigravityHookEvent[];

/** The launcher budget a host event's hook must outlast (the Friday event it becomes). */
export function launcherBudgetMs(event: AntigravityHookEvent): number {
  return LAUNCHER_BUDGET_MS[event] ?? LAUNCHER_DEFAULT_BUDGET_MS;
}

/**
 * Antigravity's matcher is a regular expression on the tool name, and its hooks page names `*`
 * (like `""`) as "every tool". Every tool is matched, so a tool Friday has no rule for answers
 * nothing, and a new host tool cannot slip past unseen.
 */
export const TOOL_MATCHER = '*';

/**
 * The hook command. Antigravity runs `command` as a shell command and documents no exec form, no
 * variable substitution and no working directory; its own examples use relative paths
 * (`./scripts/lint.sh`) without saying what they are relative to. The words need no quoting in
 * PowerShell, cmd or a POSIX shell.
 *
 * Where it runs, as observed (CLI 1.4.4 on Windows, 2026-11-16): in the folder that holds
 * `hooks.json`, `.agents/`, not in the workspace root, so this path named
 * `.agents/.friday/harness/antigravity/hook.mjs` and every hook ended with "Cannot find module".
 * The command keeps the path from the workspace root and `HOOK_SHIM` answers at the same path from
 * `.agents/`, so it runs from either folder, whichever a surface (the CLI, the App, the IDE) uses.
 */
export const hookCommand = (event: AntigravityHookEvent) => `node ${HOOK_PATH} ${VENDOR} ${event}`;

/** Where the hook command lands when it is run from `.agents/`: the same relative path, one folder down. */
export const HOOK_SHIM_PATH = `.agents/${HOOK_PATH}`;

/**
 * The file at `HOOK_SHIM_PATH`: it runs the tracked launcher, found from this file's own place and
 * not from the working directory. The launcher reads its arguments and standard input as if it had
 * been started itself, and takes the project from the hook's `workspacePaths`.
 */
export const HOOK_SHIM = `// Friday: Antigravity starts hooks in the folder of hooks.json (.agents/), where the hook command's
// path lands on this file. It runs Friday's hook launcher. Written by "friday harness config
// antigravity"; safe to commit, do not edit.
await import('../../../../${HOOK_PATH}');
`;

const handler = (event: AntigravityHookEvent) => ({
  type: 'command',
  command: hookCommand(event),
  timeout: HOOK_TIMEOUTS_S[event],
});

/** Friday's hook group: PreToolUse and PostToolUse take matcher entries, the others a plain list. */
export function fridayHookGroup(): Record<string, unknown> {
  return {
    SessionStart: [handler('SessionStart')],
    PreToolUse: [{ matcher: TOOL_MATCHER, hooks: [handler('PreToolUse')] }],
    PostToolUse: [{ matcher: TOOL_MATCHER, hooks: [handler('PostToolUse')] }],
    Stop: [handler('Stop')],
  };
}

/**
 * The `friday` server in `.agents/mcp_config.json` (stdio). The server must be named `friday`: the
 * launcher leaves Friday's own tools to the protocol behind them by that name. Only documented
 * keys are written (`command`, `args`, `env`).
 */
export const MCP_ENTRY = {
  command: 'node',
  args: [LAUNCH_MCP_PATH],
  env: { FRIDAY_HARNESS: VENDOR },
};

/**
 * Friday's skill. Antigravity turns a workspace skill (`.agents/skills/<folder>/SKILL.md`) into a
 * slash command of its name, so the person types `/friday` instead of a sentence.
 */
export const SKILL_DIR = '.agents/skills/friday';
export const SKILL_PATH = `${SKILL_DIR}/SKILL.md`;

/** The line that marks the skill as Friday's: a skill named friday that the user wrote is left alone. */
export const SKILL_MARKER = '<!-- friday:skill -->';

/**
 * One task for each `/friday`, and it ends by naming what waits next instead of starting it.
 * Antigravity's terms keep a personal account to sessions a person drives: the person's command
 * starts each task, and nothing here loops over a queue or waits for work to arrive.
 */
export const SKILL_MD = `---
name: friday
description: Take and finish the Friday task waiting for this session. Use when the user types /friday, asks what to work on, or says to take, continue or finish their Friday task.
---
${SKILL_MARKER}
# Friday

The user asked you to work on their Friday task. Do this once, for one task.

Friday's tools come from the MCP server named \`friday\`. Antigravity offers them either under the name \`mcp_friday_<tool>\` (for example \`mcp_friday_friday_whoami\`) or through \`call_mcp_tool\` with ServerName \`friday\` and the tool's name as ToolName. If neither is offered in this turn, the server was still connecting when the turn began: tell the user to type /friday again in a few seconds, and do nothing else. That does not mean Friday is down.

Steps Friday's rules pass go ahead without a question. Antigravity may still ask the user to allow a step Friday has no rule for, or one Friday wants a human to decide. That is expected: wait for their answer.

If a Friday tool refuses or fails (for example the claim is not allowed), tell the user exactly what Friday said and stop. Do not try to fix, inspect or work around Friday: do not run the \`friday\` command, read or search its files, code or configuration, or write scripts to probe it. Only the user changes Friday's settings.

1. Call \`friday_whoami\`. If the call itself says Friday is unreachable, ask the user to start it (its shortcut, the desktop app, or \`friday run\`) and stop without editing files.
2. If you already hold a task, continue it. Otherwise call \`friday_task_claim\` with \`next: true\`. If nothing is ready, say so and stop.
3. Read the context the claim returns before editing. Edit only inside the task's scope. If Friday declines a step you truly need, ask with \`friday_request_permission\`; never retry it another way.
4. Call \`friday_report_progress\` after each meaningful step.
5. Run the checks you can, then call \`friday_claim_done\` with the exact changed paths and each check's real outcome.
6. Tell the user what you claimed and that it waits for Friday's verification. If another task is ready for you, name it and say they can type /friday again. Do not start it yourself.
`;

/** `.friday/harness/antigravity/launch-mcp.mjs`: tracked, machine-neutral, no secrets. */
export const LAUNCH_MCP = `#!/usr/bin/env node
// Friday MCP launcher, written by "friday harness config antigravity". Safe to commit:
// it holds no paths or secrets. It finds this machine's Friday install via "friday setup".
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  process.stderr.write('[friday] Friday is not set up on this machine. Run "friday setup" (after building Friday), then restart Antigravity.\\n');
  process.exit(1);
}
// Antigravity does not document the folder it starts a server in: the project is the one this file is in.
// A Claude Code session's variables (Antigravity started from its terminal) name another host's project and session.
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_CODE_SESSION_ID;
process.env.FRIDAY_PROJECT_DIR ??= path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.FRIDAY_HOST_PID ??= String(process.ppid);
await import(pathToFileURL(entry).href);
`;

export const HARNESS_README = `# Friday harness files for Antigravity

Written by \`friday harness config antigravity\`. These files are safe to commit: they contain
no secrets and no machine-specific paths.

- \`hook.mjs\`: Friday's hook launcher. Antigravity runs it for the \`friday\` group in
  \`.agents/hooks.json\`. It checks reads, searches, edits, shell commands and web access against
  Friday's policy, and answers deny, ask, or nothing; it never approves anything.
- \`launch-mcp.mjs\`: starts the \`friday\` MCP server from this machine's Friday install.

Antigravity starts hooks in the folder of \`hooks.json\`, so Friday also writes
\`.agents/.friday/harness/antigravity/hook.mjs\`: a three-line file at the path the hook command
lands on from there, which runs \`hook.mjs\` above.

Friday also writes \`.agents/skills/friday/SKILL.md\`: type \`/friday\` in Antigravity to take your
next Friday task. Each \`/friday\` is one task; you start the next one yourself.

Antigravity support is experimental. Remove everything Friday added with
\`friday harness config antigravity --remove\`.
`;

/**
 * The marker block in `AGENTS.md` (the same markers as the CLAUDE.md block). Antigravity loads
 * AGENTS.md into every conversation of the folder, and other agents read it too, so it is short
 * and names no host. Its cost is bounded: about 1.1 KB, some 300 tokens of context in each conversation.
 */
export const AGENTS_MD_BLOCK = `<!-- friday:begin -->
## Friday
This repository is coordinated by Friday. In a session that has the \`friday_*\` tools:
- Start with \`friday_whoami\`. If Friday is unreachable, ask the human to start it (its shortcut, the desktop app, or \`friday run\`) and do not edit files.
- Claim a task before editing (\`friday_task_claim\` with a \`task_id\`, or \`next: true\`) and read the context it returns.
- Edit only inside the task's scope. Friday declines edits elsewhere, to protected files (\`.friday\`, \`.git\`, \`.agents\`, host settings, secrets) and risky commands. If a declined step is truly needed, ask with \`friday_request_permission\`; never retry it another way.
- Report progress with \`friday_report_progress\`. Ask for background with \`friday_request_context\`. Reach other agents or a human only with \`friday_communicate\` or \`friday_ask_human\`; a message never grants approval.
- Finish with \`friday_claim_done\`, naming the changed paths and each check's real outcome, and say the claim waits for verification. Never put tokens, keys or passwords into messages or files.
<!-- friday:end -->`;
