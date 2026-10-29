# Friday

Friday is a local orchestration and context control plane for AI software development. It sits above existing coding harnesses (Claude Code, Codex, Cursor, October) and owns what they don't: intent, plans and tasks, the compiled context each agent receives, communication between agents, policy, model routing, verification and recovery. Harnesses keep running the agent loop. Git stays the source of truth for code.

The architecture is called **ContextOS** in the original specification.

**Status:** M5 built (gates pending), after two stabilizations from independent reviews (M2.5 and M3.1; see [the dispositions](docs/reviews/)).
- **M1** gives you the event spine, the daemon, the `friday` CLI, a read-only status page, and Claude Code attached through an MCP server, a skill and policy hooks. A task runs from creation through a Claude Code session to a verified completion, with Friday's policy enforced on the session's tools.
- **M2** adds the Master Brain. A goal becomes a versioned plan that you approve; its tasks are delegated to agents, revised when verification fails, and escalated to you when only a human can decide.
- **M2.5** closes the twelve findings of the 2026-10-14 review:
  - policy follows links and junctions;
  - private folders are verified to be user-only;
  - a session counts as L1 only when its hooks really reach Friday;
  - planning sends only redacted, bounded project text, and only to an endpoint you chose, with your local approval;
  - costs are never under-reported, and the Master Brain survives restarts without losing work;
  - stale plan revisions are refused, your own requirements stay authoritative, and reservations expire.
- **M3** makes Friday the communication authority: agents message each other, roles, the Master Brain and humans through Friday, which authorizes, delivers and records every message, with per-recipient delivery and real acknowledgements. Channels a host offers outside Friday (Claude Code's own agent messaging, for example) are listed as limits in the security model. Events can be snapshotted, replayed into an isolated copy, backed up and restored.
- **M3.1** closes the nine findings of the M3 review: one authorization rule for every way of addressing a message, only authorized replies settle a request, only the receiving session acknowledges, escalations and answers survive a crash, answered questions stop asking, and backups are relocatable, verified, credential-free and restorable with `friday restore`, without holding up the daemon.
- **M3.5** tried a second host before building for it: Codex app-server takes Friday's context and tasks, asks Friday before commands and file writes, and resumes after a crash, but does not stop a running command when a turn is cancelled, so Friday will own that ([spike report](docs/integration/codex-spike.md)).
- **M4** compiles the context each agent receives: the code as it is in the agent's checkout (uncommitted work included), the files related through a code graph (imports, consumers, tests, shared contracts), and project memory with its authority, within a budget and explained by `friday context explain`.
- **M5a** gives each task its own git worktree: agents working in parallel no longer share a checkout, a session started in a task's worktree works on that task only, and worktrees holding uncommitted work are kept.
- **M5b** verifies a task in the checkout it worked in, at a recorded revision: Friday's own checks (changes against the task's scope and claim, credentials in the code) run before the project's checks for that kind of task, related tests first, and a verification whose code changed while it ran judges nothing.
- **M5c** serializes changes to conflict-prone files with file reservations, and brings each goal's verified task branches together in a goal branch, verifying the merged code before the branch moves; dependent tasks start from that integrated work, and you land the goal branch yourself.
- **M5d** recovers from a lost harness or a failed attempt without losing work: the worktree's state is preserved, the stale attempt fenced, and the task reassigned in the same worktree and branch, within limits beyond which you decide.
- **M6a** judges what agents ask for against one capability catalogue, answers what the policy decides alone at once, and binds every human approval to its task, attempt, exact target and policy, for one use unless you say otherwise.

See the [build plan](docs/BUILD_PLAN.md) for the roadmap and milestone status.

## Documentation

| Document | What it is |
|---|---|
| [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) | The complete build plan, from M0 to the MVP gate and beyond. The single document all work is checked against |
| [docs/LESSONS_LEARNED.md](docs/LESSONS_LEARNED.md) | Every problem met while building Friday and the rule to follow instead; read it before building Friday again from the handoff |
| [docs/handoff/](docs/handoff/) | The original 16-part ContextOS specification, verbatim, plus [ERRATA](docs/handoff/ERRATA.md) |
| [docs/decisions/](docs/decisions/) | Architecture decision records |
| [docs/security/model.md](docs/security/model.md) | Enforcement levels, token scopes, what is and isn't intercepted, known gaps, threat model |
| [docs/integration/claude-code.md](docs/integration/claude-code.md) | Attaching Claude Code: setup, what is enforced, headless runs, troubleshooting |
| [docs/messaging.md](docs/messaging.md) | Messages between agents and humans through Friday: addresses, the inbox, acknowledgements |
| [docs/runbooks/backup.md](docs/runbooks/backup.md) | Back up, inspect with snapshots and replay, and restore |
| [docs/runbooks/recovery.md](docs/runbooks/recovery.md) | When a harness is lost or an attempt fails: what Friday does by itself, the recovery options, getting preserved work back |
| [docs/master-brain.md](docs/master-brain.md) | Goals, plans and the Master Brain: turning planning on, approving, revisions, questions, costs |
| [docs/protocol/README.md](docs/protocol/README.md) | The harness protocol: transport, tokens, methods, errors, versions |
| [docs/integration/claude-code-spike.md](docs/integration/claude-code-spike.md) | Verified Claude Code hook and MCP behaviour on Windows |
| [docs/integration/codex-spike.md](docs/integration/codex-spike.md) | The M3.5 Codex app-server spike: what works, what does not, and the contract changes before M8 |
| [docs/reviews/](docs/reviews/) | External reviews of the plan and the project, and how each finding was handled |

## Try it (Windows, PowerShell)

```powershell
# In the Friday repository
pnpm install; pnpm build
function friday { node C:\friday\apps\cli\bin\friday.mjs @args }   # adjust the path; define it in each terminal
friday setup                                   # once per machine

friday fixture init C:\demo\shop              # a small repository that is already a Friday project
cd C:\demo\shop
friday run                                     # terminal 1: the daemon and the status page URL

# terminal 2
friday harness config claude-code --agent dev-1
friday harness doctor claude-code              # expect: Enforcement achieved: L1 enforcing
friday task create "Add discount-code support to pricing" --criteria "node --test passes" `
  --scope-write "frontend/src/pricing/**" --scope-write "frontend/test/**" --assign dev-1 --ready
code .                                         # Claude Code panel: accept folder trust, then ask "/friday start"

friday task inspect <task> --events            # after Claude submits its completion claim
friday verify <task>                           # runs the configured checks: COMPLETED or FAILED
```

Details, headless use and troubleshooting: [docs/integration/claude-code.md](docs/integration/claude-code.md).

### Plan a goal with the Master Brain

```powershell
friday secrets set anthropic                   # paste your Anthropic API key (hidden; stored for your user only)
# in .friday/config.yaml: providers.anthropic.allow_remote: true, then restart "friday run"
friday brain allow-remote --budget 5           # this clone may use your key, at most $5 a day
friday goal create "Add Stripe subscriptions, keep one-time checkout working, add tests"
friday plan approve                            # tasks are created and handed to agents
friday goal show                               # live plan; revisions and questions appear here
friday escalations                             # questions only you can answer: friday answer <id> "..."
```

Without a key, set `master_brain.provider: none` and write plans yourself (`friday plan propose`). See [docs/master-brain.md](docs/master-brain.md).

## Development

Requirements: Node 22.18+ (24 recommended), pnpm 12.11.2, Git. Windows and Linux are both supported; no native build tools are needed.

```sh
npm install -g pnpm@12.11.2     # or: corepack enable (needs write access to the Node install folder)
pnpm install
pnpm build                      # tsc -b across all packages
pnpm typecheck
pnpm lint                       # Biome
pnpm test                       # every package and suite, via Turbo
pnpm test:all                   # every Vitest project in one run
pnpm check:portability          # LF, file modes, no shell scripts, no localhost literal
```

Set `FRIDAY_TEST_TMP` to a short directory (for example `C:\t`) if your temp path is longer than about 70 characters.

## Repository layout

```
apps/        daemon, cli
packages/    protocol, core, db, events, state, sdk, policy, verification, planner, git, code-graph, context, mcp-server, adapters/{generic,claude}
tests/       support and helpers, cross-package suites (integration, hooks, mcp, security, scenarios), fixtures
docs/        plan, spec, decisions, security, integration notes
```

Messaging and memory live in `packages/state`, because each change commits with the event log. More packages (execution, routing, more adapters, UI) arrive in later milestones as listed in the build plan.
