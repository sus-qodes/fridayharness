/**
 * The typed API client: every daemon call of the interface goes through here (plan §6 rule 3).
 * Paths and bodies are the daemon's real ones (plan §2, ERRATA F4).
 */
import type {
  AgentHost,
  AgentLaunchRequest,
  AgentProcess,
  AgentProcessesView,
  AgentView,
  ClaudeSetupPlan,
  ClaudeSetupResult,
  ContextExplanation,
  ContextPacket,
  ContinueResult,
  ControlResult,
  DomainEvent,
  EscalationView,
  FilesListing,
  GlobCounts,
  GoalDiff,
  GoalSummary,
  GoalView,
  HarnessEntry,
  InboxItem,
  IntegrationView,
  LivePlanVersion,
  MessageView,
  ModelEvidenceView,
  RecoveryAssessment,
  RoutingPinView,
  RunView,
  TaskDiff,
  TaskView,
  UiLoginCode,
  UiSnapshot,
  VerificationView,
  WorktreeView,
} from '@friday/protocol';
import type { HttpRequestOptions } from '../platform/http-transport.js';
import type { RequestOptions, Transport } from '../platform/transport.js';
import { TIMEOUTS } from './timeouts.js';

const LONG = TIMEOUTS.long;
const MEDIUM = TIMEOUTS.medium;

export type TaskAction = 'ready' | 'release' | 'cancel' | 'rework' | 'unreserve';
export type Reach = 'once' | 'run' | 'task';
export type RecoveryActionName = 'reassign' | 'restart' | 'rebind' | 'needs_human' | 'cancel';

export interface TaskDetail {
  task: TaskView;
  runs: RunView[];
  verification: VerificationView | null;
  open_dependencies: string[];
}

export interface GoalDetail {
  goal: GoalView;
  versions: (Omit<LivePlanVersion, 'tasks'> & { task_count: number })[];
  active: LivePlanVersion | null;
  proposed: LivePlanVersion | null;
  escalations: EscalationView[];
  model_calls: { count: number; cost_usd: number; unknown_cost_calls: number; estimated_usd: number };
  /** What Friday did for the goal, counted from its records (plan M12.7). */
  summary: GoalSummary;
}

export interface GraphQuery {
  version: string;
  node: { path: string; area?: string | null; contract?: unknown } | null;
  dependencies: { to: string; kind: string; specifier?: string | null }[];
  consumers: { from: string; kind: string }[];
  tests: string[];
  neighbourhood: { path: string; distance: number }[];
}

export interface MemoryHit {
  memory_id: string;
  scope_type: string;
  scope_id: string | null;
  kind: string;
  subject: string;
  content: string;
  tags: string[];
  authority: string;
  verification_status: string;
  status: string;
  needs_review: boolean;
  created_at: string;
  updated_at: string;
  score?: number;
  why?: Record<string, unknown>;
}

/** `GET policy`: the effective policy (ADR-0028); what loosens waits for this clone's trust. */
export interface PolicyView {
  policy: {
    version: string;
    sources: string[];
    /** Each setting a tracked file loosens, with where it comes from. */
    loosening: { source: string; setting: string; from: string; to: string }[];
    /** What `policy/trust` must send back; null when nothing loosens. */
    loosening_hash: string | null;
    /** Whether the loosening above applies (this clone trusted exactly it). */
    trusted: boolean;
    [key: string]: unknown;
  };
}

export class FridayApi {
  constructor(
    readonly transport: Transport,
    readonly projectId: string,
  ) {}

  p(path: string): string {
    return `/api/v1/projects/${encodeURIComponent(this.projectId)}${path}`;
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.transport.request<T>('GET', this.p(path), undefined, opts);
  }

  post<T>(path: string, body: unknown = {}, opts?: RequestOptions): Promise<T> {
    return this.transport.request<T>('POST', this.p(path), body, opts);
  }

  // ---- board and events
  snapshot(): Promise<UiSnapshot> {
    return this.get('/ui/snapshot');
  }

  events(since: number, limit = 200, types: string[] = []): Promise<{ events: DomainEvent[]; head: number }> {
    const q = new URLSearchParams({ since: String(since), limit: String(limit) });
    for (const t of types) q.append('type', t);
    return this.get(`/events?${q}`);
  }

  streamPath(since: number): string {
    return this.p(`/events/stream?since=${since}`);
  }

  // ---- tasks
  task(taskId: string): Promise<TaskDetail> {
    return this.get(`/tasks/${encodeURIComponent(taskId)}`);
  }

  /** A task's events, newest first, older pages by `before` (plan §5.11). */
  taskEvents(taskId: string, opts: { before?: number; limit?: number } = {}): Promise<{ events: DomainEvent[] }> {
    const q = new URLSearchParams({ order: 'desc', limit: String(opts.limit ?? 100) });
    if (opts.before !== undefined) q.set('before', String(opts.before));
    return this.get(`/tasks/${encodeURIComponent(taskId)}/events?${q}`);
  }

  taskDiff(taskId: string, stat = false): Promise<TaskDiff> {
    return this.get(`/tasks/${encodeURIComponent(taskId)}/diff${stat ? '?stat=1' : ''}`, { timeoutMs: TIMEOUTS.diff });
  }

  goalDiff(goalId: string, stat = false): Promise<GoalDiff> {
    return this.get(`/goals/${encodeURIComponent(goalId)}/diff${stat ? '?stat=1' : ''}`, { timeoutMs: TIMEOUTS.diff });
  }

  /** A waiting task on a spawned run continues in the same session; the note reaches the agent (plan §5.6). */
  continueTask(taskId: string, note?: string): Promise<ContinueResult> {
    return this.post(`/tasks/${encodeURIComponent(taskId)}/continue`, note ? { note } : {});
  }

  createTask(body: Record<string, unknown>): Promise<TaskView> {
    return this.post('/tasks', body, { idempotencyKey: newKey() });
  }

  taskAction(taskId: string, action: TaskAction, reason?: string): Promise<{ task: TaskView }> {
    return this.post(`/tasks/${encodeURIComponent(taskId)}/${action}`, reason ? { reason } : {});
  }

  assign(taskId: string, agentKey: string): Promise<{ mode: 'assigned' | 'reserved'; task: TaskView }> {
    return this.post(`/tasks/${encodeURIComponent(taskId)}/assign`, { agent_key: agentKey });
  }

  verify(
    taskId: string,
    body: { result?: 'passed' | 'failed'; note?: string } = {},
  ): Promise<{ task: TaskView; verification: VerificationView }> {
    return this.post(`/tasks/${encodeURIComponent(taskId)}/verify`, body, { timeoutMs: LONG });
  }

  integrate(taskId: string, repaired = false): Promise<{ integration: IntegrationView }> {
    return this.post(`/tasks/${encodeURIComponent(taskId)}/integrate`, repaired ? { repaired: true } : {}, {
      timeoutMs: LONG,
    });
  }

  recovery(taskId: string): Promise<{ assessment: RecoveryAssessment }> {
    return this.get(`/tasks/${encodeURIComponent(taskId)}/recovery`, { timeoutMs: 60_000 });
  }

  recover(
    taskId: string,
    action: RecoveryActionName,
    reason?: string,
  ): Promise<{ task: TaskView; preserved_ref: string | null }> {
    return this.post(
      `/tasks/${encodeURIComponent(taskId)}/recover`,
      { action, ...(reason ? { reason } : {}) },
      { timeoutMs: MEDIUM },
    );
  }

  createWorktree(taskId: string): Promise<{ worktree: WorktreeView; warnings: string[]; created: boolean }> {
    return this.post(`/tasks/${encodeURIComponent(taskId)}/worktree`, {}, { timeoutMs: MEDIUM });
  }

  deliveredContext(
    taskId: string,
  ): Promise<{ context_id: string | null; agent_id: string | null; agent_key: string | null }> {
    return this.get(`/tasks/${encodeURIComponent(taskId)}/delivered-context`);
  }

  compileContext(taskId: string): Promise<ContextPacket> {
    return this.post('/context/compile', { task_id: taskId, purpose: 'explain' }, { timeoutMs: TIMEOUTS.graph });
  }

  explainContext(contextId: string): Promise<{ packet: ContextPacket; explanation: ContextExplanation }> {
    return this.get(`/context/${encodeURIComponent(contextId)}/explain`);
  }

  // ---- goals and plans
  goals(): Promise<{ goals: GoalView[] }> {
    return this.get('/goals');
  }

  goal(goalId: string): Promise<GoalDetail> {
    return this.get(`/goals/${encodeURIComponent(goalId)}`);
  }

  createGoal(body: {
    request: string;
    constraints: string[];
    outcomes: string[];
    priority: string;
    plan: boolean;
  }): Promise<GoalView> {
    return this.post('/goals', body, { idempotencyKey: newKey() });
  }

  cancelGoal(goalId: string, reason?: string): Promise<GoalView> {
    return this.post(`/goals/${encodeURIComponent(goalId)}/cancel`, reason ? { reason } : {});
  }

  replan(goalId: string, note?: string): Promise<{ result: string }> {
    return this.post(`/goals/${encodeURIComponent(goalId)}/replan`, note ? { note } : {}, { timeoutMs: MEDIUM });
  }

  proposePlan(goalId: string, draft: unknown): Promise<LivePlanVersion> {
    return this.post(`/goals/${encodeURIComponent(goalId)}/plans`, { draft, trigger: 'written in the interface' });
  }

  approvePlan(planId: string, version: number, note?: string): Promise<{ plan: LivePlanVersion }> {
    return this.post(`/plans/${encodeURIComponent(planId)}/versions/${version}/approve`, note ? { note } : {});
  }

  rejectPlan(planId: string, version: number, note?: string): Promise<LivePlanVersion> {
    return this.post(`/plans/${encodeURIComponent(planId)}/versions/${version}/reject`, note ? { note } : {});
  }

  planDiff(
    planId: string,
    from: number,
    to: number,
  ): Promise<{ plan_id: string; from: number; to: number; diff: unknown }> {
    return this.get(`/plans/${encodeURIComponent(planId)}/diff?from=${from}&to=${to}`);
  }

  brainRunOnce(): Promise<unknown> {
    return this.post('/brain/run-once', {}, { timeoutMs: MEDIUM });
  }

  // ---- approvals and questions
  approve(approvalId: string, reuse: Reach, note?: string, ttlS?: number): Promise<{ ok: boolean; status: string }> {
    return this.post(`/approvals/${encodeURIComponent(approvalId)}/approve`, {
      reuse,
      via: 'ui',
      ...(note ? { note } : {}),
      ...(ttlS ? { ttl_s: ttlS } : {}),
    });
  }

  reject(approvalId: string, note?: string): Promise<{ ok: boolean; status: string }> {
    return this.post(`/approvals/${encodeURIComponent(approvalId)}/reject`, { via: 'ui', ...(note ? { note } : {}) });
  }

  revoke(approvalId: string, note?: string): Promise<{ ok: boolean }> {
    return this.post(`/approvals/${encodeURIComponent(approvalId)}/revoke`, note ? { note } : {});
  }

  answer(escalationId: string, answer: string): Promise<{ ok: boolean }> {
    return this.post(`/escalations/${encodeURIComponent(escalationId)}/answer`, { answer });
  }

  // ---- messages
  messages(
    query: { task?: string; status?: string; to?: string; limit?: number } = {},
  ): Promise<{ messages: MessageView[] }> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
    return this.get(`/messages${q.size ? `?${q}` : ''}`);
  }

  send(body: {
    to: string;
    content: string;
    subject?: string;
    reply_to?: string;
    priority?: string;
  }): Promise<{ message_id: string }> {
    return this.post('/messages', body, { idempotencyKey: newKey() });
  }

  inbox(who: string): Promise<{ items: InboxItem[] }> {
    return this.get(`/inbox/${encodeURIComponent(who)}`);
  }

  ackHuman(ids: string[]): Promise<{ acknowledged: string[] }> {
    return this.post('/inbox/human/ack', { ids });
  }

  // ---- graph, memory, context
  graph(): Promise<{
    version: string;
    stats: Record<string, unknown>;
    contracts: { path: string; area: string; consumers: string[] }[];
  }> {
    return this.get('/graph', { timeoutMs: TIMEOUTS.graph });
  }

  graphQuery(path: string, depth = 2): Promise<GraphQuery> {
    return this.get(`/graph/query?path=${encodeURIComponent(path)}&depth=${depth}`, { timeoutMs: TIMEOUTS.graph });
  }

  graphReindex(): Promise<unknown> {
    return this.post('/graph/reindex', {}, { timeoutMs: TIMEOUTS.worktrees });
  }

  memory(
    query: string,
    opts: { kinds?: string[]; all?: boolean; limit?: number } = {},
  ): Promise<{ memories: MemoryHit[] }> {
    const q = new URLSearchParams();
    if (query) q.set('query', query);
    if (opts.kinds?.length) q.set('kind', opts.kinds.join(','));
    if (opts.all) q.set('all', 'true');
    q.set('limit', String(opts.limit ?? 40));
    return this.get(`/memory?${q}`);
  }

  memoryReview(): Promise<{ memories: MemoryHit[] }> {
    return this.get('/memory/review');
  }

  approveMemory(memoryId: string): Promise<MemoryHit> {
    return this.post(`/memory/${encodeURIComponent(memoryId)}/approve`);
  }

  retractMemory(memoryId: string, reason?: string): Promise<MemoryHit> {
    return this.post(`/memory/${encodeURIComponent(memoryId)}/retract`, reason ? { reason } : {});
  }

  // ---- routing
  models(): Promise<{
    models: { id: string; provider?: string; local?: boolean }[];
    evidence: ModelEvidenceView[];
    settings: Record<string, unknown>;
  }> {
    return this.get('/models');
  }

  pins(all = false): Promise<{ pins: RoutingPinView[] }> {
    return this.get(`/routing/pins${all ? '?all=true' : ''}`);
  }

  pin(body: {
    scope: 'project' | 'kind' | 'role' | 'task';
    target?: string;
    model?: string;
    mode?: string;
    note?: string;
  }): Promise<{ pin: RoutingPinView }> {
    return this.post('/routing/pins', body);
  }

  unpin(pinId: string): Promise<{ pin: RoutingPinView }> {
    return this.post(`/routing/pins/${encodeURIComponent(pinId)}/revoke`);
  }

  // ---- worktrees, policy
  worktrees(
    all = false,
  ): Promise<{ dir: string; worktrees: (WorktreeView & { present: boolean; uncommitted: number | null })[] }> {
    return this.get(`/worktrees${all ? '?all=true' : ''}`, { timeoutMs: TIMEOUTS.worktrees });
  }

  pruneWorktrees(): Promise<{ removed: string[]; kept: { path: string; reason: string }[] }> {
    return this.post('/worktrees/prune', {}, { timeoutMs: TIMEOUTS.worktrees });
  }

  policy(): Promise<PolicyView> {
    return this.get('/policy');
  }

  trustPolicy(looseningHash: string): Promise<PolicyView> {
    return this.post('/policy/trust', { loosening_hash: looseningHash });
  }

  // ---- control
  pause(reason?: string): Promise<ControlResult> {
    return this.post('/control/pause', reason ? { reason } : {}, { timeoutMs: MEDIUM });
  }

  resume(): Promise<ControlResult> {
    return this.post('/control/resume');
  }

  halt(reason?: string): Promise<ControlResult> {
    return this.post('/control/halt', reason ? { reason } : {}, { timeoutMs: MEDIUM });
  }

  /** Stops Friday gracefully (plan §5.2); the page then shows "Friday stopped". */
  stopDaemon(): Promise<{ ok: boolean }> {
    return this.post('/daemon/stop');
  }

  // ---- files (the scope picker, plan §5.11)
  files(dir = ''): Promise<FilesListing> {
    return this.get(`/files?dir=${encodeURIComponent(dir)}`);
  }

  matchFiles(globs: string[]): Promise<GlobCounts> {
    return this.post('/files/match', { globs });
  }

  // ---- agents
  agents(): Promise<{ agents: AgentView[] }> {
    return this.get('/agents');
  }

  harness(harnessId: string): Promise<HarnessEntry> {
    return this.get(`/harnesses/${encodeURIComponent(harnessId)}`);
  }

  agentHosts(refresh = false): Promise<{ hosts: AgentHost[] }> {
    return this.get(`/agent-hosts${refresh ? '?refresh=true' : ''}`, { timeoutMs: 60_000 });
  }

  agentProcesses(): Promise<AgentProcessesView> {
    return this.get('/agent-processes');
  }

  launchAgent(body: AgentLaunchRequest): Promise<{ process: AgentProcess }> {
    return this.post('/agent-processes', body, { timeoutMs: 60_000 });
  }

  stopAgent(agentKey: string): Promise<{ process: AgentProcess }> {
    return this.post(`/agent-processes/${encodeURIComponent(agentKey)}/stop`, {}, { timeoutMs: 30_000 });
  }

  /** Starts a remembered agent again (plan FD-24). */
  startAgent(agentKey: string): Promise<{ process: AgentProcess }> {
    return this.post(`/agent-processes/${encodeURIComponent(agentKey)}/start`, {}, { timeoutMs: 60_000 });
  }

  forgetAgent(agentKey: string): Promise<{ ok: boolean }> {
    return this.post(`/agent-processes/${encodeURIComponent(agentKey)}/forget`, {}, { timeoutMs: 30_000 });
  }

  /** What `harness config claude-code` would change (plan §5.10). */
  claudeSetupPlan(agentKey: string): Promise<ClaudeSetupPlan> {
    return this.get(`/agent-setup/claude-code?agent=${encodeURIComponent(agentKey)}`, { timeoutMs: TIMEOUTS.setup });
  }

  claudeSetupApply(agentKey: string): Promise<ClaudeSetupResult> {
    return this.post('/agent-setup/claude-code', { agent_key: agentKey }, { timeoutMs: TIMEOUTS.setup });
  }

  // ---- preferences: the project's copy, which outlives the page's origin (plan §6 rule 8)
  /** The preferences the daemon keeps for this project; null before the first save. Untrusted, like storage. */
  uiPrefs(): Promise<{ prefs: Record<string, unknown> | null }> {
    return this.get('/ui/prefs');
  }

  /** `keepalive` only for the copy sent as the page hides, so closing it does not cancel the save. */
  saveUiPrefs(prefs: object, opts?: HttpRequestOptions): Promise<{ ok: true }> {
    return this.post('/ui/prefs', { prefs }, opts);
  }

  // ---- session
  logout(): Promise<{ ok: boolean }> {
    return this.post('/ui/logout');
  }

  loginCode(): Promise<UiLoginCode> {
    return this.post('/ui/login-codes');
  }
}

/** A fresh idempotency key for one user action. */
export function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
