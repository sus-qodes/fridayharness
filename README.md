# Friday

Friday is a local control plane above AI coding hosts. It manages goals, plans, tasks, context, communication, policy, model routing, verification and recovery. Hosts run the agent loop and tools; git remains the code authority.

The backend supports attached and spawned Claude Code sessions, spawned Codex sessions, and experimental Cursor, Gemini CLI, Antigravity and OpenCode integrations. DeepSeek Harness has detection and configuration support. Each host's actual enforcement and readiness limits are specified in the [security model](docs/SECURITY.md) and its [integration guide](docs/README.md#hosts).

## Documentation

Start with the [backend build kit](docs/README.md). It is the consolidated index for the complete backend specification and assigns twenty implementation segments to one, two or three machines.

| Need | Document |
|---|---|
| Product, processes and vocabulary | [Overview](docs/OVERVIEW.md), [domain](docs/DOMAIN.md) |
| Machine setup and pinned toolchain | [Setup](docs/SETUP.md) |
| Build order, machine ownership and gates | [Build plan](docs/BUILD_PLAN.md) |
| Engineering rules and common pitfalls | [Conventions](docs/CONVENTIONS.md), [lessons](docs/LESSONS.md) |
| Token and runtime budgets | [Optimizations](docs/OPTIMIZATIONS.md) |
| Test strategy and acceptance inventory | [Testing](docs/TESTING.md), [test catalogue](docs/reference/test-catalogue.md) |
| API and tool integration | [HTTP API](docs/reference/http-api.md), [protocol](docs/reference/protocol.md), [MCP tools](docs/reference/mcp-tools.md) |
| Operator commands and configuration | [CLI](docs/reference/cli.md), [configuration](docs/reference/config.md) |
| Persistence and events | [Database](docs/reference/database.md), [events](docs/reference/events.md) |
| Operational recovery | [Backup](docs/runbooks/backup.md), [recovery](docs/runbooks/recovery.md) |

Node major 24 and pnpm 12.11.2 are the repository toolchain. Windows setup uses per-user tools without administrator rights; POSIX notes are included. The backend listens on **127.0.0.1**. Follow [SETUP.md](docs/SETUP.md) for the exact installation and backend-only verification commands.

Run **node docs/tools/validate.mjs** to check the build kit's structure, internal links and lesson-index destinations.

## Frontend

The Studio, Notch and desktop shell have their own [frontend documents](docs/frontend/README.md) and [design specification](docs/frontend-handoff/00_MASTER_INDEX.md). The desktop shell's toolchain and packaging instructions are in [apps/desktop/README.md](apps/desktop/README.md).

The backend's [HTTP API](docs/reference/http-api.md) and public UI types in S01 define the frontend boundary. The shared snapshot gate and release archive require the frontend artifacts named in [BUILD_PLAN.md](docs/BUILD_PLAN.md#6-gates).
