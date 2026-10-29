# Friday

Friday is a local orchestration and context control plane for AI software development. It sits above existing coding harnesses (Claude Code, Codex, Cursor, October) and owns what they don't: intent, plans and tasks, the compiled context each agent receives, communication between agents, policy, model routing, verification and recovery. Harnesses keep running the agent loop. Git stays the source of truth for code.

The architecture is called **ContextOS** in the original specification.

**Status:** M0–M7 built and tested locally, after three stabilizations from independent reviews (M2.5, M3.1 and M7.1, with its follow-up M7.1e; see [the dispositions](docs/reviews/)). The gates are pending: they need live runs with real hosts, CI on both operating systems, and the owner's acceptance of the decision records ([status table](docs/BUILD_PLAN.md#f1-status-table-updated-at-every-gate)). M8a, a second host, is under way: Codex works for Friday as a spawn-mode harness (`friday harness run codex`), checked live in six turns the owner approved, and Friday can start the installed Claude Code itself (`friday harness run claude-code`), tested against a scripted Claude Code and checked live in three turns the owner approved. After a readiness review of M8a (M8a.5), both adapters keep serving Friday through failures, and the agents they run can ask and answer each other through Friday's tools. The recorded live demonstration waits for the owner.
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
- **M6b** puts the project's own policy behind a trust boundary: what tracked files restrict applies at once, what they loosen only after you trust it on your clone; policy files add deny rules and team scopes ([docs/policy.md](docs/policy.md)).
- **M6c** runs work that needs a secret for the agent instead of handing the secret over: the project declares an operation (such as a sandbox integration test), you trust it and approve each run, and the agent gets the outcome with the secret removed. Checks run in a minimal execution profile, secrets are encrypted with DPAPI on Windows, and claims can be verified automatically once you trust that.
- **M6d** puts the tools of other MCP servers behind Friday's policy hook (none can reach Friday's files; the project sets a level per server), lets you answer low- and medium-risk requests in Claude Code's own dialog, and proves each security case of the spec with an end-to-end test.
- **M7** routes each task to a model and says why: your pins first, then hard constraints, how well each model fits the task, its verified track record, and optionally the local decision model Laya once you calibrate it. A harness that applies models is bound by the choice; an attached Claude Code session gets it as advice, and Friday records which model actually ran ([docs/routing.md](docs/routing.md)).
- **M7.1** closes the seventeen findings of the M7 review, which looked at the joints between milestones:
  - what is integrated is exactly what was verified, and evidence Friday cannot read interrupts a verification instead of passing it;
  - an operation starts only under the authority that holds when it starts, and stops, with every process it started, when that authority ends;
  - a restored clone works only in its own checkouts, and a backup now holds the code of Friday's work, so a clean clone can continue it;
  - a route that forbids the work starts nothing;
  - context and verification apply the same effective policy as the hooks, packets keep their size budget, and context requests are honoured;
  - Laya is asked locally, within one deadline, as part of normal delegation;
  - memory keeps case, and only models seen running count as measured evidence.

  One scenario now runs the whole chain, from an approved goal to its verified goal branch, including a restore into a clean clone ([disposition](docs/reviews/2026-10-14-m7-review-disposition.md)).

  A follow-up review of M7.1 found seven more gaps, closed in M7.1e ([disposition](docs/reviews/2026-10-15-m7-1-review-disposition.md)):
  - context is delivered only under the authority it was compiled under, and a file you approved for one read is shown once;
  - a verification's verdict follows the policy in force when it is recorded;
  - a failed integration can be retried, and your repair of a conflict is checked before it lands;
  - work that was finished in a lost clone continues in the restored one (`friday recover --action rebind`);
  - history shows only commits the agent may read about, and a restore checks the backup's database before it changes anything.

See the [build plan](docs/BUILD_PLAN.md) for the roadmap and milestone status.

## Documentation

| Document | What it is |
|---|---|
| [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) | The complete build plan, from M0 to the MVP gate and beyond. The single document all work is checked against |
| [docs/LESSONS_LEARNED.md](docs/LESSONS_LEARNED.md) | Every problem met while building Friday and the rule to follow instead; read it before building Friday again from the handoff |
| [docs/handoff/](docs/handoff/) | The original 16-part ContextOS specification, verbatim, plus [ERRATA](docs/handoff/ERRATA.md) |
| [docs/decisions/](docs/decisions/) | Architecture decision records |
| [docs/security/model.md](docs/security/model.md) | Enforcement levels, token scopes, what is and isn't intercepted, known gaps, threat model |
| [docs/integration/claude-code.md](docs/integration/claude-code.md) | Claude Code attached (setup, what is enforced, headless runs, troubleshooting) and in spawn mode (`friday harness run claude-code`) |
| [docs/messaging.md](docs/messaging.md) | Messages between agents and humans through Friday: addresses, the inbox, acknowledgements |
| [docs/runbooks/backup.md](docs/runbooks/backup.md) | Back up, inspect with snapshots and replay, and restore |
| [docs/policy.md](docs/policy.md) | The project's policy: what restricts at once, what needs your trust, policy files with deny rules and team scopes |
| [docs/runbooks/recovery.md](docs/runbooks/recovery.md) | When a harness is lost or an attempt fails: what Friday does by itself, the recovery options, getting preserved work back |
| [docs/master-brain.md](docs/master-brain.md) | Goals, plans and the Master Brain: turning planning on, approving, revisions, questions, costs |
| [docs/routing.md](docs/routing.md) | Model routing: pins, hard constraints, the registry and guide, evidence, Laya and its calibration, what binds and what is advice |
| [docs/protocol/README.md](docs/protocol/README.md) | The harness protocol: transport, tokens, methods, errors, versions |
| [docs/integration/claude-code-spike.md](docs/integration/claude-code-spike.md) | Verified Claude Code hook and MCP behaviour on Windows |
| [docs/integration/mvp-demo.md](docs/integration/mvp-demo.md) | The MVP demonstration with real Claude Code and Codex: the steps, and what to record for the M8 gate |
| [docs/integration/codex.md](docs/integration/codex.md) | Codex as a spawn-mode harness: running it, what Friday pins and decides, what is not mediated |
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
packages/    protocol, core, db, events, state, sdk, policy, verification, planner, git, code-graph, context,
             execution, routing, mcp-server, adapters/{generic,claude,codex}
tests/       support and helpers, cross-package suites (integration, failure, hooks, mcp, security, conformance, scenarios), fixtures
docs/        plan, spec, decisions, security, integration notes, runbooks, reviews
```

Messaging and memory live in `packages/state`, because each change commits with the event log. The Codex adapter arrived in M8a.2 and Claude spawn mode in M8a.3; further adapters follow in M8b and the full UI in M9, as listed in the build plan.
