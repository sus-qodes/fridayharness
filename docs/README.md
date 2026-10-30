# Friday: the backend build kit

**Friday** is a local control plane above AI coding hosts: Claude Code, Codex, Cursor, Gemini CLI, Antigravity, OpenCode and DeepSeek Harness.
- **Friday owns:** what a project is trying to achieve, the plan and its tasks, who works on what, the context each agent receives, how agents communicate, what they may do, which model runs each task, whether "done" is real, and how work recovers when a host fails.
- **The hosts own:** the agent loop and tool execution.
- **Git owns:** the code. It stays the only code truth.

This folder is the complete specification of Friday's backend: the daemon, the CLI, every package, every host adapter and every test. From it alone, an AI coding agent builds Friday exactly, on one machine or split over several. This file is the index: it says what each document holds, how the work is divided, and what to read before building each part.

The tool policy is five compact default tools for spawned attempts and 25 tools for attached sessions. Task-specific graph, symbolic-edit, failure-learning and full-output retrieval tools stay available to attached sessions. Follow [the MCP reference](reference/mcp-tools.md#5-the-spawned-set) for the exact sets and operation-availability rules; artifact retrieval retains its ownership checks, redaction and paging.

## Start here

1. **Everyone, before writing code**, reads:
   - [OVERVIEW.md](OVERVIEW.md): what Friday is, its principles, its processes, the life of a goal, and the glossary;
   - [DOMAIN.md](DOMAIN.md): the entities, identifiers, state machines and invariants;
   - [CONVENTIONS.md](CONVENTIONS.md): how code, tests and commits are written here;
   - [LESSONS.md](LESSONS.md) §1: the rules that prevent the costly mistakes;
   - [SETUP.md](SETUP.md): then set up the machine exactly as it says.
2. **Then the plan:** [BUILD_PLAN.md](BUILD_PLAN.md) gives the phases, the order, the split over machines and the gates.
3. **Then each assigned segment:** read its document in [segments/](segments/) completely, including §9 Pitfalls, then the reference documents it names. Build it step by step (its §11) until its exit gate (its §12) passes. The [test catalogue](reference/test-catalogue.md) lists every test the segment must have.

## Giving a machine its share of the work

Open a new Claude Code session in the repository on that machine, with this kit in `docs/`, and paste the following, adjusted to the segments it builds:

```text
You are building part of Friday's backend from the build kit in docs/.
Read docs/README.md, docs/OVERVIEW.md, docs/DOMAIN.md, docs/CONVENTIONS.md, docs/LESSONS.md (section 1) and docs/BUILD_PLAN.md first.
Your segments, in this order: S03, S04, S05.
For each segment: read its document in docs/segments/ in full, then the reference documents it names;
build it in the order of its section 11, with the tests its section 10 and docs/reference/test-catalogue.md name;
commit after each step; stop when its section 12 exit gate passes.
Do not build other segments. Do not change anything in docs/reference/ or the contracts of S01 and S02
without the owner; if the kit is unclear or wrong, stop and say exactly where.
```

Use the same instructions with any coding host. The [build plan](BUILD_PLAN.md#4-splitting-the-work) gives the ownership and prerequisites; these assignments are ready to paste after choosing the machine count:

| Machines | Machine | Assigned segments in order |
|---|---|---|
| One | A | S00, S01, S10, S02, S06, S07, S08, S12, S03, S04, S05, S09, S11, S13, S15, S16, S17, S18, S14, S19 |
| Two | A | S00, S01, S02, S03, S04, S05, S09, S11, S13; S18 after B lands S15; S14; coordinate S19 |
| Two | B | S10, S06, S07, S08, S12, S16; S15 after A lands S13; S17; assist S19 |
| Three | A | S00, S01, S02, S03, S04, S05, S11, S13, S14; coordinate S19 |
| Three | B | S10, S06, S07, S08, S09; S18 after C lands S15; assist S19 |
| Three | C | S19 shared fixtures early; S12, S16; S15 after A lands S13; S17; assist S19 |

```text
Read docs/README.md and its Start here documents. Use the machine assignment selected in
docs/BUILD_PLAN.md section 4. Build only my assigned segments and their owned files.
Before each step, check that its imported contracts are merged on the integration branch.
Use the same package manifests and lockfile as the other lanes. Send shared daemon wiring
to the S13 owner and CLI wiring to the S14 owner. Report each completed export, its tests,
any deferred consumer gate, and the commit to integrate. Use the backend-only gate until
the frontend lane supplies the shared snapshot files and the UI bundle. Keep the source
behavior in the segment specifications; report an unresolved contradiction with its
file, section and exact contract before choosing a different behavior.
```

The 65 h figure is total planned effort. The dependency-aware elapsed budgets are 44 h for two machines and 41.5 h for three, with immediate handoffs; reserve the rest of a 60–70 h window for setup and integration. [BUILD_PLAN.md](BUILD_PLAN.md) gives the arithmetic and integration gates.

## The documents

| Document | What it holds |
|---|---|
| [README.md](README.md) | This index |
| [tools/validate.mjs](tools/validate.mjs) | Checks the kit's files, section structure, internal links, line endings and lesson-index destinations; run `node docs/tools/validate.mjs` |
| [OVERVIEW.md](OVERVIEW.md) | The product, the principles, the runtime topology, the package map, the life of a goal, and the glossary |
| [DOMAIN.md](DOMAIN.md) | The entities, identifiers, every state machine, and the invariants |
| [BUILD_PLAN.md](BUILD_PLAN.md) | The phases, dependencies, work splits, parallel-work rules, gates and live checks |
| [SETUP.md](SETUP.md) | The machine and toolchain, with exact versions and commands |
| [CONVENTIONS.md](CONVENTIONS.md) | The code, test, portability, commit and working conventions |
| [TESTING.md](TESTING.md) | The test strategy and layout, helpers, scripted hosts, live checks and measurement |
| [SECURITY.md](SECURITY.md) | The security model: promises, enforcement levels, the per-host matrix, secrets, the threat model and the security suite |
| [LESSONS.md](LESSONS.md) | The cross-cutting pitfalls and rules, and the index of every lesson in the kit |
| [OPTIMIZATIONS.md](OPTIMIZATIONS.md) | Every token and time optimization: the rule, its effect, where it lives and how it is checked |
| [segments/](segments/) | One build specification per segment, `S00` to `S19` (table below) |
| [reference/protocol.md](reference/protocol.md) | The harness protocol: transport, authentication, methods, leases, idempotency, errors and versions |
| [reference/http-api.md](reference/http-api.md) | Every HTTP route of the daemon: operator API, protocol, hooks, MCP and user interface |
| [reference/events.md](reference/events.md) | Every event type: payload, emitter and projection |
| [reference/database.md](reference/database.md) | The complete database schema and its migrations |
| [reference/cli.md](reference/cli.md) | Every `friday` command and flag |
| [reference/mcp-tools.md](reference/mcp-tools.md) | Every MCP tool, resource and prompt, for attached and spawned sessions |
| [reference/config.md](reference/config.md) | `.friday/config.yaml`, policy files, environment variables, the private state directory, and the files Friday writes |
| [reference/errors.md](reference/errors.md) | Every `COS-` error code |
| [reference/registry.md](reference/registry.md) | The role registry: roles, candidates, ranks and the generated registry file |
| [reference/test-catalogue.md](reference/test-catalogue.md) | Every test, by segment and file: the acceptance checklist |
| [measurements/README.md](measurements/README.md) | Entry point used by benchmark skip messages; links to measurement procedures and resource budgets |
| [integration/](integration/) | One guide per host: its facts, setup, and live check |
| [runbooks/backup.md](runbooks/backup.md), [runbooks/recovery.md](runbooks/recovery.md) | The operator's procedures for backup and restore, and for recovering lost or failed work |

## The segments

| ID | Segment | Builds | Needs | Hours |
|---|---|---|---|---:|
| [S00](segments/S00-repository.md) | Repository and toolchain | the monorepo, every package skeleton, CI, scripts, test support | none | 1.5 |
| [S01](segments/S01-contracts.md) | Contracts | `@friday/protocol`, `@friday/core`, `schemas/` | S00 | 3 |
| [S02](segments/S02-storage-events.md) | Storage and the event spine | `@friday/db`, `@friday/events`, the schema, the row types and the projector | S01 | 3 |
| [S03](segments/S03-state-core.md) | State core | `FridayState`: transactions, projects, harnesses, sessions, leases, tokens, the outbox | S02, S10 | 2.5 |
| [S04](segments/S04-state-work.md) | State: goals, plans, tasks and work records | the life of goals, plans and tasks; approvals; verification, worktree, reservation, integration and operation records | S03 | 5.5 |
| [S05](segments/S05-state-knowledge.md) | State: messaging, memory, intent, learnings, readiness, usage, snapshots | messaging, memory, intent, learnings, readiness evidence, usage rows, backup and restore | S03 | 4.5 |
| [S06](segments/S06-policy-execution.md) | Policy and execution | `@friday/policy`, `@friday/execution`, the daemon's tool judgment and operations gateway | S01, S02 | 4.5 |
| [S07](segments/S07-git-verification-recovery.md) | Git, worktrees, verification, integration, recovery | `@friday/git`, `@friday/verification`, the daemon's verification, integration, recovery and worktree setup | S01, S06 | 4 |
| [S08](segments/S08-code-graph.md) | Code graph | `@friday/code-graph`, the graph service and its RPC handlers | S02, S07 | 3 |
| [S09](segments/S09-context.md) | Context compiler | `@friday/context`, the daemon's context delivery | S05–S08 | 2.5 |
| [S10](segments/S10-routing-readiness.md) | Routing and readiness | `@friday/routing`, the registry, the daemon's routing | S00 | 2.5 |
| [S11](segments/S11-master-brain.md) | Master Brain | `@friday/planner`, the daemon's brain jobs and routes | S04, S05, S06, S10 | 4.5 |
| [S12](segments/S12-sdk-mcp.md) | SDK, generic adapter, MCP server | `@friday/sdk`, `@friday/adapter-generic`, `@friday/mcp-server` | S01, S06 | 3 |
| [S13](segments/S13-daemon.md) | Daemon | `@friday/daemon`: the HTTP app, the lifecycle, RPC dispatch, the UI backend | S03–S12 | 4 |
| [S14](segments/S14-cli.md) | CLI | `@friday/cli`: every `friday` command | S13, S15–S18 | 4 |
| [S15](segments/S15-claude-code.md) | Claude Code | `@friday/adapter-claude`: attach mode, the hook launcher for every host, spawn mode | S12, S13 | 3 |
| [S16](segments/S16-codex.md) | Codex | `@friday/adapter-codex` | S06, S07, S12 | 1.5 |
| [S17](segments/S17-cursor-gemini.md) | Cursor and Gemini CLI | `@friday/adapter-cursor`, `@friday/adapter-gemini` | S15 | 3 |
| [S18](segments/S18-antigravity-opencode-deepseek.md) | Antigravity, OpenCode, DeepSeek Harness | `@friday/adapter-antigravity`, `@friday/adapter-opencode`, `@friday/adapter-deepseek` | S15 | 2.5 |
| [S19](segments/S19-end-to-end-release.md) | End to end, conformance, release | the conformance suite, scenarios, security suite, measurements and release archive | all | 3 |

[BUILD_PLAN.md](BUILD_PLAN.md) §4 gives the recommended order on one machine and the splits over two or three machines.

## Hosts

| Host | How Friday drives it | Status |
|---|---|---|
| Claude Code | attached (MCP server, skill and hooks) and spawned (headless, restricted) | supported |
| Codex | spawned through its app-server | supported |
| Cursor | attached and spawned, from its documented behaviour | experimental, live check to do |
| Gemini CLI | attached and spawned, from its documented behaviour | experimental, live check to do |
| Antigravity | attached, with hooks | experimental, live check to do |
| OpenCode | spawned through a pinned launcher and a policy plugin | experimental |
| DeepSeek Harness | detected and configured | not dispatchable |
| `meridian` | known by name only | no adapter |

The details per host are in [integration/](integration/), and the enforcement level each host reaches is in [SECURITY.md](SECURITY.md).

## Rules that apply everywhere

1. Friday is a manager above the hosts. It never runs an agent loop of its own.
2. Friday calls a model only as the Master Brain, within a stated budget. Every feature has a token cost of none, bounded or per use ([OPTIMIZATIONS.md](OPTIMIZATIONS.md)).
3. Each concern has one authority: state, memory, the code graph, the planner, verification and the role registry. Nothing builds a second one.
4. Authority is checked in the same transaction that records the effect ([LESSONS.md](LESSONS.md)).
5. Windows first, with no administrator rights. Use `127.0.0.1`, never `localhost`. Judge paths by their real target.
6. No secret is ever placed in config, the registry, events, MCP responses or host configuration ([SECURITY.md](SECURITY.md)).
7. The code is built exactly as the kit says. A gap in the kit is fixed in the kit, not guessed in the code.

## The user interface

The user interface (the Studio, the Notch and the desktop shell in `apps/ui` and `apps/desktop`) is a separate build with its own documents in `docs/frontend/` and `docs/frontend-handoff/`. The backend serves it through:
- the routes in [reference/http-api.md](reference/http-api.md);
- the UI contract listed in [segments/S01-contracts.md](segments/S01-contracts.md);
- the backend described in [segments/S13-daemon.md](segments/S13-daemon.md).

Those three are all a frontend build needs from this kit.
