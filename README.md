# Friday

Friday is a local control plane above AI coding hosts. It manages goals, plans, tasks, context, communication, policy, model routing, verification and recovery. Hosts run the agent loop and the tools; git remains the code authority.

Friday is local-first. One daemon per project clone serves HTTP on **127.0.0.1** only; every state change is a redacted event in a local, append-only spine backed by SQLite; context packets are compiled deterministically under the caller's read authority; and no secret is ever placed in config, events, MCP responses or host configuration. The policy engine governs the host surfaces its adapters control — it is a manager, not an OS sandbox. The exact boundary is the [security model](docs/SECURITY.md).

## Supported hosts

| Host | How Friday drives it | Status |
|---|---|---|
| Claude Code | attached (MCP server, skill and hooks) and spawned (headless, restricted) | supported |
| Codex | spawned through its app-server | supported |
| Cursor | attached and spawned, from its documented behaviour | experimental, live check to do |
| Gemini CLI | attached and spawned, from its documented behaviour | experimental, live check to do |
| Antigravity | attached, with hooks | experimental, live check to do |
| OpenCode | spawned through a pinned launcher and a policy plugin | experimental |
| DeepSeek Harness | detected and configured | not dispatchable |

Each host's achieved enforcement level and readiness limits are in the [security model](docs/SECURITY.md).

## How it fits together

| Surface | Role |
|---|---|
| Daemon (`friday run`) | One per project clone. A Hono HTTP app on `127.0.0.1`: operator API, harness protocol RPC and SSE stream, hook routes, the UI backend, verification, integration, recovery and a one-second housekeeping tick. |
| `friday-mcp` | One stdio MCP server per attached session: 25 `friday_*` tools, resources and prompts. It discovers the daemon and registers with bootstrap authority. |
| Hook launcher | A host-started, dependency-free `hook.mjs` written into the project by `friday harness config <host>`. It judges protected paths locally (fail-closed, even when the daemon is down) and forwards the event to the daemon. One launcher serves every hooked host. |
| Spawn adapters | Friday owns the host process tree per attempt: task worktree, restricted tool surface, an attempt-owned Friday tool endpoint, durable starts and resumptions, and the recorded outcome. |
| CLI (`friday`) | Operator commands over local discovery and the operator token: setup, tasks, goals, the Master Brain, secrets, harness wiring, graph, policy, routing, memory, messaging and more. |
| Studio and Notch | The browser and desktop UI served by the daemon at `/ui/`: the canvas, governance cards, the Notch island and the mascot. |

A goal runs **intent → plan → approval → delegation → workspace → context → work → claim → verification → integration**. An agent's completion claim only moves a task to `READY_FOR_VERIFICATION`; a passing Friday verification makes it `COMPLETED`, and a goal completes only when every task is completed and integrated, or cancelled.

## Repository layout

```text
apps/
  cli/          the friday command (commander)
  daemon/       the daemon behind friday run (Hono)
  ui/           the Studio, the Notch and the mascot (vanilla TypeScript + Vite)
  desktop/      the Tauri 2 Windows shell
packages/
  protocol/ core/           contracts: zod schemas and pure state machines
  db/ events/ state/        SQLite, the append-only event spine and FridayState
  policy/ execution/        capability judgment and credential-brokered operations
  git/ verification/        worktrees, source identity and the check runner
  code-graph/ context/      the tree-sitter graph and the context compiler
  routing/ planner/         the role registry and the Master Brain
  sdk/ mcp-server/          discovery and clients, the friday-mcp stdio server
  adapters/                 generic, claude, codex, cursor, gemini, antigravity, opencode, deepseek
schemas/                    JSON Schema for api/v1, protocol/v1, events/v1 and context/v1
tests/                      cross-package suites, fixtures and test support
scripts/                    the portability gate, clean and release packing
site/                       the landing page (static, zero dependencies)
docs/                       overview, security model, setup and the build-kit index
```

### Packages

| Package | Responsibility |
|---|---|
| `@friday/protocol` | Wire envelopes, harness protocol methods, event schemas, error codes and version negotiation (zod; generates `schemas/`) |
| `@friday/core` | Domain entities, invariants and pure state machines for task, agent, harness and run |
| `@friday/db` | SQLite access: pragmas, forward-only code migrations, transactions; `better-sqlite3` with a `node:sqlite` fallback |
| `@friday/events` | Append-only event store, transport, redaction, artifacts, replay and snapshots |
| `@friday/state` | `FridayState`: the command bus with idempotency, projector, queries and the memory, intent, learning and readiness services |
| `@friday/policy` | Scopes, sensitive path classes, command classes, autonomy and capability evaluation — pure functions shared with the hook launcher |
| `@friday/execution` | The execution profile and the gateway that runs operations with secrets the agent never sees |
| `@friday/git` | Git state of an execution root: status, refs, diff, dirty-content identity, worktrees, bundles and recovery |
| `@friday/verification` | The check runner and completion verification, bound to source identity and policy |
| `@friday/code-graph` | File-level code graph — imports, consumers, tests, shared contracts — via tree-sitter WASM |
| `@friday/context` | The context compiler: permission-first deterministic packets with budgets, a cache and explanations |
| `@friday/routing` | The model catalog, the static role registry (`friday_registry.json`) and the deterministic routing decision |
| `@friday/planner` | The Master Brain: goals, versioned plans, delegation, replanning and escalation over a pluggable provider |
| `@friday/sdk` | Daemon discovery, HTTP/RPC client, SSE, config, the secret store and private-directory hardening |
| `@friday/mcp-server` | The `friday-mcp` stdio server: tools, resources and prompts for attached and spawned sessions |
| `@friday/adapter-*` | The generic harness client plus Claude Code, Codex, Cursor, Gemini CLI, Antigravity, OpenCode and DeepSeek adapters |

## Getting started

Node major 24 (`.node-version`; engines `>=22.18 <27`) and pnpm **12.11.2** are the toolchain, with TypeScript pinned at **5.9.3** (the code graph uses the compiler API) and Git 2.38 or later for `git merge-tree --write-tree`. No compiler toolchain is needed for the backend: `better-sqlite3` ships a prebuilt binary with a `node:sqlite` fallback, and tree-sitter grammars load as WASM. Rust is required only by the desktop shell. Windows is the first platform and everything works without administrator rights. [SETUP.md](docs/SETUP.md) has the exact installation and staged verification gates.

```powershell
pnpm install
pnpm build            # turbo run build
pnpm typecheck
pnpm lint             # biome check .
pnpm test             # turbo run test
pnpm test:all         # one vitest run across every project
```

## Running it

```text
friday setup                       # configure this checkout (.friday/config.yaml)
friday run                         # start the daemon; the Studio is served at /ui/
friday status                      # or: tasks, goal, approvals, escalations, ...
friday harness config claude-code  # write hooks + MCP config for a host
friday harness run codex           # work the spawn loop for a host
```

During development, `pnpm friday <command>` runs the CLI from workspace sources. `friday --help` lists every command.

## Development and testing

- Unit tests are co-located in every package and run against source through workspace aliases.
- `tests/` holds the cross-package suites: **integration** (daemon, API, CLI), **conformance** (one driver per host, scripted), **hooks** (the launcher), **mcp** (stdio end to end), **security** (the Part 11 suite, tool coverage and the UI boundary), **scenarios** (milestones, demos and gated live checks), **ui-e2e** (Playwright, gated by `FRIDAY_TEST_UI_E2E=1`) and **evals** (measurements, gated by `FRIDAY_TEST_BENCH=1`).
- `pnpm check:registry` verifies the generated role registry artifact against its typed source.
- `pnpm check:portability` enforces the portability rules: LF endings, no shell scripts, no `localhost` literals, POSIX-safe package scripts. CI runs it as its own workflow.
- CI (`.github/workflows/ci.yml`) runs a test matrix (Ubuntu + Windows × Node 22/24, with Node 26 experimental) and a clean-install job on Windows.

## Release packaging

`pnpm pack:release` builds every package, esbuild-bundles the CLI and the MCP server into one npm package named `friday`, and produces `dist-release/friday-<version>.tgz`. The script then installs that tarball into a temporary prefix and smoke-tests `friday --version`, `friday setup` and `friday start` in a throwaway git repository. Nothing is published by the script. The version is the root `package.json`'s when present, else `0.1.0` from `@friday/sdk` — what `friday --version` prints.

## Frontend

[apps/ui](apps/ui) is vanilla TypeScript + Vite: the Studio canvas, the governance surface, the Notch island (physics springs, not CSS durations) and Friday the duck. The daemon serves the built bundle at `/ui/` with per-start no-cache paths; the Vite dev server proxies to the daemon (`FRIDAY_DAEMON_URL`, default `http://127.0.0.1:4310`).

[apps/desktop](apps/desktop) is the Tauri 2 Windows shell: the always-on-top, click-through Notch over the editor and the Studio window. Its Rust core is the only HTTP client of the daemon — the operator token never reaches the webview. Build it with cargo outside turbo; the toolchain and packaging are in [apps/desktop/README.md](apps/desktop/README.md).

[site/](site) is the landing page: a single static page with zero dependencies and no build step, porting the Studio's tokens, springs and components to a marketing page. Open `site/index.html` directly or serve the folder with `npx serve site`; its structure and design rules are in [site/README.md](site/README.md). To deploy it on Vercel, set the project's **Root Directory** to `site` (or run `npx vercel site`); the [vercel.json](site/vercel.json) inside it adds security headers and clean URLs — no build step.

## Documentation

| Document | Contents |
|---|---|
| [docs/README.md](docs/README.md) | The backend build kit index: what Friday owns, the host table and the rules that apply everywhere |
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | The architecture: principles, runtime topology, package map, the life of a goal and the glossary |
| [docs/SECURITY.md](docs/SECURITY.md) | The security model: enforcement levels, the per-host boundary, secrets and the threat model |
| [docs/SETUP.md](docs/SETUP.md) | Machine setup, environment variables and staged verification gates |
| [apps/desktop/README.md](apps/desktop/README.md) | The desktop shell's toolchain and packaging |
| [CHANGELOG.md](CHANGELOG.md) | The work log, newest first |

`docs/README.md` is written as a kit for building the backend from specification; some files it references — segment specifications, reference documents and host integration guides — are not part of this public repository.

## Security in brief

- Enforcement levels are `L0` (observation), `L1` (governed host surfaces) and `L2` (isolated execution, reached by no supplied adapter), each with independent evidence: `enforcing`, `degraded`, `unverified`, `observed` or `reported`.
- Every route checks its token class — `operator`, `bootstrap`, `harness`, UI session or per-attempt tool secret; the token table stores SHA-256 hashes, not raw bearer values.
- Sensitive path classes protect Friday's private state and runtime, host configuration, secrets and git internals. The hook launcher judges protected paths locally and fails closed.
- Secrets live in the per-user credential store (DPAPI on Windows), are brokered only through trusted operations, and never reach an agent; recorded output is redacted.
- Tracked policy loosenings apply only after this clone accepts them exactly: `friday policy trust --yes`.
- Completion is a claim until verified: verification binds its judgment to source identity, policy and relied-on grants, and interrupts when that judgment becomes invalid.

## License

Released under the [Apache License 2.0](LICENSE).
