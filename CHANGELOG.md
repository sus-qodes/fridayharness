# Changelog

All notable changes, one section per milestone tag. Format: what changed for someone using or building Friday.

## Unreleased — M1 event spine, daemon, CLI and Claude Code attach

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
