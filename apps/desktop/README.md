# Friday desktop shell (`apps/desktop`)

A Tauri 2 app for Windows that hosts Friday's interface (the `apps/ui` bundle) in two windows:

- **Notch** (`notch.html`): a transparent, always-on-top island at the top centre of the screen, over your editor. Clicks outside the island go through to the window underneath. It never takes focus by itself.
- **Studio** (`index.html`): a normal window (1440×900, at least 960×640), hidden until you open it.

The Rust core is the **only HTTP client of the daemon** on the desktop (plan FD-06): it reads `daemon.json` and `operator.token` from Friday's private state folder at call time, forwards only the routes of an explicit allowlist (`src-tauri/src/routes.rs`), shows native dialogs before the actions that need them (`src-tauri/src/confirm.rs`), and streams events to the page on a channel. The webview holds no credential. The shell also has a tray, global shortcuts and native notifications, and it can start, stop and restart Friday.

The shell is outside `turbo run build` (CI has no Rust; plan FD-19). It is Windows only (ERRATA F36).

## Layout

```
apps/desktop/
  package.json            @friday/desktop: desktop:build, desktop:test, desktop:icons (cargo, not turbo)
  NOTICE                  credits for the click-through technique
  scripts/make-icons.mjs  draws src-tauri/icons/icon.ico and icon.png from Friday's mark
  src-tauri/
    .gitignore            /target/ and /gen/ (before the first build: LESSONS UI-27)
    Cargo.toml  build.rs  Tauri.toml  capabilities/default.json  icons/  windows/app.manifest
    src/  main.rs lib.rs daemon.rs proxy.rs routes.rs events.rs island.rs tray.rs shortcuts.rs
          confirm.rs notify.rs platform_windows.rs paths.rs settings.rs probe.rs
```

| File | What it does |
|---|---|
| `lib.rs` | the app: windows, state, every command, the tray and shortcut actions, the daemon's lifecycle |
| `routes.rs` | the request allowlist and the raw-path checks (the security core; most of `cargo test`) |
| `proxy.rs` | the HTTP/1.1 client: `127.0.0.1` only, no redirects, no `Origin`, the token sent only after the connection's other end is checked to be the daemon's process |
| `confirm.rs` | `confirm_and_send`: re-reads the item, rebuilds the body, decides on and writes the native dialog (escaping hidden characters) |
| `events.rs` | the SSE reader and the channel messages |
| `daemon.rs` | finding the project, the private folder, Friday's install; starting and stopping the daemon |
| `island.rs` | the Notch window: placement, click-through poll, the wake strip, the keyboard |
| `platform_windows.rs` | the Win32 calls (cursor, styles, window region, TCP table, locked screen, AltGr check, password prompt, shell open) |
| `tray.rs`, `shortcuts.rs`, `notify.rs` | tray menu and icons, global shortcuts, notifications |
| `paths.rs`, `settings.rs` | paths the page may open; `desktop.json` |
| `probe.rs` | the verification harness (feature `probe`, never in a normal build) |

## Building

Both routes build in **PowerShell or cmd, not Git Bash** (its `/usr/bin/link` shadows linkers). No administrator rights are needed by either.

First build the interface bundle (the shell embeds `apps/ui/dist` at compile time):

```powershell
Set-Location C:\friday\apps\ui
node C:\friday\apps\ui\node_modules\vite\bin\vite.js build     # same as: pnpm --filter @friday/ui build
```

### Route 2: the GNU toolchain (used on this machine)

One-time setup, per user:

1. Rust with the GNU host: `rustup-init.exe -y --default-host x86_64-pc-windows-gnu` (installs to `%USERPROFILE%\.cargo` and `%USERPROFILE%\.rustup`).
2. MinGW-w64 for `windres` (the resource compiler): the WinLibs build (GCC, MSVCRT runtime), unpacked to `%LOCALAPPDATA%\Programs\winlibs`, so that `%LOCALAPPDATA%\Programs\winlibs\mingw64\bin` holds `windres.exe` and `gcc.exe`.

Every build:

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:LOCALAPPDATA\Programs\winlibs\mingw64\bin;$env:PATH"
# Link with Rust's own MinGW linker: WinLibs' gcc adds its default-manifest.o, a second application manifest.
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained\x86_64-w64-mingw32-gcc.exe"
Set-Location C:\friday\apps\desktop\src-tauri
cargo test
cargo build --release
```

The result is `apps\desktop\src-tauri\target\release\friday-desktop.exe` with `WebView2Loader.dll` beside it (tauri-build ≥ 2.7.1 copies it there on the GNU target; the two files travel together). The first release build takes about 5 minutes; `Cargo.lock` pins the versions.

What route 2 needs to know:

- `windres` must be **on PATH**. On a Windows host, `embed-resource` (used by tauri-build) ignores `RC_x86_64-pc-windows-gnu` and `RC` and runs `windres` from PATH.
- Without the linker variable the build still works: `ld` warns `.rsrc merge failure: multiple non-default manifests` and keeps both manifests, and Windows uses the first (Friday's). The variable removes the duplicate.
- `build.rs` links `windows/app.manifest` (Common Controls 6) into the executable **and the test binaries**, and tells tauri-build not to add its own copy. The native dialogs import `TaskDialogIndirect`, which only Common Controls 6 exports; a test binary without the manifest stops before `main` with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139).
- `tauri build` would bundle an MSI, which needs WiX: this crate sets `bundle.active = false` and is built with plain `cargo build --release` (the `custom-protocol` feature is named in `Cargo.toml`, so no Tauri CLI is needed). The `@tauri-apps/cli` npm package is not used.

### Route 1: Microsoft's toolchain unpacked per user (needs the owner to accept Microsoft's licence)

Not run on this machine (accepting the licence is the owner's decision).

```powershell
py portable-msvc.py --accept-license          # https://gist.github.com/mmozeiko/7f3162ec2988e81e56d5c4e22cde9977
msvc\setup_x64.bat                              # in cmd; sets PATH, INCLUDE and LIB for this shell
rustup-init.exe -y --default-host x86_64-pc-windows-msvc
Set-Location C:\friday\apps\desktop\src-tauri
cargo test
cargo build --release
```

On MSVC, `WebView2Loader.dll` is linked statically and is not needed beside the exe; `windres` is not needed (the Windows SDK's `rc.exe` is used).

## Running

```powershell
C:\friday\apps\desktop\src-tauri\target\release\friday-desktop.exe                  # the last project, or a folder picker
C:\friday\apps\desktop\src-tauri\target\release\friday-desktop.exe --project C:\work\shop
```

At start the shell:

1. opens the project: `--project`, else the last one (in `%APPDATA%\dev.friday.desktop\desktop.json`), else a folder picker. A folder without `.friday\config.yaml` offers **Set up Friday here** (`node <cli> --project <dir> init --json`), then lists the two files to commit and warns when the repository has no commit;
2. finds Friday: `FRIDAY_HOME` (a checkout), then the checkout it was built from, then `%LOCALAPPDATA%\Friday\install.json` (`friday setup`), then asks for the folder; when `install.json` is missing or stale it runs `node <cli> setup --json`;
3. finds the private folder exactly as `packages/sdk/src/discovery.ts` does: `<FRIDAY_STATE_DIR or %LOCALAPPDATA%\Friday>\projects\<project_id>-<first 8 hex of sha256(lower-cased real path of the main worktree)>`;
4. starts the daemon when none answers: `node <cli> --project <root> run`, hidden (`CREATE_NO_WINDOW`), its output in `<root>\.friday\logs\daemon-console.log`; ready when `daemon.json` names the child's pid and `/health` answers for this project and instance (30 s). If it stops early, a dialog shows the last lines of the log and offers **Run checks** (`doctor --json`) or **Start again**.

The daemon is not tied to the app: it keeps running when the app quits (Quit asks whether to keep Friday running). Closing the Studio hides it; the tray's Quit ends the app. A second launch shows the Studio of the first.

**Tray:** status icon (idle, working, waiting for you, error) and, as its first menu item and its tooltip, the page's status sentence (what runs, what waits for you and why, what is ready, to verify or failed, how many agents are connected), then the version, Show Notch, Open Studio, Settings…, Pause/Resume, Mute sounds, Open in browser, Halt…, Stop Friday (confirmed), Restart Friday, Quit. A left click opens the Studio.

**Shortcuts** (plan FD-16): `Ctrl+Alt+Shift+F` Studio, `Ctrl+Alt+Shift+N` Notch with the keyboard, `Ctrl+Alt+Shift+H` halt dialog; changeable with `set_shortcut`. A shortcut another program holds is `in_use`; one that types a character on an installed keyboard layout is `skipped`. On this machine the English (India) layout (`00004009`) types `Ṇ` and `Ḥ` with Ctrl+Alt+Shift+N and H, so those two defaults are skipped; Ctrl+Alt+Shift with B, C, F, J, K, P, V, W or Z types nothing on its layouts.

## The IPC contract

The page imports `@tauri-apps/api/core` only in `apps/ui/src/platform/tauri-transport.ts` (FD-02), through a dynamic import. It needs `"@tauri-apps/api": "~2.12.4"` in the `dependencies` of `apps/ui/package.json` (the same minor as the `tauri` crate; no dependencies, no install script); then delete `apps/ui/src/platform/tauri-api.d.ts`, the stand-in declaration of the two exports used. Until the package is installed, Vite cannot transform `tauri-transport.ts` (it resolves the specifier of a dynamic import too), so `tauri-transport.test.ts` skips and says why. Command arguments use the page's camelCase names (Tauri converts `timeout_ms` to `timeoutMs`).

### Commands

| Command | Arguments | Answer | Notes |
|---|---|---|---|
| `friday_request` | `method: 'GET'\|'POST'`, `path` (with query), `body?`, `timeoutMs?` (default 15 000, from 1 000 up to 3 700 000, the page's longest budget: verification), `idempotencyKey?` | the daemon's JSON (`null` when empty) | allowlisted routes only; refuses every route `confirm_and_send` owns and any body asking for `danger-full-access`; a test reads `apps/ui/src/api/timeouts.ts` and fails if a budget there is above the ceiling |
| `confirm_and_send` | `method`, `path`, `body?` | the daemon's JSON | for the routes it owns (below) and danger bodies; shows a native dialog when Rust decides one is needed |
| `stream_open` | `since: number`, `channel: Channel<StreamMessage>` | stream id | resolves once the daemon accepted the stream |
| `stream_close` | `id` | — | shuts the connection; the reading thread ends at once |
| `project_info` | — | `{project_id, name, root, port, url, ui_api: 1}` | `url` is `http://127.0.0.1:<port>` |
| `daemon_status` | — | `{state, message?}`; state `starting`, `ready`, `stopping`, `stopped`, `failed` or `no_project` | also pushed as event `daemon-status` |
| `stop_daemon` | — | — | native confirmation, then `POST /admin/shutdown` with the operator token; waits for the process to exit (2 min) |
| `restart_daemon` | — | — | native confirmation, then stop and start as at launch; a cancel answers 400 `DESKTOP-1003`, which the page takes as "cancelled", not as an error |
| `notch_rect` | `x, y, w, h` (CSS pixels of the Notch window) | — | Notch window only; a rectangle at most 4.5 px high is the wake strip |
| `notch_keyboard` | `take: boolean` | — | Notch window only; `true` makes the window focusable and focuses it, `false` restores and gives the keyboard back to the window that had it |
| `show_studio` | `target?: {focus_task?, approval_id?, panel?, id?, tab?, path?, reach?}` | — | shows and focuses the Studio and sends it `studio-deeplink` with `target`. Rules (the same in the Studio's receiver, `apps/ui/src/desktop/boot.ts`): `focus_task`, `approval_id`, `id` `[A-Za-z0-9_-]{1,128}`; `panel` `[a-z-]{1,32}`; `tab` `^[a-z][a-z0-9-]{0,31}$`; `path` 1–1 024 characters, no control character; `reach` `once`, `run` or `task`. One bad field refuses the whole target (`DESKTOP-1007`), so the Notch leaves out a tab or path that breaks its rule |
| `set_tray_state` | `state: 'idle'\|'working'\|'waiting'\|'error'`, `countsLine`, `paused?`, `muted?` | — | the tray icon, status line and tooltip. `countsLine` is the page's status sentence (`apps/ui/src/notch/derive.ts` `statusSentence`: "2 running, 1 waiting for you: 1 approval; 3 ready; 2 agents connected"); the shell cleans it and cuts it at 119 characters, because a Windows tray tooltip holds 127 and "Friday: " takes eight, then shows the same line as the tooltip (`Friday: <line>`) and as the disabled status item at the top of the menu. Pause/Resume and Mute follow `paused` and `muted` |
| `notify` | `title`, `body`, `test?` | `boolean`: handed to Windows | Notch window only; sent only while the Notch is parked (Show Notch off) or the screen is locked; at most 10 a minute. With `test`: from either window, at once, at most 3 a minute on a budget of its own (then 429 `DESKTOP-1008`). The notification plugin queues the toast and drops Windows' answer, so `true` never means it appeared, and `false` means it could not be prepared or was not sent |
| `get_autostart` | — | `boolean` | whether the per-user Run entry `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `Friday` starts this exe |
| `set_autostart` | `enabled: boolean` | `boolean`: on now | writes the entry (this exe's path in quotes, no argument: the app opens the last project) or removes it; a path holding a quote or a control character, or over 260 characters, is refused; failure `DESKTOP-2007` |
| `get_shortcuts` | — | `[{id, accel, state, note?}]`, state `registered`, `in_use`, `skipped` or `invalid` | ids `studio`, `notch`, `halt` |
| `set_shortcut` | `id`, `accel` (`Ctrl+Alt+Shift+K`) | the new list | stored in `desktop.json` |
| `open_in_editor` | `path` (absolute, or relative to the root), `line?` | — | only existing files inside the project root or the `friday-worktrees` folder; opens `vscode://file/<path>[:line]` with `ShellExecuteW` (no command line is built) |
| `open_in_browser` | — | — | `POST …/ui/login-codes` with the operator token, then opens the user-only redirect file it returns (never the link itself) |
| `store_key` | `name` (`[a-z][a-z0-9_-]{0,31}`) | `{name, stored, protection, endpoint}` | Windows' own credential prompt (hidden field), then `node <cli> --project <root> secrets set <name> --json` with the key on standard input; the key is never logged, stored elsewhere or returned |
| `allow_spending` | `budget` (dollars, 0–100 000) | the CLI's JSON | native confirmation, then `node <cli> --project <root> brain allow-remote --budget <n> --json` |

**Owned by `confirm_and_send`** (mirror: `DESKTOP_CONFIRMED` in `tauri-transport.ts`, checked against `routes.rs` by its test): `approvals/{aid}/approve`, `policy/trust`, `control/halt`, `tasks/{tid}/cancel`, `goals/{gid}/cancel`, `daemon/stop`, `agent-processes` (POST, starting an agent), `agent-processes/{key}/start`, and any POST whose body holds `danger-full-access`.

- **Approving:** Rust reads `GET …/approvals?status=pending`, finds the id (else 409 `DESKTOP-1004`), and sends only `reuse` (required: `once`, `run` or `task`), `ttl_s` clamped to [10, 86 400], `note` and `via: "ui"`. A dialog appears only when the risk is `high`, missing or unknown, or the reach is `task`.
- **Trusting policy:** Rust reads `GET …/policy`; the body's `loosening_hash` must be the current one (else 409 `DESKTOP-1006`); the dialog lists every loosened setting.
- **Halt, cancel a task or goal, stop Friday, start an agent, danger-full-access:** always a dialog (the task's summary, the goal's text, the agent's host, key, role and options; a warning for `danger-full-access`).
- Agent-written text in a dialog is shown in full, with every C0 and C1 control (newlines included), `U+00AD`, `U+061C`, `U+180E`, `U+200B`–`U+200F`, `U+2028`–`U+202E`, `U+2060`–`U+2064`, `U+2066`–`U+2069` and `U+FEFF` shown as `⟨U+XXXX⟩`. Text longer than 4 000 characters is refused (`DESKTOP-1005`): decide it in a terminal.

### Errors

A failed command rejects with `{status, body}`: `status` is the daemon's HTTP status, or 0 when the daemon was not reached; `body` is the daemon's JSON passed through unchanged, `{error: {code, name, message, retryable, details?}}`. The shell's own refusals use the same shape:

| Code | Status | Meaning |
|---|---|---|
| `DESKTOP-1000` | 403 | not a route the desktop app forwards (raw-path checks, template, project id) |
| `DESKTOP-1001` | 400 | the route belongs to `confirm_and_send` |
| `DESKTOP-1002` | 400 | `confirm_and_send` on a route it does not own |
| `DESKTOP-1003` | 400 | you cancelled the native dialog |
| `DESKTOP-1004` | 409 | the approval is no longer pending |
| `DESKTOP-1005` | 400 | too long to show in a dialog |
| `DESKTOP-1006` | 409 | the policy changed since it was shown |
| `DESKTOP-1007` | 400 | a bad argument |
| `DESKTOP-1008` | 429 | three test notifications went out in the last minute |
| `DESKTOP-2000` | 0 | the daemon was not reached |
| `DESKTOP-2001` | 0 | the port is held by a process other than the daemon in `daemon.json` (the token was not sent) |
| `DESKTOP-2002` | 0 | no project is open yet |
| `DESKTOP-2003`–`2006` | 0/500 | no install, no `vscode://` handler, no sign-in file, a CLI command failed |
| `DESKTOP-2007` | 500 | the sign-in entry could not be written or removed |

### Channel messages (`stream_open`)

`{kind: "event", event}` for each message with a JSON `data` line; `{kind: "activity"}` when bytes arrive, pings included (at most every 500 ms); `{kind: "end", reason: "shutdown" | "closed"}`; `{kind: "error", message}` when the connection fails mid-stream.

### Events (Rust to the page; `listen` from `@tauri-apps/api/event`)

| Event | To | Payload |
|---|---|---|
| `cursor` | Notch | `{x, y}`: the cursor in the Notch window's CSS pixels (outside the window too), at most every 16 ms while it moves, not while the island is the wake strip or the Notch is parked |
| `notch-open` | Notch | `{focus: true}` (the Notch shortcut; the window already has the keyboard) |
| `studio-deeplink` | Studio | `{focus_task?, approval_id?, panel?, id?, tab?, path?, reach?}` (`show_studio`, rules above; the tray's Settings… and the Notch's footer send `{panel: "settings"}`; the Notch sends `{panel: "diff", id: <task>, path}` from its file ticker, and from its card's notices `{panel: "plan-review", id: <goal>}`, `{panel: "inbox", id: <delivery>}`, `{panel: "memory", tab: "review"}` and `{panel: "settings", tab: "policy"}`; a card's item sends `{focus_task, approval_id}`) |
| `open-halt` | Studio | none (the tray's Halt…, the halt shortcut) |
| `toggle-mute` | all | `{muted}` (the tray's Mute sounds) |
| `daemon-status` | all | `{state, message?}` |

## Security

- `withGlobalTauri = false`; the pages are the bundled ones only (navigation is limited to `index.html` and `notch.html`; new windows and downloads are refused).
- Capability `default` (windows `notch` and `studio`): `core:app:default`, `core:event:default`, `core:webview:default`, `core:window:default` and the app's own commands (`build.rs` names them, so each is a permission). The core defaults for menus, tray icons, paths, images and resources are left out: the page needs none, and they would let a script create tray icons or menus. No plugin permission is granted: Rust calls the dialog, notification and shortcut plugins itself.
- CSP (in `Tauri.toml`): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc:` plus Tauri's IPC host; `base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`. **Trusted Types stay on**: Tauri's IPC works under them (verified below), so no directive was removed.
- The operator token is read from the private folder for every request, re-read after a 401, never logged (its `Debug` prints `<redacted>`, its bytes are cleared after use) and never reaches the webview. Before the token is written to a connection, the TCP table must show the other end owned by the pid in `daemon.json`; otherwise nothing is sent (`DESKTOP-2001`).
- Raw paths are refused before parsing when they hold a dot segment, any `.` in the path, `%2e`, `%2f`, `%5c`, `%00`, `%25` (any case), any `%` in the path, a backslash, an empty segment, a second `?`, a `#`, NUL or another control character; the query may hold only the keys its route takes. The parsed path and query must equal the raw ones; the project id must be the open project's. `ui/login-codes`, `ui/logout`, `harness-sessions/bind`, `hooks/*`, `/admin/*` and `/protocol/*` are not in the table (the shell itself sends `/admin/shutdown` and `ui/login-codes` for Stop Friday and Open in browser).

## Verifying the shell

`cargo test` runs 74 unit tests (two more with `--ignored`: one against a real project, one that reports which Ctrl+Alt+Shift letters type a character on the installed layouts): the allowlist (dot segments, encoded dots, slashes and backslashes in both cases, `//`, backslashes, NUL and control characters, a foreign project id, `/admin`, `/hooks`, `/protocol`, `harness-sessions/bind`, `ui/login-codes`, `ui/logout`, a second `?`, stray queries, every confirm-owned route refused by `friday_request`, danger bodies), the HTTP head and chunked decoding, the dialog escaping and approval rules, the SSE parser, the project key against values computed with Node and the SDK's algorithm, `daemon.json` checks, the TCP-table pid check on a real loopback connection, placement and hit-test math, shortcuts and the AltGr rule, paths the page may open, the deep link's fields, every time budget of the page's table passing the proxy unclamped, the preference routes, the sign-in entry (on a scratch key under `HKCU\Software`, removed when the test ends) and the two notification budgets.

`cargo test -- --ignored` with `FRIDAY_DESKTOP_TEST_PROJECT` (a folder inside a project) and `FRIDAY_DESKTOP_TEST_KEY` (the SDK's key for it) checks the project discovery against a real repository.

The **probe** (`cargo build --features probe`, then run with `FRIDAY_DESKTOP_PROBE=<report.json>`, optionally `FRIDAY_DESKTOP_PROBE_RESTART=1` and `--project <dir>`) evaluates a script in both windows once the daemon is ready, checks the Notch window from Rust, writes the report and quits. Never ship a probe build.

### Verified on this machine (Windows 11, route 2, 2026-10-17)

- `cargo test`: 65 passed, 2 ignored; the real-project test (`--ignored`) passed against a scratch repository; `cargo build --release`: `friday-desktop.exe` (4.3 MB, one application manifest) and `WebView2Loader.dll`.
- The release exe with `--project` on a scratch project: the Notch window existed 1.3 s after launch, the tray icon window and the hidden Studio window were created, the daemon was started hidden and kept running after the app was ended, and the shell's own process used 32 MB (working set, WebView2 processes not counted).
- The probe against a scratch project (`FRIDAY_STATE_DIR` in a scratch folder), from a stopped daemon: the shell started the daemon (ready), `friday_request` read `ui/snapshot` (`ui_api` 1), refused `approvals/…/approve` (`DESKTOP-1001`), `/admin/shutdown` and `%2e%2e` (`DESKTOP-1000`); `confirm_and_send` for an unknown approval answered 409 `DESKTOP-1004` without a dialog; the channel delivered `activity` and `event` messages; `restart_daemon` stopped and started the daemon on a new port and requests followed it; with the daemon already running the shell attached to it.
- In both pages, under the CSP with `require-trusted-types-for 'script'`: `__TAURI_INTERNALS__` present, `window.__TAURI__` absent, `invoke` and channels work, assigning `innerHTML` throws `TypeError` (Trusted Types enforced), `fetch` to another origin is blocked.
- The Notch window: `WS_EX_TOOLWINDOW`, `WS_EX_NOACTIVATE` and `WS_EX_TOPMOST` set; 575×375 physical pixels at the top centre (scale 1.25); as the wake strip only the strip takes the mouse (a point below it reaches the window underneath); with an expanded island and the cursor away from it the window is click-through (`WS_EX_TRANSPARENT`) and a point on the card reaches the window underneath.
- Shortcuts: `Ctrl+Alt+Shift+F` registered; N and H skipped (English (India) layout, above).

- With the pages wired (`apps/ui/src/desktop/boot.ts`), the release exe on a scratch project, its pages read and photographed through WebView2's debugging port (the screen was locked; `apps/ui` LESSONS UI-62): the Studio window mounted the Studio connected through the shell, with no in-page Notch and no token in the page; the Notch window showed its pill. A scripted agent (`tests/fixtures/scripted-adapter/worker.mjs`) was given a task; its commit request opened the Notch window's card by itself (medium risk, the exact command), the Studio counted it; **Allow once** in the Notch, armed by a pointer move, granted it, the Notch folded with "Allowed once", the Studio's count went to 0, and the agent continued in the same run and claimed the task.

To read the pages that way: start the exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` set to the arguments of `BROWSER_ARGS` (in `src/lib.rs`) plus `--remote-debugging-port=9333 --remote-debugging-address=127.0.0.1`, then connect with `chromium.connectOverCDP('http://127.0.0.1:9333')` from `playwright-core`. Never ship or document that variable for daily use: it opens the pages to any local program.

### Not verified (manual checks of plan §10.4, on an unlocked screen)

Clicks on the island with the real cursor over it, approving from the Notch without stealing focus from the editor, typing in the floating Notch, the Studio's modal opened from the Notch by a high-risk approval, the first alert's sound, the tray items and shortcuts by hand, the native dialogs and the credential prompt by hand, notifications (from `target\release` Windows shows them as PowerShell's; an exe run from elsewhere needs a Start-menu shortcut carrying the app id `dev.friday.desktop`, or Windows drops them), "Send a test notification" from both kinds of build, "Start Friday when I sign in" through an actual sign-in, monitor and DPI changes, route 1.

`eval` inside the probe's script was not blocked: scripts the host injects (WebView2 `ExecuteScript`) are not subject to the page's CSP, so the probe cannot show that page scripts cannot `eval`; the CSP has no `'unsafe-eval'` and Tauri adds none.
