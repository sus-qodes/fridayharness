# Backend setup

Use Windows 11 without administrator rights. The same backend runs on POSIX; the commands below use PowerShell and the Windows executable shims. The package manifests and exact configuration are in [S00](segments/S00-repository.md). [BUILD_PLAN](BUILD_PLAN.md) controls when each package exists and which gate applies.

## 1. Toolchain

| Tool | Required value or contract | Source |
|---|---|---|
| Node.js | Major 24 in `.node-version`; accepted engine range `>=22.18 <27` | Root `package.json`, `.node-version` |
| pnpm | Exactly `12.11.2` | Root `packageManager: pnpm@12.11.2` |
| TypeScript | Exactly `5.9.3` | Root devDependencies; compiler API used by the graph |
| Git | A release supporting `merge-tree --write-tree`; Git 2.38 or later supplies that command | `packages/git/src/integrate.ts` and S07 |
| Editor | VS Code or another editor preserving UTF-8 without BOM and repository line endings | `.editorconfig`, `.gitattributes` |
| Native builds | No compiler toolchain is required for the backend's normal supported prebuilt installation | SQLite driver and WASM grammars |

Use a user-writable Node installation or an existing installation in the accepted range. Do not run `corepack enable`; it writes beside Node and can require administrator rights. The installation below uses npm's user global prefix. `npm.cmd config get prefix` identifies that prefix; it must be writable by this user.

**TERMINAL:** `node --version`

**TERMINAL:** `npm.cmd config get prefix`

**TERMINAL:** `npm.cmd install -g pnpm@12.11.2`

**TERMINAL:** `pnpm.cmd --version`

**HERE:** the final command prints `12.11.2`; Node satisfies the range above. A blocked `pnpm.ps1` is handled by calling `pnpm.cmd`, without changing execution policy. On POSIX use `npm` and `pnpm` in the same commands.

`better-sqlite3` uses its distributed native binary when compatible with the platform and Node ABI. The alternate `node:sqlite` driver is part of supported Node builds; [S02](segments/S02-storage-events.md) states its selection and refusal rules. A resolvable native package whose addon fails to load is an error, not an automatic fallback. Tree-sitter loads WASM grammars through `web-tree-sitter`; do not install a native tree-sitter compiler. Rust is required only by the desktop shell in `apps/desktop`.

## 2. Repository and Git

Use a short checkout path such as `C:\friday`. Test temp roots may contain at most 80 characters; use a short writable temp folder inside the checkout if the user's profile path is long. Task worktrees also need short paths.

For a fresh repository, [S00](segments/S00-repository.md) writes `.gitattributes` before the first file is staged. Configure this repository explicitly; keep the user's global identity separate.

**TERMINAL:** `Set-Location -LiteralPath C:\friday`

**TERMINAL:** `git config --local core.autocrlf false`

**TERMINAL:** `git config --local core.longpaths true`

**TERMINAL:** `git config --local user.name "Friday Builder"`

**TERMINAL:** `git config --local user.email "builder@friday.local"`

**HERE:** use the owner's intended commit identity before any real project commit; the two values above are a deterministic local-build identity. Authentication for a remote is separate. Git Credential Manager may authenticate a push without exposing a reusable credential to another program. Never place a credential in a remote URL or in this kit.

Use the GitHub CLI or the signed-in Actions page to inspect a private repository's CI. A private endpoint's 404 does not establish that a workflow or repository is absent. Local green checks do not establish a remote CI result.

## 3. Editor and host setup

The backend can be built and tested against scripted hosts without any host account. Install only hosts the owner intends to use. A host version in this table is the adapter's compatibility evidence, not a promise about an arbitrary installed version. Run its doctor before relying on it.

| Host | Version contract | Setup and doctor |
|---|---|---|
| Claude Code | Attached fail-closed hooks require `2.1.295` or later; `2.1.232` through the preceding range is degraded. Spawn requires `2.1.300` or later | [Claude Code](integration/claude-code.md), S15 |
| Codex | Adapter protocol follows CLI `0.162.1`; another version receives a doctor warning. A native executable is required, rather than an npm `.cmd` shim | [Codex](integration/codex.md), S16 |
| Cursor | IDE `3.24` or later supplies the documented failClosed contract. CLI build `2026.10.16-e3cb207` is the documented compatibility string | [Cursor](integration/cursor.md), S17 |
| Gemini CLI | Minimum `0.36.0`, adapter's documented version `0.64.0`; hooks fail open, so enforcement is degraded | [Gemini CLI](integration/gemini-cli.md), S17 |
| Antigravity | Adapter follows `1.4`; BOM-safe hook loading starts at CLI `1.3.1`. Enforcement failure behaviour requires the guide's live check | [Antigravity](integration/antigravity.md), S18 |
| OpenCode | Controlled launch requires exactly native `1.19.3`; health and version output are checked | [OpenCode](integration/opencode.md), S18 |
| DeepSeek Harness | Named integration boundary; no dispatchable Friday host | [DeepSeek](integration/deepseek.md), S18 |

For VS Code, install the Claude Code extension through the Extensions view, or use its installed `code` command:

**TERMINAL:** `code --install-extension anthropic.claude-code`

The extension can contain the native Claude executable even if `claude` is absent from PATH. Friday's detector tries PATH, `CLAUDE_CODE_BIN`, the extension's `resources/native-binary/claude.exe`, then its CLI Node installation route. The extension and standalone CLI are separate installations; inspect the detected binary's version. Follow the host guides for exact host configuration files, login, version commands and shell flags.

Never configure Friday's hooks or MCP server inside Friday's source checkout. Use a temporary application project for the setup commands in those guides. A nested headless Claude process drops `CLAUDE*` and `MCP_CONNECTION_NONBLOCKING`; the adapter supplies its controlled environment. Never copy provider keys into a project host configuration.

### CodeGraph for code navigation

[CodeGraph](https://github.com/colbymchenry/codegraph) provides a local symbol and dependency index for navigating this checkout. Install it separately from the workspace dependencies:

```powershell
npm.cmd install --global @colbymchenry/codegraph@1.6.2
codegraph.cmd install --target=codex --location=global --yes
codegraph.cmd telemetry off
codegraph.cmd init --yes
codegraph.cmd status
```

Run the initialization and queries from the repository root. Restart Codex after installing its MCP connection. The installer also adds CodeGraph usage guidance to the user's Codex `AGENTS.md`. Its MCP server watches source changes and catches up when reconnecting; CLI-only workflows can run `codegraph.cmd sync` before querying.

```powershell
codegraph.cmd explore "How does the CLI submit work to the daemon?" --max-files 4
codegraph.cmd callers buildApp --file apps/daemon/src/app.ts
codegraph.cmd callees buildApp --file apps/daemon/src/app.ts
codegraph.cmd impact buildApp --file apps/daemon/src/app.ts
```

Use `codegraph_explore` through MCP, or `codegraph.cmd explore` in the shell, before searching or reading code to understand its structure. The graph contains static relationships; confirm runtime behavior with the relevant implementation and focused checks when needed. The local database and runtime files are ignored by `.codegraph/.gitignore`. The root `codegraph.json` excludes release archives, the local pitch project and review reports; dependency and build directories are excluded by CodeGraph's defaults.

On POSIX use `npm` and `codegraph` in these commands. This navigation tool is separate from Friday's own graph implementation and host hooks.

## 4. Environment and private files

| Variable | Purpose | Default or rule |
|---|---|---|
| `FRIDAY_STATE_DIR` | Private per-user state root override | SDK platform location; permissions are verified before credentials are written |
| `FRIDAY_WORKTREES_DIR` | Task-worktree root override | Platform worktree root or sibling of the configured state root |
| `FRIDAY_TEST_TMP` | Short temp base for test workspaces | OS temporary folder |
| `FRIDAY_TEST_KEEP_ON_FAILURE` | Preserve complete failing workspace | Only literal `1` enables it; artifacts are saved separately |
| `FRIDAY_SQLITE_DRIVER` | SQLite driver selection | `better-sqlite3` or `node:sqlite`; explicit option takes precedence |
| `CLAUDE_CODE_BIN` | Explicit Claude executable candidate | Detection rules in S15 |
| `CODEX_BIN` | Codex native executable | Detection rules in S16 |
| `CURSOR_AGENT_BIN` | Explicit Cursor agent installation | Detection rules in S17; use the host guide's supported file/folder shapes |
| `GEMINI_CLI_BIN` | Explicit Gemini package, entry or native executable | Detection rules in S17 |
| `AGY_BIN` | Antigravity CLI override | Detection rules in S18 |
| `OPENCODE_BIN` | Pinned OpenCode executable | Controlled launcher rules in S18 |
| `FRIDAY_TEST_BENCH` | Enables optional measurement jobs | Literal `1`; see TESTING |
| `FRIDAY_TEST_UI_E2E` | Enables frontend browser suite | Frontend-only gate |

The complete configuration and environment catalogue is [reference/config](reference/config.md); host-specific variable names are defined by the integration guides. No `.env` file is required to build the backend. Do not read another user's tokens or keys during setup. A folder inside a profile is not automatically private: the SDK checks Windows SDDL or POSIX ownership/modes, repairs where permitted and refuses unsafe storage. Never bypass that check by treating a gitignore entry as access control.

**TERMINAL:** `New-Item -ItemType Directory -Force -Path C:\friday\.test-tmp | Out-Null`

**TERMINAL:** `$env:FRIDAY_TEST_TMP = 'C:\friday\.test-tmp'`

**HERE:** if this optional folder is used for local work, give it its own `.gitignore` containing `*` before leaving generated files there. POSIX uses a short directory such as `/tmp/friday-tests` and `export FRIDAY_TEST_TMP=/tmp/friday-tests` in the interactive shell; package scripts remain cross-platform Node commands.

## 5. Install and staged gates

First create all package manifests and configurations in S00, including the metadata-only frontend entries it names. `tests/package.json` declares `@friday/ui` as a workspace dependency even when frontend implementation is supplied by another machine. A missing workspace package makes install fail. Every lane shares one committed lockfile; never let lanes independently regenerate dependency lists.

**TERMINAL:** `pnpm.cmd install`

**HERE:** install completes with `strictDepBuilds:true` and only `esbuild:true` in `allowBuilds`. Inspect both documents in `pnpm-lock.yaml`. Keep the dependency versions in S00. Do not add release-age exclusions or broadly enable dependency build scripts.

On a complete backend implementation with frontend metadata but no frontend build, use:

**TERMINAL:** `pnpm.cmd --filter '!@friday/ui' --filter '!@friday/desktop' --filter '!@friday/tests' -r build`

**TERMINAL:** `pnpm.cmd --filter '!@friday/ui' --filter '!@friday/desktop' --filter '!@friday/tests' -r typecheck`

**TERMINAL:** `pnpm.cmd --filter '!@friday/ui' --filter '!@friday/desktop' --filter '!@friday/tests' -r test`

**TERMINAL:** `pnpm.cmd lint`

**TERMINAL:** `node scripts/check-portability.mjs --working-tree`

The root commands `pnpm.cmd build`, `pnpm.cmd typecheck`, `pnpm.cmd test` cover every participating workspace, including frontend tasks. `@friday/tests` also typechecks `tests/ui-e2e`; `pnpm.cmd --dir tests exec tsc -p tsconfig.json` checks cross-package backend tests directly. That compilation still imports `apps/ui/src/shell/version.ts` and `apps/ui/src/sync/rows.ts` through `tests/integration/ui-snapshot.test.ts`. Supply those frontend-owned contract files before the cross-package typecheck and full suite; the backend kit names their required ownership in S13. Never replace their implementations with guessed stubs merely to make a gate green.

Before S15 supplies the hook bundler and its entry, a full backend build cannot pass the Claude adapter's final build script. Use each completed segment's targeted gate during construction. The full release archive additionally requires `apps/ui/dist/index.html`. [S19](segments/S19-end-to-end-release.md) defines the complete final gate.

Durations depend on disk, native binary availability and concurrency; this kit specifies ceilings instead of inventing a machine benchmark. CI's main matrix job has 30 minutes and its clean-install job 20 minutes. Integration test cases have a 120-second timeout, process-heavy conformance/MCP/hooks/scenarios 90 seconds, context evals 300 seconds. Record elapsed time for a local gate and investigate a timeout against machine load and sleep before attributing it to product behavior. Avoid timing while a large local model or another build competes for CPU.

## 6. Portability and recovery rules

- L0-01 — Work without administrator rights; use writable user installations and exact executable paths.
- ENV-01 — Corepack activation can require write access beside Node; install `pnpm@12.11.2` with npm instead.
- ENV-04 — The graph uses TypeScript's compiler API; retain the exact `5.9.3` pin.
- ENV-06 — Deep pnpm and Git paths consume Windows path length; use short checkout, test and worktree roots and `core.longpaths=true`.
- ENV-13 — Private CI needs authenticated access; inspect it through `gh` or the owner's signed-in Actions page.
- ENV-14 — Profile and temporary folders can grant other accounts access; require verified private-folder ACLs before storing credentials.
- ENV-16 — Commit identity is repository-local; set it before the first commit and keep it separate from remote authentication.
- ENV-17 — Git Credential Manager authenticates Git; do not assume another process can read its credentials noninteractively.
- ENV-21 — The backend has no Rust build; Rust and its linker belong solely to the desktop build.

Use `127.0.0.1` for every local HTTP address. When a test fails, inspect its copied artifacts and close processes and SQLite handles before deleting a workspace. The exact per-host diagnosis belongs to its integration guide; the exact project recovery procedure is [runbooks/recovery](runbooks/recovery.md).
