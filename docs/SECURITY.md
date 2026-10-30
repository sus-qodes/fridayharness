# Security model

Friday coordinates coding hosts on the user's machine. It authenticates its APIs, governs the host surfaces its adapters control, keeps credentials outside repositories, and verifies claimed work against recorded source and policy. Its policy engine is not an OS sandbox. Allowed project code executes with the user's operating-system rights.

The implementation specifications are [S06 policy/execution](segments/S06-policy-execution.md), [S12 SDK/MCP](segments/S12-sdk-mcp.md), [S13 daemon](segments/S13-daemon.md) and the host segments S15–S18. The exact HTTP, protocol and tool contracts are in [reference/http-api.md](reference/http-api.md), [reference/protocol.md](reference/protocol.md) and [reference/mcp-tools.md](reference/mcp-tools.md).

## 1. Promises and authority

| Promise | Concrete boundary |
|---|---|
| Agent credentials do not grant operator authority | Every route checks token class; protocol calls bind the current agent/harness to its own task and attempt. A shadow session cannot act as the holder. |
| A governed tool cannot directly read or write Friday's protected locations | The common launcher performs protected-path checks before contacting the daemon; the daemon uses the same sensitive classes and real-target checks. The exact shell and host limitations are in §13. |
| Tracked content cannot grant itself local trust or provider permission | Tightening applies immediately; loosenings require this clone's exact content trust. Remote provider use and endpoint choices are stored outside the repository. |
| An approval is authority for an explicit effect | Capability, target, task, reuse, expiry and policy version are checked where used. Text claiming approval in a file or message creates no grant. |
| Agents do not receive brokered secrets | `secret.resolve` is refused; trusted operations receive credentials privately and return sanitized outcomes. Code running inside an operation can use its credential and remains outside a sandbox guarantee. |
| Completion is checked independently | Verification binds its result to code/source identity, policy and relied-on grants, and interrupts if the judgment becomes invalid. |
| Sensitive recorded output is redacted | Events, message bodies, operation output and outbound model requests pass their specified redactors. Pattern redaction cannot recognize every possible encoding or secret. |
| Governance is explicit about evidence | Level and enforcement status describe what this session demonstrates. A configured hook file alone is not proof that a hook reached Friday. |

An agent, a repository author, a third-party MCP server and a remote model provider are separate actors. A process running as the same operating-system user is not isolated from the user's files merely because it has a Friday harness token. Administrators retain their operating-system power.

## 2. Enforcement levels and evidence

| Level | Meaning | What a builder may claim |
|---|---|---|
| `L0` | Observation/coordination without demonstrated tool interception | Friday records work and gives context; it cannot claim that policy stops host-native actions. |
| `L1` | Policy on the adapter's governed host tool/approval surfaces | Protected paths, scopes, capabilities, approvals, reservations and pause apply to those surfaces. It is not OS isolation and does not cover an unhooked native tool. |
| `L2` | Isolated execution | No supplied adapter provides L2. Configuring `security.enforcement_required: L2` prevents these sessions claiming work. |

The independent `EnforcementStatus` is `enforcing`, `degraded`, `unverified`, `observed` or `reported`:

| Status | Evidence |
|---|---|
| `enforcing` | This attached session's Friday hooks reached the daemon and its recognized host/version/configuration blocks an action when the hook fails. |
| `degraded` | Hooks or adapter evidence exist, but the host lets an action through if the hook fails. |
| `unverified` | Policy surface exists but its failure behavior/version is not established; OpenCode uses this status even when claiming L1. |
| `observed` | No interception evidence; L0. |
| `reported` | Spawn adapter reports its controlled surface/level. This status is not interchangeable with `enforcing`. |

`packages/state/src/service.ts` owns `hookEvidenceOf`, `achievedEnforcement`, `hostCohort` and `enforcementGap`. `hookEvidenceOf` accepts only a nonempty string `host_version` and `hook_failure` equal to `fail-closed` or `fail-open`; other values become null. Hook evidence retained by registration is part of that session's capabilities. `hostCohort` groups numeric versions by major/minor for reporting; it does not determine the level.

For attached Claude Code, no observed hook means L0. With observed hooks, an unknown/unparseable version gives L1/unverified; `2.1.295` or later gives L1/enforcing; `2.1.232` through `2.1.294` gives L1/degraded; older versions give L0/observed. A three-part minimum requires a three-part version.

For attached Cursor, observed hooks are required for L1. A known fail-open permission hook yields degraded. If the hook file cannot establish every permission hook as fail-closed, status is unverified. Fail-closed plus a qualifying version gives enforcing: IDE `3.24` or later, CLI `2026.10.16` or later. The CLI's numeric date-shaped value is a host version contract. Cursor's reported hook host version takes precedence over the registration version. Earlier/unknown versions remain unverified even if the file contains the key.

Attached Gemini CLI with observed hooks is L1/degraded; its hook-failure behavior is fail-open. Attached Antigravity with observed hooks is L1/unverified. No observed hook gives L0 for either. For other spawn adapters, a non-L0 claim is reported unless `capabilities.hook_failure` is `fail-open`, which makes it degraded. OpenCode is handled separately: L1/unverified when claiming L1, otherwise L0/observed.

`enforcementGap` compares `L0 < L1 < L2` against the project's required level at claim. Work can be reserved for a below-level session; its claim fails with `enforcement_insufficient` (`COS-3007`). `security.require_enforcing_hooks` additionally requires status `enforcing` for hosts named in its fix map: Claude Code, Cursor, Antigravity and Gemini. In this implementation, the map also affects their spawned registrations, whose status is `reported` or `degraded`; those are refused under that setting. OpenCode is absent from the map. Do not turn the setting into a broader guarantee than these checks provide.

## 3. Per-host boundary

| Host/mode | Achieved surface | Enforcement mechanism | Uncontrolled surface and status |
|---|---|---|---|
| Claude Code attach | L1 once session hook evidence arrives; status by version in §2 | PreToolUse protected checks and daemon judgment; PostToolUse observation; MCP calls authorize through protocol. Hook failure blocks on recognized enforcing versions. | Native orchestration, messaging and other tools listed in §4 are outside the matcher. Allowed shell code is not isolated. Supported. |
| Claude Code spawn | L1/reported | One process group per attempt; `--restricted`, explicit eight builtins, strict attempt MCP config, `--permission-prompts none`, disabled slash commands, private settings and prompt files; startup inventory verifies tools, servers, plugins and skills before work. | Uses restricted host file/shell tools and Friday's spawned tools. Host transcript storage is outside the task's source checkout. Supported; see S15 for session/resume limits. |
| Codex spawn | L1/reported | One app-server process group per attempt; thread approval policy `untrusted`, reviewer `user`; each approval reaching the client goes through `tool.check`; only accept/decline returned. Web search disabled, discovered MCP servers disabled, startup report checked. Friday tools are client served. | Safe reads/commands Codex does not send for approval are not pre-judged. Native delegation is reported, not prevented. Host sandbox choice is not proof of provisioned OS isolation. Supported. |
| Cursor attach | L1 with evidence; enforcing/degraded/unverified per §2 | Permission hooks cover reads, writes, shell, MCP and network; `failClosed` and qualifying version establish hook-failure blocking. | Hook shell/folder/environment and exact live behavior follow the host guide. Native tools outside its hook surface remain outside Friday. Experimental. |
| Cursor spawn | L1/reported | Headless CLI under its own group; startup tool/MCP report checked; one Friday plugin/tool endpoint; broad matching native tool denials and governed permission hooks. | Some configuration is machine/host behavior; failure mode is not promoted from reported to enforcing automatically. Experimental. |
| Gemini CLI attach | L1/degraded after hook evidence | `SessionStart`, `BeforeTool`, `AfterTool`, `AfterAgent`, `SessionEnd`; per-call judgment, MCP own tools authorize through protocol. | Hook failures let calls through; untrusted/outside-root and ACP sessions can omit hooks; another BeforeTool hook can rewrite a call after Friday judged it. Experimental. |
| Gemini CLI spawn | L1/degraded | Worktree hook validation; owned group; host approvals `yolo` with Friday BeforeTool judgment; explicit deny policy for native agents, user prompts, memory/skills and other MCP tools; attempt tools/system settings where the host's machine settings permit. | Fail-open hooks remain a limit. Machine system settings and the host's settings loader determine whether attempt MCP tools are available. Experimental; preserve every preflight restriction in S17. |
| Antigravity attach | L1/unverified after hooks | Common launcher maps the host's tools/events and judges governed calls. | Failure behavior of a crashed/timed-out hook is unverified; no dispatchable spawn adapter. Experimental. |
| OpenCode spawn | L1/unverified | Pinned `1.19.3`, controlled home/config/environment, before-tool plugin freezes arguments, denies unknown tools and failed/missing/slow checks; verifies nonce/plugin/session identity; owned worker process tree. | Plugin is not an OS sandbox. The adapter's level note and state's basis differ about lifecycle evidence; retain the conservative unverified status. Experimental; exact permitted launcher/model/profile is S18. |
| DeepSeek Harness | Not dispatchable | Detection and configuration only | No `deepseek` Vendor enum registration path; no governed worker claim. |
| `meridian` | Name only | Protocol vendor value | No adapter or enforcement promise. |

Claude's eight spawned builtins are exactly `Read`, `Glob`, `Grep`, `Edit`, `Write`, `NotebookEdit`, `Bash`, `PowerShell`. The attempt's additional tools are the spawned set defined by S12, not the attached session's complete tool set. Do not enable an inherited MCP server, skill, plugin or native delegation tool without a matching governed surface.

## 4. Claude Code tools outside the matcher

`tests/security/tool-coverage.test.ts` reads this exact section to ensure every builtin in the pinned fixture manifest is either intercepted or explicitly named. Keep the names in backticks. The current `PRE_TOOL_MATCHER` is exactly:

```text
Read|Glob|Grep|Edit|Write|NotebookEdit|Bash|PowerShell|WebFetch|WebSearch|mcp__.*
```

Writes and command tools in that matcher also appear in `POST_TOOL_MATCHER`. `Shell` is a normalized common policy action for other hosts; it is not another entry in this Claude matcher.

| Tool | Security consequence |
|---|---|
| `Task`, `Agent` | Host-native subagent creation; child governed file/shell calls still pass hooks, but creating/messaging the child is not Friday's task protocol. |
| `Skill`, `ToolSearch` | Load instructions/tool schemas. Their text supplies no Friday authority. |
| `EnterWorktree`, `ExitWorktree` | Change host working directory; post-use observation does not replace real-target and execution-root checks. |
| `Monitor`, `Workflow`, `ListAgents`, `TaskStop` | Host-level orchestration outside Friday's native task-control policy. |
| `SendMessage` | Host-native messaging can bypass Friday's communication topology. Instructions directing a session to `friday_communicate` are guidance at L1. |
| `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`, `PushNotification` | Host scheduling/notification surface outside this matcher. |
| `DesignSync`, `ReportFindings`, `AskUserQuestion` | Host reporting/UI interaction; does not decide Friday's approval records. |

Every third-party MCP tool matching `mcp__.*` is intercepted. Friday's own `mcp__friday__*` tools receive no hook decision because the protocol behind each call authorizes it. For another server, string inputs are recursively checked locally for protected references; path-looking strings are checked as writes so host configuration and git internals remain protected. Only then does server/tool policy decide the call. With the daemon unavailable, a nonlocally-denied third-party call asks the human. The server's internal action after allowed input is outside Friday's view.

## 5. Sensitive path classes

These are the literal glob lists in `packages/policy/src/sensitive.ts`:

```typescript
export type SensitiveClass = 'friday.private' | 'friday.runtime' | 'host.config' | 'secrets' | 'git.internal';
const RUNTIME = [
  '.friday/run/**',
  '.friday/project.db',
  '.friday/project.db-*',
  '.friday/logs/**',
  '.friday/cache/**',
  '.friday/sessions/**',
];
const HOST_CONFIG = [
  '.claude/**',
  '.mcp.json',
  '.cursor/**',
  '.codex/**',
  '.gemini/**',
  '.agents/**',
  '.friday/harness/**',
  '.friday/config.yaml',
  '.friday/policies/**',
  '.friday/.gitignore',
];
const SECRETS = ['**/.env', '**/.env.*', '**/*.pem', '**/id_rsa', '**/id_rsa.*', '**/id_ed25519', '**/id_ed25519.*'];
const GIT_INTERNAL = ['.git/**'];
const PATHEXT = ['com', 'exe', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msc'];
export const ROOT_PROGRAMS: readonly string[] = ['node', 'git'].flatMap((n) => PATHEXT.map((e) => `${n}.${e}`));
```

| Class | Denied action/path |
|---|---|
| `friday.private` | Reads, searches, writes and explicit command references inside the per-user state directory, including other projects and credentials. Recognizes textual environment/home forms and token filenames. |
| `friday.runtime` | Reads/searches/writes of RUNTIME files; commands naming runtime paths or running/changing directory inside `.friday` are also refused. |
| `secrets` | Reads/searches/writes of the exact SECRETS globs, including outside-project paths. `.env.example` matches `.env.*`; `id_rsa_backup` does not match `id_rsa` or `id_rsa.*`. |
| `git.internal` | Direct file/search/write access into `.git`; shell `git` commands are classified independently, and explicit changes into `.git` are denied. Do not claim all shell reads of git metadata are intercepted. |
| `host.config` | Writes to HOST_CONFIG and root `node.*`/`git.*` executable names. Reads/searches are allowed by this class; task read policy still applies. Shell writes are classified separately and must not be auto-allowed. |

Classification checks state directories before runtime, secrets, git internals and host configuration. Direct directory forms are protected when a descendant is protected. `sensitiveClassOf` judges both lexical path and real target, then the main checkout's protected locations when the session works in another execution root. `canonicalize` resolves links, junctions, nearest existing ancestors and dangling-link targets as S06 specifies. A write outside the execution root is outside-project even when it targets the main checkout or another task's worktree.

`sensitiveWorkingFolder` separately protects a shell tool whose named cwd is private state, `.friday` or `.git`, lexically and through links. `sensitiveInText` recognizes explicit private/runtime/secret references and directory-changing commands. These checks are a heuristic for shell text, not a full shell interpreter or atomic mediation of the final host syscall.

## 6. Credentials, discovery and local HTTP

### 6.1 Private storage and access checks

User state is `%LOCALAPPDATA%/Friday` on Windows and `${XDG_STATE_HOME:-~/.local/state}/friday` on POSIX; `FRIDAY_STATE_DIR` overrides it. The private project directory is `<stateDir>/projects/<project_id>-<8-hex-hash-of-root>/`. Discovery resolves the main root and lowercases it for the Windows hash. Two clones therefore use separate tokens, local trust and provider approvals.

`ensurePrivateDir` calls `protectPrivateDir` before writing. Windows checks use absolute System32 `whoami.exe` and `icacls.exe`, not PATH-selected programs. `whoami /user /fo csv /nh` supplies the user's SID. `icacls /save` supplies locale-independent SDDL, parsed from UTF-16LE. Every allow ACE in the DACL must name the user or the allowed well-known set: `SY`, `S-1-5-18`, `BA`, `S-1-5-32-544`, `CO`, `S-1-3-0`, `OW`, `S-1-3-4`. System and local Administrators may hold access; excluding administrators would not isolate files from their OS privileges.

Repair resets children to inheritance, removes inherited access on the owned directory and grants full inherited child access to the user, SYSTEM and Administrators. It verifies the result and fails before writing credentials if the folder remains open. A successful folder verification is cached per process by resolved lowercased path. `resetAccessCache` exists for tests; a later external ACL change is not detected by every cached write.

POSIX checks require the user's ownership and no group/other mode bits. Repair sets directories to `0700`, files to `0600`; the implementation walks to depth four. Private file writes use a `0600` PID-suffixed temporary file and atomic rename, retrying Windows rename failures up to 20 retries with 25 ms waits. `checkFolderAccess` is a nonrecursive check used for browser profile warnings. See S12 for exact code and failure messages.

### 6.2 Token classes and route scope

| Credential | Raw holder | Authorized surface | Rotation/lifetime |
|---|---|---|---|
| `operator` | CLI/local operator; private `operator.token` | Operator project API/admin; mint UI codes. An operator token is not a harness RPC token. | Fresh at daemon start and explicit rotation. |
| `bootstrap` | Hook launcher and attached MCP process; private `bootstrap.token` | Harness registration, session binding, permitted hook routes and authenticated health. It cannot perform ordinary operator mutations. | Fresh at daemon start and explicit rotation. |
| `harness` | One registration's client memory | Its own protocol/stream, current task and authorized recipient views; exact API exceptions are in HTTP reference. | Re-registration revokes prior harness token; disconnect/revocation can end it. Operator/bootstrap rotation does not itself revoke every harness credential. |
| UI session | One browser login, in-memory server registry plus operator-class credential | Operator project UI API; explicitly refused admin, protocol, harness binding and code-minting routes. | At most 12 hours; logout/expiry/rotation/restart ends it. |
| Attempt tool endpoint secret | One spawn adapter/attempt | That endpoint and attempt only | Adapter-owned lifecycle; not a daemon operator credential. |

The token table stores SHA-256, not raw bearer values. Issuing a registration credential is deliberately not cached as an idempotent response. Raw operator/bootstrap tokens must exist in protected local files for discovery; they do not appear in tracked host config, registry, events, MCP result text or model packets. The harness registration wire response necessarily contains its newly issued harness credential to its authenticated bootstrap client; that internal transport response must not become an agent-facing MCP result or log.

HTTP requires exact `Host: 127.0.0.1:<daemon-port>`. An Origin, if present, must be the daemon's own origin or an explicitly trusted origin. Trusted foreign origins get a specific allow-origin response, not `*`; preflight admits the named headers and GET/POST. Authenticated requests reject missing, unknown, revoked and cross-project credentials. The request-body limit is `1024 * 1024` bytes; structured protocol limits apply additionally. Shutdown rejects effects with the specified retry response. S13 owns every route's exact class and body schema.

### 6.3 Browser sign-in backend

`UiAuth` uses random 32-byte base64url one-time codes, indexed by SHA-256. The in-memory entry also retains the raw code so the redactor can remove it; do not claim codes are stored as hashes only. At most five outstanding codes exist; each expires after `60_000` ms. Only the operator token mints one. The code travels in a private redirect HTML file, not a process command line.

`POST /ui/session` is public but requires the daemon's exact own Origin and JSON content type. Redemption deletes the code before issuing the operator-class UI credential. Unknown/used/expired codes receive the same failure. UI session age is `12 * 60 * 60 * 1000` ms and checked on requests. UI credentials cannot call `/admin/*`, `/protocol/*`, `.../harness-sessions/bind` or `.../ui/login-codes`. Static assets and API responses use the no-cache/per-start-path rules in S13; frontend rendering is outside this backend specification.

## 7. Secret store and provider endpoints

Secrets live in `<stateDir>/credentials/<name>.key`. Names match `^[a-z][a-z0-9-]{0,31}$`. Values are trimmed, must be nonempty and cannot contain whitespace. CLI input is hidden prompt, piped stdin or a named environment variable; a key is not accepted as a literal command-line argument.

On Windows, `storeSecret` uses current-user DPAPI through the absolute Windows PowerShell executable. Plaintext and encrypted blob travel as base64 on stdin/stdout, never command arguments. Additional entropy is SHA-256 of `friday-credential:<name>`. The stored prefix is `friday-dpapi:1:`. Copying a protected blob to a different secret name does not satisfy the entropy check. `FRIDAY_SECRET_STORE=file` selects user-only plaintext files; DPAPI failure also falls back to that file protection with a reported note. POSIX uses private file protection. This is not a promise of encrypted storage on every platform.

`resolveSecret` reads at call time and returns undefined if decryption fails. Listing/status expose names and protection, never values. Removing a key removes only the named credential file. A plaintext key and a raw token are registered with the redactor before any controlled use can echo them.

Provider permission and endpoint are different local choices:

| Choice | Location and rule |
|---|---|
| This clone may use a provider | `<privateDir>/providers.json`, written by `friday brain allow-remote`; optional local daily budget can lower the project budget. Repository `allow_remote` alone is insufficient. |
| This user's endpoint for a provider key | `<stateDir>/credentials/<provider>.json`, written by `friday secrets set ... --base-url`. HTTPS is required, except plain HTTP to literal `127.0.0.1` or `[::1]`. |
| Tracked provider `base_url` | Does not choose the destination for the user's remote credential. The brain reports that it is ignored. |
| Local planner | Literal loopback OpenAI-compatible endpoint, no remote credential; default `http://127.0.0.1:11434/v1`. Redirects and nonloopback names do not widen this boundary. |

See S11 for provider-specific environment fallback and wire endpoint behavior. Provider approval is per clone, does not travel in a backup, and is separate from tracked policy trust.

## 8. Tracked policy and clone trust

`packages/policy/src/project-policy.ts` merges defaults and validated sources from config/policy files. A malformed or unknown-key policy file applies nothing from that file, including tightening. Valid tightening applies without trust: stronger autonomy/risk/enforcement, read/write denies and role/team intersections. Multiple sources tighten cumulatively.

Loosening applies only when the clone's stored trust hash equals the exact normalized loosening hash. The trusted definition includes operation command, args, cwd, environment, credential names, risk, timeout and roles; an operation's description is excluded from its executable-definition hash. A changed definition needs a matching local decision.

| Tracked loosening | Why local trust is required |
|---|---|
| Lower command autonomy or risk | Can let agent actions execute with less review. |
| Lower required level; disable reservations | Weakens work/ownership governance. |
| Auto-approve plans or automatic verification | Can approve work or execute project code without a human at that moment. |
| Declared operation | Runs a repository-selected command with the user's rights and possibly credentials. |
| Additional execution binary or environment passthrough | Adds a program or ambient authority to executed checks/operations. |
| MCP server/tool `auto` | Lets a third-party server run without review. |
| Fixed daemon port | Lets repository content select a browser origin. |
| Custom worktree install command or lifecycle scripts | Runs repository-controlled code during setup. |

**TERMINAL:** `pnpm.cmd friday -- policy trust --yes`

That command records this clone's exact loosenings. It does not override never-allowed sensitive classes or `secret.resolve`, does not approve a remote provider, and is not a task capability grant. A restored or separate clone has its own local trust decision.

## 9. Capability requests and approvals

The capability catalogue is exactly `file.read`, `file.write`, `file.delete`, `shell.test`, `shell.build`, `shell.git.read`, `shell.git.commit`, `shell.git.push`, `network.read`, `network.write`, `package.install`, `secret.resolve`, `process.spawn`, `agent.communicate`, `task.reassign`, `policy.request`, `human.escalate`, `operation.run`, `mcp.call`.

`evaluateCapability` returns allow, review or deny with risk/rule/reason. It denies raw secrets outright, allows Friday communication/escalation tools through their own authorization, sends reassign/policy changes to a human, checks file targets against sensitive paths/project boundary/role ceiling before asking, and uses the strictest relevant command autonomy for shell/package/process requests. A resource above the role ceiling cannot obtain an approval that widens the ceiling.

Default low risk is file read, test/build/git-read, agent communication and escalation. File write, git commit, network read, package install, process spawn and MCP calls are medium; deletion, push, network write, raw secrets, reassign and policy requests are high. An operation is high by default when it uses credentials, medium otherwise, unless its trusted definition sets a risk. Exact capability/risk maps are in S06.

An approval records capability, exact target (`resource` then command), purpose, requester, task, run, risk, expiry, reuse and policy version. A nonreview decision creates no pending approval. Human decisions reject expired or already-decided requests. Default reuse is `once`; explicit operator reuse may be `run` or `task`. A once grant becomes `used` after an allowed effect; broader grants record uses while staying granted.

Grant matching is the exact implementation in `Queries.usableApproval`: capability and target equal, granted status, unexpired; nonnull policy versions must agree; a nonnull task binding must match; task reuse then covers the task across agents/attempts, while other reuse checks the nonnull run binding and requesting agent. Narrower grants are selected before broader ones. Null bindings are not a global statement that every approval always contains a task/run; the requesting path is responsible for supplying its required bindings.

Context delivery can spend an exact-path read grant. Verification records and checks spent grants that justified a write. Policy/grant changes can invalidate a prepared packet, patch, operation or verification. Check authority after awaits and where the effect records; do not rely only on the initial request.

MCP elicitation relays a human answer only for the current agent's pending request in its current attempt, under enforcing hook evidence, at low/medium risk, with once reuse. High risk requires operator CLI/UI. `approvals.elicitation: false` keeps decisions there. A host decline that is not a completed human form leaves the request pending. Replayed relay cannot replenish a spent grant. A denial reaches the agent as a human notification; the waiting task/host continuation resumes only through the explicit decision path.

Expiry makes grants unusable; it is not a process that rewrites every pending row to expired. The tool judge's pending-action dedupe does not check expiry, so an expired pending ID can remain the one returned until operator action changes the situation. State this operational limit; do not promise automatic refresh.

## 10. Third-party MCP policy

`mcp.servers.<server>` supports a default level and per-tool overrides. The effective policy combines sources with the specified strictest semantics. The levels are:

| Level | Meaning |
|---|---|
| `never` | Denied; an approval cannot make the server/tool callable. |
| `manual` | Human decision required. |
| `review` | Human decision required; default when no server policy exists. |
| `auto` | No per-call review for that server/tool; tracked loosening requires clone trust. |

Local sensitive-input screening precedes this policy. `auto` never grants a direct read of Friday's private store or a write to hook config. A server can perform behavior not named by an allowed input; Friday does not inspect its internal implementation. Spawned hosts restrict their MCP inventory to their attempt-owned Friday tools rather than inheriting arbitrary configured servers.

## 11. Execution gateway and credential broker

The execution profile resolves an allowed binary, rejects unsafe command-shim arguments, constrains cwd to the execution root, refuses private-state references, and builds an allowlisted environment with a fresh temporary folder. It does not inherit the daemon's full environment. Project additions and passthrough variables wait for trust. Windows `.cmd` handling uses its exact quoting/unsafe-character rules; argument arrays do not justify bypassing those checks.

An operation runs only when its named definition is trusted and available, the agent holds a RUNNING task and current run from this harness, the role is allowed, required keys exist, the profile accepts the command, policy/pause still permit it and a required approval is usable. Low-risk operations run directly; medium/high ask. Credential names appear in the catalog; values never do.

The gateway resolves secrets asynchronously only after preliminary checks, registers values with the redactor, and rechecks live definition/policy/role/task/run/pause/approval inside `startOperation`. It starts the process immediately after that synchronous state boundary. One running operation per task protects overlapping uses. A task attempt ending triggers stop of its operation process tree; orphaned running rows are interrupted on recovery.

Each credential must have at least `MIN_SECRET_LENGTH = 8` characters. Output is sanitized for exact values and common base64/base64url/hex/URL/JSON forms, plus known secret patterns. Output storage is bounded at `256 * 1024` characters; the agent receives at most the final `8 * 1024` characters and an artifact reference for retained sanitized output. A truncated leading partial line is dropped before sanitization to avoid exposing the tail of a cut credential.

A process receiving a secret can send it over the network or encode it differently. Use test-mode or restricted credentials for an operation whose project code an agent can change. High risk approval shows the task's changed files, not a claim that every line of executable code is trusted.

## 12. Master Brain outbound boundary

Dispatch and model rank require no remote model call. Remote planning needs the project's request plus this clone's provider approval, a locally chosen endpoint and the available worst-case budget before each paid attempt, retries included. Unknown cost is charged at its estimate for budgeting, never as zero. Worker-host spending is a separate reported quantity and may be unavailable.

`apps/daemon/src/brain-context.ts` builds outbound repository context from bounded git output and safe documents. Documents must resolve to regular files within the project and outside protected classes; outside-project links are skipped. Stable context has at most 400 tracked filenames, 6,000 characters per selected document and 60,000 characters total; the intent-draft document path has its own smaller limits in S11. Current revision/status stays separate from the stable provider-cache block.

Every outbound request passes the event redactor immediately before transmission. Repository text is marked untrusted after Friday's rules. A planner can propose intent/plan changes but cannot approve its own unrestricted authority; plan validation and local approval still gate effects. Model-call records hold usage/status and estimates rather than raw prompts or provider keys. Provider keys are resolved at call time and registered for redaction.

Read filtering is surface-specific in this implementation. Graph tool outputs apply the recipient read filter, but the context compiler's `symbol` answer does not apply that filter to every named caller/callee/test/name match. Blast-radius annotations can also name withheld paths. Do not describe all graph/context metadata as preventing every path-name disclosure; preserve the precise limitations in S08/S09.

## 13. Limits

| Limit | Consequence and rule |
|---|---|
| L1 governs tools, not OS syscalls | An allowed test/build/command can run arbitrary project code with the user's rights. Never call the policy a sandbox. |
| Shell classifier is a heuristic | Unknown or dynamic commands ask; explicit protected text/cwd is checked, but variables, constructed paths, glob-based directory changes and unrecognized encodings can hide effects. Keep all command-corpus cases in S06. |
| Host tool inventories can change | A host tool outside the matcher is not intercepted. Pin/check inventories and keep §4 complete. |
| Hook failures differ by host/version | Degraded and unverified status must remain visible; requiring L1 alone does not require fail-closed behavior. |
| Host-native messaging/delegation at L1 | Friday communication instructions are guidance for these tools. Spawn restrictions are host-specific. |
| External file reads | Sensitive secret forms remain denied, but ordinary outside-project reads depend on host prompts/workspace restrictions. Do not promise universal confinement. |
| Lexical/real-target checks have a race | A same-user process can swap a link after judgment and before the host syscall. Hard links also appear as ordinary files. |
| Shell `.git` reads | Git metadata reads through allowed shell commands are not all blocked; direct file access is a different policy surface. |
| Broad root search | A search rooted at `.friday` can expose runtime names even where reading their content is forbidden. |
| Pattern redaction | Unknown secrets/encodings can escape recognition. An intentionally malicious credential-bearing operation can exfiltrate. |
| Private access checks cache success | External ACL changes after caching require explicit reinspection/process lifetime considerations. POSIX recursive checks stop at depth four. |
| Same-user/admin attacker | Friday's file permissions and token classes do not isolate processes with the same OS account or administrators. |
| UI origin reuse | Random ports and per-start no-cache paths reduce stale-origin risk; a controlling hostile service worker is a browser-origin threat requiring the explicit UI checks in S13. |
| Supported versus experimental | Scripted conformance proves the stated fake protocol; it is not proof of every real host version/login/configuration. Live checks follow [TESTING.md](TESTING.md) and the host guides. |
| Enforcement setting quirks | `require_enforcing_hooks` maps specific vendors and rejects reported spawned sessions for those vendors; OpenCode has a separate unverified path. |
| Approximate usage | Host-reported usage/cost and absent usage are observational; approval and budget semantics must preserve unknown values. |

## 14. Threat model and enforcement ownership

| Threat/asset | Mitigation and enforcing location | Acceptance evidence |
|---|---|---|
| Repository requests operator power with agent token | `app.ts` token class and `rpc.ts` current caller checks; S13/S03 | Security capability/scope/cross-project cases |
| Same agent key in two sessions acts twice | Shadow/session ownership checks, current harness/run; S03/S04 | State and messaging authority suites |
| Path traversal, case variants, junction outside scope | `paths.ts`, sensitive classes, role/task/team checks; S06 | Security traversal/scope plus policy links/worktrees tests |
| Repository overwrites hook/MCP config or plants root executable | Sensitive HOST_CONFIG/ROOT_PROGRAMS and no-current-dir executable search; S06/S15 | Tool coverage and launcher suites |
| Tracked policy lowers review or adds privileged operation | Local exact loosening trust; policy validation applies no malformed file; S06/S12 | Policy downgrade/malicious-files cases |
| Permission grants above delegation ceiling | Plan ceiling and `aboveCeiling` checked before grant; S04/S06/S07 | Security delegation ceiling case |
| Approval replay, staleness or self-approval | Grant binding/reuse/policy/expiry; human-only decision and restricted relay; S04/S06/S12 | Replay/stale/unauthorized cases |
| Authority changes while async preparation runs | Packet, operation and verification have effect-specific final checks. Symbolic patching judges tools before asynchronous preparation, but its final state check proves only task existence, assigned agent and a nonnull current run; policy, grants, pause and the same attempt are not rejudged there, and file reread/replacement await afterward. S06–S09 specify the resulting limit. | Context, operation-authority, graph and verification suites |
| Cross-task/run mutation | Protocol ownership, current attempt and worktree task; S03/S04/S06 | Security scope case and recovery tests |
| Concurrent checkout writers overwrite each other | One live writer/tool judgment, task worktrees and file reservations; S06/S07 | Reservations and worktree integration suites |
| Verified branch changes before integration | Source/tree/policy check and merged-content checks; S07 | Verification/integration suites |
| Credential appears in message/events/artifacts | Redaction before event append/delivery/output storage; S02/S05/S06 | Secret-message case and operation/master-brain scans |
| Agent asks for secret | `evaluateCapability` denies `secret.resolve`, offers operation path; S06 | Unauthorized-capability and operation tests |
| Trusted operation abuses secret | Profile/role/approval/current run, sanitized output, explicit residual limit; S06 | Operations and operation-authority tests |
| Third-party MCP names private file | Launcher-local recursive input scan then server policy; S06/S15 | MCP sensitive-input and tool-coverage cases |
| Repository sends provider key to chosen endpoint | User-local endpoint, clone provider approval, outbound redaction; S11/S12 | Master-brain endpoint/key scan cases |
| Repository prompt injection grants authority | Untrusted text classification, schema validation, human plan/grant decisions; S05/S11 | Prompt injection security case |
| Peer impersonates human or unrelated agent | Related-work topology, sender trust labels, session-bound acknowledgement; S05 | Messaging authority and forged-message hook cases |
| Clone/backup impersonates active session | Clone key, credentials omitted, re-registration and inspection-copy refusal; S03/S05/S12 | Restore/snapshot/clone tests |
| Daemon token leaked to another project | Per-clone token store and project checks; S03/S13 | Cross-project security case |
| Browser mints or replays sign-in | Operator-only mint, 60 s single use, own Origin/JSON, 12 h cap, session scope; S13 | UI-auth and UI security suites |
| Stale cached UI or service worker | Random per-start bundle path, no-store and service-worker cleanup response; S13 | UI-serving and daemon-port suites |
| Agent-written preferences carry a credential | Private-file writer, bounded object/depth, event redactor; S13 | UI-prefs integration suite |
| Cancel/pause status leaves work running | Grouped child stop plus effect-time pause checks; S06/S07/S13/adapters | Control, conformance and busy-stop sentinel tests |
| Windows runs project-planted executable | `NoDefaultCurrentDirectoryInExePath=1`, absolute system programs, external background cwd; S12/S14/S15 | Entry-point/launcher and shortcut tests |

## 15. Security acceptance cases

The kit names the end-to-end file `tests/security/security-cases.test.ts`. Its exact implementation inputs and expectations are specified in [S19](segments/S19-end-to-end-release.md); all cases also appear in the [test catalogue](reference/test-catalogue.md). Each case proves the forbidden effect is absent, not merely that some exception occurs.

| Case | Required evidence |
|---|---|
| Path traversal | Relative `..`, mixed separators, encoded traversal-looking text, absolute/UNC and protected targets are denied; a valid scoped file is allowed; outside-project permission request is denied without approval; outside sentinel absent. |
| Unauthorized capability | `secret.resolve` denied with no approval; harness token gets HTTP 403 for operator approval/cancel; high-risk relay and nonenforcing/other-agent relay refused for named reasons; unlisted operation denied; requests stay pending and task still RUNNING. |
| Scope confusion | Frontend task cannot mutate backend/shared paths through case/traversal forms; legitimate scope allowed; asking does not grant; foreign task update/result/context fail with ownership reason; foreign task keeps running. |
| Policy downgrade | Protected config/policy/hook/MCP writes denied; shell variant not auto-allowed; untrusted loosening leaves effective version unchanged; push denied and explicit policy change waits. |
| Message credential exfiltration | Provider, GitHub, AWS, daemon tokens and PEM content absent from delivery and every database table; redaction marker present. |
| Prompt injection | README and human-looking message claiming push approval create no granted row, change no policy version and still cannot push. |
| Malicious policy files | Unknown key makes whole file inapplicable, including its deny; loosening MCP/push/operation waits for trust; even trusted operation targeting credential store is denied before execution; zero operation runs. |
| Replayed approval | Same idempotent request returns same approval; once grant allows exactly one action; another decision cannot renew it; repeated elicitation reports used and does not permit another action. |
| Stale approval | Task-wide grant stops at effective policy change and at explicit expiry using fake clock; allowed before, refused afterward. |
| Delegation ceiling | Reviewed/materialized scope is cut to role scope with exact explanatory note; write/permission above ceiling denied with no approval and no file; no permitted overlap rejects proposal with HTTP 400 and no active plan. |
| Cross-project leakage | Every token class from project A rejected by B with 401; B cannot access A project/task/memory; foreign task 404, memory empty, private directories differ. |

The tool-coverage file independently proves:

| Case | Required evidence |
|---|---|
| Protected cwd and directory changes | Every normalized shell denies `.friday`/`.git`/private cwd forms; ordinary/similarly prefixed folders remain accepted by this check. |
| Root executable protection | Root `node.cmd`, `node.exe`, `NODE.BAT`, `git.exe`, `node.js` writes denied as host.config; similarly named source/nested files do not falsely match. |
| Matcher/action completeness | Exact matcher sequence, each mapped to policy action; own Friday MCP tool maps to null; matched writes/commands in post matcher. |
| Unintercepted manifest completeness | Every builtin not matched appears in §4 in backticks; section length exceeds 100 characters. |
| Sensitive class × tool matrix | Path/search tools and supported shell examples deny every applicable sensitive class without a daemon; host.config read/search allowed. |
| Third-party MCP sensitive input | Nested and direct protected strings denied locally; ordinary query not falsely classified. |
| Shell host-config write safety | Redirect/copy/Set-Content/Remove-Item variants for every host config/root shim are never auto-allowed. |

The remaining backend security file `tests/security/ui.test.ts` checks UI sign-in Origin/content-type/code handling, token scope and session boundary. Its exact assertions and backend implementation belong to S13. Frontend rendering/desktop implementation tests are outside this kit.

**CLAUDE:** write a failing regression for each new authority path and assert its rule/reason, forbidden effect and coupled state. Follow the full gate in TESTING; a documentation-only edit needs the document-dependency checks, not a paid live-host run.

## 16. Security rules for builders

- **L0-04 —** One effect has one authorization rule applied on every entry path; enumerate API, hook, MCP, automatic and recovery paths before implementation.
- **L0-06 —** A lexical in-scope path can reach another target; judge real targets and verify private-folder permissions before writing credentials.
- **L0-14 —** A check before an await can expire; recheck task, attempt, policy and grants in the transaction that records the effect, and refuse when bounded retries cannot establish current authority.
- **L0-15 —** A spawned host brings machine configuration, plugins, tools and accounts; restrict inherited authority, verify startup inventory and probe configuration behavior against a copy.
- **G7 —** Tool policy is L1 governance; name the achieved level/status and never present it as an OS sandbox.
- **D-52 —** Windows can resolve a bare executable from the current directory; set `NoDefaultCurrentDirectoryInExePath=1` at each entry point, use absolute system programs and start background helpers outside repositories.
- **T-26 —** An arbitrary rejection can pass for the wrong reason; security tests assert the named denial cause and the absent effect.
- **L12-02 —** Messaging has several authenticated paths; define an action/actor/session/entry-point authorization matrix before adding a path and test each cell.
- **L12-05 —** Link-aware checks and verified ACLs are prerequisites; build them into the first protected-file write and first governed path evaluation.
- **L13-15 —** Attached Claude Code leaves native tools and shell heuristics outside complete mediation; keep §4 and §13 visible and verify a stricter requirement from session evidence.
