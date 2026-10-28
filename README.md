# Friday

Friday is a local orchestration and context control plane for AI software development. It sits above existing coding harnesses (Claude Code, Codex, Cursor, October) and owns what they don't: intent, plans and tasks, the compiled context each agent receives, communication between agents, policy, model routing, verification and recovery. Harnesses keep running the agent loop. Git stays the source of truth for code.

The architecture is called **ContextOS** in the original specification.

**Status:** M0 (skeleton). Nothing runs yet beyond the toolchain and test helpers. See the [build plan](docs/BUILD_PLAN.md) for the full roadmap and current milestone status.

## Documentation

| Document | What it is |
|---|---|
| [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) | The complete build plan, from M0 to the MVP gate and beyond. The single document all work is checked against |
| [docs/handoff/](docs/handoff/) | The original 16-part ContextOS specification, verbatim, plus [ERRATA](docs/handoff/ERRATA.md) |
| [docs/decisions/](docs/decisions/) | Architecture decision records |
| [docs/security/model.md](docs/security/model.md) | Enforcement levels, token scopes, what is and isn't intercepted |
| [docs/integration/claude-code-spike.md](docs/integration/claude-code-spike.md) | Verified Claude Code hook and MCP behaviour on Windows |
| [docs/reviews/](docs/reviews/) | External reviews of the plan |

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
packages/    protocol, core, db, events, state, sdk, policy, verification, mcp-server, adapters/{generic,claude}
tests/       support (test helpers), cross-package suites, fixtures
docs/        plan, spec, decisions, security, integration notes
```

More packages (planner, communication, git, code-graph, memory, context, execution, routing, more adapters, UI) arrive in later milestones as listed in the build plan.
