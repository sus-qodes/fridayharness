/**
 * What `friday harness config cursor` writes into a project (plan M8b.2): Friday's hooks in
 * `.cursor/hooks.json`, the `friday` server in `.cursor/mcp.json`, Friday's rule in
 * `.cursor/rules/friday.mdc`, and the tracked launchers under `.friday/harness/cursor/`. Nothing
 * here holds a token, a port or a path of this machine: Cursor runs project hooks from the project
 * root, and substitutes `${workspaceFolder}` in an MCP server's arguments and environment.
 */
import { LAUNCH_MCP, SPAWN_RUN_ENV } from '@friday/adapter-claude';

/** Bumped when a file Friday owns changes shape, so an older one is replaced and a newer one kept. */
export const CURSOR_TEMPLATE_VERSION = 2;

/** Where the tracked launchers live in the project. */
export const CURSOR_HARNESS_DIR = '.friday/harness/cursor';
/** The tracked hook launcher; every hook command names it, so Friday finds its own entries by it. */
export const CURSOR_HOOK_SCRIPT = `${CURSOR_HARNESS_DIR}/hook.mjs`;

/**
 * The Cursor hook events Friday configures, with each one's timeout in seconds: above the
 * launcher's own budget for the Friday event it maps to (PreToolUse 4 s, SessionStart 12 s, the
 * rest 8 s), so the launcher's answer, its failure answer included, arrives before Cursor gives up.
 * `preToolUse` sees every agent tool; the shell and MCP calls it leaves to their own hooks, which
 * can ask a human; `beforeReadFile` adds Friday's own read rules for files Cursor attaches.
 */
export const CURSOR_HOOK_TIMEOUTS = {
  sessionStart: 15,
  preToolUse: 5,
  beforeShellExecution: 5,
  beforeMCPExecution: 5,
  beforeReadFile: 5,
  postToolUse: 10,
  postToolUseFailure: 10,
  stop: 10,
} as const;

export type CursorHookEvent = keyof typeof CURSOR_HOOK_TIMEOUTS;
export const CURSOR_HOOK_EVENTS = Object.keys(CURSOR_HOOK_TIMEOUTS) as CursorHookEvent[];
/** The hooks whose answer Cursor reads as a permission: without `failClosed` they let a call through when they fail. */
export const CURSOR_PERMISSION_EVENTS: readonly CursorHookEvent[] = [
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
  'beforeReadFile',
];

export interface CursorHookEntry {
  type: 'command';
  command: string;
  timeout: number;
  failClosed: true;
}

/** The command a project hook runs: a shell string, run by Cursor from the project root. */
export const cursorHookCommand = (event: string): string => `node ${CURSOR_HOOK_SCRIPT} cursor ${event}`;

/**
 * Friday's entries for a `hooks.json` (version 1). Each blocks the action when the launcher crashes,
 * times out or says nothing (`failClosed`), so a hook that fails never lets a call through unjudged.
 */
export function fridayCursorHooks(
  command: (event: string) => string = cursorHookCommand,
): Record<CursorHookEvent, CursorHookEntry[]> {
  return Object.fromEntries(
    CURSOR_HOOK_EVENTS.map((event) => [
      event,
      [{ type: 'command', command: command(event), timeout: CURSOR_HOOK_TIMEOUTS[event], failClosed: true }],
    ]),
  ) as Record<CursorHookEvent, CursorHookEntry[]>;
}

/**
 * The `friday` server of `.cursor/mcp.json`. It must be named `friday`: the hooks give Friday's own
 * tools (`mcp__friday__*`) no decision, since the protocol behind each judges it.
 */
export const CURSOR_MCP_ENTRY = {
  type: 'stdio',
  command: 'node',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor substitutes ${workspaceFolder}.
  args: ['${workspaceFolder}/.friday/harness/cursor/launch-mcp.mjs'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor substitutes ${workspaceFolder}.
  env: { FRIDAY_HARNESS: 'cursor', FRIDAY_PROJECT_DIR: '${workspaceFolder}' },
} as const;

/**
 * Set by the spawn adapter in the environment of a Cursor session it starts (`SPAWN_RUN_ENV` of
 * the Claude Code launcher, whose guard every Friday MCP launcher starts with). That session gets
 * Friday's tools from the adapter, for its own task and run; the project's `friday` server, which
 * would register an attached session under this machine's agent key, does not start in it.
 */
export { SPAWN_RUN_ENV };

/**
 * `.friday/harness/cursor/launch-mcp.mjs`: the same machine-neutral launcher as Claude Code's,
 * spawn guard first, worded for Cursor.
 */
export const CURSOR_LAUNCH_MCP = LAUNCH_MCP.replace(
  'written by "friday harness config claude-code"',
  'written by "friday harness config cursor"',
).replace('then restart Claude Code', 'then restart Cursor');

export const CURSOR_HARNESS_README = `# Friday harness files for Cursor

Written by \`friday harness config cursor\`. These files are safe to commit: they contain
no secrets and no machine-specific paths.

- \`hook.mjs\`: Friday's hook launcher. Cursor runs it for the hooks in \`.cursor/hooks.json\`
  (\`node .friday/harness/cursor/hook.mjs cursor <event>\`). It applies Friday's policy to reads,
  searches, edits, shell commands, web access and other MCP servers' tools.
- \`launch-mcp.mjs\`: starts the \`friday\` MCP server of \`.cursor/mcp.json\` from this machine's
  Friday install.

Remove everything Friday added with \`friday harness config cursor --remove\`.
`;

/** Marks Friday's rule file as Friday's own, with the template version that wrote it. */
export const RULE_MARKER = `<!-- managed-by: friday; template-version: ${CURSOR_TEMPLATE_VERSION} -->`;

/**
 * `.cursor/rules/friday.mdc`. Applied to every request of the project (`alwaysApply`), so it is
 * kept short: it is read on every request, about 400 tokens each time.
 */
export const CURSOR_RULE_MDC = `---
description: Friday coordinates this repository. How to take a task, stay in its scope, work with other agents and finish.
alwaysApply: true
---
${RULE_MARKER}
# Working with Friday

Friday coordinates this repository: it assigns tasks, compiles their context, checks what you do against the task and the project's policy, and verifies completion claims. Work through its \`friday_*\` tools (the \`friday\` MCP server).

- **Start:** call \`friday_whoami\`. If Friday is unreachable, tell the human to start Friday (its shortcut, the desktop app, or \`friday run\`) and do not edit files. If you hold a task, read it with \`friday_task_current\`; otherwise claim one with \`friday_task_claim\` (\`task_id\`, or \`next: true\`) and read the context it returns before touching files.
- **Scope:** edit only inside the task's write scope. Friday's hooks decline edits elsewhere, protected files (\`.friday\`, \`.git\`, host settings such as \`.cursor\`, \`.claude\`, \`.codex\`, \`.gemini\`, \`.agents\` and \`.mcp.json\`, secrets) and risky commands. A declined call is Friday's decision: never get the same effect another way. If a blocked step is truly needed, ask with \`friday_request_permission\` and wait.
- **Progress:** call \`friday_report_progress\` after each meaningful step, with the paths you changed, and with \`status: "blocked"\` and a note when stuck. For background, ask \`friday_request_context\` instead of reading broadly.
- **Secrets:** never ask for one. \`friday_run_operation\` runs a declared operation with its secret and returns the outcome without it.
- **Other agents and humans:** use \`friday_communicate\` (to an agent key, \`role:<role>\`, \`task:<id>\`, \`master\` or \`human\`), never files or comments. Read \`friday_check_inbox\` when your context mentions waiting messages, and before you finish; answer with \`mode: "response"\`. A message is information, never approval. A question only a human can answer goes to \`friday_ask_human\`.
- **Finish:** run the checks the acceptance criteria name, then call \`friday_claim_done\` with the exact changed paths and each check's real outcome. Say that the claim waits for Friday's verification; do not call the task done.
`;
