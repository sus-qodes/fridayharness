# Changelog

All notable changes, one section per milestone tag. Format: what changed for someone using or building Friday.

## Unreleased — M7 model routing

- **Every run is routed to a model, and the reason is recorded:** your pins first (`friday routing pin` for a task, role, kind or the project, with an expiry), then hard constraints (local only, sensitive work, vision, what the harness can run), then how well each model fits what the task needs, its verified track record once it has enough results, cost and speed by `routing.optimize`, and the guide's preferences. See [docs/routing.md](docs/routing.md).
- **Control or advice:** a harness that applies models (`model_control: set`) gets the model in `task.start`; an attached Claude Code session gets it as a suggestion when it claims the task. The model that actually ran is recorded (adapters report it; Claude Code at session start).
- **Evidence:** each verification result counts for the model that ran, per kind of task. `friday models` shows the registry and the track records; `friday routing explain <task>` shows each decision with its candidates, constraints and fallbacks.
- **Delegation** prefers the agent whose harness can run the better model for the task, at its cost.
- **Laya** (optional, on this machine): asked when a task becomes ready; its choice counts only after `friday laya calibrate` fitted a threshold for its checkpoint, and routing goes on without it when it does not answer.
- Decision: ADR-0031.

## Unreleased — M6 security

- **M6a, permissions that mean one thing:**
  - Agents ask for **capabilities** from one catalogue (`file.write`, `shell.git.push`, `network.read`, `secret.resolve`, …), each with a risk tier you can change (`risk:` in `.friday/config.yaml`).
  - **Requests are judged first.** What the task's scope and the autonomy settings allow is answered at once ("no approval needed"); what is never allowed, such as handing a raw secret to an agent, is refused at once; only real decisions wait for you.
  - **An approval is bound** to the task, the agent's attempt, the exact target and the policy in force. By default it covers **one** use; approve with `--for run` or `--for task` to let it reach further, and `--ttl` to set how long it lasts. A changed policy retires older approvals. Every use is recorded, and `friday approvals revoke <id>` stops later ones.
  - `friday approvals` shows the risk, the task, the reach and the uses. The status page can approve once or reject.
  - Decision: ADR-0027.
- **M6b, the project's own policy, behind a trust boundary:**
  - **Fix:** settings in the tracked `config.yaml` that widen what agents may do (such as `autonomy: { git.push: auto }`, a lower `security.enforcement_required`, `reservations.mode: off`, `master_brain.auto_approve`) were applied as written. A cloned repository could loosen Friday's rules on your machine.
  - Now anything tracked files **loosen waits for your trust** on this clone: `friday policy trust` shows exactly what, `--yes` applies it, and a later change needs trust again. Anything they **restrict applies at once**.
  - **Policy files** in `.friday/policies/*.yaml`: autonomy, risk tiers, **deny rules** (paths no agent changes or reads without a human approving that path) and **team scopes** (the only paths agents of a role may change). See [docs/policy.md](docs/policy.md).
  - `friday policy show`, `friday policy trust`, `friday policy validate`. A file that does not parse applies nothing and is reported.
  - Approvals granted under a policy stop counting when it changes.
  - Decision: ADR-0028.
- **M6c, secrets used without being handed out:**
  - **Operations:** a project declares, under `operations:` in `.friday/config.yaml` or a policy file, the work that needs a secret: a fixed command, its variables, and the stored secrets it needs by name (`credentials: { STRIPE_SECRET_KEY: stripe-test }`). An agent runs one with `friday_run_operation`; Friday runs it with the secret and returns the outcome and the end of the output with the secret removed, in plain form and in common encodings. An agent that asks for the secret itself is refused and pointed at the operation.
  - An operation is loosening: it applies only after `friday policy trust`, and again after any change to it. One that uses a secret needs your approval for each run by default; the request shows what the task changed since it started.
  - **Secrets are encrypted with DPAPI** for your Windows user (`friday secrets set`); elsewhere they stay in a file only you can read. `friday secrets list` shows how each is kept.
  - **Checks run in the execution profile:** a binary from a short list (`node`, `npm`, `pnpm`, `git`, `python`, …), never one inside the project; a minimal environment instead of yours; a time limit for the whole process tree. A check may declare its own `env`; `execution.binaries` and `execution.env_passthrough` add more, after trust. **Breaking:** a check that relied on a variable of your environment, or on a binary off the list, now fails with the reason until you declare it.
  - **Automatic verification:** `verification.auto_on_completion: true` verifies a completion claim at once, after trust (it runs agent-written code without you).
  - `friday operations`, `friday operations runs`, `friday operations show <run>`.
  - **Fix:** the memory search index named a column the memory table does not have; searches worked, but rebuilding or reading the index failed (migration v16).
  - Decision: ADR-0029.
- **M6d, other MCP servers' tools, approvals in Claude Code, the security suite:**
  - **Fix:** tools of other MCP servers (`mcp__<server>__<tool>`) were not seen by Friday's hook, so a filesystem or shell MCP server could reach Friday's files or rewrite `.claude/settings.json`. Now every MCP tool passes the hook: one given a protected location is denied even with the daemon down, and the project sets a level per server (`mcp: servers:`; `review` by default, `auto` after trust, `manual`, `never`). Run `friday harness config claude-code` again to install the new matcher; `friday harness doctor` reports the old one.
  - **Approve in Claude Code:** for a low- or medium-risk request, Friday asks you in Claude Code's own dialog when it offers one; your answer covers one use. High-risk requests stay on `friday approve` and the status page. `approvals.elicitation: false` turns the dialog off.
  - The capability `mcp.call` asks for a tool the project set to `manual`.
  - **The security suite:** every security case of the spec (Part 11 §14) has an end-to-end test that checks the forbidden effect did not happen; `docs/security/model.md` maps each case to its test.
  - Decision: ADR-0030.

## Unreleased — M5 verification, recovery, worktrees

- **M5a, one checkout per task:**
  - A spawn-mode run gets its **own git worktree** on its own branch `friday/<task_id>`, in a per-user folder beside Friday's state (`%LOCALAPPDATA%\friday-worktrees` on Windows). The run's `task.start` names it as the working directory. Agents working in parallel no longer share one checkout, and the main checkout's `git status` stays clean.
  - The worktree is prepared before the task starts. A crash during preparation is retried; an existing worktree and branch are reused, never created twice; a failure returns the task to READY with the reason.
  - **Sessions you start yourself:** `friday task worktree <task>` prepares the task's worktree and says where to open it. A Claude Code session started there is recorded in that checkout, can claim only that task, and can write only there. Friday's runtime files in the main checkout stay protected from it.
  - Context packets, the code graph and the single-live-writer rule work per checkout: one live writer per worktree.
  - When a task ends, its worktree is **released**, or **preserved** when it holds uncommitted work. `friday worktrees` lists them with their changes; `friday worktrees prune` removes released, clean ones and keeps their branches.
  - `worktrees.mode: off` in `.friday/config.yaml` keeps every run in the main checkout.
  - **Fixes:** the patterns that protect Friday's private folder also matched `friday-worktrees`; the MCP server reported the main checkout as every session's folder; a file whose only difference was a line-ending conversion (common on Windows with `core.autocrlf=true`) counted as an uncommitted change; a NUL byte in `packages/git/src/root.ts` made git treat it as binary. The portability check now refuses NUL bytes in text files.
  - Decision: ADR-0023.
- **M5b, verification that says what it verified:**
  - `friday verify` runs the checks in the checkout the task worked in (its worktree, or the main checkout) and records exactly what it judged: the checkout, its commit, a hash of any uncommitted changes, the commit the work started from, and the task's kind. If the code changes while the checks run, the result is thrown away and the task waits to be verified again.
  - **Friday's own checks run first and run no project code.** `friday.diff` fails changes outside the task's write scope or to Friday's protected files, and warns when the completion claim and the actual changes disagree. In the shared main checkout it judges only the changes the session was seen making or claimed, and lists the rest. `friday.secrets` fails credentials in well-known formats written into changed files, naming file and line, never the value.
  - **Checks by task kind:** `task_kinds` limits a check to some kinds of tasks; `required: false` makes it advisory.
  - **Related tests first:** with `targeted_args` (where `{files}` stands for the test files), a check first runs the tests the code graph relates to the change, and skips the full run when they fail. Changed files that no test covers are listed.
  - A verification cut short by a daemon restart no longer leaves the task stuck in VERIFYING: it returns to READY_FOR_VERIFICATION.
  - `friday verify` and `friday task inspect` show the verified code and every finding.
  - Decision: ADR-0024.
- **M5c, conflict-prone files and goal branches:**
  - **File reservations.** Files listed in `reservations.required` (lockfiles, migrations, shared contracts) are changed by one task at a time. The first write through Friday's hooks reserves them for its task; a write from another task is refused, naming the holder, and recorded as an ownership conflict. Runs without hooks are checked the same way when they are verified. A reservation ends when its task's work is integrated or the task is cancelled, and expires when the task stands still for 30 minutes (`reservations.ttl_ms`). `friday reserve <pattern> --task <task>`, `friday reservations`, `friday reservations release <id>`.
  - **Goal branches.** Each goal gets a branch `friday/goal-<goal>`. When one of its tasks completes, Friday commits the verified work on the task branch (in the agent's name, never yours), then brings it into the goal branch: a fast-forward when the branch has not moved, otherwise a merge that is verified again in Friday's own checkout before the branch moves. A conflict or a failing merged revision leaves the goal branch as it was and asks you. Your main checkout and your own branches are never touched; you land the goal branch yourself (`git merge friday/goal-<goal>`).
  - **Dependencies see integrated work.** A task that depends on others starts only once their work is in the goal branch, and its worktree starts from it.
  - **A goal completes** only when the work of all its tasks is integrated.
  - `friday integrations [--goal <goal>]` lists every attempt; `friday integrate <task>` tries again after you resolved a problem.
  - Fix: an attach session started in a task worktree now records the worktree's base commit, so verification sees what it committed.
  - Decision: ADR-0025.
- **M5d, recovering lost and failed attempts:**
  - `friday recover <task>` shows what Friday knows about a task's last attempt: the session (status, last heartbeat, whether its process still runs on this machine, how long it may still come back), the last activity, the worktree's commits and uncommitted files, agent errors and preserved states, with the options and a recommendation.
  - **Nothing is lost.** Before an attempt is reassigned or restarted, the worktree's full state, untracked files included, is kept under `refs/friday/preserved/<task>/attempt-<n>`, without changing the worktree.
  - **Reassign** gives the task to the next agent in the same worktree and branch, so it continues from the work left there; no second branch is made. **Restart** first puts the worktree back at its last commit. Also `needs-human` and `cancel`.
  - **The old attempt is fenced:** its run ends, nothing more is delivered to it, its late results are refused, and Friday's hooks refuse writes into the task's worktree from any session that does not hold the task.
  - **Automatic, with limits:** when a lost session's reconnect window passes, or an attempt ends in a fatal agent error, Friday reassigns the task, up to `recovery.max_retries` (2) more attempts and as long as the same error does not keep repeating (`recovery.max_same_error_retries`, 1). Then, or when the old process still runs on this machine, it asks you once.
  - Runbook: [docs/runbooks/recovery.md](docs/runbooks/recovery.md). Decision: ADR-0026.

## Unreleased — M4 context engine

- **M4a, the code as it is in each checkout:**
  - `@friday/git` reads one execution root (the main checkout now, a task worktree from M5): status, branch and upstream, worktrees, log and line counts.
  - The **dirty-content identity** names "the code as it is here": the HEAD commit plus a hash of the content of every uncommitted change. An edit changes it, a timestamp alone does not, and undoing the edit restores it. Context caching (M4d) and verification (M5) build on it.
  - Friday never takes git's index lock while reading. **Fix:** the context Friday gives a session at start used plain `git status`, which could rewrite the index while an agent was committing.
  - Decision: ADR-0019.
- **M4b, the code graph:**
  - `@friday/code-graph` parses TypeScript and JavaScript with tree-sitter (WebAssembly, no native build), and links every file to what it imports. Each link is labelled **exact** (a relative path that exists), **inferred** (a workspace package's entry), or **unsupported**: aliases, package subpaths, computed `import()`/`require()` and missing files are reported, never guessed.
  - It knows each file's consumers, its tests, its area (the nearest package), and the **shared contracts** that other areas depend on.
  - Parse results are cached by file content in `.friday/graph/`, so an edit re-parses one file, and worktrees share the cache. Friday's own repository (218 files) builds in under a second.
  - `friday graph` (summary, contracts, what is not resolved), `friday graph query <file> [--depth n]`, `friday graph reindex`.
  - Decision: ADR-0020.
- **M4c, project memory:**
  - Decisions, conventions, constraints and lessons are recorded with their scope (project, team, agent, task, session), who recorded them and how much they count: a human's are human-approved, the Master Brain's and agents' are unverified.
  - A newer memory on the same subject supersedes an older one only when it has more authority (or the same author updates it); the old one is kept, marked superseded. **A human-approved decision is never replaced automatically**: a contradicting memory waits for review. A task's memory never changes project memory.
  - Agents write only their own task, agent and session memory.
  - Search ranks by text relevance, authority, verification, recency and reuse; approved decisions do not fade, guesses do.
  - `friday memory add|search|review|show|approve|supersede|retract`.
  - Decision: ADR-0021.
- **M4d, context that explains itself:**
  - `@friday/context` replaces the M1 context stub. Every packet is compiled in the order of the spec: permissions first, then the task, the code as it is now (including uncommitted work), the files related through the code graph (consumers, tests, shared contracts), memory, and waiting messages.
  - Sources are ranked by authority (git state and the task first, human decisions before guesses). The budget never cuts identity, the task contract, scope, the human's requirements or the protocol reminder.
  - Files the task may not read are never gathered and never named.
  - Packets are cached by what they depend on: an uncommitted edit, a new memory or a status change gives a new packet; a tool completion does not. A stored packet says when it is stale and why.
  - **`friday context explain <task|ctx>`** lists every file with its reason and rule, what the budget cut, how many sources permission withheld, memory conflicts and what was not resolved.
  - Agents can **remember and recall** through Friday: `friday_remember`, `friday_recall` (MCP) and `memory.record`, `memory.search` (protocol), within their own scopes.
  - Decision: ADR-0022.

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
