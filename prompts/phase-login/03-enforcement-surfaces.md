# 03 — Enforcement surfaces: the concrete gates

Everything here is a *client-side* gate, i.e. a UX and licensing boundary that
stops every real user and no determined attacker. Read `02` first so this is not
mistaken for a security architecture. The security architecture is `04` §5 and
`05` §3 — the empty room.

## 1. The five buckets

Before writing any gate, sort every piece of "our functionality" into these.
The sorting **is** the exercise; it tells you how much of the product is
defensible.

| Bucket | Examples in this repo | Can it be withheld? |
|---|---|---|
| **Rendering / chrome** | panes, xterm canvas, window, CSS, interaction | ❌ Ships in the binary. Permanently crackable. Accept it. |
| **Curated content** | `contracts/integrations/presets.ts`, `mcp-catalog.json`, provider-mix templates, layout presets, keyboard maps, wizard flows, **`MODEL_PRICES` in `usage/cost.ts`** | ✅ Serve per-account, signed. Don't ship it. |
| **User state** | workspaces (`app-settings.ts`), board, profiles, ownership ledger (`pty-daemon/ledger.ts`), usage history (`usage/history.ts`) | ✅ Canonical server-side, cached locally. |
| **Decision logic** | `templates/resolveLayout`, swarm role manifest, `usage/thresholds.ts` (`suggestFailover`, `evaluateThresholds`), `usage/pace.ts` (`computePace`), MCP tool-plan resolver | ✅ Low-frequency → API calls. Value ∝ reimplementation cost. |
| **PTY / source / keys** | `node-pty`, the user's repo, provider API keys, scrollback | ❌ Must stay local forever. This is also the marketing. |

A crack then yields buckets 1 + 5: **a bare terminal multiplexer with no
organization, no presets, no history, no plans.** Which is exactly what the free
tier should be. *The empty room and the free tier are the same room.*

**The catch:** buckets 2–4 must be cached locally or the app feels slow — the
very sluggishness we attack BridgeSpace for. So sync-down-and-cache, never
call-per-action. But a cache is a copy. Encrypt it with a key carried **inside
the entitlement token**, which expires.

> **The offline grace window and the anti-crack window are the same knob.**
> Set the token TTL to 7 days: a legitimate user works on a plane for a week; a
> cracked client also works for a week, then its cache stops decrypting and it
> must re-authenticate against a server that will refuse it. One number, tuned
> once, governs both.

**And the real defense is freshness.** An attacker who authenticates once as a
paying customer can dump the decrypted content from memory and keep that snapshot
forever. There is no fixing that. Make the snapshot **rot**: model prices change,
CLI flags change, presets improve, the catalog grows. A pirate gets the version
they stole, decaying weekly, with cost figures quietly drifting wrong. This is
how Sublime survives on an honor system and why Obsidian Sync has never been
cracked — there is nothing static to take.

## 2. The entitlement table — make "gate everything" a compile error

`src/contracts/ipc/channels.ts` already declares itself the single shared touch
point: *"adding a feature = add its channel map here and spread it into
AllChannels."* Exploit that.

Two changes:

```ts
// channels.ts:262 — was: export const AllChannels: readonly string[] = [...]
export const AllChannels = [...] as const
export type Channel = (typeof AllChannels)[number]
```

```ts
// src/contracts/ipc/entitlements.ts (new)
export type Tier = 'free' | 'pro' | 'team'

export const CHANNEL_TIER = {
  'terminal:spawn': 'free',
  'workspace:loadState': 'free',
  'usage:history': 'pro',
  'ledger:claim': 'team',
  // …all 119
} satisfies Record<Channel, Tier>
```

That `satisfies` is the whole trick. **Add a channel without classifying it and
the build fails.** With 119 handlers across 21 channel groups, this is the
difference between a gate and a sieve — "did we gate every feature?" stops being
a review question someone eventually forgets and becomes a type error.

**Do this first.** One day, breaks nothing, and classifying all 119 handlers
forces the tier decision (see `05` §2) as a byproduct.

## 3. The five gates

### Gate 1 — the window
`src/main/index.ts:142` (`win = createMainWindow()`). Boot into an auth window
when there is no valid entitlement token.

### Gate 2 — IPC (one interceptor, 119 handlers)
All 22 `register*()` calls run contiguously after `whenReady`, starting at
`src/main/index.ts:201`. Install the interceptor at **`:200`**, monkey-patching
`ipcMain.handle` / `ipcMain.on` before any registration. No handler needs to know
it is gated.

Denials return a typed `{ ok: false, reason: 'entitlement', feature }` so the UI
renders an upsell rather than a crash.

### Gate 3 — the PTY daemon
`src/pty-daemon/transport.ts`'s `hello` frame currently carries only a local
random token. It must **also verify the entitlement token** against an embedded
public key. This bumps `DAEMON_PROTOCOL_VERSION` **3 → 4** (`contracts/daemon/protocol.ts`,
and the mirrored constant in `bin/mogging.mjs`).

Remember the daemon **outlives the app by 30 minutes**
(`pty-daemon/index.ts:25`, `IDLE_SHUTDOWN_MS`). A revoked lease must reach a
running daemon, not just a running window.

### Gate 4 — the browser-control endpoint
`src/main/mcp-endpoint.ts` is a second token-authed socket with the identical
handshake shape (`:46` endpoint file, `:146` token, `:172` compare). Same treatment.

### Gate 5 — the CLIs
`bin/mogging.mjs` and `bin/mogging-mcp.mjs` speak Gates 3 and 4 directly and can
`spawn`, `send`, `send-key`, `capture`, `claim`, `approve` — full pane control,
no app, no auth.

**They need no auth logic of their own.** The daemon is only ever spawned by the
app (`src/main/daemon-client.ts:54`, `ensureDaemon`). So have the app mint a
short-lived, **plan-scoped capability token** into the `0600` endpoint file at
startup. No authenticated app → no endpoint file → no CLI. Zero new crypto in
`bin/`.

### And close the two backdoors
- `startInProc()` (`src/main/index.ts:189`) swaps the whole terminal backend into
  the main process when the daemon fails. It must enforce the same gate as the
  daemon path.
- **`MOGGING_INPROC`** forces that path from an env var. It must not be settable
  in a production build.

Any gate on the daemon that is absent from the in-proc path is decorative.

## 4. Client hardening (last, and cheap)

In this order, because each unblocks the next:

1. **Migrate the daemon spawn to `utilityProcess`.** `src/main/daemon-client.ts:61-63`
   spawns `process.execPath` with `ELECTRON_RUN_AS_NODE: '1'`. That is the single
   most dangerous fuse to leave on. Verified: **no production `child_process.fork()`
   exists** (only `spawn`/`execFile`), and `src/main/electron-context.ts:7` already
   anticipates this migration. Smaller than it looks.
2. **Enable the fuses.** `RunAsNode`, `EnableNodeCliInspectArguments`,
   `EnableNodeOptionsEnvironmentVariable` → **off**;
   `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` → **on**
   (together, or the `app/` fallback bypasses validation). None are configured today.
3. **Drop the two mac entitlements.** Once the daemon is no longer Electron-as-Node,
   `disable-library-validation` and `allow-dyld-environment-variables` can leave
   `build/entitlements.mac.plist` — and hardened runtime starts meaning something.
4. **Sign + notarize.** Config is READY, certs pending (`docs/10-distribution.md`).
   This does not stop the cracker; it stops the cracked copy from **spreading**,
   which is the threat that costs money. It also unlocks macOS auto-update.

## 5. Auth and token storage

- **System-browser OAuth + PKCE**, loopback `127.0.0.1:<random>` redirect
  ([RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)). **Not** a custom
  protocol scheme — any app on the machine can register `mogging://`. **Never** an
  embedded `BrowserWindow` login form.
- **Entitlement token**: Ed25519-signed JWT/PASETO — `{ sub, plan, features[],
  deviceId, iat, nbf, exp: +7d }` — verified against a public key compiled into
  the app, cached on disk, refreshed on launch and on heartbeat.
- **Refresh token** → `src/main/vault.ts`, which already correctly refuses
  Linux's fake `basic_text` backend (`:18`).
- **What `safeStorage` protects:** other users on the box, offline disk theft.
  **What it does not:** the same user with a debugger. Store tokens there for
  hygiene, never as an enforcement boundary.
- **Clock rollback** extends offline grace. Mitigate with an issued-date-not-in-future
  check and a monotonic max-seen-timestamp. Detect, don't heroically prevent.
