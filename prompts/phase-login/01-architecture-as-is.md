# 01 — The architecture as it is: a trust-boundary map

Ground truth, verified against the working tree at `6c03c35` (2026-07-09).
The organizing question: *if every feature had to sit behind an authenticated,
paid account, where exactly would the enforcement points be, and how would a
user bypass them?*

## 1. Process model — already hardened, for a local tool

`src/main/window.ts:32-43`:

```
contextIsolation: true
nodeIntegration: false
sandbox: true
webviewTag: true      // browser dock; guest runs out-of-process, own partition
```

That is the correct posture and it is already in place. The browser dock's guest
page never enters the trusted renderer's context (ADR 0002 / `docs/13`).

`src/preload/index.ts` exposes **one generic bridge** — `invoke` / `send` / `on`
— locked to an allowlist built from `AllChannels`:

```
const allow = new Set<string>(AllChannels)          // :9
function assertAllowed(channel) { ... }             // :10-12
contextBridge.exposeInMainWorld('bridge', { ... })  // :14
```

The renderer can never reach arbitrary IPC. This is a good design and it is the
reason a single entitlement interceptor is even possible (see `03`).

## 2. The IPC surface — 119 handlers, no main-side router

`src/contracts/ipc/channels.ts` declares **21 channel groups**: Terminal,
Clipboard, Workspace, Agent, Template, Telemetry, Control, Shell, Worktree,
Board, Remote, Profile, Ledger, Gate, Review, Fs, Git, Browser, Update, Usage,
Integrations.

`grep -c 'ipcMain.handle\|ipcMain.on' src/main/` → **119 call sites**, registered
ad hoc inside 22 per-feature `register*()` functions. There is no central router.

**But there is a choke point.** All 22 `register*()` calls run sequentially in
one function body after `whenReady`:

- `src/main/index.ts:149` — `app.whenReady().then(async () => {`
- `src/main/index.ts:201` — `registerClipboard()` ← first registration
- …21 more, contiguous

A single interceptor installed at **`index.ts:200`**, monkey-patching
`ipcMain.handle` and `ipcMain.on` before any registration runs, covers all 119
handlers at once. See `03` §3.

**Caveat that matters:** `AllChannels` is typed `readonly string[]`
(`channels.ts:262`), which widens away the literal union. Change to `as const`
+ `export type Channel = (typeof AllChannels)[number]` and the entitlement table
becomes compiler-enforced.

## 3. Feature inventory — where the value actually lives

| Layer | Dirs | Gateable? |
|---|---|---|
| `src/backend/features/` | 11 — agent-state, agents, fs-browse, git, integrations, review, templates, terminal, usage, workspace, worktrees | In main; gateable |
| `src/ui/features/` | 18 — agents, blocks, board, browser, command-blocks, git, home, layout, notify, palette, review, settings, shortcuts, terminal, updates, usage, wizard, workspace | Renderer; **unenforceable alone** |

Anything whose value is purely renderer-side is JS in an asar. Re-enabling it is
a one-line patch. This distinction is the crux of the whole pack.

## 4. Five entry points, not one

Enforcement that covers only IPC covers roughly one fifth of the surface.

1. **The main window** — `src/main/index.ts:142`, `win = createMainWindow()`.
2. **IPC** — the 119 handlers above.
3. **The PTY daemon** — a *separate detached process* that **outlives the app**
   (`src/pty-daemon/index.ts:25`, `IDLE_SHUTDOWN_MS = 30 min`). Listens on a
   named pipe (Windows) or `0600` unix socket (`lifecycle.ts:37-38`), behind a
   version + random-token handshake; unauthed sockets are destroyed after 3s
   (`transport.ts`). `DAEMON_PROTOCOL_VERSION = 3`.
4. **The browser-control endpoint** — `src/main/mcp-endpoint.ts`, a **second**
   token-authed local socket (`browser-control.json`, `:46`; `token =
   randomBytes(24)`, `:146`; `authed = msg.token === token`, `:172`).
5. **The two CLIs** — `bin/mogging.mjs` and `bin/mogging-mcp.mjs`, which are pure
   clients of (3) and (4) via `bin/lib/endpoint-client.mjs`. `mogging` can
   `spawn`, `send`, `send-key`, `capture`, `list`, `claim`, `approve` — i.e.
   drive panes, type into them, and read scrollback — **without the app ever
   authenticating anyone.**

Two further bypasses inside the app itself: `startInProc()` swaps the entire
terminal backend into the main process when the daemon fails
(`src/main/index.ts:189`), and **`MOGGING_INPROC` forces that path from an
environment variable.** Any gate on the daemon path that is absent from the
in-proc path is decorative.

## 5. Local state and secrets

`src/main/vault.ts` wraps Electron `safeStorage`. **It already does the right
thing** — it treats Linux's `basic_text` backend as *unavailable* rather than
pretending it encrypts:

```
if (!safeStorage.isEncryptionAvailable()) return false        // :15
if (process.platform === 'linux')
  return safeStorage.getSelectedStorageBackend() !== 'basic_text'   // :18
```

This is the trap most codebases fall into. Reuse this for the refresh token.

**There is no existing notion of a user, account, license, device id, plan, tier,
subscription, or activation.** Greps for `stripe|paddle|entitle|licence|jwt|
oauth|signin|deviceId|machineId|activation` return only unrelated hits
(integrations `plan.ts` is an MCP *tool plan*; usage `api-key.ts` reads the
user's own provider keys). **We are starting from zero.**

## 6. Packaging & integrity — the weak point

From `electron-builder.yml` and `docs/10-distribution.md`:

- **No Electron fuses configured anywhere.** `EnableEmbeddedAsarIntegrityValidation`
  and `OnlyLoadAppFromAsar` are off by default; `RunAsNode`,
  `EnableNodeCliInspectArguments`, `EnableNodeOptionsEnvironmentVariable` are on.
- **Nothing is signed today.** Windows + macOS config is READY, certs pending.
  macOS auto-update is **inert until signed** (Squirrel.Mac refuses unsigned).
- `asarUnpack` exposes `node-pty`, `better-sqlite3`, `bindings` on disk.
- macOS `hardenedRuntime: true`, `notarize: true` — but the entitlements grant
  **`disable-library-validation`** and **`allow-dyld-environment-variables`**,
  *specifically for the Electron-as-Node daemon* (`docs/10`). Those are precisely
  the entitlements that permit dylib injection. The daemon design has already
  spent part of the hardened-runtime budget.

## 7. The blocker at the root of §6

`src/main/daemon-client.ts:54-63`:

```ts
/** Discover a running daemon or spawn one (detached, via Electron-as-Node). */
const child = spawn(process.execPath, [daemonEntry], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },   // :63
  detached: true, ...
})
```

`RunAsNode` is the single most important anti-tamper fuse — it is what stops
anyone running your main process as a bare Node interpreter. **The current
architecture requires it to stay on.**

Two mitigating facts, both verified:

- **No production `child_process.fork()` exists** — only `spawn` and `execFile`.
  Disabling the `RunAsNode` fuse breaks exactly one thing: this daemon spawn.
- `src/main/electron-context.ts:7` already anticipates a **`utilityProcess`**
  migration. The fix is smaller than it looks.

## Top 5 enforcement points, ranked

1. `src/main/index.ts:200` — one interceptor, 119 handlers. (UX gate.)
2. `src/pty-daemon/transport.ts` — the hello handshake. Bump protocol v3 → v4.
3. `src/main/mcp-endpoint.ts` — the second socket, same handshake shape.
4. `src/main/index.ts:142` — don't create the window without an entitlement.
5. `startInProc()` + `MOGGING_INPROC` — close both, or 1–4 are theatre.

## Top 5 bypasses, ranked by ease

1. **`bin/mogging.mjs`** — drives panes over the daemon socket. No app, no auth.
2. **Patch the asar.** `npx asar extract`, flip the boolean, repack. No fuses, no
   signature, no integrity hash to recompute. Minutes.
3. **`ELECTRON_RUN_AS_NODE=1`** on the shipped binary — full Node introspection
   of the main process, because the fuse cannot currently be disabled.
4. **`MOGGING_INPROC=1`** — swap the backend out from under any daemon-side gate.
5. **DevTools / `--inspect`** — `EnableNodeCliInspectArguments` is on by default.
