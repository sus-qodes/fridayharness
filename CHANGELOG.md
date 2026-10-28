# Changelog

All notable changes, one section per milestone tag. Format: what changed for someone using or building Friday.

## Unreleased — M4 context engine

- **M4a, the code as it is in each checkout:**
  - `@friday/git` reads one execution root (the main checkout now, a task worktree from M5): status, branch and upstream, worktrees, log and line counts.
  - The **dirty-content identity** names "the code as it is here": the HEAD commit plus a hash of the content of every uncommitted change. An edit changes it, a timestamp alone does not, and undoing the edit restores it. Context caching (M4d) and verification (M5) build on it.
  - Friday never takes git's index lock while reading. **Fix:** the context Friday gives a session at start used plain `git status`, which could rewrite the index while an agent was committing.
  - Decision: ADR-0019.

## Unreleased — M3.5 second-harness spike (Codex app-server)

- **Codex app-server 0.162.1, tried for real** (8 short turns on the owner's ChatGPT plan, approved): it registers, takes Friday's context and tasks, asks for approval before commands and file writes (and respects a refusal), resumes after its process dies, and reports its model and any reroute. Report: [docs/integration/codex-spike.md](docs/integration/codex-spike.md).
- **Cancelling a turn does not stop the command Codex started**, and Codex does not report its process id, so the M8 adapter ends the process tree itself.
- **Conformance is vendor-neutral and checks behaviour:** adapters implement `ConformanceHarness`; the cancel case now proves the work stopped, and a self-check shows a host that ignores cancellation fails it.
- Recorded protocol catalogue and sanitized transcripts in `tests/fixtures/codex/v0.162.1/`; spike scripts in `scripts/spikes/codex/`.

## Unreleased — M3.1 stabilization (M3 review 2026-10-14)

An independent review of M3 found nine gaps (R01–R09). All were confirmed: R01–R06 by failing regressions written before the fixes, R07–R09 by source review and measurement ([disposition](docs/reviews/2026-10-14-m3-review-disposition.md), plan H.8).

- **One rule for every address (R01):** an agent reaches a role only within related work, and a delayed delivery goes to a related task, not to any agent of that role. Humans still reach any agent of a role.
- **Only an authorized reply settles a request (R02):** `response_to` is accepted only on responses, by the protocol and by the service.
- **Only the receiving session acknowledges (R03):** shadow sessions are refused, and a delivery must be read before it is acknowledged. A restarted session receives what its predecessor left, at once.
- **Crash-safe escalation (R04):** an escalation commits with its marker, and an answer with its reply. Answers recorded without a reply by older builds are sent.
- **Answered questions stop asking (R05):** the other recipients' deliveries become `resolved`. Those who had read the question get a short "Resolved:" note from Friday, and the Stop hook no longer holds a session for it.
- **Relocatable snapshots (R06):** snapshots are JSON Lines files recorded relative to the artifacts folder, so a moved or restored project still finds them.
- **A verified backup (R07):**
  - built in a staging folder and renamed when complete;
  - credentials removed;
  - a manifest read from the copy, with every artifact's sha256;
  - links not followed, and missing artifacts reported.
- **Restore and restart (R08):** `friday restore --from <dir>` checks the backup, sets the current state aside and puts the backup in. At the next start, sessions register again and get one lease to come back. An interrupted model call needs this clone's approval before it is retried. Replay output is an inspection copy Friday refuses to run on.
- **Maintenance no longer holds the daemon (R09):** reads use a second connection, copies use SQLite's online backup in steps, and rebuilds run in batches. On 160,001 events the longest stall fell from 5.5 s to 187 ms. A paused or sleeping machine no longer marks every session lost.
- **Portability:** `pnpm check:portability:local` also checks untracked files before they are staged.

## Unreleased — M3 communication authority, replay and backup

- **M3a, messages through Friday:**
  - Agents send with `friday_communicate`: to an agent, `role:<role>` (Friday picks a related agent with that role), `task:<id>`, `dependencies`, `dependents`, `master` or `human`.
  - Friday routes only between related work and refuses the rest.
  - Every message has one delivery per recipient, read with `friday_check_inbox` (reserved for the session, delivered again if not acknowledged, dead-lettered after five tries) and acknowledged with `friday_acknowledge`, only by its own recipient.
  - A request settles when it is answered, and the answer shares its correlation id.
  - Inbox items say who sent them, how their work relates to yours and how far to trust them; no message ever grants authority.
  - Humans use `friday say`, `friday inbox human|master|<agent>` and `friday messages`.
  - The Master Brain reads what is addressed to it and uses the reported facts when it revises a plan.
  - Decision: ADR-0017; guide: [docs/messaging.md](docs/messaging.md).
- **M3b, delivery under failure:**
  - Messages expire visibly after 24 hours.
  - An unanswered blocking request reaches a human at its deadline, and the human's answer becomes the reply.
  - A full inbox refuses low-value notifications (`COS-2005`) but never requests or urgent messages; senders learn when a recipient is not attached.
  - Claude Code sessions are held at their next stop while urgent messages are unread.
  - The Master Brain's place in the event log is a durable consumer (`event_consumers`).
- **M3c, snapshots, replay and backup:**
  - `friday events snapshot` captures the domain tables with an integrity hash.
  - `friday events replay --into <dir> [--snapshot <id>]` rebuilds everything in an isolated copy (no credentials, nothing sent or started) and says whether it equals the live state.
  - `friday backup --into <dir>` makes a consistent copy of the database and artifacts with a manifest.
  - Corrupt, interrupted, foreign and old snapshots are refused.
  - Decision: ADR-0018; runbook: [docs/runbooks/backup.md](docs/runbooks/backup.md).
- **Gate:** the M3 scenario on fixture-shop (Part 12 §3/§4: role routing, minimal recipient context, correlated answers with facts, an unrelated agent refused; replay equals live).

## Unreleased — M2.5 stabilization (review 2026-10-14)

An independent review found twelve gaps in M1 and M2. All were confirmed in the source and handled ([disposition](docs/reviews/2026-10-14-review-disposition.md), plan H.6).

- **Links and junctions:** policy checks the path a tool names and its real target, so a junction inside a scope no longer reaches other scopes, Friday's runtime files or private state. This holds with the daemon down too.
- **Private folders are verified:**
  - Windows ACLs are read and repaired so only you, SYSTEM and Administrators can open Friday's tokens and keys; POSIX folders need the owner and modes 0700/0600.
  - Friday refuses to write secrets elsewhere.
  - `friday doctor` reports verified access.
- **Planning sends less, and only where you chose:**
  - Context comes from real paths inside the project, skips protected files, is bounded and redacted, and is marked as untrusted source material.
  - Remote planning needs your approval per clone (`friday brain allow-remote [--budget]`, `deny-remote`).
  - The key's endpoint is yours to set (`friday secrets set <name> --base-url`); `base_url` in `config.yaml` is ignored.
- **Honest costs:**
  - Refused or cut-off answers are recorded with their cost; unknown costs are null with a worst-case estimate.
  - Models without a price are not called.
  - The budget is checked before every attempt, including the repair.
- **A Master Brain that survives restarts:**
  - Work is a durable job written with the cursor, and coordination is derived from state.
  - Model calls run in their own lane, so a slow model never stalls delegation.
  - Interrupted calls are recorded and retried, and failing actions are retried, then escalated.
  - A second failure while a revision waits is kept, and a rejected revision with failed tasks asks you how to continue.
- **Fresh approvals:** approving a revision re-checks it against the live plan and tasks; a stale one is refused with `COS-2008` and nothing changes.
- **Your requirements stay yours:** the planner's additions are stored apart. Your constraints and outcomes go into every planning call and every agent's context.
- **Reservations end:** reservations made by delegation or rework expire (15 minutes) or end with their agent's session; `friday task unreserve` releases any reservation.
- **Enforcement from evidence:**
  - A Claude Code session is L1 only after its hooks reach Friday, and is `enforcing`, `degraded` or `unverified` by host version.
  - `security.enforcement_required` and `require_enforcing_hooks` are enforced (`COS-3007`).
  - `friday_whoami` says what the session really has.
- **Smaller fixes:**
  - verification checks no longer inherit API keys or tokens;
  - `friday_acknowledge` says honestly that messaging arrives in M3.
- **Decisions:** ADR-0014 (execution root and worktree location, for M4 and M5), ADR-0015 and ADR-0016. The plan's M3–M8 sections are rewritten with checkpoints, a snapshot contract, revision-bound verification, a second-harness spike (M3.5) and an M8 split.
- **Tests:** 378 across 16 packages.

## Unreleased — M2 Master Brain

- **Goals and plans:** `friday goal create` turns a request into a goal and the Master Brain proposes plan v1. Each task has acceptance criteria, a write scope, a role and dependencies. You approve or reject each version (`friday plan approve|reject`), compare versions (`friday plan diff`), or write the plan yourself (`friday plan propose --file`).
- **Approval** creates the tasks in one transaction. Tasks without open dependencies become READY; dependents start when their prerequisites complete.
- **Delegation** is a deterministic score (role fit, context, record, locality). Spawn-mode agents get the task directly; Claude Code sessions get a reservation. Tasks that would overlap running writes wait.
- **Revisions and questions:** a failed verification produces a revision that reworks, drops or adds tasks. The Master Brain asks a human instead of guessing: on ambiguous intent, on repeated failures, at the revision limit, when no planner is available, after an invalid plan, and over budget. Each question carries the six fields of Part 03 §11.
- **Claude as the planner:** the Anthropic Messages API with structured outputs and a cached project context; `claude-opus-5-5` by default.
  - Planning happens only with `providers.anthropic.allow_remote: true` and a key from `friday secrets set anthropic`, stored per user outside every repository.
  - A daily budget applies, and every call is a `model.called` event with tokens and cost.
  - `provider: fake` replays scripted answers; `provider: none` means humans write plans.
- **More:**
  - the CLI commands `goals`, `goal show|replan|cancel`, `brain status|run-once|calls` and `secrets set|list|remove`;
  - goals and questions on the status page;
  - the goal, rework notes and human decisions in each agent's context;
  - read-only review and research tasks.
- **Tests:** 343 across 16 packages. They cover the planner core, the Master Brain against a real database (including replay), the API and CLI with two parallel agents, the Anthropic provider against a local stand-in, and the M2 gate on fixture-shop with a real `friday run`.

## M1 event spine, daemon, CLI and Claude Code attach

- **Core spine:** protocol schemas with generated JSON Schema and a drift test; the task state machine (Part 14 plus `HARNESS_LOST`, release and wait transitions); an append-only SQLite event store with per-project sequences, redaction and replay; a command bus whose projector is the only writer of domain tables.
- **Daemon (`friday run`):** one per project on `127.0.0.1`, discovery and tokens in the per-user private directory, three token classes, Host and Origin checks, payload limits, leases and reconnect, a durable outbox with poll and SSE delivery, and a read-only status page at `/ui`.
- **CLI (`friday`):** `setup`, `init`, `run`, `status`, `doctor`, `tasks`, `task create|inspect|ready|assign|release|cancel|rework`, `verify`, `harnesses`, `agents`, `events tail`, `approvals`, `escalations`, `token rotate`, `ui`, `daemon stop`, `harness config|doctor claude-code`, and `fixture init`.
- **Policy:** sensitive path classes decided locally by the hook launcher (so they hold with the daemon down), task write scopes, the single-live-writer rule, shell command classes with an autonomy table, and network review.
- **Verification:** `friday verify` runs the project's checks; a completion claim never completes a task by itself.
- **`friday-mcp`:** 14 tools (5 always loaded), resources, prompts and server instructions; it registers as a harness and links to the session's hooks.
- **Claude Code attach:** `friday harness config claude-code` writes the hook launcher, the MCP entry, the hooks, the `friday` skill and an optional `CLAUDE.md` block, with nothing secret or machine-specific in them. Re-runs are idempotent, `--remove` is exact, and `--scope local` and `--print` are supported. `friday harness doctor claude-code` reports the enforcement level reached, including Claude Code folder trust.
- **fixture-shop:** a small demo repository with a byte-identical history on every OS.
- **Tests:** 281 across 15 packages, including conformance, hook contract tests from recorded Claude Code payloads, the bundled launcher end to end, tool coverage, secret scans, worktree discovery, and the M1 demo as a deterministic scenario.
- **Verified live** with Claude Code 2.1.296 (headless): claim, scoped edits, policy denials, verification, COMPLETED.

## M0 skeleton

- Monorepo with pnpm 12 workspaces, Turbo, TypeScript 5.9 project references, Vitest 5 projects and Biome.
- Package skeletons for every M1 package: protocol, core, db, events, state, sdk, policy, verification, mcp-server, generic and Claude Code adapters, daemon, CLI.
- Test helpers in `@friday/test-support`: short temp workspaces with Windows-safe cleanup (including SQLite WAL files), process-tree killing, a fake clock, and deterministic git.
- `.friday/.gitignore` template with a test proving runtime files are ignored and config, policies and harness files stay trackable.
- Claude Code spike against 2.1.296: hook fail-closed behaviour, session linking, tool names and subagent hooks verified; 21 scrubbed hook fixtures recorded.
- CI on Windows and Linux (Node 22 and 24; Node 26 non-blocking), a cache-free install job, and a portability job.
- Documentation: the 16-part specification, errata, ADR-0001 to ADR-0012, security model skeleton, spike results, the plan review, and the build plan.
