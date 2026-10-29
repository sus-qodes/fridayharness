import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { POLICY_DIR, PolicyFile } from '@friday/sdk';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { type GlobalOptions, operator, out, project } from './context.js';

/** The project's policy and this clone's trust in it (plan M6b, ADR-0028). */

interface Effective {
  autonomy: Record<string, string>;
  risk: Record<string, string>;
  deny: { write: string[]; read: string[] };
  teams: Record<string, { source: string; write: string[] }[]>;
  enforcement_required: string;
  reservations_mode: string;
  auto_approve: boolean;
  loosening: { source: string; setting: string; from: string; to: string }[];
  loosening_hash: string | null;
  trusted: boolean;
  version: string;
  sources: string[];
  errors: { file: string; error: string }[];
}

function lines(p: Effective): string[] {
  const out = [`Policy ${p.version} from ${p.sources.join(', ')}`];
  const entries = (o: Record<string, string>) =>
    Object.entries(o)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') || '(defaults)';
  out.push(`  autonomy: ${entries(p.autonomy)}`);
  out.push(`  risk: ${entries(p.risk)}`);
  if (p.deny.write.length) out.push(`  agents may not change: ${p.deny.write.join(', ')}`);
  if (p.deny.read.length) out.push(`  agents may not read: ${p.deny.read.join(', ')}`);
  for (const [role, layers] of Object.entries(p.teams)) {
    for (const l of layers) out.push(`  team ${role} writes only: ${l.write.join(', ')} (${l.source})`);
  }
  out.push(
    `  sessions need ${p.enforcement_required}; file reservations ${p.reservations_mode}; plans ${p.auto_approve ? 'approved without a human' : 'approved by a human'}`,
  );
  if (p.loosening.length) {
    out.push(p.trusted ? '  Trusted on this clone, loosening:' : '  Waiting for your trust (not applied), loosening:');
    for (const l of p.loosening) out.push(`    ${l.setting}: ${l.from} -> ${l.to} (${l.source})`);
    if (!p.trusted) out.push('  Apply it with: friday policy trust --yes');
  }
  for (const e of p.errors) out.push(`  NOT APPLIED ${e.file}: ${e.error}`);
  return out;
}

export function registerPolicyCommands(program: Command, g: () => GlobalOptions): void {
  const policy = program
    .command('policy')
    .description("the project's policy: config.yaml and .friday/policies/, and what this clone trusts");
  policy
    .command('show')
    .description('the policy in force, and what tracked files loosen that waits for your trust')
    .action(async () => {
      const { client } = operator(g());
      const r = await client.get<{ policy: Effective }>(client.projectPath('/policy'));
      out(g(), r, () => lines(r.policy).join('\n'));
    });
  policy
    .command('trust')
    .description("apply what the project's tracked policy loosens, on this clone; changed files need trust again")
    .option('--yes', 'confirm after reading "friday policy show"')
    .action(async (o: { yes?: boolean }) => {
      const { client } = operator(g());
      const shown = await client.post<{ policy: Effective }>(client.projectPath('/policy/reload'), {});
      if (!shown.policy.loosening_hash) {
        out(g(), shown, () => "Nothing in the project's policy loosens Friday's defaults; there is nothing to trust.");
        return;
      }
      if (!o.yes) {
        out(g(), shown, () =>
          [
            ...lines(shown.policy),
            '',
            'Read the loosening above; to apply it on this clone, run: friday policy trust --yes',
          ].join('\n'),
        );
        return;
      }
      const r = await client.post<{ policy: Effective }>(client.projectPath('/policy/trust'), {
        loosening_hash: shown.policy.loosening_hash,
      });
      out(g(), r, () => ['Trusted on this clone.', ...lines(r.policy)].join('\n'));
    });
  policy
    .command('validate')
    .description('check every file in .friday/policies/ without a daemon')
    .action(() => {
      const ref = project(g());
      const dir = path.join(ref.root, POLICY_DIR);
      let files: string[] = [];
      try {
        files = readdirSync(dir)
          .filter((f) => /\.ya?ml$/i.test(f))
          .sort();
      } catch {
        files = [];
      }
      const results = files.map((f) => {
        try {
          PolicyFile.parse(parseYaml(readFileSync(path.join(dir, f), 'utf8')) ?? {});
          return { file: f, ok: true, error: null as string | null };
        } catch (e) {
          const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
          return {
            file: f,
            ok: false,
            error: issues
              ? issues.map((i) => `${i.path.map(String).join('.') || '(file)'}: ${i.message}`).join('; ')
              : (e as Error).message,
          };
        }
      });
      out(g(), { files: results }, () =>
        results.length
          ? results.map((r) => (r.ok ? `ok      ${r.file}` : `invalid ${r.file}: ${r.error}`)).join('\n')
          : `No policy files in ${POLICY_DIR}.`,
      );
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    });
}
