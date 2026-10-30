import type { ReadinessEvidenceView } from '@friday/protocol';
import type { TestDaemon } from './daemon.js';

/**
 * Records a host as installed, configured and connected on this machine for a day, as
 * `friday harness doctor <host>` does (ADR-0035 §1), so a dry run can route to it without a
 * session of it being connected. Readiness is evidence, so a test that expects a route names the
 * hosts it has "seen".
 */
export async function hostSeen(td: TestDaemon, host: string, version: string | null = null): Promise<void> {
  await td.operator.post<{ evidence: ReadinessEvidenceView[] }>(td.operator.projectPath('/readiness/evidence'), {
    host,
    version,
    source: 'harness doctor',
    stages: ['detected', 'configured', 'handshake'].map((stage) => ({ stage, status: 'passed' })),
  });
}
