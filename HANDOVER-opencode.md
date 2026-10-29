# OpenCode A/B handover

Implementation commits: feat/opencode. Publication branch: feat/opencode-ab-2026-10-19 (requested by the owner). Base: feat/overnight-2026-10-18 at 950aedb.
**Review status:** A/B checks pass. The full repository test gate is NOT CLEAN: unchanged Cursor/Gemini/Codex tests failed intermittently during broad runs and passed alone. This is an experimental review branch, with that validation blocker recorded below.

Scope: checkpoints A (controlled no-model launcher) and B (policy plugin/translator with fixtures).
No model, sign-in or Ollama start is part of this work. C–E are not started.

The implementation and integration guide describe only the built A/B behavior. The three shared documents below are deliberately not edited in this worktree.

## Exact M8b checkpoint row for docs/BUILD_PLAN.md

Add after the existing M8b.4 row:

| M8b.5 — OpenCode controlled launcher and policy plugin (A/B, experimental) | @friday/adapter-opencode pins the classic OpenCode 1.19.3 API; harness config writes only a tracked preflight declaration, doctor checks the binary/dependency bundle/configuration without starting it, and harness run starts a private no-model profile, verifies version/effective config and the nonce-bound policy plugin, creates and binds an idle session, then closes it; no prompt submission or task polling is enabled. The dependency-free before-tool plugin freezes judged arguments and sends supported tools through tool.check; unknown tools, missing/failed/slow checks, unbound sessions, replay and profile changes are denied. The translator includes every patch source/destination. Token cost: none. | Unit fixtures and tests/conformance/opencode.conformance.test.ts check A/B against a scripted host and the real daemon; the optional native preflight calls no model. L1 unverified until live checkpoint C; no autonomous-worker or busy-cancellation claim. |

## Exact Appendix 10 row for docs/BUILD_PLAN.md

| OpenCode controlled preflight (classic 1.19.3; experimental A/B) | L1 unverified | In-process tool.execute.before freezes arguments and sends supported tools through tool.check; unknown tools and failed/missing/slow checks are denied | Private profile with nonce/plugin/session and effective-config checks; no providers, MCP servers, prompts, task polling or automatic worker discovery; live failure behavior and busy lifecycle remain unverified | M8b.5 (A/B) |

## Exact Part H.32 addition for docs/BUILD_PLAN.md

OpenCode A/B adds a separate in-process policy plugin rather than a shell-command hook module. Its classic 1.19.3 launcher creates an isolated no-model profile and an idle session, checks plugin readiness before binding that session, uses the existing tool.check judgment and process groups, and stays L1 unverified. The unit and scripted-host tests prove the A/B contracts; only a permitted live checkpoint C can establish the host's actual failure behavior. Token cost: none. The integration guide is docs/integration/opencode.md.

## Exact lessons to add to docs/LESSONS_LEARNED.md §4a

Assign the next free HX numbers during integration; each row is written as pitfall -> rule:

- OpenCode can skip a plugin whose initializer fails while its HTTP server remains healthy -> require a nonce-bound plugin-ready response and matching effective configuration before binding a session; health alone is not enforcement.
- OPENCODE_CONFIG merges, disabling project config still leaves global/home sources, and --pure removes Friday too -> use a fresh private profile and a small explicit environment; check all effective security fields and refuse conflicting administrator settings.
- Plugins share mutable arguments and later hooks may rewrite them after a judgment -> freeze the original arguments and output before checking, and reject any unreviewed plugin.
- A grep content regex is not a filename filter, and a file target can broaden to its parent -> translate include as the filename selector and judge both the selected path and the directory actually searched.
- A server's session ID becomes available before any prompt -> bind that explicit ID to the registration; refuse unbound or child IDs rather than infer the current session.
- Windows temporary paths can use short 8.3 names while realpath returns long names -> canonicalize the newly created private profile directory before recording paths and hashes.
- OpenCode initializes plugin dependencies before loading the external hook -> require a preinstalled pinned bundle with a real lockfile and keep npm offline; a missing bundle fails startup instead of downloading implicitly.
- The tool.check command contract judges at the run execution root, not at an arbitrary host workdir -> refuse a different workdir until a verified translation preserves it.
- OpenCode apply_patch can move a file while editing it -> judge both source and destination, plus every add/delete/update target, and reject ambiguous envelopes.
- existsSync follows a dangling link and can hide the link itself -> inspect path components with lstat before planning and applying configuration writes.
- OpenCode rewrites Windows MSYS/WSL drive aliases differently from ordinary path resolution -> refuse those aliases until host and policy paths have verified parity.
- A declared policy-plugin filename or a successful scripted test is not live failure evidence -> keep the daemon and doctor status unverified until checkpoint C records the actual host behavior.
- Script-filter arguments after a literal -- can expand a pnpm test script into the full suite on this toolchain -> use pnpm exec vitest run with explicit test paths for targeted checks; keep the final test:all gate unfiltered.
- PowerShell can select a blocked pnpm.ps1 shim, and node -e can lose nested quotes -> use pnpm.cmd without changing execution policy and use a temporary script file for structured edits.

## Exact changelog paragraph for CHANGELOG.md

Added experimental OpenCode checkpoints A/B: a pinned 1.19.3 no-model server/session preflight with private configuration, plugin readiness and effective-config checks; a fail-closed before-tool plugin and fixture-tested translator using the existing tool.check policy; harness config/doctor/run dispatch, scripted-host conformance and an optional native no-model check. OpenCode remains L1 unverified. Model prompt submission, task polling and autonomous-worker discovery are disabled; no live model enforcement, coding-quality or busy-lifecycle claim is made.

## Problems met and how they were handled

1. Another agent owns the active checkout. All source and test changes are in this separate worktree; the shared checkout was used only for the explicitly requested worktree registration. No shared plan, lessons or changelog edits were made.
2. PowerShell blocked pnpm.ps1. Used pnpm.cmd, with the same pnpm commands, without changing execution policy.
3. A large Windows exec command exceeded the process command-line limit. Split file writes into bounded commands.
4. PowerShell damaged nested quotes passed to node -e before the edit script could parse. Used a temporary .cjs file and removed it after the edit.
5. A first targeted test:all invocation passed a literal -- through pnpm and ran the broader suite. Switched targeted checks to pnpm exec vitest run; the required final gate remains pnpm test:all.
6. A source-level fast path for missing dependencies had only been a research test convenience. The built launcher requires an explicitly preinstalled pinned bundle and its actual npm lockfile; there is no runtime installer. A native A-check bundle was prepared under ignored tests/.artifacts, with scripts disabled.
7. npm warned that ini@7.0.0 in that external bundle advertises a newer Node engine than this machine's 24.12.0. The bundle is not a Friday workspace dependency. No Node upgrade or engine-policy override was made. Record the final native preflight outcome below; deployment must provision a compatible reviewed toolchain.
8. Native A initially failed strict profile attestation. Canonicalized generated temporary paths during investigation; the diagnostic then identified that OpenCode inserts $schema into its config. The launcher now supplies that expected metadata before sealing, rather than accepting or ignoring file mutation. Repeated checks remain no-model.
9. The initial profile needed explicit Windows user-only ACL protection and cleanup when preparation fails. It now uses Friday's existing ensurePrivateDir and removes an incomplete owned profile on failure.
10. A declaration writer must not follow a linked .friday path or overwrite changes since planning. Both checks are enforced before applying the common atomic write plan.
11. A missing check and a malformed object containing only decision:allow are different failures. Validate the full ToolCheckResult schema before accepting an allow; both are fixture-tested. OpenCode's bash tool can actually use PowerShell on Windows, so tool.check receives the explicitly selected shell dialect.
12. The existing spawn status defaults to reported. Added the OpenCode-specific unverified rule so a capability claim cannot promote it to enforcing.
13. The SDK percent-encodes x-opencode-directory. Raw non-ASCII folder names cannot safely be sent as HTTP header bytes. The launcher now follows that encoding, and native A uses a Unicode execution directory.
14. An early broad smoke run overlapped ongoing implementation and compilation; it reported existing Claude/goal-integration timeouts and an old in-memory policy module. The Claude case passed alone after the forced rebuild. Final gates are run from the finished source, without concurrent edits or builds. A final review interrupted one in-progress full gate before this encoding fix; it is rerun from scratch.
15. No shared worker delivery/recovery loop is added at A/B. The public prompt method throws, and the preflight is absent from automatic host discovery; the existing eleven-case worker suite and checkpoints C–E are not represented as complete.

16. A full test gate exceeded an existing Cursor doctor test budget under default concurrency. With two workers that test passed, but existing Cursor/Gemini cancellation cases and one Cursor behavior case still failed. Those implementations and assertions are unchanged; final isolated checks and a serial full-gate outcome are recorded below. Stopped only verified worktree-owned test trees when restarting; Windows reported already-exiting job descendants, and their PIDs were confirmed absent afterward.
17. Final isolation review needed explicit evidence for project .env and auto-discovered .opencode/plugins, beyond JSON configuration. Added both hostile fixtures to native A; the strengthened no-model preflight passed and the foreign-plugin marker remained absent.

18. Shared CLI help promises FRIDAY_AGENT as the default identity. OpenCode now follows that existing convention, with opencode-1 as the fallback, and the help names it. This does not forward Friday credentials or environment to the host.

19. existsSync follows a link and reports a dangling target absent. The config writer now inspects links with lstat directly and refuses both existing and dangling linked paths; both variants have fixtures.

20. Grep pattern is a content regex, while include selects filenames; the host also searches the parent when path is a file or missing. The translator now preserves include for sensitive-file judgment and checks the selected path plus the actual canonical search directory. A real tool.check fixture denies a .env include, and filesystem fixtures cover directory, file and missing targets.

21. The pinned host rewrites MSYS/WSL drive aliases before file access. A lexical Friday path could otherwise appear inside one root while the host accesses another. The closed translator refuses those Windows aliases, with a fixture where the misleading lexical path would be inside the project; native/project-relative paths remain supported.

22. Broad Windows test runs were not consistently clean. A two-worker full run finished with 3 failures, 2,670 passes and 21 skips; a serial full run finished with 2 different Cursor failures, 2,671 passes and 21 skips. The original three cases passed alone, then the other two Cursor cases passed alone. The final serial retry-enabled run passed all 59 OpenCode checks and all Cursor/Gemini conformance cases, but a Codex usage case failed after its retry. Further integration/process stalls led to stopping only that verified test tree; its remaining PIDs were checked absent. The Codex case then passed alone in 7.9 seconds. No unrelated host code, assertions or timeout limits were changed. This leaves the full repository gate unresolved, rather than green by inference.

## Checkpoint C permission request, when the owner chooses to proceed

Authorize use of the already-downloaded Ollama qwen2.5:7b, using C:\research\tools\ollama and C:\research\tools\ollama-models, with a bounded context/output/turn budget and a disposable test repository. Authorize starting and stopping that local server by owned PID. No hosted fallback, sign-in or new model download is implied.

Authorize harmless denied actions only: write an out-of-scope sentinel file; read a fake .env with no real credential; attempt a shell marker write which Friday refuses; and call a mock MCP operation. Record zero sentinel effects under policy denial, plugin throw, hung check, daemon outage and session mismatch. For C only, native permissions in the disposable profile must permit the harmless fixture action enough to distinguish Friday before-hook refusal from the A/B native deny-all restriction. Enabling inference transport and recording real before-tool enforcement is checkpoint C, not this implementation.

## Validation record

Native A passed against the installed OpenCode 1.19.3: only version, health, config, named idle-session creation, idle abort and disposal were used. Hostile project/user/home JSON, project .env and auto-discovered project-plugin fixtures did not execute; a Unicode execution root worked; the private profile was removed and submitPrompt stayed disabled. The strengthened native test passed in 16.85 seconds total. No model, provider sign-in or Ollama start occurred.

The final source passed 45 OpenCode unit fixtures (37 translator, 8 configuration) and all 14 scripted-host conformance cases against the real Friday daemon: 59 A/B checks. They include .env filename-filter denial, every patch target, Windows drive aliases, dangling junctions, session binding, replay, frozen arguments, profile changes and absent/malformed/failed/slow/ask judgments. Native before-tool enforcement is still unverified.

Required gates were invoked individually, without pipes, before the feature commit:

- pnpm.cmd lint: passed; 790 files checked, with one existing informational String.raw diagnostic in packages/execution/src/groups.ts.
- pnpm.cmd turbo run build typecheck --force: passed; 52/52 tasks, no cache, 1m13.097s on the final source.
- pnpm.cmd test:all: NOT CLEAN in broad runs, as recorded in problem 22. The last unfiltered attempt used VITEST_MAX_WORKERS=1 and pnpm.cmd test:all --retry=1; it was stopped after the confirmed Codex failure and further process stalls. Passing isolated reruns do not turn that full gate into a pass.
- node scripts/check-portability.mjs --working-tree: passed; 1,152 files, zero untracked. git diff --cached --check also passed.

Broader-suite review locations: tests/conformance/harness-conformance.ts:189 (waiting for work before cancellation); tests/conformance/cursor.conformance.test.ts:205, :337 and :382 (claim/project-hook/message timing); tests/integration/codex-adapter.test.ts:595 (usage report/result retry). The affected cases passed individually with their original assertions; resolve the full-run timing/reliability blocker on a quiet machine or CI before treating the branch as merge-ready.

Implementation commits remain on feat/opencode. The owner requested publication on a newly created feat/opencode-ab-2026-10-19 branch. The source in C:/friday was not edited. docs/BUILD_PLAN.md, docs/LESSONS_LEARNED.md and CHANGELOG.md are unchanged in this worktree; their exact proposed additions are above. C–E remain unstarted.
