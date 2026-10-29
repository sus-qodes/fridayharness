/**
 * Test factories for the interface (unit tests only; never imported by page code). Each returns a
 * complete, valid object with readable defaults; pass overrides for what a test is about.
 */
import type {
  AgentView,
  ApprovalRow,
  DomainEvent,
  EscalationView,
  GoalView,
  HarnessEntry,
  LivePlanTask,
  LivePlanVersion,
  RunView,
  SnapshotInboxItem,
  SnapshotTask,
  UiSnapshot,
  VerificationView,
} from '@friday/protocol';

export const T0 = '2026-10-17T10:00:00.000Z';
export const PID = 'proj_000000000000000000000000t1';

export function makeEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
  actor: { kind: string; id: string } = { kind: 'system', id: 'friday' },
): DomainEvent {
  return {
    event_id: `evt_${sequence}`,
    sequence,
    schema_version: 1,
    type,
    project_id: PID,
    actor,
    caused_by: [],
    correlation_id: null,
    occurred_at: T0,
    recorded_at: T0,
    payload,
    sensitivity: 'internal',
    redaction_status: 'none',
    artifact_refs: [],
  } as unknown as DomainEvent;
}

export function makeTask(overrides: Partial<SnapshotTask> = {}): SnapshotTask {
  return {
    task_id: 'task_0000000000000000000000aa01',
    project_id: PID,
    goal_id: null,
    plan_id: null,
    plan_version: null,
    plan_key: null,
    role: null,
    kind: 'implementation',
    summary: 'Add discount codes to pricing',
    description: null,
    acceptance_criteria: ['node --test passes'],
    status: 'READY',
    waiting_reason: null,
    priority: 'normal',
    risk_level: 'low',
    scope: { write: ['frontend/src/**'], read: ['frontend/**'] },
    dependencies: [],
    reserved_for_agent_key: null,
    reserved_by: null,
    reserved_until: null,
    assigned_agent_id: null,
    assigned_harness_id: null,
    current_run_id: null,
    created_by: { kind: 'human', id: 'local-operator' },
    created_at: T0,
    updated_at: T0,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    revision: 1,
    agent_key: null,
    waiting_note: null,
    delegation_note: null,
    ...overrides,
  } as SnapshotTask;
}

export function makeGoal(overrides: Partial<GoalView> = {}): GoalView {
  return {
    goal_id: 'goal_0000000000000000000000gg01',
    project_id: PID,
    request: 'Add Stripe subscriptions and keep one-time checkout working',
    objective: null,
    constraints: ['keep one-time checkout working'],
    outcomes: ['tests pass'],
    inferred_constraints: [],
    inferred_outcomes: [],
    priority: 'normal',
    status: 'ACTIVE',
    plan_id: 'plan_0000000000000000000000pp01',
    created_by: { kind: 'human', id: 'local-operator' },
    created_at: T0,
    updated_at: T0,
    completed_at: null,
    ...overrides,
  } as GoalView;
}

export function makePlanTask(overrides: Partial<LivePlanTask> = {}): LivePlanTask {
  return {
    key: 'api',
    position: 0,
    change: 'new',
    task_id: null,
    kind: 'implementation',
    summary: 'Add the subscription API',
    description: null,
    acceptance_criteria: [],
    depends_on: [],
    scope: { write: ['backend/**'], read: [] },
    role: 'backend',
    priority: 'normal',
    risk_level: 'low',
    note: null,
    status: null,
    waiting_reason: null,
    agent_key: null,
    reserved_for_agent_key: null,
    ...overrides,
  } as LivePlanTask;
}

export function makePlan(overrides: Partial<LivePlanVersion> = {}): LivePlanVersion {
  return {
    plan_id: 'plan_0000000000000000000000pp01',
    version: 1,
    goal_id: 'goal_0000000000000000000000gg01',
    status: 'ACTIVE',
    supersedes: null,
    summary: 'Two tasks: API, then checkout page',
    rationale: null,
    needs_human: null,
    trigger: 'written in the interface',
    proposed_by: { kind: 'human', id: 'local-operator' },
    model_call_id: null,
    prompt_version: null,
    created_at: T0,
    decided_at: T0,
    decided_by_id: 'local-operator',
    decision_note: null,
    tasks: [makePlanTask()],
    ...overrides,
  } as LivePlanVersion;
}

export function makeAgent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    agent_id: 'agent_000000000000000000000ag01',
    agent_key: 'claude-1',
    role: 'developer',
    status: 'AVAILABLE',
    shadow: false,
    harness_id: 'harness_00000000000000000000hh01',
    current_task_id: null,
    current_run_id: null,
    updated_at: T0,
    ...overrides,
  } as AgentView;
}

export function makeHarness(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
  return {
    harness_id: 'harness_00000000000000000000hh01',
    harness_key: `claude-code:${PID}:spawn:claude-1`,
    vendor: 'claude-code',
    name: 'Claude Code',
    version: '2.1.301',
    attach_mode: 'spawn',
    protocol_version: '1.0',
    status: 'READY',
    enforcement_level: 'L1',
    enforcement_status: 'reported',
    enforcement_basis: null,
    adapter_version: '0.1.0',
    host_pid: 4242,
    host_session_id: null,
    capabilities: { hooks: true },
    registered_at: T0,
    updated_at: T0,
    lease_expires_at: null,
    last_heartbeat_at: T0,
    shadow: false,
    requested_agent_key: 'claude-1',
    observed_model: 'claude-haiku-5-5',
    host_cwd: null,
    ...overrides,
  } as HarnessEntry;
}

export function makeRun(overrides: Partial<RunView> = {}): RunView {
  return {
    run_id: 'run_000000000000000000000rr01',
    task_id: 'task_0000000000000000000000aa01',
    harness_id: 'harness_00000000000000000000hh01',
    agent_id: 'agent_000000000000000000000ag01',
    attempt: 1,
    status: 'ACTIVE',
    outcome: null,
    session_ref: null,
    observed_paths: [],
    claim: null,
    created_at: T0,
    accepted_at: T0,
    ended_at: null,
    execution_root: 'C:/wt/abc',
    base_commit: 'a'.repeat(40),
    branch_ref: 'friday/task_0000',
    workspace: 'ready',
    model_requested: null,
    model_binding: false,
    routing_decision_id: null,
    model_observed: null,
    model_basis: null,
    ...overrides,
  } as RunView;
}

export function makeVerification(overrides: Partial<VerificationView> = {}): VerificationView {
  return {
    verification_id: 'ver_000000000000000000000vv01',
    task_id: 'task_0000000000000000000000aa01',
    run_id: null,
    status: 'PASSED',
    started_at: T0,
    ended_at: T0,
    summary: '3/3 required checks passed',
    execution_root: null,
    commit_sha: null,
    source_version: null,
    base_commit: null,
    task_kind: 'implementation',
    tree: null,
    policy_version: null,
    checks: [
      {
        name: 'friday.diff',
        kind: 'diff',
        status: 'PASSED',
        exit_code: null,
        artifact_ref: null,
        summary: '2 files',
        required: true,
        origin: 'friday',
        duration_ms: 40,
        details: null,
      },
    ],
    ...overrides,
  } as VerificationView;
}

export function makeApproval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    approval_id: 'apr_000000000000000000000ap01',
    project_id: PID,
    task_id: 'task_0000000000000000000000aa01',
    run_id: 'run_000000000000000000000rr01',
    requested_by_kind: 'agent',
    requested_by_id: 'agent_000000000000000000000ag01',
    capability: 'shell.git.commit',
    target: 'git commit -m "pricing"',
    purpose: 'Bash: commit the change',
    risk: 'low',
    status: 'pending',
    decided_by_kind: null,
    decided_by_id: null,
    decided_at: null,
    expires_at: '2026-10-17T11:00:00.000Z',
    created_at: T0,
    reuse: 'once',
    policy_version: 'pv1',
    uses: 0,
    last_used_at: null,
    note: null,
    decided_via: null,
    expired: false,
    ...overrides,
  };
}

export function makeEscalation(overrides: Partial<EscalationView> = {}): EscalationView {
  return {
    escalation_id: 'esc_000000000000000000000es01',
    project_id: PID,
    task_id: 'task_0000000000000000000000aa01',
    run_id: null,
    goal_id: null,
    kind: null,
    question: 'Should discount codes stack?',
    status: 'pending',
    answer: null,
    requested_by_id: 'agent_000000000000000000000ag01',
    requested_by_kind: 'agent',
    created_at: T0,
    answered_at: null,
    options: ['Yes, stack them', 'No, one code per order'],
    details: { why: 'The spec does not say', proposed_action: 'one code per order', evidence: [] },
    ...overrides,
  };
}

export function makeInboxItem(overrides: Partial<SnapshotInboxItem> = {}): SnapshotInboxItem {
  return {
    delivery_id: 'dlv_000000000000000000000dl01',
    message_id: 'msg_000000000000000000000ms01',
    correlation_id: 'msg_000000000000000000000ms01',
    from: { kind: 'agent', id: 'agent_000000000000000000000ag01', agent_key: 'claude-1', role: 'developer' },
    mode: 'notification',
    subject: 'Contract changed',
    preview: 'The checkout response now carries currency.',
    body_artifact_ref: null,
    facts: [],
    priority: 'normal',
    blocking: false,
    reply_by: null,
    response_to: null,
    in_reply_to: null,
    task_id: 'task_0000000000000000000000aa01',
    ...overrides,
  } as SnapshotInboxItem;
}

export function makeSnapshot(overrides: Partial<UiSnapshot> = {}): UiSnapshot {
  return {
    ui_api: 1,
    head: 10,
    generated_at: T0,
    project: {
      project_id: PID,
      name: 'shop',
      root: 'C:/demo/shop',
      port: 4310,
      daemon_version: '0.0.0',
      has_commit: true,
      worktrees_mode: 'per_task',
    },
    config: { loaded_hash: 'h1', current_hash: 'h1' },
    control: { paused: false, reason: null, changed_at: null, changed_by: null, halted_at: null },
    verification: { checks: [{ name: 'tests', kind: 'test', required: true }], auto_on_completion: false },
    counts: {},
    goals: [],
    plans: {},
    tasks: [],
    runs: {},
    verifications: {},
    integrations: {},
    usage: {},
    agents: [],
    harnesses: [],
    approvals: [],
    escalations: [],
    inbox: [],
    reservations: [],
    brain: null,
    brain_jobs: [],
    truncated: {},
    ...overrides,
  };
}

/**
 * A realistic board: one goal with an active plan of four tasks in different states, a loose task,
 * two agents (one spawned Claude Code at work, one Codex waiting), a pending approval and a question.
 */
export function makeScenario(): UiSnapshot {
  const goal = makeGoal();
  const ids = {
    api: 'task_00000000000000000000api001',
    ui: 'task_00000000000000000000ui0001',
    docs: 'task_0000000000000000000doc001',
    qa: 'task_00000000000000000000qa0001',
  };
  const tasks = [
    makeTask({
      task_id: ids.api,
      goal_id: goal.goal_id,
      plan_key: 'api',
      summary: 'Add the subscription API',
      status: 'RUNNING',
      role: 'backend',
      agent_key: 'claude-1',
      assigned_agent_id: 'agent_000000000000000000000ag01',
      current_run_id: 'run_000000000000000000000rr01',
      scope: { write: ['backend/**'], read: ['shared/**'] },
    }),
    makeTask({
      task_id: ids.ui,
      goal_id: goal.goal_id,
      plan_key: 'ui',
      summary: 'Add the subscription page',
      status: 'WAITING',
      waiting_reason: 'blocked',
      waiting_note: 'Which plan names should the page show?',
      role: 'frontend',
      agent_key: 'codex-1',
      dependencies: [ids.api],
      current_run_id: 'run_000000000000000000000rr02',
    }),
    makeTask({
      task_id: ids.docs,
      goal_id: goal.goal_id,
      plan_key: 'docs',
      summary: 'Document the subscription flow',
      status: 'PROPOSED',
      kind: 'docs',
      dependencies: [ids.api, ids.ui],
    }),
    makeTask({
      task_id: ids.qa,
      goal_id: goal.goal_id,
      plan_key: 'qa',
      summary: 'Verify one-time checkout still works',
      status: 'COMPLETED',
      kind: 'verification',
      completed_at: T0,
    }),
    makeTask({
      task_id: 'task_0000000000000000000loose01',
      summary: 'Tidy the README',
      status: 'READY',
      kind: 'chore',
      delegation_note: 'no agent is available',
    }),
  ];
  return makeSnapshot({
    goals: [goal],
    plans: {
      [goal.goal_id]: {
        active: makePlan({
          tasks: [
            makePlanTask({ key: 'api', task_id: ids.api, status: 'RUNNING' }),
            makePlanTask({ key: 'ui', task_id: ids.ui, depends_on: ['api'], status: 'WAITING', role: 'frontend' }),
            makePlanTask({
              key: 'docs',
              task_id: ids.docs,
              depends_on: ['api', 'ui'],
              status: 'PROPOSED',
              kind: 'docs',
            }),
            makePlanTask({ key: 'qa', task_id: ids.qa, status: 'COMPLETED', kind: 'verification' }),
          ],
        }),
        proposed: null,
      },
    },
    tasks,
    runs: {
      [ids.api]: makeRun({ task_id: ids.api }),
      [ids.ui]: makeRun({
        run_id: 'run_000000000000000000000rr02',
        task_id: ids.ui,
        harness_id: 'harness_00000000000000000000hh02',
        agent_id: 'agent_000000000000000000000ag02',
      }),
    },
    verifications: { [ids.qa]: makeVerification({ task_id: ids.qa }) },
    agents: [
      makeAgent({ status: 'BUSY', current_task_id: ids.api, current_run_id: 'run_000000000000000000000rr01' }),
      makeAgent({
        agent_id: 'agent_000000000000000000000ag02',
        agent_key: 'codex-1',
        role: 'frontend',
        status: 'WAITING',
        harness_id: 'harness_00000000000000000000hh02',
        current_task_id: ids.ui,
      }),
    ],
    harnesses: [
      makeHarness(),
      makeHarness({
        harness_id: 'harness_00000000000000000000hh02',
        harness_key: `codex:${PID}:codex-1`,
        vendor: 'codex',
        name: 'Codex',
        version: '0.162.1',
        capabilities: {},
        requested_agent_key: 'codex-1',
        observed_model: 'gpt-5.6-luna',
      }),
    ],
    approvals: [makeApproval({ task_id: ids.api })],
    escalations: [makeEscalation({ task_id: ids.api })],
    counts: { RUNNING: 1, WAITING: 1, PROPOSED: 1, COMPLETED: 1, READY: 1 },
  });
}
