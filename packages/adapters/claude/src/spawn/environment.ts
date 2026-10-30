/**
 * The environment of a Claude Code session Friday's spawn adapter starts (ADR-0032 §11): the
 * adapter's own, without what would tie it to another session or hand it a secret.
 * - Every `CLAUDE*` variable that describes the session the adapter itself runs in (a parent
 *   Claude Code's session id, messaging socket and token, entry point) is dropped, or the new
 *   session would take itself for that one's child; the user's own Claude Code settings stay.
 * - Friday's variables are dropped, except the state folder its hook launcher reads.
 * - Names that look like secrets are dropped, except Claude Code's own login: an API key, or the
 *   subscription token `claude setup-token` prints (CLAUDE_CODE_OAUTH_TOKEN), which is how a
 *   session signs in where no browser login exists, such as a container.
 */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)/i;

/** The user's choices for Claude Code itself, which a spawned session keeps. */
const CLAUDE_OWN = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

/** Claude Code's own login, when the user gives it by environment. */
const LOGIN = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']);

export function claudeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (upper.startsWith('CLAUDE') && !CLAUDE_OWN.has(upper) && !LOGIN.has(upper)) continue;
    if (upper === 'MCP_CONNECTION_NONBLOCKING') continue;
    if (upper.startsWith('FRIDAY_') && upper !== 'FRIDAY_STATE_DIR') continue;
    if (SECRET_NAME.test(k) && !LOGIN.has(upper)) continue;
    out[k] = v;
  }
  return out;
}
