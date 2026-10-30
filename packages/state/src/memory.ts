import { createHash } from 'node:crypto';
import { type Actor, FridayError } from '@friday/protocol';
import type { CommandContext } from './bus.js';
import type { Caller, FridayState } from './service.js';

/**
 * Scoped memory with provenance and authority (plan M4c, ADR-0021). Memory is project state:
 * every change is an event, projected into `memories` and `memory_links`.
 */

export const MEMORY_KINDS = [
  'decision',
  'architecture',
  'constraint',
  'convention',
  'bug-pattern',
  'dependency',
  'operational-runbook',
  'human-preference',
  'outcome',
  'learned-risk',
  'unresolved-question',
  'summary',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_SCOPES = ['project', 'team', 'agent', 'task', 'session'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryAuthority = 'human-approved' | 'verified' | 'system' | 'agent';

/** Who records or reads memory. */
export type MemoryActor =
  | { kind: 'agent'; caller: Caller }
  | { kind: 'human'; actor: Actor }
  | { kind: 'master_brain'; actor: Actor }
  | { kind: 'system'; actor: Actor };

export interface MemoryInput {
  scope_type: MemoryScope | 'organization';
  /** Defaults: the project id, the agent's own key, its current task, its session. */
  scope_id?: string;
  kind: MemoryKind;
  subject: string;
  content: string;
  tags?: string[];
  source_events?: string[];
}

export interface MemoryView {
  memory_id: string;
  scope_type: MemoryScope;
  scope_id: string;
  kind: MemoryKind;
  subject: string;
  content: string;
  tags: string[];
  source_events: string[];
  source: { kind: string; id: string };
  authority: MemoryAuthority;
  verification_status: 'verified' | 'unverified';
  status: 'active' | 'superseded' | 'retracted';
  supersedes: string | null;
  superseded_by: string | null;
  contradicts: string[];
  needs_review: boolean;
  created_at: string;
  updated_at: string;
}

export interface RecordResult {
  memory: MemoryView;
  /** The same memory already existed; nothing was recorded. */
  deduplicated: boolean;
  superseded: string[];
  contradicts: string[];
}

export interface SearchQuery {
  query?: string;
  kinds?: MemoryKind[];
  /** Restrict to these scopes (within what the reader may read). */
  scopes?: { scope_type: MemoryScope; scope_id: string }[];
  include_inactive?: boolean;
  limit?: number;
}

export interface SearchHit extends MemoryView {
  score: number;
  /** Why it ranks where it does: text relevance and decay weight. */
  why: { relevance: number; weight: number; uses: number };
}

const RANK: Record<MemoryAuthority, number> = { 'human-approved': 3, verified: 2, system: 1, agent: 0 };
const AUTHORITY_WEIGHT: Record<MemoryAuthority, number> = {
  'human-approved': 1,
  verified: 0.85,
  system: 0.7,
  agent: 0.45,
};
/** Half-life in days; human-approved memories do not decay (Part 04 §9). */
const HALF_LIFE_DAYS: Record<MemoryAuthority, number> = {
  'human-approved': Number.POSITIVE_INFINITY,
  verified: 180,
  system: 90,
  agent: 30,
};
const MAX_CONTENT = 4000;

export const subjectKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const normalized = (s: string) => s.trim().replace(/\s+/g, ' ');
/**
 * The identity of a memory's content (review F14): whitespace is ignored, case is not, because
 * identifiers, paths and literal values differ by case. Prefixed, so it never equals a hash taken
 * before this rule, of lower-cased text (`legacyHash`).
 */
const contentHash = (s: string) =>
  createHash('sha256')
    .update(`v2:${normalized(s)}`)
    .digest('hex');
const legacyHash = (s: string) => createHash('sha256').update(normalized(s).toLowerCase()).digest('hex');
/** Whether a stored memory holds this content: by its hash, or for an older record by its exact text. */
const holds = (row: { content: string; content_hash: string }, content: string) =>
  row.content_hash === contentHash(content) ||
  (row.content_hash === legacyHash(content) && normalized(row.content) === normalized(content));

interface MemoryRow {
  memory_id: string;
  project_id: string;
  scope_type: MemoryScope;
  scope_id: string;
  kind: MemoryKind;
  subject: string;
  subject_key: string;
  content: string;
  content_hash: string;
  tags_json: string;
  source_events_json: string;
  source_kind: string;
  source_id: string;
  authority: MemoryAuthority;
  verification_status: 'verified' | 'unverified';
  status: 'active' | 'superseded' | 'retracted';
  supersedes: string | null;
  superseded_by: string | null;
  needs_review: number;
  created_at: string;
  updated_at: string;
}

export class MemoryService {
  constructor(private readonly state: FridayState) {}

  private exec<T>(name: string, projectId: string, actor: Actor, fn: (ctx: CommandContext) => T, params?: unknown) {
    return this.state.bus.execute({ name, project_id: projectId, actor, params }, fn).result;
  }

  private actorOf(who: MemoryActor): Actor {
    return who.kind === 'agent' ? { kind: 'agent', id: who.caller.agent_id } : who.actor;
  }

  /** Tasks the agent holds or has reserved (the task scopes it may write and read). */
  private tasksOf(projectId: string, agentId: string): string[] {
    const agent = this.state.q.agent(agentId);
    return this.state.q
      .tasks(projectId, { limit: 2000 })
      .filter((t) => t.assigned_agent_id === agentId || t.reserved_for_agent_key === agent.agent_key)
      .filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED')
      .map((t) => t.task_id);
  }

  /** Resolves and checks the scope a memory is written to (ADR-0021 §3). */
  private writeScope(projectId: string, who: MemoryActor, input: MemoryInput): { type: MemoryScope; id: string } {
    if (input.scope_type === 'organization') {
      throw new FridayError(
        'invalid_request',
        'a project daemon has no organization scope; record it in project scope',
      );
    }
    const type = input.scope_type;
    if (!MEMORY_SCOPES.includes(type)) throw new FridayError('invalid_request', `unknown memory scope ${type}`);
    if (who.kind !== 'agent') {
      if (type === 'project') return { type, id: projectId };
      if (who.kind === 'master_brain' && (type === 'agent' || type === 'session')) {
        throw new FridayError('permission_denied', 'the Master Brain writes project, team and task memory only');
      }
      if (!input.scope_id) throw new FridayError('invalid_request', `${type} memory needs a scope_id`);
      return { type, id: input.scope_id };
    }
    const harness = this.state.q.harness(who.caller.harness_id);
    if (harness.shadow) throw new FridayError('harness_shadowed', 'a shadow session cannot record memory');
    const agent = this.state.q.agent(who.caller.agent_id);
    if (type === 'project' || type === 'team') {
      throw new FridayError(
        'permission_denied',
        `agents record only task, agent and session memory, not ${type} memory`,
        {
          rule: 'memory.agent_scope',
        },
      );
    }
    if (type === 'agent') {
      if (input.scope_id && input.scope_id !== agent.agent_key) {
        throw new FridayError(
          'permission_denied',
          "an agent records memory for itself only, not for another agent's scope",
        );
      }
      return { type, id: agent.agent_key };
    }
    if (type === 'session') {
      if (input.scope_id && input.scope_id !== who.caller.harness_id) {
        throw new FridayError('permission_denied', 'an agent records session memory for its own session only');
      }
      return { type, id: who.caller.harness_id };
    }
    const held = this.tasksOf(projectId, agent.agent_id);
    const taskId = input.scope_id ?? agent.current_task_id ?? held[0];
    if (!taskId || !held.includes(taskId)) {
      throw new FridayError(
        'permission_denied',
        `task memory is for a task you hold${taskId ? `; ${taskId} is not yours` : ''}`,
      );
    }
    return { type, id: taskId };
  }

  private provenance(who: MemoryActor): {
    source_kind: string;
    source_id: string;
    authority: MemoryAuthority;
    verification_status: 'verified' | 'unverified';
  } {
    if (who.kind === 'human') {
      return {
        source_kind: 'human',
        source_id: who.actor.id,
        authority: 'human-approved',
        verification_status: 'verified',
      };
    }
    if (who.kind === 'system') {
      return { source_kind: 'system', source_id: who.actor.id, authority: 'verified', verification_status: 'verified' };
    }
    if (who.kind === 'master_brain') {
      return {
        source_kind: 'master_brain',
        source_id: who.actor.id,
        authority: 'system',
        verification_status: 'unverified',
      };
    }
    const agent = this.state.q.agent(who.caller.agent_id);
    return { source_kind: 'agent', source_id: agent.agent_key, authority: 'agent', verification_status: 'unverified' };
  }

  /** The pipeline of ADR-0021 §5: scope, dedupe, contradiction, provenance, all in one transaction. */
  record(
    projectId: string,
    who: MemoryActor,
    input: MemoryInput,
    opts: { idempotency_key?: string } = {},
  ): RecordResult {
    this.check(input);
    const actor = this.actorOf(who);
    return this.state.bus.execute(
      { name: 'memory.record', project_id: projectId, actor, idempotency_key: opts.idempotency_key, params: input },
      (ctx) => this.recordWithin(ctx, projectId, who, input),
    ).result;
  }

  /** What a memory must be before anything is recorded: a subject, content within bounds, a known kind. */
  private check(input: MemoryInput): void {
    const subject = input.subject?.trim();
    const content = input.content?.trim();
    if (!subject) throw new FridayError('invalid_request', 'a memory needs a subject');
    if (!content) throw new FridayError('invalid_request', 'a memory needs content');
    if (content.length > MAX_CONTENT) {
      throw new FridayError(
        'invalid_request',
        `memory content is limited to ${MAX_CONTENT} characters; put longer text in an artifact`,
      );
    }
    if (!MEMORY_KINDS.includes(input.kind)) {
      throw new FridayError(
        'invalid_request',
        `unknown memory kind ${input.kind}; use one of ${MEMORY_KINDS.join(', ')}`,
      );
    }
  }

  /**
   * The same pipeline inside a command that is already open, so another record (a promoted
   * learning, ADR-0034 §7) and the memory it makes commit together or not at all.
   */
  recordWithin(ctx: CommandContext, projectId: string, who: MemoryActor, input: MemoryInput): RecordResult {
    this.check(input);
    const subject = input.subject.trim();
    const content = input.content.trim();
    const scope = this.writeScope(projectId, who, input);
    const prov = this.provenance(who);
    const key = subjectKey(subject);
    const hash = contentHash(content);
    const same = this.rows(
      'SELECT * FROM memories WHERE project_id = ? AND kind = ? AND subject_key = ? AND status = ?',
      projectId,
      input.kind,
      key,
      'active',
    );
    const duplicate = same.find((r) => r.scope_type === scope.type && r.scope_id === scope.id && holds(r, content));
    if (duplicate) return { memory: this.view(duplicate), deduplicated: true, superseded: [], contradicts: [] };
    const superseded: string[] = [];
    const contradicts: string[] = [];
    let needsReview = false;
    for (const old of same) {
      if (holds(old, content)) continue;
      const sameScope = old.scope_type === scope.type && old.scope_id === scope.id;
      const newRank = RANK[prov.authority];
      const oldRank = RANK[old.authority];
      const sameSource = old.source_kind === prov.source_kind && old.source_id === prov.source_id;
      const humanUpdate = prov.authority === 'human-approved' && old.authority === 'human-approved';
      const mayReplace =
        old.authority === 'human-approved' ? humanUpdate : newRank > oldRank || (newRank === oldRank && sameSource);
      if (sameScope && mayReplace) {
        superseded.push(old.memory_id);
      } else {
        contradicts.push(old.memory_id);
        if (newRank <= oldRank) needsReview = true;
      }
    }
    const memory_id = this.state.ids.next('mem');
    ctx.emit({
      type: 'memory.recorded',
      payload: {
        memory: {
          memory_id,
          scope_type: scope.type,
          scope_id: scope.id,
          kind: input.kind,
          subject,
          subject_key: key,
          content,
          content_hash: hash,
          tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))],
          source_events: input.source_events ?? [],
          ...prov,
          supersedes: superseded[0] ?? null,
          needs_review: needsReview,
        },
        contradicts,
      },
      refs: [{ kind: 'memory', id: memory_id }, ...contradicts.map((id) => ({ kind: 'memory' as const, id }))],
    });
    for (const old of superseded) {
      ctx.emit({
        type: 'memory.superseded',
        payload: { memory_id: old, by: memory_id, reason: `superseded by ${prov.source_kind} ${prov.source_id}` },
        refs: [
          { kind: 'memory', id: old },
          { kind: 'memory', id: memory_id },
        ],
      });
    }
    return { memory: this.get(memory_id), deduplicated: false, superseded, contradicts };
  }

  /** A human approves a memory: it becomes human-approved and verified (ADR-0021 §4). */
  approve(projectId: string, actor: Actor, memoryId: string): MemoryView {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human approves memory');
    return this.exec('memory.approve', projectId, actor, (ctx) => {
      const m = this.row(memoryId);
      if (m.status !== 'active') throw new FridayError('invalid_state_transition', `memory ${memoryId} is ${m.status}`);
      ctx.emit({ type: 'memory.approved', payload: { memory_id: memoryId }, refs: [{ kind: 'memory', id: memoryId }] });
      return this.get(memoryId);
    });
  }

  /** Replaces `oldId` with `newId` (a human, or the author of both within its own scopes). */
  supersede(projectId: string, who: MemoryActor, oldId: string, newId: string, reason: string): MemoryView {
    const actor = this.actorOf(who);
    return this.exec('memory.supersede', projectId, actor, (ctx) => {
      const old = this.row(oldId);
      const next = this.row(newId);
      if (old.status !== 'active' || next.status !== 'active') {
        throw new FridayError('invalid_state_transition', 'only active memories supersede or are superseded');
      }
      if (oldId === newId) throw new FridayError('invalid_request', 'a memory cannot supersede itself');
      if (who.kind !== 'human') {
        if (old.authority === 'human-approved') {
          throw new FridayError('permission_denied', 'a human-approved memory is superseded only by a human');
        }
        this.writeScope(projectId, who, {
          scope_type: old.scope_type,
          scope_id: old.scope_id,
          kind: old.kind,
          subject: old.subject,
          content: old.content,
        });
      }
      ctx.emit({
        type: 'memory.superseded',
        payload: { memory_id: oldId, by: newId, reason },
        refs: [
          { kind: 'memory', id: oldId },
          { kind: 'memory', id: newId },
        ],
      });
      return this.get(oldId);
    });
  }

  retract(projectId: string, who: MemoryActor, memoryId: string, reason: string): MemoryView {
    const actor = this.actorOf(who);
    return this.exec('memory.retract', projectId, actor, (ctx) => {
      const m = this.row(memoryId);
      if (m.status !== 'active') throw new FridayError('invalid_state_transition', `memory ${memoryId} is ${m.status}`);
      if (who.kind !== 'human') {
        if (m.authority === 'human-approved')
          throw new FridayError('permission_denied', 'only a human retracts a human-approved memory');
        this.writeScope(projectId, who, {
          scope_type: m.scope_type,
          scope_id: m.scope_id,
          kind: m.kind,
          subject: m.subject,
          content: m.content,
        });
      }
      ctx.emit({
        type: 'memory.retracted',
        payload: { memory_id: memoryId, reason },
        refs: [{ kind: 'memory', id: memoryId }],
      });
      return this.get(memoryId);
    });
  }

  get(memoryId: string): MemoryView {
    return this.view(this.row(memoryId));
  }

  find(memoryId: string): MemoryView | undefined {
    const r = this.state.db.prepare('SELECT * FROM memories WHERE memory_id = ?').get<MemoryRow>(memoryId);
    return r ? this.view(r) : undefined;
  }

  /** The scopes a reader may read (ADR-0021 §3); null means every scope. */
  readScopes(projectId: string, who: MemoryActor): { scope_type: MemoryScope; scope_id: string }[] | null {
    if (who.kind !== 'agent') return null;
    const agent = this.state.q.agent(who.caller.agent_id);
    return [
      { scope_type: 'project', scope_id: projectId },
      { scope_type: 'team', scope_id: agent.role },
      { scope_type: 'agent', scope_id: agent.agent_key },
      { scope_type: 'session', scope_id: who.caller.harness_id },
      ...this.tasksOf(projectId, agent.agent_id).map((id) => ({ scope_type: 'task' as const, scope_id: id })),
    ];
  }

  /** Ranked memories within the reader's scopes (ADR-0021 §6). */
  search(projectId: string, who: MemoryActor, q: SearchQuery = {}, nowIso = this.state.clock.now()): SearchHit[] {
    type ScoringRow = Pick<
      MemoryRow,
      'memory_id' | 'authority' | 'verification_status' | 'updated_at' | 'needs_review' | 'status'
    > & { rank: number; uses: number };
    const db = this.state.db;
    const read = (): SearchHit[] => {
      const allowed = this.readScopes(projectId, who);
      let scopes = q.scopes ?? allowed;
      if (allowed && q.scopes) {
        scopes = q.scopes.filter((s) =>
          allowed.some((a) => a.scope_type === s.scope_type && a.scope_id === s.scope_id),
        );
      }
      const where: string[] = ['m.project_id = ?'];
      const args: (string | number)[] = [projectId];
      if (!q.include_inactive) where.push("m.status = 'active'");
      if (q.kinds?.length) {
        where.push(`m.kind IN (${q.kinds.map(() => '?').join(', ')})`);
        args.push(...q.kinds);
      }
      if (scopes) {
        if (!scopes.length) return [];
        where.push(`(${scopes.map(() => '(m.scope_type = ? AND m.scope_id = ?)').join(' OR ')})`);
        for (const s of scopes) args.push(s.scope_type, s.scope_id);
      }
      const match = ftsQuery(q.query);
      const columns = 'm.memory_id, m.authority, m.verification_status, m.updated_at, m.needs_review, m.status';
      const rows = match
        ? db
            .prepare(
              `SELECT ${columns}, -bm25(memories_fts, 4.0, 1.0, 2.0) AS rank, COALESCE(u.uses, 0) AS uses
               FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
               LEFT JOIN memory_usage u ON u.memory_id = m.memory_id
              WHERE memories_fts MATCH ? AND ${where.join(' AND ')}`,
            )
            .all<ScoringRow>(match, ...args)
        : q.query?.trim()
          ? []
          : db
              .prepare(
                `SELECT ${columns}, 0 AS rank, COALESCE(u.uses, 0) AS uses FROM memories m
                 LEFT JOIN memory_usage u ON u.memory_id = m.memory_id WHERE ${where.join(' AND ')}`,
              )
              .all<ScoringRow>(...args);
      const now = Date.parse(nowIso);
      // Normalize against every permitted match before applying authority and decay. An early
      // SQL limit would change the result; only full records and links wait until selection.
      const best = Math.max(0, ...rows.map((r) => r.rank));
      return rows
        .map((row) => {
          const weight = decayWeight(row, row.uses, now);
          const relevance = match && best > 0 ? Math.max(0, row.rank) / best : 1;
          return {
            row,
            score: round(relevance * weight),
            why: { relevance: round(relevance), weight: round(weight), uses: row.uses },
          };
        })
        .sort((a, b) => b.score - a.score || b.row.updated_at.localeCompare(a.row.updated_at))
        .slice(0, Math.min(Math.max(q.limit ?? 20, 1), 200))
        .map(({ row, score, why }) => ({ ...this.view(this.row(row.memory_id)), score, why }));
    };

    if (db.inTransaction) return read();
    // Keep scope checks, scores, bodies and links on one snapshot without taking a write lock.
    db.exec('BEGIN');
    try {
      const result = read();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure if SQLite has already rolled back the transaction.
      }
      throw error;
    }
  }

  /** Counts a use of each memory (when a context packet includes it; M4d). */
  noteUse(projectId: string, ids: string[], nowIso = this.state.clock.now()): void {
    const up = this.state.db.prepare(
      `INSERT INTO memory_usage (memory_id, project_id, uses, last_used_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(memory_id) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`,
    );
    this.state.db.transaction(() => {
      for (const id of ids) up.run(id, projectId, nowIso);
    });
  }

  private rows(sql: string, ...args: (string | number)[]): MemoryRow[] {
    return this.state.db.prepare(sql).all<MemoryRow>(...args);
  }

  private row(memoryId: string): MemoryRow {
    const r = this.state.db.prepare('SELECT * FROM memories WHERE memory_id = ?').get<MemoryRow>(memoryId);
    if (!r) throw new FridayError('invalid_request', `no memory ${memoryId}`);
    return r;
  }

  private view(r: MemoryRow): MemoryView {
    const contradicts = this.state.db
      .prepare(
        "SELECT to_id AS id FROM memory_links WHERE from_id = ? AND kind = 'contradicts' UNION SELECT from_id FROM memory_links WHERE to_id = ? AND kind = 'contradicts'",
      )
      .all<{ id: string }>(r.memory_id, r.memory_id)
      .map((x) => x.id)
      .sort();
    return {
      memory_id: r.memory_id,
      scope_type: r.scope_type,
      scope_id: r.scope_id,
      kind: r.kind,
      subject: r.subject,
      content: r.content,
      tags: JSON.parse(r.tags_json) as string[],
      source_events: JSON.parse(r.source_events_json) as string[],
      source: { kind: r.source_kind, id: r.source_id },
      authority: r.authority,
      verification_status: r.verification_status,
      status: r.status,
      supersedes: r.supersedes,
      superseded_by: r.superseded_by,
      contradicts,
      needs_review: Boolean(r.needs_review),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Authority × verification × recency × reuse × review (ADR-0021 §6). */
export function decayWeight(
  m: Pick<MemoryRow, 'authority' | 'verification_status' | 'updated_at' | 'needs_review' | 'status'>,
  uses: number,
  nowMs: number,
): number {
  if (m.status !== 'active') return 0;
  const ageDays = Math.max(0, (nowMs - Date.parse(m.updated_at)) / 86_400_000);
  const recency = 0.5 ** (ageDays / HALF_LIFE_DAYS[m.authority]);
  const verification = m.verification_status === 'verified' ? 1 : 0.7;
  const reuse = 1 + Math.min(0.5, 0.1 * Math.log2(1 + uses));
  const review = m.needs_review ? 0.8 : 1;
  return AUTHORITY_WEIGHT[m.authority] * verification * recency * reuse * review;
}

/** Words of the query, each quoted, so user input is never read as FTS5 syntax; null when empty. */
export function ftsQuery(text: string | undefined): string | null {
  const words = (text ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!words.length) return null;
  return words.map((w) => `"${w}"*`).join(' OR ');
}
