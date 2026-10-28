import path from 'node:path';
import { type Actor, FridayError } from '@friday/protocol';
import { runCheck, summarizeOutcome } from '@friday/verification';
import type { DaemonContext } from './daemon.js';

/**
 * Runs every check in `verification.checks` for a READY_FOR_VERIFICATION task and moves it to
 * COMPLETED or FAILED (plan B14). Check output is stored as a redacted artifact; events carry
 * only a one-line summary and the artifact reference.
 */
export async function runVerification(ctx: DaemonContext, taskId: string, actor: Actor) {
  const { state, project } = ctx;
  const pid = project.project_id;
  const checks = project.config.verification.checks;
  if (checks.length === 0) {
    throw new FridayError(
      'verification_unavailable',
      'no checks are configured: add verification.checks to .friday/config.yaml, or record a result with --result passed|failed',
    );
  }
  const { verification_id } = state.startVerification(pid, actor, taskId);
  let passed = 0;
  try {
    for (const check of checks) {
      const outcome = await runCheck({
        name: check.name,
        command: check.command,
        args: check.args,
        cwd: check.cwd ? path.resolve(project.root, check.cwd) : project.root,
        timeoutMs: check.timeout_ms,
      });
      const artifact = state.artifacts?.storeText(
        pid,
        'verification',
        `$ ${check.command} ${check.args.join(' ')}\n${outcome.output}`,
      );
      if (outcome.passed) passed += 1;
      state.recordVerificationCheck(pid, actor, verification_id, {
        name: check.name,
        kind: check.kind,
        status: outcome.passed ? 'PASSED' : 'FAILED',
        exit_code: outcome.exit_code,
        artifact_ref: artifact ? `artifact:${artifact.artifact_id}` : null,
        summary: summarizeOutcome(outcome),
      });
      ctx.logger.info('verification check finished', {
        task_id: taskId,
        check: check.name,
        passed: outcome.passed,
        ms: outcome.duration_ms,
      });
    }
  } catch (e) {
    ctx.logger.error('verification runner failed', { task_id: taskId, message: (e as Error).message });
    const task = state.finishVerification(pid, actor, verification_id, false, `runner error: ${(e as Error).message}`);
    return { task, verification: state.q.verification(verification_id) };
  }
  const ok = passed === checks.length;
  const task = state.finishVerification(pid, actor, verification_id, ok, `${passed}/${checks.length} checks passed`);
  return { task, verification: state.q.verification(verification_id) };
}
