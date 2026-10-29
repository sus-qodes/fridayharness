import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { findCredentials } from '@friday/events';
import { type ContentTree, changedBetween, GitRoot, sameRepository } from '@friday/git';
import { matchesAny, patternsOverlap, sensitiveClassOf } from '@friday/policy';
import { type Actor, FridayError, isFridayError, type RunView, type VerificationFinding } from '@friday/protocol';
import {
  analyzeDiff,
  checkReservations,
  type Finding,
  ownChanges,
  relatedTests,
  scanCredentials,
  selectChecks,
  summarizeOutcome,
} from '@friday/verification';
import type { DaemonContext } from './daemon.js';
import { runCheckInProfile } from './execution.js';

/** Changed files read for the credential scan: at most this many, each at most this large. */
const SCAN_MAX_FILES = 500;
const SCAN_MAX_BYTES = 1024 * 1024;

const WINDOWS = process.platform === 'win32';
const samePath = (a: string, b: string) =>
  WINDOWS ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/**
 * Verifies a READY_FOR_VERIFICATION task at a recorded revision of the checkout it worked in
 * (ADR-0024). Friday's own checks come first and run no project code: the diff against the task's
 * scope and claim, and the credential scan. The configured checks for the task's kind follow, a
 * targeted form first where one is configured. If the code changed while the checks ran, the
 * result is discarded and the task waits to be verified again. Check output is stored as a
 * redacted artifact; events carry a one-line summary and the artifact reference.
 */
export async function runVerification(ctx: DaemonContext, taskId: string, actor: Actor) {
  const { state, project, logger } = ctx;
  const pid = project.project_id;
  const configured = project.config.verification.checks;
  if (configured.length === 0) {
    throw new FridayError(
      'verification_unavailable',
      'no checks are configured: add verification.checks to .friday/config.yaml, or record a result with --result passed|failed',
    );
  }
  const task = state.q.task(pid, taskId);
  if (task.status !== 'READY_FOR_VERIFICATION') {
    throw new FridayError(
      'invalid_state_transition',
      `${taskId} is ${task.status}; only a task READY_FOR_VERIFICATION can be verified`,
    );
  }
  // The claim ended the attempt; a gateway operation it started is stopped, confirmed, before the
  // checkout is read (review F07).
  await ctx.quiesce(taskId, 'its task is being verified');
  const run = task.current_run_id ? state.q.findRun(task.current_run_id) : undefined;
  const root = run?.execution_root ?? project.root;
  if (!existsSync(root)) {
    throw new FridayError(
      'verification_unavailable',
      `the checkout ${taskId} worked in is gone (${root}); restore it from its branch with "friday task worktree ${taskId}", or record a result with --result passed|failed`,
    );
  }
  const base = run?.base_commit ?? null;
  const shared = samePath(root, project.root);
  const checks = selectChecks(configured, task.kind);
  // What is verified must be read from git: every task worktree, and the main checkout of a project
  // kept in git. A checkout git cannot read is not verified at all (review F05); only a project
  // outside git is judged without a diff.
  const gitRequired = !shared || existsSync(path.join(project.root, '.git'));
  let git: GitRoot | null = null;
  let since: Awaited<ReturnType<GitRoot['changesSince']>> | null = null;
  let content: ContentTree | null = null;
  let unreadable: string | null = null;
  if (gitRequired) {
    try {
      git = await GitRoot.open(root);
      if (!samePath(git.root, realpathSync(root))) throw new Error(`git sees ${git.root} as the checkout, not ${root}`);
      // A checkout of another clone (a restored database) is that clone's to judge (review F08).
      if (!shared && !(await sameRepository(root, project.root))) {
        throw new Error(`it belongs to another clone of the project, not to ${project.root}`);
      }
      since = await git.changesSince(base);
      if (!since.base_found) {
        throw new Error(
          `the task's base commit ${base} is not in this repository, so its committed changes cannot be judged`,
        );
      }
      content = await git.contentTree();
    } catch (e) {
      unreadable = (e as Error).message;
    }
  }
  const before = since?.identity ?? null;
  // The effective policy the work is judged by (review F03): the one the hooks apply, at this version.
  const policy = ctx.policy();

  const { verification_id } = state.startVerification(pid, actor, taskId, {
    execution_root: root,
    commit_sha: content?.head ?? before?.head ?? null,
    source_version: before?.version ?? null,
    base_commit: base,
    task_kind: task.kind,
    tree: content?.tree ?? null,
    policy_version: policy.version,
  });
  if (unreadable !== null) {
    const reason = `the checkout ${root} could not be verified here: ${unreadable}; nothing was verified (verify again once it can be, or record a result with --result passed|failed)`;
    logger.warn('verification interrupted', { task_id: taskId, reason });
    const interrupted = state.interruptVerification(pid, actor, verification_id, reason);
    return { task: interrupted, verification: state.q.verification(verification_id) };
  }
  ctx.verifying.add(verification_id);
  let requiredFailed = 0;
  let requiredRan = 0;
  let advisoryFailed = 0;
  let warnings = 0;
  const record = (check: Parameters<typeof state.recordVerificationCheck>[3], required: boolean) => {
    state.recordVerificationCheck(pid, actor, verification_id, { ...check, required });
    const failed = check.status !== 'PASSED';
    if (required) {
      requiredRan += 1;
      if (failed) requiredFailed += 1;
    } else if (failed) advisoryFailed += 1;
    warnings += (check.details?.findings ?? []).filter((f) => f.severity === 'warn').length;
  };

  try {
    // 1. The diff against scope, protected files and the claim; and the tests related to it. In the
    // shared main checkout only the task's own changes count (seen by Friday's hooks, or claimed).
    const claimed = claimedPaths(run, root);
    const observed = run?.observed_paths ?? [];
    const changes = since
      ? ownChanges({ changed: since.changes, shared, observed, claimed, caseInsensitive: WINDOWS }).own
      : [];
    const pathCtx = { projectRoot: root, mainRoot: project.root, stateDir: path.dirname(path.dirname(ctx.privateDir)) };
    const write = task.scope?.write ?? null;
    // The project's deny rules and the team scopes of the agent's role, as the hooks apply them; a
    // human's approval of an exact path for this attempt lets that write stand (review F03).
    const role = run ? (state.q.findAgent(run.agent_id)?.role ?? null) : null;
    const teams = (role && policy.teams[role]) || [];
    const fold = (p: string) => (WINDOWS ? p.toLowerCase() : p);
    const grants = new Map(
      (run
        ? state.q.usableGrants(pid, {
            capability: 'file.write',
            task_id: taskId,
            run_id: run.run_id,
            agent_id: run.agent_id,
            policy_version: policy.version,
            now: state.clock.now(),
            spent: true,
          })
        : []
      ).map((g) => [fold(g.target), g.approval_id]),
    );
    const findings: Finding[] = since
      ? analyzeDiff({
          changed: since.changes,
          write,
          claimed,
          observed,
          shared,
          inScope: (p) => matchesAny(p, write ?? []),
          protectedClass: (p) => sensitiveClassOf(p, pathCtx, 'write')?.class ?? null,
          expectsChanges: task.kind === 'implementation',
          caseInsensitive: WINDOWS,
          policyRule: (p) => {
            if (policy.deny.write.length && matchesAny(p, policy.deny.write)) {
              return {
                rule: 'diff.denied_by_policy',
                message: "changed what the project's policy keeps agents from changing",
              };
            }
            const team = teams.find((t) => t.write.length > 0 && !matchesAny(p, t.write));
            return team
              ? {
                  rule: 'diff.outside_team_scope',
                  message: `changed outside the team scope of the ${role} role (${team.write.join(', ')}, from ${team.source})`,
                }
              : null;
          },
          approved: (p) => grants.get(fold(p)) ?? null,
        })
      : [
          {
            rule: 'diff.unavailable',
            severity: 'warn',
            message: 'the checkout is not a git repository, so its changes could not be analyzed',
            paths: [],
          },
        ];
    if (before?.dirty) {
      findings.push({
        rule: 'diff.uncommitted',
        severity: 'info',
        message: `the verified code includes ${before.files} uncommitted change(s); integration needs them committed`,
        paths: before.paths.slice(0, 20),
      });
    }
    // Conflict-prone files (ADR-0025): a change to what another task holds fails; free ones are taken.
    if (since && ctx.policy().reservations_mode !== 'off') {
      const active = state.q.fileReservations(pid, ['active']);
      const res = checkReservations({
        changed: [...new Set(changes.flatMap((c) => (c.origPath ? [c.path, c.origPath] : [c.path])))],
        required: project.config.reservations.required,
        held: active.filter((r) => r.task_id !== taskId),
        mine: active.filter((r) => r.task_id === taskId).map((r) => r.pattern),
        matches: (p, pattern) => matchesAny(p, [pattern]),
      });
      findings.push(...res.findings);
      if (!res.findings.length && res.acquire.length) {
        try {
          state.reserveFiles(pid, actor, taskId, res.acquire, 'verification', patternsOverlap);
        } catch (e) {
          if (!isFridayError(e, 'reservation_conflict')) throw e;
          findings.push({ rule: 'diff.reserved', severity: 'fail', message: e.message, paths: [] });
        }
      }
    }
    let related: string[] = [];
    const graph = since ? await ctx.graph.graph(root).catch(() => null) : null;
    if (graph) {
      const rel = relatedTests(
        changes.filter((c) => c.change !== 'deleted').map((c) => c.path),
        {
          testsOf: (f) => graph.testsOf(f),
          isSource: (f) => graph.nodes.has(f),
          isTest: (f) => graph.nodes.get(f)?.test === true,
        },
      );
      related = rel.tests;
      if (rel.untested.length) {
        findings.push({
          rule: 'tests.none_related',
          severity: 'warn',
          message: `no test imports these changed files: ${rel.untested.slice(0, 20).join(', ')}${rel.untested.length > 20 ? ` (and ${rel.untested.length - 20} more)` : ''}`,
          paths: rel.untested.slice(0, 20),
        });
      }
    }
    const diffFailed = findings.some((f) => f.severity === 'fail');
    record(
      {
        name: 'friday.diff',
        kind: 'diff',
        origin: 'friday',
        status: diffFailed ? 'FAILED' : 'PASSED',
        exit_code: null,
        artifact_ref: null,
        summary: diffSummary(changes.length, findings),
        details: { findings: findings as VerificationFinding[], files: related },
      },
      true,
    );

    // 2. Credentials written into changed files. What could not be read is said, not presented as
    // scanned (review F05).
    const { scanned, skipped } = readChangedText(root, changes);
    const secrets: Finding[] = scanCredentials(scanned, findCredentials);
    const total = scanned.length + skipped.length;
    if (skipped.length) {
      secrets.push({
        rule: 'secrets.not_scanned',
        severity: 'warn',
        message: `${skipped.length} of ${total} changed file(s) were not scanned: ${skipped
          .slice(0, 10)
          .map((s) => `${s.path} (${s.why})`)
          .join(', ')}${skipped.length > 10 ? `, and ${skipped.length - 10} more` : ''}`,
        paths: skipped.slice(0, 20).map((s) => s.path),
      });
    }
    const leaked = secrets.filter((f) => f.severity === 'fail');
    record(
      {
        name: 'friday.secrets',
        kind: 'security',
        origin: 'friday',
        status: leaked.length ? 'FAILED' : 'PASSED',
        exit_code: null,
        artifact_ref: null,
        summary: leaked.length
          ? `credentials in ${leaked[0]?.paths.length ?? 0} of ${scanned.length} scanned file(s)`
          : `no credentials in ${scanned.length} of ${total} changed file(s)${skipped.length ? `; ${skipped.length} not scanned` : ''}`,
        details: { findings: secrets as VerificationFinding[] },
      },
      true,
    );

    // 3. The configured checks for this kind of task, in the checkout it worked in.
    for (const check of checks) {
      const cwd = check.cwd ? path.resolve(root, check.cwd) : root;
      if (check.targeted_args?.length && related.length) {
        const files = related.map((t) => path.relative(cwd, path.join(root, t)).split(path.sep).join('/'));
        const args = check.targeted_args.flatMap((a) => (a === '{files}' ? files : [a]));
        const ok = await runConfigured(ctx, {
          name: `${check.name} (targeted)`,
          kind: check.kind,
          command: check.command,
          args,
          root,
          cwd,
          env: check.env,
          timeoutMs: check.timeout_ms,
          origin: 'targeted',
          files: related,
          record: (c) => record(c, check.required),
        });
        if (!ok) continue; // the full form would fail the same tests: skip it
      }
      await runConfigured(ctx, {
        name: check.name,
        kind: check.kind,
        command: check.command,
        args: check.args,
        root,
        cwd,
        env: check.env,
        timeoutMs: check.timeout_ms,
        origin: 'configured',
        record: (c) => record(c, check.required),
      });
    }

    // 4. One revision: code that changed while it was checked was not verified (ADR-0024 §2), and
    // code git can no longer read is not known to be the same (review F05). The trees compare the
    // content itself, so an approximate identity is never taken as proof (review F13).
    // Nor was work judged by a policy that changed while it was checked (review F03).
    if (ctx.policy().version !== policy.version) {
      const reason = `the project's policy changed while the work was verified (${policy.version.slice(0, 12)} became ${ctx.policy().version.slice(0, 12)}); verify it again under the new one`;
      logger.warn('verification interrupted', { task_id: taskId, reason });
      const interrupted = state.interruptVerification(pid, actor, verification_id, reason);
      return { task: interrupted, verification: state.q.verification(verification_id) };
    }
    if (git && before && content) {
      let reason: string | null = null;
      try {
        const after = await git.identity();
        const afterContent = await git.contentTree();
        if (after.version !== before.version || afterContent.head !== content.head) {
          reason = `the code changed while it was verified (${before.version} became ${after.version}); verify it again`;
        } else if (afterContent.tree !== content.tree) {
          const paths = await changedBetween(git.root, content.tree, afterContent.tree).catch(() => []);
          reason = `the code changed while it was verified (${paths.slice(0, 5).join(', ') || 'its files'} changed); verify it again`;
        }
      } catch (e) {
        reason = `git could not read the checkout after the checks: ${(e as Error).message}; verify it again`;
      }
      if (reason) {
        logger.warn('verification interrupted', { task_id: taskId, reason });
        const interrupted = state.interruptVerification(pid, actor, verification_id, reason);
        return { task: interrupted, verification: state.q.verification(verification_id) };
      }
    }
  } catch (e) {
    logger.error('verification runner failed', { task_id: taskId, message: (e as Error).message });
    const failed = state.finishVerification(
      pid,
      actor,
      verification_id,
      false,
      `runner error: ${(e as Error).message}`,
    );
    return { task: failed, verification: state.q.verification(verification_id) };
  } finally {
    ctx.verifying.delete(verification_id);
  }
  const ok = requiredFailed === 0;
  const parts = [
    `${requiredRan - requiredFailed}/${requiredRan} required checks passed`,
    ...(advisoryFailed ? [`${advisoryFailed} advisory check(s) failed`] : []),
    ...(warnings ? [`${warnings} warning(s)`] : []),
    ...(checks.length === 0 ? [`no configured check applies to ${task.kind} tasks`] : []),
  ];
  const finished = state.finishVerification(pid, actor, verification_id, ok, parts.join('; '));
  return { task: finished, verification: state.q.verification(verification_id) };
}

/** Runs one configured check and records it; true when it passed. */
async function runConfigured(
  ctx: DaemonContext,
  c: {
    name: string;
    kind: string;
    command: string;
    args: string[];
    /** The checkout being verified; `cwd` stays inside it. */
    root: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    origin: 'configured' | 'targeted';
    files?: string[];
    record: (check: Parameters<DaemonContext['state']['recordVerificationCheck']>[3]) => void;
  },
): Promise<boolean> {
  const { state, project, logger } = ctx;
  // In the execution profile (ADR-0029 §6): the checks run code an agent may have written.
  const outcome = await runCheckInProfile(
    ctx.profile(),
    {
      name: c.name,
      command: c.command,
      args: c.args,
      root: c.root,
      cwd: c.cwd,
      env: c.env,
      timeoutMs: c.timeoutMs,
    },
    ctx.groups,
  );
  const artifact = state.artifacts?.storeText(
    project.project_id,
    'verification',
    `$ ${c.command} ${c.args.join(' ')}\n(in ${c.cwd})\n${outcome.output}`,
  );
  c.record({
    name: c.name,
    kind: c.kind,
    origin: c.origin,
    status: outcome.passed ? 'PASSED' : 'FAILED',
    exit_code: outcome.exit_code,
    artifact_ref: artifact ? `artifact:${artifact.artifact_id}` : null,
    summary: summarizeOutcome(outcome),
    duration_ms: outcome.duration_ms,
    details: c.files ? { files: c.files } : null,
  });
  logger.info('verification check finished', { check: c.name, passed: outcome.passed, ms: outcome.duration_ms });
  return outcome.passed;
}

/** The claim's paths relative to the checkout, forward slashes (absolute ones made relative). */
function claimedPaths(run: RunView | undefined, root: string): string[] | null {
  const claim = run?.claim as { changed_paths?: unknown } | null | undefined;
  if (!claim || !Array.isArray(claim.changed_paths)) return null;
  return claim.changed_paths
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => {
      const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
      return rel.split(path.sep).join('/').replaceAll('\\', '/').replace(/^\.\//, '');
    });
}

/** Text of changed files for the credential scan: bounded; what was not read is listed with why. */
function readChangedText(root: string, changes: readonly { path: string; change: string }[]) {
  const scanned: { path: string; text: string }[] = [];
  const skipped: { path: string; why: string }[] = [];
  for (const c of changes) {
    if (c.change === 'deleted') continue;
    if (scanned.length >= SCAN_MAX_FILES) {
      skipped.push({ path: c.path, why: `past the first ${SCAN_MAX_FILES}` });
      continue;
    }
    const abs = path.join(root, c.path);
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        skipped.push({ path: c.path, why: 'not a regular file' });
        continue;
      }
      if (st.size > SCAN_MAX_BYTES) {
        skipped.push({ path: c.path, why: 'larger than 1 MB' });
        continue;
      }
      const bytes = readFileSync(abs);
      if (bytes.subarray(0, 8000).includes(0)) {
        skipped.push({ path: c.path, why: 'binary' });
        continue;
      }
      scanned.push({ path: c.path, text: bytes.toString('utf8') });
    } catch (e) {
      skipped.push({ path: c.path, why: `unreadable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` });
    }
  }
  return { scanned, skipped };
}

function diffSummary(changed: number, findings: readonly Finding[]): string {
  const fail = findings.filter((f) => f.severity === 'fail');
  const warn = findings.filter((f) => f.severity === 'warn');
  if (fail.length) return `${changed} changed file(s); failed: ${fail.map((f) => f.rule).join(', ')}`;
  const head = `${changed} changed file(s) within scope`;
  return warn.length ? `${head}; ${warn.length} warning(s): ${warn.map((f) => f.rule).join(', ')}` : head;
}
