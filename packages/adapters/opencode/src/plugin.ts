/** Dependency-free plugin emitted into the private profile; never loaded from the project. */
export const PLUGIN_BODY = `
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function FridayPolicy(context) {
  const directory = realpathSync(context.directory);
  if (directory !== SETTINGS.cwd) throw new Error('Friday: wrong plugin execution root');
  const pluginHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  async function send(body) {
    const response = await fetch(SETTINGS.url, {
      method: 'POST', redirect: 'error',
      headers: { authorization: 'Bearer ' + SETTINGS.secret, 'content-type': 'application/json' },
      // A little past the bridge's own deadline, so the bridge's reason for a late check arrives.
      signal: AbortSignal.timeout(SETTINGS.timeoutMs + 1500),
      body: JSON.stringify({ ...body, nonce: SETTINGS.nonce, directory, pluginHash })
    });
    if (!response.ok) throw new Error('Friday: policy bridge unavailable');
    const answer = await response.json();
    if (answer.ok !== true) throw new Error('Friday: policy check blocked');
    return answer;
  }
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  await send({ kind: 'ready' });
  return {
    'tool.execute.before': async (input, output) => {
      if (!input || !output || !output.args || typeof output.args !== 'object' || Array.isArray(output.args))
        throw new Error('Friday: malformed tool call');
      // Freeze the original object, not a substituted copy: later hooks cannot change judged args.
      freeze(output.args);
      Object.freeze(output);
      const args = structuredClone(output.args);
      const answer = await send({ kind: 'check', ...input, args });
      if (answer.decision !== 'allow') throw new Error('Friday: ' + (answer.reason || 'tool refused'));
    },
    'shell.env': async (_input, output) => {
      output.env.OPENCODE_SERVER_PASSWORD = '';
      output.env.OPENCODE_SERVER_USERNAME = '';
    }
  };
}
`;

export interface PluginSettings {
  cwd: string;
  url: string;
  secret: string;
  nonce: string;
  timeoutMs: number;
}
export function policyPluginSource(settings: PluginSettings): string {
  return `const SETTINGS = ${JSON.stringify(settings)};\n${PLUGIN_BODY}`;
}
