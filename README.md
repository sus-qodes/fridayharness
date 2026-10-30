# Friday

Friday is a local orchestration and context control plane for AI software development. It sits above existing coding harnesses (Claude Code, Codex, Cursor, Gemini CLI, Antigravity) and owns what they don't: intent, plans and tasks, the compiled context each agent receives, communication between agents, policy, model routing, verification and recovery. Harnesses keep running the agent loop. Git stays the source of truth for code.

The architecture is called **ContextOS** in the original specification.

**Status:** M0 to M12 built and tested locally, after stabilizations from independent reviews (M2.5, M3.1, M7.1 with its follow-up M7.1e, M8a.5; see [the dispositions](docs/reviews/)). Claude Code and Codex work with Friday attached and spawned, shown live with real hosts on 2026-10-16; Cursor, Antigravity and Gemini CLI are experimental until they are tried with a real login. The gates are pending: they need CI on both operating systems and the owner's hands-on checks ([status table](docs/BUILD_PLAN.md#f1-status-table-updated-at-every-gate)). The decision records were accepted by the owner on 2026-10-18.
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
- **M4** compiles the context each agent receives: the code as it is in the agent's checkout (uncommitted work included), the files related through a code graph (imports, consumers, tests, shared contracts; answered on request, since the first packet names no files), and project memory with its authority, within a budget and explained by `friday context explain`.
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

- **M8** puts two different hosts on one project under one Master Brain: Codex through its app-server (`friday harness run codex`) and Claude Code driven headless with Friday's hooks (`friday harness run claude-code`), each in its task's worktree and inside a process group Friday ends; the deterministic MVP scenario and a recorded live demonstration with both hosts ([guide](docs/integration/mvp-demo.md)). **M8b** adds Cursor (attached and spawned), Antigravity (attached) and Gemini CLI (attached and spawned) through one hook launcher for every host, each experimental until tried with a real login ([Cursor](docs/integration/cursor.md), [Antigravity](docs/integration/antigravity.md), [Gemini CLI](docs/integration/gemini-cli.md)).
- **M9** gives Friday an interface, so daily work needs no terminal ([plan](docs/frontend/PLAN.md)): the **Studio**, a canvas of goals, tasks and agents with drawers for a task's context, diff and history; the **Notch**, an island at the top of the screen with the mascot Blip, which opens when an agent needs your approval or an answer; and a desktop shell that floats the Notch over your editor. From it you start agents, write or approve plans, decide requests (agents started from the interface carry on afterwards), verify, integrate, recover, see what is ready to land, and pause, resume or halt everything.
- **M10a and M10b** measure what a host spends: `friday usage` gives one row per run attempt (the host's tokens and cost, what Friday gave it, the tool calls, the verdict), and two live runs of the same tasks are recorded in [docs/measurements/](docs/measurements/README.md). A spawned host's first message no longer repeats what its instructions hold.
- **M11** finishes what the built milestones left open: commands inside `xargs` and `case` judged as what they run, `config.yaml` applied while Friday runs, Codex usage recorded, and a spending cap per task (`routing.task_budget_usd`).
- **M12** makes existing parts cheaper to run or quicker to start: planning with a model on your own machine (`master_brain.provider: local`), a task never holding more authority than what delegated it, a fixed handoff summary when work is continued, two agent tools (`friday_list_peers`, `friday_message_receipt`), `friday start` and an install archive, the context evals, and one line per goal saying what Friday did for it.

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
| [docs/integration/cursor.md](docs/integration/cursor.md) | Cursor attached and in spawn mode (experimental): the files, what the hooks decide, the level, the doctor, the live check still to do |
| [docs/integration/antigravity.md](docs/integration/antigravity.md) | Antigravity attached (experimental, no spawn mode): the files, what the hooks decide, why the level is unverified, the live check still to do |
| [docs/integration/gemini-cli.md](docs/integration/gemini-cli.md) | Gemini CLI attached and in spawn mode (experimental): the files, what the hooks decide, why the level is degraded, the live check still to do |
| [docs/integration/codex-spike.md](docs/integration/codex-spike.md) | The M3.5 Codex app-server spike: what works, what does not, and the contract changes before M8 |
| [docs/reviews/](docs/reviews/) | External reviews of the plan and the project, and how each finding was handled |
| [docs/frontend/](docs/frontend/) | The interface: its plan, where it deviates from the [design handoff](docs/frontend-handoff/), and its lessons |

## Quickstart

Friday needs Node 22.18 or newer and Git; nothing else of Friday has to be on the machine.

**Install Friday once per machine.** The archive `friday-<version>.tgz` is not published yet: build it from this repository, then install it with npm.

```powershell
pnpm install; pnpm pack:release                   # writes dist-release\friday-0.1.0.tgz
npm install -g .\dist-release\friday-0.1.0.tgz    # the friday command, on your PATH
```

`pnpm pack:release` builds every package, bundles the `friday` command (the daemon runs inside it) and the `friday-mcp` server with every workspace package inlined, declares the third-party packages npm installs with them (among them `better-sqlite3`, whose prebuilt binary npm fetches), includes the Studio bundle and the hook launcher, packs the archive, then installs it into a temporary folder and runs `friday --version`, `friday setup` and `friday start` in a fresh repository there before it reports the archive good. Nothing is published.

**Start Friday in your repository.** In a folder that is a git repository (`git init` makes one; no commit is needed yet):

```powershell
friday start
```

It makes the folder a Friday project when it is not one yet (`.friday/config.yaml` and `.friday/.gitignore`; commit both), starts Friday hidden when it is not running (its output goes to `.friday/logs/daemon-console.log`), and opens the Studio in your browser, already signed in; it prints what it did, in three lines at most. A folder that is not a git repository is refused with the command that makes it one. Every day after that, `friday start` again, or double-click the shortcut `friday shortcut` creates. `friday start --desktop` opens the desktop app instead when it is installed on this machine and otherwise says where to get it; `friday start --no-open` prints the Studio's address instead of opening anything.

To attach a Claude Code session running in VS Code, run `friday setup` once per machine first: it records where Friday is installed, for the hooks and the MCP launcher ([docs/integration/claude-code.md](docs/integration/claude-code.md)). From the Studio:
- **Agents** (dock): start Claude Code or Codex for this project, or set up Claude Code in VS Code.
- **New goal**: describe what you want; write the plan yourself, or let the Master Brain plan it once a provider key is set up (Settings → Planner says how).
- When an agent needs you, the request appears in full under **Waiting for you** at the right, and the Notch at the top of the page shows how many wait; decide it there (a high-risk request asks you to hold the button), and the agent carries on in its run.
- When a task claims it is done, **Verify** on its card runs the checks; verified work is integrated into the goal's branch, and the goal card says when it is **Ready to land**.

A sign-in link works once, for a minute; a browser session lasts until Friday stops or restarts, at most 12 hours. `friday ui` opens it again from a terminal. See [docs/frontend/README.md](docs/frontend/README.md).

**The desktop app (Windows)** floats the Notch over your editor and keeps the Studio in its own window, with a tray icon; it starts Friday for the project when it is not running, and holds no credential in its pages. It is built with Rust's per-user toolchain (no administrator rights), into an exe or into a per-user installer, `Friday Desktop_0.1.0_x64-setup.exe`, that installs it into `%LOCALAPPDATA%\Friday Desktop` (the steps are in [apps/desktop/README.md](apps/desktop/README.md)). It is started with `friday start --desktop` or with `friday-desktop.exe --project <the project's folder>`. `friday start --desktop` finds the app at the path in `FRIDAY_DESKTOP`, in the checkout named by `FRIDAY_HOME` or the one the `friday` command runs from, or where the installer put it.

## Try it (Windows, PowerShell)

With Friday installed from the archive, `friday` is on your PATH; in a source checkout, define the function below instead.

```powershell
# In the Friday repository
pnpm install; pnpm build
function friday { node C:\friday\apps\cli\bin\friday.mjs @args }   # adjust the path; define it in each terminal
friday setup                                   # once per machine

friday fixture init C:\demo\shop              # a small repository that is already a Friday project
cd C:\demo\shop
friday run                                     # terminal 1: the daemon; "friday ui" opens the interface

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
friday goal show                               # live plan; revisions, questions and "What Friday did" appear here
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
pnpm pack:release               # the install archive, dist-release/friday-<version>.tgz, built, packed and checked
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
