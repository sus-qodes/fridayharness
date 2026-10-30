# Friday architecture

Friday is a local control plane above AI coding hosts. It owns intent, goals, plans, tasks, assignment, policy, context, communication, model routing, verification, integration and recovery. Claude Code, Codex, Cursor, Gemini CLI, Antigravity and OpenCode supply their own agent loops and execute their own tools. DeepSeek Harness is detectable and configurable but is not dispatchable. The vendor `meridian` is a protocol name with no adapter. Git is the authority for source content and revisions.

Read [DOMAIN.md](DOMAIN.md) for the vocabulary and state machines, [SECURITY.md](SECURITY.md) for the enforcement boundary, and [BUILD_PLAN.md](BUILD_PLAN.md) for ownership and build order. Exact public contracts are in [S01](segments/S01-contracts.md); exact tables and events are in [database](reference/database.md) and [events](reference/events.md).

## 1. Rules of the architecture

| Rule | Implementation and implication |
|---|---|
| Hosts own the agent loop | An adapter translates Friday's task protocol into a host session. Friday does not implement a second coding agent loop. |
| One authority per concern | `FridayState` owns domain writes; `MemoryService` owns memory; `CodeGraph` owns source facts; `MasterBrain` owns planning and delegation; verification judges work; the role registry owns model rank. A projection, UI or adapter does not become another authority. |
| Git owns code | Events describe work and decisions. They do not replace git commits, branches, working trees or the content verified. |
| State changes are event first | A command validates its authority and transition, appends redacted events, and projects their effects within the same database transaction. Publication follows commit. Operational records such as leases, outbox acknowledgements and brain jobs have the explicit direct-write rules in S02/S03/S11. |
| Authority is checked at the effect | An asynchronous preparation is followed by a check of live task, run, policy and usable grants where its effect commits. An outdated result is retried within its bound or refused. |
| Model calls are bounded | Friday's own model calls belong to the Master Brain: plan, replan, role classification or intent drafting. Dispatch, graph queries, policy, memory search and event processing are deterministic. Worker hosts spend their own tokens. |
| Every feature has a token cost class | `none` means deterministic records and computation, `bounded` means an explicitly capped model call on a stated occasion, and `per use` means content a host's model receives on a tool call or session. See [OPTIMIZATIONS.md](OPTIMIZATIONS.md). |
| Runtime data is local | The daemon binds `127.0.0.1`; source, events, memory, graph facts and routing records remain local. A locally approved remote Master Brain call sends bounded, redacted context to the user's provider endpoint. |
| Windows works without administrator rights | Use a user installation of pnpm, `.cmd` shims where required, real-target path checks, explicit process groups and checked private-directory permissions. |
| Concurrent work has an owner | One live writer works in a checkout; spawned tasks normally use task worktrees. File reservations protect configured conflict-prone paths across worktrees. Shared implementation files have one build lane owner. |
| Completion is a claim until verified | `agent.completion_claim` moves a task to `READY_FOR_VERIFICATION`. Only a passing Friday verification moves it to `COMPLETED`; a goal also waits for integration. |

The time budgets in [BUILD_PLAN.md](BUILD_PLAN.md) are planning estimates. Passing the specified gates establishes correctness; elapsed time does not establish it.

## 2. Runtime topology

```text
operator CLI -------------------- operator HTTP API ------------------+
browser UI ---------------------- UI session / UI API ----------------+
                                                                    |
attached host -> friday-mcp (stdio) -> harness RPC / durable stream ---+-> daemon
attached host -> hook launcher -----> host hook HTTP route -----------+    |
                                                                    |    +-> FridayState -> SQLite/event spine
spawn adapter -> harness RPC / stream -------------------------------+    +-> context compiler -> graph/git/memory
    |                                                                    +-> policy / execution gateway
    +-> one host process tree per attempt                                 +-> verification / integration / recovery
    +-> attempt-owned tools endpoint or client-served tools                +-> Master Brain -> chosen provider
    +-> task worktree
```

### 2.1 Processes and interfaces

| Surface | Lifetime and authority | Owner |
|---|---|---|
| Daemon | One live daemon per project clone, with a lock and discovery record. Serves HTTP on `127.0.0.1` at a chosen port; a tracked fixed port requires this clone's trust. Holds state, policy, jobs, verification and integration managers. | [S13](segments/S13-daemon.md) |
| `friday-mcp` | One stdio MCP server per attached session. Discovers the daemon, registers with bootstrap authority, and keeps the returned harness credential in its own process. `friday-local-mcp` is its other executable name. | [S12](segments/S12-sdk-mcp.md) |
| Hook launcher | Host-started, short-lived process. Normalizes host events, performs protected-path checks locally, discovers the daemon and posts the event. It is the common launcher for supported hooked hosts. | [S15](segments/S15-claude-code.md), S17/S18 |
| Spawn adapter | A long-lived Friday client for an agent key. Receives durable starts and resumptions, creates host process groups, mediates the host's available approval surface and records the attempt outcome durably. | S15–S18 |
| CLI | Operator process. Uses local discovery and the operator token; command handlers call the daemon or perform the explicitly local setup, credential, trust and restore operations. | [S14](segments/S14-cli.md) |
| UI backend | Static assets, sign-in, session, preferences, snapshots and event delivery are served by the daemon. The UI bundle and desktop shell are separate builds. | [HTTP API](reference/http-api.md), S13 |

The daemon has no general MCP endpoint. `friday-mcp` is stdio; the spawn adapters own their per-attempt tool endpoints. Codex receives its tools through its client protocol. Do not wire an adapter-owned endpoint into the daemon API.

### 2.2 Locations

`packages/sdk/src/discovery.ts` resolves the main git worktree through `git rev-parse --path-format=absolute --git-common-dir`, provided it contains `.friday/config.yaml`; otherwise it walks upward for that config. Linked task worktrees discover the same main project. `checkoutRoot` separately identifies the checkout containing the host's current folder.

| Data | Location and derivation |
|---|---|
| Project definition | `<main-root>/.friday/config.yaml`; tracked, no credentials. Project policies and harness configuration are under `.friday/policies/` and `.friday/harness/`. |
| Project runtime | `<main-root>/.friday/project.db`, logs/cache/runtime pointers and artifacts as catalogued in [config](reference/config.md). Runtime files are ignored and protected from agent tools. |
| User state, Windows | `%LOCALAPPDATA%/Friday`; fallback is `<home>/AppData/Local/Friday`. |
| User state, POSIX | `<XDG_STATE_HOME>/friday`, or `<home>/.local/state/friday`. |
| State override | `FRIDAY_STATE_DIR`, resolved to an absolute path. |
| Clone key | `<project_id>-<8 hex of sha256(root)>`; the root is lowercased on Windows before hashing. The project root is resolved through its real path by discovery. |
| Private project directory | `<stateDir>/projects/<project_key>/`; holds discovery, lock, operator/bootstrap tokens, local provider approvals and per-clone runtime configuration. Permissions are checked, not inferred from the profile directory. |
| User credential store | `<stateDir>/credentials/<name>.key`; provider endpoint preferences use `<name>.json`. Secrets are shared by the user's projects, provider permission is per clone. |
| Install descriptor | `<stateDir>/install.json`; paths to the installed Node, the CLI and the MCP server entry point. `daemon_entry` is always `null`: the daemon runs inside the CLI (`friday run`), so no separate daemon launcher exists. |
| Task worktree base, Windows | `%LOCALAPPDATA%/friday-worktrees`. |
| Task worktree base, POSIX | `<XDG_STATE_HOME>/friday-worktrees`, or `<home>/.local/state/friday-worktrees`. |
| Worktree overrides | `FRIDAY_WORKTREES_DIR`; otherwise, when `FRIDAY_STATE_DIR` is set, `friday-worktrees` beside that state directory. |
| Task worktree | `<worktreesDir>/<8-hex-root-key>/<last-8-characters-of-task-id>` on `friday/<task_id>`. A goal task starts from `friday/goal-<goal_id>`. |

Private state and task worktrees are siblings by default. A textual path segment `Friday` denotes private state; `friday-worktrees` is not private state. Paths that need to survive a move or restore use the relative formats specified by their owner.

## 3. Package map

Every package declares ESM and owns its public `src/index.ts` exports. The exact manifests, external version ranges and resolved versions are in [S00](segments/S00-repository.md). The following map is generated from the package manifests; arrows point from a consumer to its workspace dependency.

| Package | Folder | Owner | Workspace dependencies |
|---|---|---|---|
| `@friday/cli` | `apps/cli` | S14 | `@friday/adapter-antigravity`, `@friday/adapter-claude`, `@friday/adapter-codex`, `@friday/adapter-cursor`, `@friday/adapter-deepseek`, `@friday/adapter-gemini`, `@friday/adapter-opencode`, `@friday/daemon`, `@friday/db`, `@friday/git`, `@friday/protocol`, `@friday/routing`, `@friday/sdk` |
| `@friday/daemon` | `apps/daemon` | S13 | `@friday/code-graph`, `@friday/context`, `@friday/core`, `@friday/db`, `@friday/events`, `@friday/execution`, `@friday/git`, `@friday/planner`, `@friday/policy`, `@friday/protocol`, `@friday/routing`, `@friday/sdk`, `@friday/state`, `@friday/verification` |
| `@friday/desktop` | `apps/desktop` | frontend | none |
| `@friday/ui` | `apps/ui` | frontend | none |
| `@friday/adapter-antigravity` | `packages/adapters/antigravity` | S18 | `@friday/adapter-claude`, `@friday/protocol`, `@friday/sdk` |
| `@friday/adapter-claude` | `packages/adapters/claude` | S15 | `@friday/adapter-generic`, `@friday/daemon`, `@friday/execution`, `@friday/git`, `@friday/mcp-server`, `@friday/policy`, `@friday/protocol`, `@friday/sdk`, `@friday/state` |
| `@friday/adapter-codex` | `packages/adapters/codex` | S16 | `@friday/adapter-generic`, `@friday/execution`, `@friday/git`, `@friday/mcp-server`, `@friday/protocol`, `@friday/sdk` |
| `@friday/adapter-cursor` | `packages/adapters/cursor` | S17 | `@friday/adapter-claude`, `@friday/adapter-generic`, `@friday/execution`, `@friday/git`, `@friday/mcp-server`, `@friday/protocol`, `@friday/sdk` |
| `@friday/adapter-deepseek` | `packages/adapters/deepseek` | S18 | none |
| `@friday/adapter-gemini` | `packages/adapters/gemini` | S17 | `@friday/adapter-claude`, `@friday/adapter-generic`, `@friday/execution`, `@friday/git`, `@friday/mcp-server`, `@friday/protocol`, `@friday/sdk` |
| `@friday/adapter-generic` | `packages/adapters/generic` | S12 | `@friday/protocol`, `@friday/sdk` |
| `@friday/adapter-opencode` | `packages/adapters/opencode` | S18 | `@friday/adapter-claude`, `@friday/adapter-generic`, `@friday/execution`, `@friday/git`, `@friday/protocol`, `@friday/sdk` |
| `@friday/code-graph` | `packages/code-graph` | S08 | `@friday/db`, `@friday/git` |
| `@friday/context` | `packages/context` | S09 | `@friday/code-graph`, `@friday/git`, `@friday/policy`, `@friday/protocol`, `@friday/state` |
| `@friday/core` | `packages/core` | S01 | `@friday/protocol` |
| `@friday/db` | `packages/db` | S02 | `@friday/protocol` |
| `@friday/events` | `packages/events` | S02 | `@friday/core`, `@friday/db`, `@friday/protocol` |
| `@friday/execution` | `packages/execution` | S06 | `@friday/events`, `@friday/policy` |
| `@friday/git` | `packages/git` | S07 | `@friday/protocol` |
| `@friday/mcp-server` | `packages/mcp-server` | S12 | `@friday/adapter-generic`, `@friday/protocol`, `@friday/sdk` |
| `@friday/planner` | `packages/planner` | S11 | `@friday/core`, `@friday/events`, `@friday/policy`, `@friday/protocol`, `@friday/routing`, `@friday/state` |
| `@friday/policy` | `packages/policy` | S06 | `@friday/protocol` |
| `@friday/protocol` | `packages/protocol` | S01 | none |
| `@friday/routing` | `packages/routing` | S10 | none |
| `@friday/sdk` | `packages/sdk` | S12 | `@friday/protocol` |
| `@friday/state` | `packages/state` | S03–S05 | `@friday/core`, `@friday/db`, `@friday/events`, `@friday/protocol`, `@friday/routing` |
| `@friday/verification` | `packages/verification` | S07 | `@friday/core`, `@friday/execution`, `@friday/protocol` |
| `@friday/tests` | `tests` | S19 | none |
| `@friday/test-support` | `tests/support` | S00 | none |

```text
@friday/cli -> @friday/adapter-antigravity, @friday/adapter-claude, @friday/adapter-codex, @friday/adapter-cursor, @friday/adapter-deepseek, @friday/adapter-gemini, @friday/adapter-opencode, @friday/daemon, @friday/db, @friday/git, @friday/protocol, @friday/routing, @friday/sdk
@friday/daemon -> @friday/code-graph, @friday/context, @friday/core, @friday/db, @friday/events, @friday/execution, @friday/git, @friday/planner, @friday/policy, @friday/protocol, @friday/routing, @friday/sdk, @friday/state, @friday/verification
@friday/desktop -> (no workspace runtime dependency)
@friday/ui -> (no workspace runtime dependency)
@friday/adapter-antigravity -> @friday/adapter-claude, @friday/protocol, @friday/sdk
@friday/adapter-claude -> @friday/adapter-generic, @friday/daemon, @friday/execution, @friday/git, @friday/mcp-server, @friday/policy, @friday/protocol, @friday/sdk, @friday/state
@friday/adapter-codex -> @friday/adapter-generic, @friday/execution, @friday/git, @friday/mcp-server, @friday/protocol, @friday/sdk
@friday/adapter-cursor -> @friday/adapter-claude, @friday/adapter-generic, @friday/execution, @friday/git, @friday/mcp-server, @friday/protocol, @friday/sdk
@friday/adapter-deepseek -> (no workspace runtime dependency)
@friday/adapter-gemini -> @friday/adapter-claude, @friday/adapter-generic, @friday/execution, @friday/git, @friday/mcp-server, @friday/protocol, @friday/sdk
@friday/adapter-generic -> @friday/protocol, @friday/sdk
@friday/adapter-opencode -> @friday/adapter-claude, @friday/adapter-generic, @friday/execution, @friday/git, @friday/protocol, @friday/sdk
@friday/code-graph -> @friday/db, @friday/git
@friday/context -> @friday/code-graph, @friday/git, @friday/policy, @friday/protocol, @friday/state
@friday/core -> @friday/protocol
@friday/db -> @friday/protocol
@friday/events -> @friday/core, @friday/db, @friday/protocol
@friday/execution -> @friday/events, @friday/policy
@friday/git -> @friday/protocol
@friday/mcp-server -> @friday/adapter-generic, @friday/protocol, @friday/sdk
@friday/planner -> @friday/core, @friday/events, @friday/policy, @friday/protocol, @friday/routing, @friday/state
@friday/policy -> @friday/protocol
@friday/protocol -> (no workspace runtime dependency)
@friday/routing -> (no workspace runtime dependency)
@friday/sdk -> @friday/protocol
@friday/state -> @friday/core, @friday/db, @friday/events, @friday/protocol, @friday/routing
@friday/verification -> @friday/core, @friday/execution, @friday/protocol
@friday/tests -> (no workspace runtime dependency)
@friday/test-support -> (no workspace runtime dependency)
```

Frontend packages are named to define the interface boundary. Their implementation and build specification are outside this backend kit. Backend UI contracts remain in `@friday/protocol`, and backend HTTP behavior remains in `@friday/daemon`.

## 4. The life of a goal

1. **Intent (S05/S11).** A human proposes and approves project intent, or asks the Master Brain to draft it. The goal records its request, constraints, outcomes, non-goals and definition of done. Inferred planner text is kept distinct from human text. Effective intent versions are content-bound.
2. **Plan (S11/S04).** A local or approved remote planner proposes a schema-validated plan version. Validation checks task keys, dependencies, scopes, role ceilings and parallel writes. A proposal changes no running work.
3. **Approval (S04/S06).** A human approves the proposal by default. Trusted automatic approval is a separate policy choice. Approval rechecks the live plan version and every kept, reworked or dropped task. Materialization, dependency edges, ready transitions and the plan/goal state commit together.
4. **Delegation (S10/S11/S04).** The Master Brain selects an available agent using role fit, cost class and the specified stable ordering. Routing applies hard constraints, role contracts, pins, sensitive-task restrictions and registry rank with readiness filtering. No route that violates a hard constraint produces a start.
5. **Assignment or reservation (S04).** Spawned work creates a run and durable start; attached work is reserved for an agent to claim. A READY reservation is not a file reservation. Claim checks ownership, dependencies and achieved enforcement.
6. **Workspace (S07).** Friday allocates or reuses a task worktree, records the base commit and branch, and installs dependencies using the detected lockfile and trust rules. A failed setup follows its configured refusal/warning policy. A pending workspace receives no executable start.
7. **Context and start (S09/S03/S12).** The compiler assembles a bounded packet under the current read authority. The run stores its intent version and execution root. The durable outbox delivers a current start; acknowledgements and start acceptance do not let an obsolete attempt resume. The host owns its coding loop.
8. **Work and policy (S06/S15–S18).** Every tool surface Friday controls uses the same judgment: protected locations, task/team/role ceilings, policy denies, approvals, file reservations, checkout ownership and pause state. The host's enforcement limits remain visible.
9. **Communication (S05).** Agents communicate with related work through messages and individual deliveries. Requests, responses, acknowledgements, deadlines and escalation are separate state. Text from a peer grants no permission.
10. **Claim (S04).** The agent reports completion with its outcome. This ends its attempt and moves the task to `READY_FOR_VERIFICATION`; it does not establish that acceptance criteria pass.
11. **Verification (S07/S04).** Friday runs deterministic analysis and the configured checks against the precise content and authority it records. A pass moves the task to `COMPLETED`; failure moves it to `FAILED`; an interrupted judgment returns it to `READY_FOR_VERIFICATION`. Eligible learning proposals are promoted through the memory service inside the verdict transaction.
12. **Integration (S07/S04).** Verified task-branch work is merged into the goal branch only after merged-content checks pass. Conflict or failed checks record an outcome and escalation. Reservations end for every integration outcome. Dependents become READY only when prerequisite work is available where they start.
13. **Goal completion (S04/S11).** The goal becomes `COMPLETED` and its active plan becomes `COMPLETED` only when every goal task is completed and integrated or cancelled, with at least one completed task.

### 4.1 Failure and control paths

| Trigger | Result and owner |
|---|---|
| Verification fails | The task is `FAILED`; rework goes through `REWORK` to `READY`. A compatible resumable host can continue its recorded session with verification feedback. S04/S07/S11 and its adapter specify the bounds. |
| Host start, auth, transport, runtime, timeout or rate-limit failure | The current attempt records the host failure separately from task-quality failure. Readiness benches the host/model or marks authentication failed; routing can choose the next eligible host without changing registry rank. S03/S04/S10. |
| Heartbeats stop | The lease expires, grace applies, active work becomes `HARNESS_LOST` and the run `SUSPENDED`. Recovery can resume the same run or release it for another attempt; it does not silently discard work. S03/S07. |
| Daemon restarts | Orphaned checks and operations are interrupted; durable jobs and outbox state resume under their rules. Adapters reconnect and tokens are refreshed. A status alone is not evidence that a child process stopped. S03/S11/S13/S15–S18. |
| Human pauses | Assignment, durable starts, mutating policy calls, operations, automatic verification/integration and Master Brain activity check pause at the effect. Attached sessions stop at governed calls; spawned sessions that can write without an approval are stopped with work preserved. S06/S13. |
| Human cancels or halts | Current attempt authority ends, grouped children are stopped and work is preserved according to recovery/worktree rules. Cancellation and process termination are separate effects that must both be checked. S04/S07/S13. |
| Policy, grant, task or intent changes during asynchronous preparation | The committing operation rechecks the relevant authority. Context recompiles within its retry bound; verification is interrupted if its judgment is invalidated. Intent changes appear explicitly in packets and verification records. S04–S09. |
| Backup or move | Snapshots contain domain data and redacted artifacts, not live credentials. Restored sessions register separately; inspection copies cannot run as live projects. Provider approval is local to the destination clone. S05. |

## 5. Enforcement summary

| Level | Meaning | Evidence and limit |
|---|---|---|
| `L0` | Observation and coordination | No proof that a Friday policy hook governs tool execution. |
| `L1` | Governed host surfaces | Hook evidence or a spawn adapter's declared approval surface. `enforcing`, `degraded`, `unverified` and `reported` describe the evidence and failure behavior, independently of the level. It is not OS isolation. |
| `L2` | Isolated execution | No supplied adapter provides this level. Requiring L2 prevents claims by these adapters. |

See [SECURITY.md](SECURITY.md) for the exact version thresholds, host restrictions, protected-path rules and known gaps. A supported adapter is not a promise that all host tools are intercepted.

## 6. Glossary

| Term | Meaning |
|---|---|
| Actor | Authenticated origin of a command: `human`, `system`, `agent`, `harness` or `master_brain`. |
| Adapter | Friday code translating a host's process/protocol into the Friday harness protocol. |
| Agent | Stable project identity identified by `agent_id` and human-readable `agent_key`, with a role and current work. |
| Approval | Human decision about an exact capability/target under specified policy and task/run bindings. |
| Attempt | One `task_runs` row, identified by `run_id`, with an integer `attempt` within its task. |
| Attach mode | Friday tools/hooks join a host session the user starts; the agent claims reserved work. |
| Bench | Time-bounded or explicitly cleared failed readiness evidence excluding a host/model from dispatch. |
| Brain job | Durable operational work item consumed by the Master Brain, with status, attempts and retry time. |
| Candidate | Host/model entry for a role in the registry, with a declared rank. |
| Capability | Named action class such as `file.write`, `operation.run` or `mcp.call`, evaluated with an exact target. |
| Cost class | `free`, `cheap` or `standard`; delegation cost ordering, distinct from monetary usage and feature token cost classes. |
| Delivery | One message's recipient-specific queued/delivered/acknowledged or ended state. |
| Enforcement level | L0/L1/L2 scope of governance; its status separately records the strength of evidence. |
| Escalation | Durable question requiring a human decision, with an explicit kind and options. |
| Execution root | Checkout in which the particular run works; normally its task worktree for spawn mode. |
| Failover | Routing a task to another eligible host/model after a host failure, with that failure in its handoff summary. |
| File reservation | Exclusive task ownership of a configured conflict-prone path/glob across checkouts. |
| Goal | User request and intent whose accepted plan organizes work. |
| Goal branch | `friday/goal-<goal_id>`; integration destination for its task branches. |
| Goal intent | Goal objective and human/inferred constraints, outcomes, non-goals and definition of done. |
| Handoff summary | Bounded deterministic summary of attempts, verification and failures given to continuing work. |
| Harness | Registered Friday client session associated with a vendor, capabilities, lease and token. |
| Host | External coding application or CLI supplying the model loop and tools. |
| Inbox | Recipient's pending or queryable message deliveries; viewing does not itself decide approvals. |
| Integration | Recorded attempt to place verified task work onto the goal branch after merged-content checks. |
| Intent version | `p<project-version>.g<goal-revision>.<6-hex-content-hash>`, binding work to effective intent. |
| Learning | Task-origin proposal promoted into project memory by a passing verification or a human. |
| Lease | Heartbeat-based evidence that a harness session remains live, with explicit expiry and grace. |
| Memory | Typed, scoped, provenance-bearing durable fact under the memory service's authority rules. |
| Operation | Trusted fixed project command run by Friday's execution gateway, optionally with brokered credentials. |
| Outbox | Durable daemon-to-harness protocol delivery queue; distinct from an agent message delivery. |
| Packet | Bounded compiled context for a particular recipient, work and read authority. |
| Plan | Goal's versioned proposal and accepted task structure; identified by `plan_id`. |
| Plan revision | Integer `version` within that plan, with proposal/decision status and optional superseded version. |
| Plan task | Keyed draft/materialized row within one plan version; distinct from the live task identity. |
| Project | Configured git main checkout plus clone-local state and private credentials. |
| Project intent | Human-approved versioned purpose and constraints shared by the project's work. |
| Rank | Registry's declared role ordering; measured outcomes do not rewrite it. |
| Readiness | Time-sensitive machine evidence of installation, configuration, handshake, authentication, live checks and benches. |
| Rebind | Record a run's execution root/base/branch under explicit worktree recovery checks. |
| Recovery | Human-governed resumption, release, preservation or cancellation of interrupted work. |
| Reservation | A READY task held for an agent key; does not lock any file. |
| Role | Work responsibility resolved through the role contract and its model candidates; an agent also declares a role. |
| Role registry | Versioned local data defining roles, aliases, candidates, costs and rank. |
| Run | The persisted attempt record; synonymous with attempt, never with an entire goal. |
| Session | One attached or spawned host interaction, which may be resumed across attempts where supported. |
| Spawn mode | Friday adapter starts and owns a host process tree for assigned work. |
| Task | Live work item with acceptance criteria, scope, dependencies and state machine. |
| Task branch | `friday/<task_id>` containing one task's work. |
| Tick | Deterministic housekeeping for leases, starts, deadlines, reservations, budgets and reply recovery. |
| Trust | `friday policy trust --yes` accepts the exact tracked loosenings on this clone; tightening needs no such acceptance. |
| Usage row | Joined attempt-level token/cost/tool/check reporting, with unknown values distinguished from zero. |
| Verification | Friday's content- and authority-bound judgment of an agent's completion claim. |

## 7. Architecture checks

**CLAUDE:** keep this map aligned with every backend package manifest, S01's public types, S02's schema, S13's wiring and the relevant adapter's real protocol. A package edge or public status has one owning segment.

**HERE:** before handing segments to separate machines, check that every consumer has its named provider and that S13 owns shared daemon wiring. The acceptance tests and exact build gates are in [TESTING.md](TESTING.md) and [BUILD_PLAN.md](BUILD_PLAN.md).
