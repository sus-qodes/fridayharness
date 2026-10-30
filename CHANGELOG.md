# Changelog

All notable changes, one section per milestone tag. Format: what changed for someone using or building Friday.

## Unreleased — Phase 5C, the questions asked of the code graph (ADR-0037, proposed)

- **`friday graph symbol <name>`:** each match with its file and lines, kind, signature, whether it is exported, who calls, constructs, types or renders it (resolved edges with their certainty), what it uses, the tests of its file, and, apart, the name-only matches (guesses, labelled). Bounded: 20 matches, 50 edges each, and it says when cut.
- **`friday graph blast-radius <path>… [--symbol file#name] [--diff] [--depth] [--names]`:** what a change would reach upstream, to a depth, each hit with a confidence from the edges it came by (`high` exact, `medium` inferred, `low` name-only) and what it was reached from; the seeds say why a change may break others (an exported symbol called from another area, a shared contract). Name-only matches come in only with `--names`. It lists; it judges nothing.
- **`friday graph skeleton <file> [--level 2]`:** the file with its bodies folded, line numbers kept: L1 imports, exports and each declaration's first line; L2 also doc comments and exported interfaces, types and enums whole. A context view only. **`friday graph search <words>`** ranks symbols and files by their words.
- **For agents:** `friday_request_context` answers `kind: "symbol"` (query: the name) with the lookup, alone like a file request; `scope_files` with `query: "skeleton"` adds each scope file's L1 skeleton. Nothing is sent unasked. Phase 5 is complete; the handoff's tool names (`graph_query_context`, `graph_blast_radius`, `opt_skeleton_read`) arrive as projections of these queries in Phase 6. Guide: `docs/graph.md`.

## Unreleased — Phase 5B, the code graph knows when nothing changed, and answers keywords (ADR-0037, proposed)

- **A Merkle tree over the files git sees** (`.friday/graph/merkle.db`): the BLAKE3 of each file, kept with its size and time so an unchanged file is never read again; folder hashes from their children; the root hash names the tree and is recorded on the graph. "Did anything change" costs a stat per file. When git could not vouch for a checkout (an approximate identity, many dirty files), an unchanged tree keeps the last graph instead of rebuilding it, and a changed tree names the files to read again. Git's source identity stays the authority on what the checkout is; the tree only accelerates the graph's own staleness check. `@noble/hashes` (pure JavaScript, no install scripts) provides BLAKE3.
- **Keyword search over the graph** (`.friday/graph/search.db`, SQLite FTS5 with BM25): one row per symbol (its name's words, its path, its signature) and one per file (its path's words, its area, the names it exports); identifiers are split at case changes and separators, so `checkoutService` is found by `checkout`; every word is required first, any word second; symbols rank above files on a tie. Rebuilt with each graph; `friday graph reindex` rebuilds everything. No vectors: they wait for a measurement that shows keyword and graph retrieval miss things. The daemon's graph service exposes `search()`; the command and the context request that read it come with 5C.

## Unreleased — Phase 5A, the code graph knows the symbols inside files (ADR-0037, proposed)

- **Symbols are facts of a file:** functions, classes with their methods and fields, interfaces, type aliases, enums, variables and namespaces, each with its line range, whether it is exported (as a declaration, the default, or in an `export { … }` list), its parent and a one-line signature; beside them, what each import binds and what the file calls, constructs, uses as a type, renders as JSX or calls through a member. Facts stay content-addressed (format 2; an older `facts.db` is discarded) and the incremental build keeps unchanged files' symbols as it keeps their imports.
- **Edges between symbols, never guessed:** a reference to a local symbol is an edge within the file; one to an imported name follows the import's file edge to the symbol the target declares and exports (exact, or inferred when the import was); `this.m()` resolves inside the class; `ns.f()` through a namespace import. Anything else is unsupported with its reason (an unsupported import, a re-export the target does not define, a namespace member, or a member call on a value whose type the graph does not know, kept by name alone and labelled so). Queries on `CodeGraph`: `symbolsOf`, `findSymbols`, `callersOf`, `calleesOf`, `nameReferences`, `enclosingSymbol`; `friday graph` counts symbols and their edges. The commands and the context request that read them come with 5C.

## Unreleased — Phase 4, the coding tools on a machine wired to Friday once (ADR-0036, proposed)

- **`friday hosts setup`:** one `friday` MCP server entry in each installed tool's own user configuration (Claude Code `~/.claude.json`, Cursor `~/.cursor/mcp.json`, Gemini CLI `~/.gemini/settings.json`, OpenCode `~/.config/opencode/opencode.json`, Codex `~/.codex/config.toml`, DeepSeek Harness `~/.deepseek-harness/config.yaml`), pointing at a launcher Friday owns in its state folder. From then on the tool reaches Friday in every repository on the machine; where there is no Friday project the server says so and does nothing else. Merge-only (JSON keys kept; TOML and YAML get one marked block and are never parsed), backed up once a day, atomic, byte-stable when nothing changes, `friday hosts remove` takes it back out, a hand-written entry is reported `manual` and never touched, a tool that is not installed is never written blind.
- **`friday hosts`** reports each tool: installed, the machine entry, this project's attach files, the next step; the report is also written to the state folder. `friday init` runs the setup once the machine is set up (`--no-hosts` skips); `friday setup` writes the launcher. An installed and configured host counts as detected and configured in readiness for a day when the project's daemon runs.
- **DeepSeek Harness skeleton** (`@friday/adapter-deepseek`): detection of `dsh`, its configuration block, a doctor; it spawns and attaches nothing, and stays non-dispatchable in the registry until someone has seen it work. Antigravity keeps project-local files only.
- **`friday-local-mcp`** is the launcher's name and the setup surface; the server entry stays `friday`, so tools keep their `mcp__friday__…` names. OpenCode sessions started from a user entry now register under their own name.

## Unreleased — Phase 7.1, dependencies installed in a fresh task worktree

- **No attempt waits mid-run for an install:** before the agent starts, Friday installs the worktree's dependencies in the execution profile: the install the lockfile calls for (pnpm, npm, yarn or bun; frozen, offline first, lifecycle scripts ignored, so no project code runs), or the project's own `worktrees.setup.command`. The project's own command and `allow_scripts: true` are loosenings that wait for `friday policy trust`; a declared command this clone has not trusted is refused, never replaced by a guess. Nothing runs when there is no `package.json`, no lockfile, or `node_modules` already.
- **Nothing is installed silently:** `run.workspace_ready` records what ran, how long and how it ended (output redacted), `friday task inspect` shows it, and an agent whose dependencies could not be installed is told so in its `task.start` note. `worktrees.setup.on_failure: fail` declines the attempt instead and asks a human. The worktree timeout follows the install's `timeout_s` (default 600 s).
- The large multi-file rerun the plan asks for (Phase 7) still waits for the owner: it needs the Edutube repositories and paid model calls.

## Unreleased — Phase 2.3, a multi-role proposal is approved by splitting the task (ADR-0035 §5)

- **`friday task split <task>`:** a human approves the classifier's multi-role proposal by splitting the task into one task per role, in dependency order; each part carries the proposal's summary for its role and the original's kind, scope, acceptance criteria, priority, risk and goal, and the roles' `depends_on` become task dependencies. The original is cancelled as split, naming its parts, and whatever depended on it now depends on the split's last parts (`task.dependencies_changed`). A standalone task's parts carry a `human` role and are READY when the original was; a task of a goal is split through a plan revision the same approval approves, so the planner stays the one authority for a goal's tasks and the parts carry the plan's role. Neither asks the classifier again. Route: `POST tasks/:tid/split`; event: `task.split`.

## Unreleased — Phase 2.2, a host that fails is benched and the work moves down the ranking (ADR-0035)

- **Host failures have a kind:** an agent error may say why the host failed (`failure: { kind, retry_after_s? }`: `start`, `auth`, `rate_limit`, `transport`, `timeout`, `runtime_unavailable`). The Claude Code and Codex adapters classify what they can recognize (not signed in, rate limited with the wait the host asked for, a host that could not launch, a process that died mid-turn); a turn the host ended with an error of its own stays a work failure. Friday classifies what it sees itself: a decline before work started is `start`, a `task.start` never acknowledged is `timeout`, a session that did not come back within the reconnect window is `transport`.
- **A failing host is benched, never the work:** a sign-in failure keeps the host out until it is seen signed in again or `friday readiness clear <host>`; a rate limit benches the model until its reset time, else 30 minutes; a failed start, a lost process or a timeout benches the host and model for 10 minutes. Failed verifications, failing checks, policy denials, scope violations and agent errors without a kind bench nothing. `friday readiness` shows benches with their end; `friday readiness clear <host> [--model <m>]` lifts one.
- **Failover rides on recovery:** the attempt is reassigned as before (two automatic switches, then a human), and because the bench was recorded first, the next route skips the failed host for the next rank. The next route's receipt and `friday routing explain` name the failed attempt, its host, model and failure (`failover:`); the next attempt's handoff summary opens with "Stopped: the previous attempt on … stopped (…); it is benched until …. This attempt runs on ….".

## Unreleased — Phase 2.1, routing dispatches only to hosts this machine has seen (ADR-0035)

- **Readiness is evidence, not a declaration:** Friday records what it has seen of each host and model on this machine: a session that registers shows its host installed, configured and connected to Friday while the session lives; an attempt that ends in a completion claim shows the host and model signed in for seven days, renewed by each claim; `friday harness doctor claude-code` and `friday harness doctor codex` record what they found for a day, when the daemon is running. Evidence is event-sourced (`readiness.recorded`, `readiness.invalidated`, table `readiness_evidence`, migration 26) and replays.
- **Routing filters on it and never reorders:** after pins and hard constraints, an unready candidate is excluded with a reason and the next rank is considered; when every candidate is out, the route blocks with the reasons. Under the owner's loose rule a sign-in never seen is tried; a paid live check is never required. A dry run judges each candidate on its own host, so `friday routing explain` says which hosts could take the work now. A pinned model needs a ready host too.
- **`friday readiness`** lists every host and model the ranking names (and every host seen) with its verdict, live sessions, sign-in, bench and the reason it is out; `--evidence` shows the observations; `friday readiness clear <host> [--model <m>]` lifts a bench or a failed sign-in. Routing receipts and `routing explain` carry the readiness checks made. Benches and automatic failover follow in slice 2.2.

## Unreleased — M14.10, the code graph builds from its last build

- **A rebuild reads only what git cannot vouch for:** the graph of a checkout starts from the last graph of that checkout and keeps a file's facts unread when its content is unchanged: with the same HEAD, when it was dirty at neither build; across commits, when the commits do not differ in it. Every edge is still resolved from scratch, so a new file, a deleted one, a changed `exports` map or a tsconfig that appeared reach every importer. An approximate identity (too many dirty files to hash) or a different checkout reads everything, as before. Measured: a rebuild after one edit takes a quarter to a third of a warm full build on this repository, a quarter on a 200-file monorepo; the two graphs are equal in every node, edge, skipped file and contract (`docs/measurements/2026-10-20-incremental-graph.md`).
- `friday graph` says how many files were kept from the last graph, beside the parsed and cached counts. The daemon reads a checkout's identity once per rebuild, not twice.

## Unreleased — M14.9, the code graph reads the workspace's configuration

- **A package's whole `exports` map is followed:** `@shop/db/schema`, `@shop/api/modules/*` and the like resolve to their files, with the conditions Friday reads (`development`, `import`, `types`, `default`, `require`, `node`) and Node's longest-prefix rule for patterns. A subpath the map does not export, a key set to `null`, a key with none of those conditions and a target outside the package are still unsupported edges, each saying why. A package without an exports map exposes its files by path.
- **Build outputs lead to their sources, where the package says so:** an export that names `./dist/src/schema.d.ts` resolves to `src/schema.ts` when the package's `tsconfig.build.json` (else `tsconfig.json`) declares both `outDir` and `rootDir`. Without them the edge stays unsupported, and its reason names the tsconfig and the missing field. Nothing assumes `src`.
- **tsconfig `paths` resolve as TypeScript applies them:** the nearest `tsconfig.json` above a file governs it, `baseUrl` and relative `extends` are honoured, targets are tried in order, and paths come before workspace packages. A path whose targets name no file is unsupported, with the mapping in its reason.
- Every edge this adds is `inferred`, with the declaration behind it in its reason; `graph explain` and `scope_files` show it. Measured on a monorepo that exports `dist`: 126 unsupported edges of 574 became 0, and 12 shared contracts appeared where none was found; the graph build takes 5 to 35 ms more. Record: `docs/measurements/2026-10-20-workspace-resolution.md`.

## Unreleased — M14.8, the cheap fixes of the core audit

- **A file asked for through `friday_request_context` now arrives:** the tool sends the path it was given as the request's path (it sent it as a query the compiler never read, so every file request answered "names no paths"). `history` takes a path the same way.
- **The planner's cache survives a commit:** the revision and the recent commits are sent after the cached project context, not inside it, so a commit no longer rebuilds the provider's cache. They stay in every planning call, as source material.
- **A small task names its files:** cost-class routing sends the cheapest agent only to a low-risk task that may change one to three named files; a scope with a glob (`backend/**`, `**`) is of unknown size and is routed by the score.
- **A plan cannot ask for an edit it forbids:** a criterion that asks to change a named file outside the task's write scope is a validation error the planner repairs; criteria about running or passing a file are not edits.
- **Context requests cache better and read git once:** a request's answer is reused across unrelated memory or inbox changes (the code, the policy, the grants and the task's state still key it), and each compile reads the working tree's status once.

## Unreleased — M14.7, a minimal first packet

- **The first packet of a session names no files:** it carries who the agent is, the task, its criteria, the checks that will judge it, what it may change (`write:`) and one line against exploring broadly, with the project's memory and, for a rework, the handoff summary. The read-scope list, the related code and the recent commits left it: when measured, every file named got opened whether the task needed it or not, at 40% more cost and no gain in correctness.
- **A context request is answered alone:** `friday_request_context` with `scope_files` (the files the task may change, each once with what the graph knows of it, and the code the graph relates to them), `file` or `history` returns that material and nothing of the task packet; `task` and `decision` keep the task's context; `symbol` stays unsupported. The first packet lists no uncommitted paths either: its head line counts them, and `scope_files` marks the changed ones. `friday context explain` of a task shows the packet as the agent got it.
- **`friday context explain <task> --files`** shows what an agent's `scope_files` request is answered with: the files the task may change and the code related to them, with each file's reason. Without the flag, the command explains the packet the agent was given, which names no files.
- The context evals (`FRIDAY_TEST_BENCH=1`) score the first packet by default; `FRIDAY_EVAL_REQUEST=scope_files` scores the request that now holds the related files.

## Unreleased — the exploration measurement

- **Measured on a large repository** (`tests/scenarios/exploration.live.test.ts`, 20 Haiku sessions on clones of Friday itself): a plain Claude Code session spends 8 to 11% of its input on searches and reads of files it never changes, so a better map of the code can save a tenth of a session at most; Friday's full packet made sessions 40% dearer, because its file lists get read; a minimal packet (the task, its criteria, its write scope, one line against exploring) was as right as the full one, 20% cheaper, with 60% fewer reads of unchanged files. Record: `docs/measurements/2026-10-20-exploration.md`. The graph-query tool and mandatory workflow proposed for worker IDEs are not built: measured, not worth it.

## Unreleased — M14.5, is a small local model worth it (OpenCode checkpoint E)

- **Measured on this machine:** three small task kinds of the fixture shop, done by OpenCode alone and under Friday on `qwen2.5:7b`, judged by the same hidden checks (`tests/scenarios/opencode-e.live.test.ts`). No task ended right: OpenCode alone ran out of its 20 minutes on one and changed nothing on another, and under Friday the model's edit broke the project's tests and verification refused it. A small local model is not worth sending tasks to on this processor; OpenCode stays experimental.

## Unreleased — M14.4, OpenCode as a worker (experimental)

- **OpenCode takes Friday's tasks on a model on this machine:** `friday harness run opencode --model-url http://127.0.0.1:11434/v1 --model qwen2.5:7b` registers a worker (cost class free) that runs each attempt in its own controlled OpenCode server and session, with every call judged for that task and run. The task goes as one prompt with its packet; the last answer is the claim (plain words; `BLOCKED: …` when it cannot finish), with the worktree's changed paths and what the model calls cost. A cancellation stops the session with no call after it and ends its server; a restarted worker resumes its runs in a new session under the policy of that moment. It passes the eleven-case harness conformance suite against a scripted server, and live on `qwen2.5:7b` a task reached its claim, a cancelled session made no call after the stop, and a lost worker's run resumed in a new session and claimed. The session's completed writes are reported as observed before the claim. `harness run opencode` without the two flags is still the no-model preflight.
- **What the live runs fixed:** the final answer is plain words, since a small model asked for JSON wrote its tool calls as JSON text (LESSONS HX-40); one missed poll while the model takes every processor no longer ends an attempt (HX-41); closing the worker waits for attempts still ending, so no private profile is left (HX-42).

## Unreleased — M14.6, the packet names the project's checks

- **An agent is told which checks will judge its claim:** every task packet's acceptance section names the checks Friday's verification runs for the task, with their commands (`Friday verifies a claim with these project checks; run them before you claim: - tests: node --test … - rules: node scripts/check.mjs`). An agent kept to its task's files no longer misses a project rule that only a check enforces. A change of the checks compiles a new packet. Token cost: one line per configured check in each task packet.
- **Agents may run those checks:** a command that is exactly one of the project's checks, and that no other rule knows (a project's own script such as `node scripts/check.mjs`), is judged as a test run instead of asking a human. A check written as a deletion, a push or a fetch is still judged as what it does. On the trap goal, both of Friday's agents then ran the rule check before claiming and both tasks were right on the first try, in 46 s against 77 s (`docs/measurements/2026-10-19-benefit-trap.md`).

## Unreleased — M14.3, a goal where something goes wrong

- **The benefit comparison has a trap goal** (`FRIDAY_BENEFIT_GOAL=trap`): receipts and refunds with the currency symbol first, in a shop whose formatter another area relies on and whose rules a check of its own enforces. On Haiku every way shipped both tasks right; Friday's verification refused a claim that broke a project rule its tests could not see, and the rework fixed it in one edit. The plain sessions avoided that mistake by reading the project's decisions, which Friday's packet did not point its agent to. Record: `docs/measurements/2026-10-19-benefit-trap.md`.

## Unreleased — M14.2, cost classes live

- **Cost classes checked with a real host** (`tests/scenarios/cost-classes.live.test.ts`): a small, low-risk task went to the agent limited to claude-haiku-5-5 as the cheapest capable agent; its claim, refused by a human, was reserved for and reworked by the agent limited to claude-sonnet-5-5 and passed verification. Record: `docs/measurements/2026-10-19-cost-classes.md`.

## Unreleased — M14.1, the leftovers

- **Settings Hub:** the trust question lists exactly what is trusted and its hash; Stop Friday says how to start it again; the Friday and About pages follow the board; the notification refusals say where to allow them again; the browser session note and the clean-up hint are back.
- **OpenCode refusals say why:** a session Friday did not bind, a call it does not judge, a replayed call, a check that failed or came late, and Friday's own policy reason, instead of one generic message.
- **Tests that only timed out on a busy machine** wait for their state or have ceilings that hold under load (LESSONS T-109, T-110).

## Unreleased — the Settings Hub completed

- **What the Settings drawer offered is back in the Settings Hub:** in the desktop app, Planner stores the provider key in Windows' own prompt and allows spending with its own dialog, with the daily budget box and *Open config.yaml in VS Code*; the Planner page follows the planner's state; shortcuts are named by what they do and say why one is not active; starting at sign-in shows the shell's answer and puts a refused change back. Leaving Settings by Esc or Ctrl+comma no longer leaves the old Settings panel over the canvas.

## Unreleased — OpenCode checkpoint C (experimental)

- **Friday's refusals shown in front of a live model:** with the owner's permission, OpenCode 1.19.3 ran with Ollama's `qwen2.5:7b` on this machine, its own permissions open, and Friday's plugin as the only gate. The allowed write happened; a write outside the task's scope, a read of a fake `.env`, a shell write, a mock MCP tool, and writes under a failing check, a hanging check, an unbound session, a cancelled task and a stopped daemon were all refused with nothing written (`tests/scenarios/opencode-c.live.test.ts`, `docs/integration/opencode.md`). OpenCode stays experimental and L1 unverified until its lifecycle (checkpoint D) is recorded.

## Unreleased — OpenCode A/B (experimental)

- Added experimental OpenCode checkpoints A/B: a pinned 1.19.3 no-model server/session preflight with private configuration, plugin readiness and effective-config checks; a fail-closed before-tool plugin and fixture-tested translator using the existing tool.check policy; harness config/doctor/run dispatch, scripted-host conformance and an optional native no-model check. OpenCode remains L1 unverified. Model prompt submission, task polling and autonomous-worker discovery are disabled; no live model enforcement, coding-quality or busy-lifecycle claim is made.

## Unreleased — M13, fewer sessions and fewer tokens per goal

- **A small goal is one task:** the Master Brain's plan prompt (`plan-3`) keeps work one agent can finish as one task, and Friday merges a first plan of two or three tasks that would only run one after another into one, saying so in the plan's rationale. Plans you write, or ask for with feedback, are never merged. On the benefit comparison's goal: 38% less input than as two tasks, and as fast as one plain session.
- **A rework continues its session:** when the agent that did the work reworks it, spawned Claude Code (`--resume`) and Codex (`thread/resume`) continue the session that did the work, told why the claim was refused; a session the host cannot resume is replaced by a new one. Measured: 43% less input and half the calls for the rework.
- **Cost classes:** every agent is `free`, `cheap` or `standard` (`friday harness run claude-code|codex --cost-class`, else its model's class from the registry; `--models` limits the models routing may run for it). A small, low-risk task goes to the cheapest capable agent of its role, and a refused claim is reworked by a stronger agent when one is free.
- **A forgiving final answer:** a spawned session's final answer needs only its status; the changed paths come from the worktree. No missing or added field makes Claude Code refuse an answer.
- **Slimmer tools in spawned sessions:** Friday's tools are described in one line each, with only the fields an agent needs, and `friday_run_operation` only where the project declares an operation. With the final answer above: 943 tokens fewer in every call.
- **Measured:** `docs/measurements/2026-10-19-fewer-sessions.md`; the benefit comparison has a `friday-one` arm and the baseline a rework variant (`FRIDAY_TOKEN_BASELINE_REWORK`).

## Unreleased — the benefit comparison

- **Measured whether Friday helps:** `tests/scenarios/benefit.live.test.ts` (gated by `FRIDAY_BENEFIT`) does one goal three ways on the same host and model (one plain Claude Code session, two plain sessions at once in one folder, and Friday with two spawned agents) and judges each result by the same hidden checks no agent sees. The first record (`docs/measurements/2026-10-18-benefit.md`): on an easy goal of two tasks on one shared file, all three got everything right; Friday spent 51% more input and took 1.7 times as long as one session, and 17% less input than two sessions working at once, where the shared file collided in both runs and one session reported itself blocked with the work done.

## Unreleased — M10b, fewer tokens per call

- **The first message of a spawned attempt says it once:** a spawned Claude Code or Codex attempt is told which task to start and that its contract, acceptance criteria and scope are in its instructions, instead of being given the task's text a second time. Measured twice against the token baseline, every call of an attempt is 413 tokens smaller (`docs/measurements/2026-10-18-token-baseline-m10b.md`). When the packet cannot be compiled, the message still carries the task's text.
- **Measured:** of a spawned Claude Code call (about 16,350 tokens at the first call), Friday sends about 2,000; the rest is the host's own prompt, tools and per-session context.

## Unreleased — M8b, three further hosts

Cursor, Antigravity and Gemini CLI can work under Friday, each `experimental` until it is tried with a real login; nothing signs in on its own.

- **One hook launcher for every host:** `node hook.mjs <vendor> <event>` (Claude Code's form unchanged), a small module per host that reads its input and writes its reply, and one judgment for all; Friday's answer is deny, ask where the host honours it, context at session start, or nothing, never allow. The daemon's route is `/hooks/<vendor>/<event>`. A host's hooks and its `friday` MCP server make one session whichever reaches Friday first, and each session's level comes from its own hooks.
- **Cursor** (attach and spawn): `friday harness config cursor` writes fail-closed hooks for every tool, the `friday` server and an always-applied rule; `friday harness doctor cursor` checks them without starting Cursor; `friday harness run cursor` drives the Cursor CLI headless in a task's worktree, with Friday's hooks and its tools for spawned agents from a plugin folder. Cursor is `enforcing` on 3.24 or later (CLI 2026.10.16 or later).
- **Antigravity** (attach only): `friday harness config antigravity` writes Friday's hook group, the `friday` server and an `AGENTS.md` block; Friday answers deny or `force_ask`, never an approval. It is `unverified` until a run shows what a failing hook does.
- **Gemini CLI** (attach and spawn): `friday harness config gemini` writes Friday's hooks and the `friday` server into `.gemini/settings.json` and a `GEMINI.md` block; `friday harness run gemini` drives Gemini CLI headless with Friday's hooks, its own approvals off and the tools Friday cannot judge denied. It is `degraded`: a hook that fails lets the call through. Gemini CLI no longer serves consumer accounts, so a paid key is needed.
- **Protections for every host:** the folders where Gemini CLI and Antigravity read hook commands (`.gemini/`, `.agents/`) and programs named `node` or `git` at the project root are protected like Claude Code's settings; a shell call that runs inside, or changes into, `.friday`, `.git` or Friday's state folder is refused; Gemini CLI's `web_fetch` is judged by every URL it would fetch; a stop is held only when the agent ended its own turn, never after a human's abort; with Friday down, a session Friday spawned is refused at once.
- **The CLI and the Studio** list all four hosts: `friday harness hosts`, the start-agent dialog, the agent cards and `friday doctor`.

## Unreleased — M12, the optimizations

What already exists became cheaper to run or quicker to start; Friday's role does not change, and nothing here spends model tokens beyond the Master Brain's bounded calls.

- **Planning on your own machine:** `master_brain.provider: local` plans with a model your Ollama or LM Studio server runs, with no key, no remote consent and no budget, at a cost of $0.00, while every call's tokens are still recorded. The server must be at a loopback address (`providers.local.base_url`, default `http://127.0.0.1:11434/v1`); other addresses are refused when the configuration is read, and redirects are never followed. Friday sends the plan's JSON schema so the server's grammar enforces task keys and roles, falls back to JSON mode on a server that refuses a schema, and applies the same validation, repair attempt and approval as with Claude. `friday doctor` checks the server and the model, `friday brain status` names them and says the budget is none, and `friday models` lists the model as local. Checked live with `qwen2.5:7b` on a laptop processor: a valid plan in 1.7 minutes.
- **The ceiling on delegated work:** a task never holds more authority than what delegated it. A plan's task is held to the scope the project declares for its role: cut to what lies inside, with a note the reviewer sees, or refused when nothing fits, when the plan is proposed (the Master Brain's drafts are checked before the proposal) and again when it is approved. While a task runs, a write outside both its scope and its role's scope is refused by the hooks with the ceiling named, a permission request for it is refused at once instead of being put to you, and verification fails such a change whatever was approved.
- **The handoff summary:** an attempt that continues a task after a crash, a reassignment, a restart or a rework starts from a fixed summary built from Friday's records (goal and constraints, what was done, what was checked, what was decided, what is next, the files changed), at most 1,500 characters and never dropped by the packet budget; a resumed session gets it at SessionStart.
- **Two agent tools:** `friday_list_peers` tells an agent who works on its goal, and `friday_message_receipt` whether a message it sent was delivered, read or answered, per recipient; both read Friday's records. Friday's tools number 19, and `friday harness config claude-code` refreshes the skill (template version 5).
- **One command to start:** `friday start` makes the folder a Friday project when it is not one, starts Friday hidden when it is not running, and opens the Studio signed in, in three lines at most; `--desktop` opens the desktop app when it is installed, and `--no-open` prints the address. `pnpm pack:release` bundles Friday into `dist-release/friday-<version>.tgz` and checks it by installing it into a temporary folder and running `friday --version`, `friday setup` and `friday start` in a fresh repository; `npm install -g ./friday-<version>.tgz` installs Friday on a machine with Node and Git. `friday init` now points to `friday start`. The desktop app has a per-user installer, `Friday Desktop_0.1.0_x64-setup.exe`, which installs it into `%LOCALAPPDATA%\Friday Desktop` without administrator rights, apart from Friday's private state folder; `friday start --desktop` finds it there.
- **Context evals:** sixteen tasks written against Friday's own repository measure what the context compiler hands an agent, offline and without a model (`FRIDAY_TEST_BENCH=1`): 59% mean required-context recall at the claim budget with a declared read scope, every protected and out-of-scope file kept out, every delivered packet within budget, each miss named with its cause (`docs/measurements/2026-10-18-context-evals.md`). The set's own checks run in every full test run.
- **What Friday did for a goal:** the goal card shows one line, with each fact on its own row in its tooltip; the landing dialog lists them under "What Friday did", and `friday goal show` prints them: tasks verified, completion claims the checks refused and the rework that followed, actions held for you and actions the policy refused, sessions lost and recovered, the hosts' reported tokens and cost and from how many attempts, and Friday's own planning calls. A figure nobody reported is never shown as 0. `GET goals/:gid` carries them as `summary`.
- **Large repositories:** a context record too large for one event is cut to fit, with a note; a claim whose context cannot be delivered still answers with the task and the reason; a compile builds the handoff summary once, reads only the task's own approvals and questions, and reads the source identity once.

## Unreleased — M11, finishing the built milestones

What the built milestones had left open is closed; none of it spends model tokens.

- **Commands:** the judge reads `xargs` as the command it runs with its arguments, in every shell: `find … | xargs grep -l x` runs without a human, `find … | xargs rm -rf` is refused as `rm -rf` would be. In a POSIX shell a `case … esac` is judged by what its word and patterns substitute and by every branch's commands. A word that only passes a command on (`sudo`, `env`, `nohup`, `exec`) no longer hides a shell wrapper, and `env` alone is refused as `printenv` is. An `xargs` whose command is its input, and a wrapper run in the background, ask a human.
- **Configuration:** Friday reads `.friday/config.yaml` again whenever it changes and applies at once every setting it reads where it is used: scopes, autonomy and risk (what loosens still waits for `friday policy trust`), verification checks, conflict-prone files, recovery limits, routing, the agent messaging limits, and the Master Brain's model, effort, token limit and replan limits. The settings captured at start (project, daemon, leases, worktrees, providers, the Master Brain's provider) keep their start values, and the Studio's banner and `friday status` name exactly which changed key still needs a restart. Each read is recorded as a `config.reloaded` event.
- **Interface:** the Notch pill's waiting chip shows the rail through the same door as the header's count; opening Project memory from a "memories need review" row scrolls to that section, which says so when nothing needs review any more; a message awaiting your reply raises a notification as an approval does, under the same toggle and limit, and clicking it opens Messages at that delivery.
- **Codex usage:** the Codex adapter records what each run attempt cost from the app-server's token-usage notifications (the last count wins), with the model the thread reported and the turns the adapter ran; `friday usage` shows Codex attempts with their host fields. Each host's counters are kept as the host reports them.
- **A spending cap per task:** `routing.task_budget_usd` in `.friday/config.yaml`; unset means no cap. Friday passes the cap to the Claude Code sessions it starts (`--max-budget-usd`, the smaller of the agent's own cap and the task's) and, for every host, stops an attempt whose reported cost reaches the cap, once, recording the figures and asking you what to do next; the task waits for you and is never run again on its own. Finished work the session reports right after the stop is kept as a claim, not run again. `friday usage` shows the cap beside the cost of an attempt the cap stopped.

## Unreleased — M9k, the clearer interface

A product review of the interface as built judged each of its 204 surfaces on whether it earns its place on the screen ([the review](docs/reviews/2026-10-17-ui-product-clarity.md)); the owner took its recommended option on all six of its decisions. The first screen now holds what a person decides and watches daily, and what explains or tunes Friday is one click or one typed word away. Nothing is removed from the code: every surface that left the first screen is still reachable where the review's section 6 says, and a test opens it there. An adversarial review of the built result found 16 things, every one fixed with a test. The interface plan is at revision 3 ([PLAN.md](docs/frontend/PLAN.md) §7, FD-31 to FD-36), with ERRATA F41 to F44, ADR-0033 amended (still Proposed) and [lessons](docs/frontend/LESSONS.md) UI-97 to UI-112.

- **The first screen holds 20 fixed controls** (21 with the Notch pill in a browser), down from about 27, counted by a test over the rendered shell. A header of eight: the project's name (the folder path in its tooltip), the state dot (the address in its tooltip), Running (the status sentence in its tooltip: what runs, what waits for you and why, what is ready, to verify or failed, how many agents are connected), Waiting for you, Search, Messages, a More (…) menu with Project memory, Code graph and About, and the gear. A dock of four: New goal, Agents, Pause/Resume, Halt. The header's Memory, Code graph, Routing and Worktrees items and the dock's Search, gear and Mute left the screen: Memory and the Code graph are in the More menu and the palette, Routing in Settings → Routing, the worktrees count in Settings → Friday and About, Search and the gear in the header, Mute in Settings → Sound, the palette, the desktop Notch's footer and the tray.
- **One name per thing:** *Messages*, *Project memory*, the inspector's tabs *Overview · Changes · History · What the agent was given*, *Live stream: <key>*, *Allow for this task…*, one vocabulary for a grant's reach (*Once / For this attempt / For this task*, on the card, in the full view and in the toast), *Reply to <agent>* on every reply box, *Open Studio* and *Open this in Studio* on the desktop Notch. The agent pods and the Agents drawer say *Enforced*, *Reported*, *Watched* or *Unverified*, with the level in the tooltip; the level codes appear nowhere else.
- **The board:** the task card loses its branch row and opens its diff from the `+N −M` figure and a *Changes* hover action; the minimap appears only while a card lies outside the view; the zoom toolbar gains a *Finished goals* toggle and, after a card was dragged, *Tidy*; in a Studio narrower than 900 px the two toggles are icons. The live stream opens on Errors after a failure. The plan editor's JSON tools sit behind a *More* fold. The config-changed banner says how to restart from where you are (a Restart Friday button on the desktop; Open Settings in a browser).
- **Settings regrouped:** Notifications first, with its test button; Sound; Look and Notch, with the Notch timings under an Advanced fold; Planner; Routing is the pins' home, with the routing mode word; Policy; Friday holds Stop, Restart, Log out, "Worktrees in use: N" and *Clean up released worktrees*; Desktop app; About shows Friday's version, the interface's version and API, the project, the folder, the address and the worktrees in use. The palette's housekeeping commands (Prune, Reindex, Stop Friday, Reset moved cards) appear when typed, not in the empty list; Zoom in and Zoom out left the palette (the toolbar, the wheel and the keys zoom).
- **The Agents drawer** shows one list of agents, each row saying whether Friday started it or it attached in VS Code, connected or not, its process state, enforcement and model, with Stop, Start again, Forget and an Output fold as they apply; the installed hosts live in the Start dialog's Host field, with *Check again*, and in the drawer only when none is found; the dialog's host options sit under an Options fold. The routing question card keeps its Pin, with the line "Pins are kept in Settings → Routing."
- **The Notch in a browser** is its pill: the task tag opens the task, the file ticker the diff, the waiting chip the rail; it never opens a card. **The desktop Notch** keeps its card; its quick prompt is one goal line ("Describe a goal…", Enter, "Create a goal: …? Press Enter") with no command words, and the card shows a notice with a door for a proposed plan, a message awaiting your reply, memories to review and a policy change to trust.
- **Waiting for you is one list everywhere:** the header count, the title badge, the Notch chip, the desktop tray and the rail read the same list, which now includes proposed plans and three new kinds: a message awaiting your reply, memories needing review and a policy loosening not yet trusted. The three new rows open where they are decided: the Messages drawer at that message, Project memory at Needs review, Settings → Policy. Getting started gains "Get notified while this tab is hidden" and, when it applies, "Trust this project's policy".
- **The desktop tray's** tooltip and first menu item carry the status sentence, cut at 119 characters.
- **For anyone building on the API:** the board snapshot gains `memories_to_review` (a number) and `policy_untrusted` (a boolean, from the daemon's policy trust).

## Unreleased — M10a, the token baseline

The baseline was run twice on 2026-10-18 and recorded in `docs/measurements/2026-10-18-token-baseline.md`: both tasks verified on their first attempt in both runs; 75,005 input-side tokens per verified task (the two runs 1.9% apart), 4 API calls per task, 3.25 whole-file reads per task, about $0.01 notional per run. A call carries the whole context again, about 17,000 to 20,000 tokens, of which Friday's rules, packet, tools and first message are about 2,450; what the agents read is about 2% of the input side. The next change, M10b, removes a call per task.

Friday now joins what each run attempt cost with what it was given. `friday usage [--goal <id>] [--task <id>] [--json]` and `GET /usage` show, per attempt, the host's reported input and output tokens, cache reads and writes, cost, turns and model, the weight of the context packets delivered to it, its context requests by kind, its tool calls by kind (read, edit, shell, web, Friday; and whole-file against ranged reads) and the verification verdict. A host that reports nothing shows unknown values, never zeros, and the totals say how many attempts reported. This row is the yardstick every later change to context handling is measured against.

- **What counts for an attempt:** only what its own session did. A second live session of the same agent (a shadow, or one restarted during the reconnect grace) reads the same task and gets its own packet at its start; the hooks no longer record its tool calls against the attempt, and the row counts neither its packet nor its calls. The rules for a task worked on twice (a boundary packet goes to the earlier attempt, once; an attempt never shows another attempt's verdict) are tested.
- **Context requests:** Friday records a `context.requested` event when a request arrives, before the compiler answers or refuses it, so the row counts a refused request too.
- **Totals:** `host_reported` says how many attempts sent a usage report at all; `reporters` says how many each token total sums, since a host may leave a field out (an older report without the cache fields, an error result with a cost and no counts). The CLI prints "(from N of M)" next to a total whose reporters differ, and its legend says which "-" means the host did not report and which means nothing to show.
- **The Claude spawn adapter** keeps the host's usage report with the report of how the turn ended, so an outage at that moment loses neither.
- **The baseline run** (`tests/scenarios/token-baseline.live.test.ts`, gated by `FRIDAY_TOKEN_BASELINE`): two spawned Claude Code sessions do the gift-card goal of a hand-written plan (`tests/fixtures/baseline/giftcard-plan.json`) on a fresh fixture-shop copy, pinned to `claude-haiku-5-5`, each attempt capped at `--max-budget-usd 0.25` and the whole run by a turn budget; a dry mode starts the real Claude Code and refuses its first message, so no model is called; everything the run showed is saved outside the repository whatever happens, and the run passes only when every usage row is complete. `docs/measurements/README.md` says how to run it and how to read a row.

## Unreleased — M9, the user interface

Friday can be used from a browser for daily work: `friday ui` (or `friday ui --start` and `friday shortcut`, which start Friday when it is not running) opens the Studio signed in ([the plan](docs/frontend/PLAN.md)).

- **The Studio:** goals, tasks and agents on a canvas, with an inspector, the diff, the code graph, memory and a live terminal; approvals and questions in a Decisions tray beside it; plans written in the page or proposed by the Master Brain, approved on the board; verification, integration and landing; pause, resume and halt in the dock; the Notch at the top with Blip.
- **Starting agents:** Claude Code or Codex started from the Agents drawer, remembered as profiles that start again with Friday.
- **Sign-in:** a one-time link opened through a file in the private folder, so the code is on no command line; a session per tab, at most 12 hours; a page served under a path new at every start, never cached, so nothing an earlier program left on the address runs in it.
- **Daemon:** pause, resume and halt by effect; spawned agents continue in their run after a human decides; Friday's own questions act by kind and close when their cause is resolved; verification runs Friday's own checks when a project has none.
- **Tests:** `tests/ui-e2e` drives the real page in the installed Edge or Chrome against a real Friday (`FRIDAY_TEST_UI_E2E=1`), including a day in the life from `friday init` to a verified, integrated goal across a restart. What those runs found is fixed and recorded ([lessons](docs/frontend/LESSONS.md) UI-43 to UI-52).
- **The desktop app (Windows, `apps/desktop`):** a Tauri 2 shell that floats the Notch over the editor, keeps the Studio in its own window and a tray icon, starts Friday when it is not running, and forwards only an allowlist of routes from its pages, which hold no credential. Built per user with Rust's GNU toolchain ([steps](apps/desktop/README.md)).
- **Review of the interface** ([record](docs/reviews/2026-10-17-ui-interface-review.md)): 25 defects fixed, each with a test. Plans are approved in their review, where every task's instructions are shown in full. Hidden characters are marked the same way everywhere, and an escape never hides the text after it. Events are no longer lost when a snapshot read gets ahead of the stream. A decision made on the page is not undone by an older snapshot. The desktop app confirms every route that cancels, restarts or launches. A resume held through a long pause is still sent. On Windows, Friday never starts `git` or `explorer.exe` from the repository folder.
- **Fix:** a loose task a human reserved for a spawned agent (`friday task create --assign <agent> --ready`) was never started; Friday now starts it when that agent is free (LESSONS D-51).
- **Deep review of the interface** ([record](docs/reviews/2026-10-17-frontend-deep-review.md)): 13 findings and 12 problems found in their fixes, each fixed with a test (LESSONS UI-73 to UI-96):
  - **Goals:** a goal whose plan editor was closed, or created from the quick prompt, offers **Write the plan** on its card and in the palette; progress counts every task of the goal, also those finished days ago.
  - **The board:** a failed read is retried by itself; questions appear the moment they are asked; the stream never replays old history into sounds; each task card shows its tool calls, live.
  - **Dialogs and the diff:** "Open the diff" from verification, landing or an approval opens in front and goes back; a removed final newline shows as a change.
  - **Preferences** (sound, motion, outfit, node positions) survive a restart: Friday keeps them per project, and the desktop app shares them; notifications stay per browser address, where permission to notify belongs.
  - **The desktop app:** long verifications no longer time out after 15 minutes; the Notch's Settings, Routing and file links open the right place; the Planner's key and spending dialogs are in Settings; **Start Friday when I sign in**; **Send a test notification**, which says only what the app can know.

## Unreleased — the recorded live MVP demonstration

Part 12 §18 ran once with two real hosts: Claude Code 2.1.301 and Codex 0.162.1, both spawned, on one goal ([the record](docs/integration/mvp-demo.md#recorded-live-2026-10-16)). Two tasks ran in parallel worktrees; the shared contract's change reached only the backend agent; the Codex adapter was killed mid-turn and the same run resumed in the same Codex thread, with Friday's tools; a failed verification was reworked; both tasks were verified and integrated, and the goal completed. What it found is fixed, each with a regression that failed before the change (LESSONS D-49, D-50):

- **Fix:** `friday context explain <task>` compiled a new packet for the human asking, who may read more than the agent, and showed it as the task's context. It now explains the newest packet the task's agent was given; `--fresh` compiles a preview, labelled as compiled for a human.
- **Fix:** a Master Brain question about a failed task stayed open after the human reworked the task, and the goal completed with it pending. When a task is sent back for rework, completed or cancelled, Friday closes its open failure questions as no longer needed, and that answer starts no revision.

## Unreleased — the interactive Claude Code check

Claude Code 2.1.300 in the VS Code panel ran two tasks end to end, both verified COMPLETED. What it found is fixed, each with a regression that failed before the change ([the guide](docs/integration/claude-code.md), LESSONS D-41 to D-45):

- **Approvals:** the panel declines Friday's in-panel approval form without showing it, and Friday counted that as the human's refusal. Only a filled-in form counts now; a decline leaves the request pending for `friday approve`.
- **Verification:** a session working in the main checkout had no base commit, so what it committed during the task escaped the diff and secret checks. Its run now starts from the commit its checkout was at when it claimed.
- **Policy files:** a new or changed file in `.friday/policies/` applied only after a reload or a restart. Friday reads them again when they change; `config.yaml` still needs a restart.
- **Commands:**
  - bash loops over files, `command -v`, `[ … ]` and `read` are judged as reads, so they no longer ask;
  - **Fix:** commands in backticks (`` echo `rm -rf x` ``), `find -delete`, `find -exec`, and a leading `$x` in bash passed as reads. Each is judged as what it runs, by the shell the host names.
- **From the owner's hands-on tests:**
  - **Fix:** approving a request now resumes the task its agent set waiting for it, and an operation refused for a waiting task says why.
  - **Fix:** `friday plan propose --goal X` failed, and `plan approve --goal X` approved the newest goal's plan instead of X's.
  - **Delegation:** a task that names a role goes to a free agent of that role when there is one; experience decides among them.

## Unreleased — M8a.5, the M8 readiness review

A review of M8a found 7 gaps; each is closed, those that were defects with a regression that failed before the change ([disposition](docs/reviews/2026-10-15-m8-readiness-review-disposition.md)).

- **Commands:**
  - **Fix:** a value PowerShell only prints, written into a file (`'x' > f`, `$x > f`), passed as a read. A redirection into a file now needs a human's decision at every depth of a command.
  - **Fix:** a numbered stream (`2> f`) or a quoted target was never seen as a write.
- **Spawn adapters (Codex and Claude Code) keep serving Friday:**
  - **Fix:** one failed poll stopped every later instruction, cancellations included, while the heartbeat kept the harness looking healthy. The loop now keeps polling.
  - After a whole lease without hearing Friday, an adapter ends its hosts' work, and registers again once Friday answers.
  - A daemon started again on another port is found.
- **Fix: a start Friday no longer wants starts nothing.** Friday's answer to an acknowledgement now says which runs are current (`current`). A start cancelled, expired or reassigned before the answer ends the host prepared for it.
- **Fix: Claude Code's startup check can no longer lose to a quick result.** It decides when the report arrives; a report that leaves out what the session runs with is refused.
- **Fix: how an attempt ended is no longer lost.**
  - It is kept until Friday records it, on disk with `friday harness run`, and tried with one idempotency key.
  - A spawn adapter started again is told to resume its running tasks. Before, it was told only about tasks Friday had already judged lost.
- **Friday's tools in spawned sessions.** Codex and Claude Code sessions that Friday starts can now reach the agents whose work relates to theirs, answer them with facts, ask Friday for context and permissions, and have a declared operation run (`friday_communicate`, `friday_request_context`, `friday_request_permission`, `friday_run_operation`).
  - Codex gets them as client-served tools (experimental in 0.162.1).
  - Claude Code gets them from an MCP server the adapter serves, its only one.
  - Messages reaching a session say their id, so it can answer.
- **Live checks are gates.** A live check passes only when every behaviour it names was observed. A case it did not run fails as not run, and one that fails keeps the rest of the approved turns. Claude's live cases are selected with `FRIDAY_CLAUDE_LIVE_CASES` (`work`, `restart`).
- **The live MVP script** starts with a checklist that calls no model: the Codex sandbox, fixed models and spending, a hand-written plan, and what to record.

## Unreleased — M8a, a second host

- **M8a.1, one judgment for every host** (ADR-0032):
  - **New protocol method `tool.check`.** A spawn adapter asks Friday before its host runs a command or changes a file. It gets the same answer Claude Code's hooks get, from the same code. Where a human decides, Friday records one pending approval for exactly that action; once you approve it, the action goes through once.
  - **Commands are judged inside their shell wrapper** (`"C:\…\powershell.exe" -Command '…'`, `cmd /c`, `bash -lc`), every part of them. **Fix:** before, a redirect inside `bash -lc` counted as a read, and `printenv` inside it was not refused.
  - **Fix:** a request to run a command is judged as that command. Before, a recursive delete naming an absolute path could not be approved.
  - `task.resume` tells the adapter which host session to resume.
  - Hosts that speak over stdio run inside Friday's process groups.
- **M8a.2, Codex works for Friday** (`friday harness run codex --agent <key>`, guide: `docs/integration/codex.md`):
  - **Its own host.** Each task attempt gets its own Codex app-server, in the task's worktree, inside a Friday process group. Cancelling a task stops it and everything it started.
  - **Friday decides.** Every command and file change Codex asks about is decided by Friday's policy. Friday answers only accept or decline. What a human must decide waits for `friday approve`.
  - **Settings pinned on every thread:** Codex's approvals come to Friday, never to its own reviewer. The model Friday routed is used, and the model Codex reports is recorded.
  - **Messages** for the agent reach its running turn.
  - **Finishing.** A turn's end becomes a completion claim for verification, a blocked result, or an error.
  - **Doctor.** `friday harness doctor codex` checks the executable, its app-server and its sandbox, without calling a model.
  - Writes Codex makes without asking, and its own delegation, are reported, not hidden.
- **M8a.4, the MVP demonstration:** `tests/scenarios/mvp-demo.test.ts` runs the spec's MVP script end to end with Claude Code and Codex on one project. That covers the plan, parallel worktrees, each agent's context, a contract change routed only to the agent it concerns, tests, one harness killed and recovered, verification, integration and the verified goal. `docs/integration/mvp-demo.md` is the same script for a recorded run with real hosts.
- **M8a.3, Claude Code in spawn mode:** `friday harness run claude-code` lets Friday start your installed Claude Code (2.1.300 or newer) itself for the tasks it gives an agent. Each run attempt is one headless session in the task's worktree, ended with the attempt, on cancel, or when you stop the adapter. The session:
  - reads no settings files of yours or the repository's;
  - has only the tools Friday's hooks judge, and no MCP servers or skills.

  Friday decides every tool call: what a human decides waits for `friday approve`, and the session is told no until then. A restarted adapter resumes the same session. `--max-budget-usd` caps each attempt's spending.
- **Stopping Friday lets work in flight finish:** an integration or a task worktree job that is still running when the daemon stops now finishes first (within a minute), instead of being cut off with no record and leaving git working in your checkout.
- **The live Codex check:** Friday's Codex adapter ran against the real Codex in six turns the owner approved (`tests/scenarios/codex.live.test.ts`, results in `docs/integration/codex.md`). What it changed:
  - Friday's Codex threads no longer carry your own Codex tools (plugins, ChatGPT apps, MCP servers, web search), and a repository's own Codex configuration no longer applies in them; nothing is written to your Codex configuration.
  - A run's first turn starts only once Friday knows the run started. An error before that frees the task instead of leaving it stuck.
  - Context for a host without Friday's tools no longer names them.
  - Friday's command policy judges what PowerShell blocks run, so Codex's reads on Windows pass and the writes inside them do not.
  - `friday harness doctor codex` starts a command in Codex's sandbox to see whether it works. `friday harness run codex` takes `--windows-sandbox` and `--service-tier`.
- **The live Claude spawn check:** Friday ran your installed Claude Code (2.1.300) in three turns the owner approved (`tests/scenarios/claude-spawn.live.test.ts`, results in `docs/integration/claude-code.md`). The third turn ran a task end to end, for $0.006: Friday judged every tool call, a message reached the running turn, and verification completed the task. What it changed:
  - **Fix:** Claude Code adds a tool, `StructuredOutput`, for the final answer. Friday ended every session that reported it; it now expects that tool and allows it.
  - Friday now also checks the plugins and skills a session reports. Claude Code's own built-in plugins are accepted; any other plugin, or any skill, ends the attempt before a tool runs.
  - Friday's rules for spawned sessions, Claude Code's and Codex's, now say to change files with the file tools, not shell commands. They also say a refused call is Friday's decision: the agent should not get the same effect another way.
  - The guide says where Claude Code keeps each session's transcript (`~/.claude/projects`, one folder per worktree).

## Unreleased — M7.1e, the follow-up review of M7.1

A follow-up review of M7.1 found 7 more gaps in authority and continuation. Each is fixed, with a regression that failed before the change ([disposition](docs/reviews/2026-10-15-m7-1-review-disposition.md)).

- **Context:**
  - A packet is delivered only under the authority it was compiled under: the policy, the agent's read grants, and its task and attempt. If any of them changes meanwhile, the packet is compiled again; after three changes the request is refused (`COS-5000`) instead of answered with a stale packet.
  - A file shown only because of your exact-path approval now spends it: a one-use approval opens one packet.
  - History lists only commits that change a file the agent may read.
- **Verification** checks its authority as the very last step before the verdict, so a policy tightened during its final reads of the checkout interrupts it.
- **Integration:**
  - `friday integrate <task>` retries a failed integration from the same verified commit, including after Friday committed the work and stopped before recording the integration.
  - **New:** `friday integrate <task> --repaired` integrates your repair of a conflict on the task branch, after the checks pass on what would land.
- **Restore:**
  - **New:** `friday recover <task> --action rebind` brings finished work from a lost clone into this one and keeps the task's state: a claim waiting to be verified, a verification the backup caught midway, or verified work waiting to be integrated. A claim comes only with the work it lists.
  - `friday restore` checks the backup's database (its hash, then a copy's integrity, project, event head and schema) before it changes anything; a damaged or swapped database is refused.
- No migration.

## Unreleased — M7.1 cross-milestone stabilization

The M7 review looked at the joints between milestones and found 17 gaps; each is fixed or decided, with a regression that failed before the change ([disposition](docs/reviews/2026-10-14-m7-review-disposition.md)).

- **Verified means verified:**
  - Integration commits exactly the git tree a verification judged, never what is in the folder by then, and a merge whose checks change its checkout fails.
  - Evidence Friday cannot read (an unreadable checkout, an unknown base, a failed read after the checks) interrupts a verification instead of passing it.
  - Verification applies the project's deny rules and team scopes as the hooks do, honours a human's exact-path approval, records the policy version, and is interrupted by a policy change. **Breaking:** a verification recorded before M7.1 has no tree; verify such a task again before it is integrated.
- **Operations obey their authority and their lifetime:** an operation starts only if its task, attempt, session, approval, policy, definition and role still hold when it starts; cancelling, releasing or recovering the task stops it and every process it started (a job object on Windows, a process group elsewhere), confirmed before the worktree is reused.
- **Clones and backups:**
  - A restored clone works only in its own checkouts and asks you about work that was in another clone.
  - `friday backup` now also holds the code of Friday's work: its branches, preserved attempts and the uncommitted work of task worktrees (`code.bundle`, format 2). `friday restore` adds it to the clone without moving any of its refs back, and `friday recover <task> --action reassign` brings a task's work into a worktree there. Without the code, Friday says what is missing instead of starting over silently. See [docs/runbooks/backup.md](docs/runbooks/backup.md).
- **Routing:**
  - A route that forbids the work starts nothing (`COS-7003 routing_blocked`), is recorded once, and asks you once; a host reporting a model its constraints exclude has its attempt ended.
  - **Breaking:** secret-sensitive work runs only on a local model you pinned for it with `--sensitive`; a general pin no longer counts.
  - Laya is reached only at a literal loopback address, never through a redirect, within one deadline for its whole answer, and its answers are validated. Delegation waits for a task's open Laya question, bounded by its deadline.
  - `friday models` separates measured results (a model seen running) from assumed ones, and compares results under the same checks and host version.
- **Context:** packets apply the same read policy as the hooks and are compiled again when it changes; the size you ask for is the size of the packet delivered, or the answer says what it needs (`COS-5002`); requests for files, scope, history and decisions are honoured.
- **Memory** keeps case: correcting `UserID` to `userId` is a new fact, not a duplicate.
- **Fix:** a command or check argument naming a folder next to Friday's state folder whose name starts the same way was refused as private.
- Migrations v19, v20 and v21.

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
