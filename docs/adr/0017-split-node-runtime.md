# ADR 0017 — Split the Node runtime to disable `runAsNode`

- **Status:** Accepted (2026-07-16). Shipped with the phase-accounts/09 runtime split.
- **Relates to:** ADR 0006 (the detached PTY daemon — its host changes, its wire protocol
  and survival guarantee do not), ADR 0016 §hardening (the fuse wall this completes),
  docs/19-accounts.md (the shipped-state doc; its fuse table now reads `runAsNode: OFF`).

## Context

Until this ADR, the signed Electron binary could be run as a **generic Node interpreter**:
`ELECTRON_RUN_AS_NODE=1 MoggingLabs-Workspace evil.js` executes arbitrary script with our
binary's identity. That is simultaneously

- a **keychain-theft vector** — on macOS, a process that *is* our signed app (same code
  signature, same entitlements, keychain ACLs that name us) running attacker script; the
  classic Electron living-off-the-land technique;
- a **cracker's lever** — a free, bundled, signed Node with which to script against the
  install, the vault, and the entitlement machinery.

We could not simply flip the `runAsNode` fuse, because the capability was **load-bearing
at exactly three sites** (the reason electron-builder.yml carried a "flipping early is a
review rejection" comment):

| Consumer | Site | Why it needed a Node |
|---|---|---|
| the detached PTY daemon | `daemon-client.ts` (spawn) | must **outlive the app** (ADR 0006), needs node-pty + better-sqlite3 |
| the house MCP server | `mcp-manager.ts` `houseServerEntry` | CLI configs name `command + args` that must run without a system Node |
| every `mogging` / `mogging-connection` shim | `cli-runtime.ts` (generators) | the whole control API, invoked from panes and CLI configs |

A `UtilityProcess` cannot host the daemon: it is a *child* of main and dies with it —
ADR 0006 rejected it for exactly this reason, and nothing about that has changed.

## Decision

Ship a **minimal standalone Node runtime** — the *helper* — and move all three consumers
onto it; then burn `runAsNode: false` into the packaged binary.

- **The helper** (`scripts/build-node-helper.mjs` → `build/node-helper/<platform>-<arch>/`,
  shipped as `resources/node-helper/`): a **pinned official Node binary**
  (`mogging-node[.exe]`, one exact version everywhere; downloaded dists are sha256-verified
  against the release's SHASUMS) plus its **own deps** carrying `node-pty` and
  `better-sqlite3` built for the *helper's* ABI — the app's copies are Electron-ABI and
  must never load under it. The build ends in a load probe: the helper binary itself must
  spawn a real pty and round-trip a real sqlite insert, or the build fails.
- **`node_deps`, not `node_modules`:** electron-builder unconditionally strips any
  `node_modules` path segment from an `extraResources` copy — the helper's natives shipped
  *empty* the first time (daemon boots, loads nothing, no terminals), and every other gate
  stayed green because dev reads `build/node-helper/` directly. So the deps ship under
  `node_deps`; the daemon reaches them by **explicit absolute path** (never the
  node_modules walk, which from the asar-unpacked `daemon.js` would hit the Electron-ABI
  copies first) plus **`NODE_PATH=<deps>`** for their flattened transitive requires
  (better-sqlite3's `bindings`). The **FUSES gate** now asserts the shipped helper carries
  a real `.node` under each package — the one gate that holds the packaged artifact, so the
  one that can catch this.
- **Why a naked pinned binary and not an SEA/pkg bundle:** the helper must execute the
  daemon entry, the protocol-versioned CLI satellites, and the stable MCP launcher scripts
  that persist in CLI config files across releases — arbitrary on-disk script paths *by
  design* (the stable-launcher architecture in `cli-runtime.ts`). An SEA whose bootstrap
  `import()`s `argv[1]` is byte-for-byte as capable as the naked binary, so the naked
  binary is the smaller, more debuggable choice. The security claim never rested on
  restricting the helper — see the residual below.
- **Host-aware native resolution** (`@backend/platform/native-require.ts`): the daemon
  spawn sets `MOGGING_HELPER_NATIVES`; under a non-Electron host the seam resolves the two
  ABI-bound natives from the helper's `node_modules`, under Electron it resolves normally.
  `process.versions.electron` guards the branch so a leaked variable can never repoint the
  app's own natives. node-pty additionally stays behind the pty-host chokepoint
  (`check-pty-seam.mjs` now treats the seam as a value-require).
- **The daemon ships as plain JS, outside the asar.** Plain node has no asar support, so
  `out/main/daemon.js` + its chunks are `asarUnpack`ed; and V8 bytecode is bound to the
  V8 that compiled it — Electron's, not the helper's — so the bytecode plugin narrows to
  `chunkAlias: ['index']`. `check-bytecode.mjs` asserts BOTH directions: index compiled,
  daemon (and everything it requires) readable.
- **The three call sites repoint:** the daemon spawns as `helper daemon.js` (no env games);
  the house MCP row becomes a **bare command** on the helper (no `env` at all — the old
  `ELECTRON_RUN_AS_NODE=1` literal exception in the registry validator's docs is history);
  the shim generators emit `"<helper>" "<script>" args` with no variable set. The daemon
  **wire protocol is untouched** (v9, PROTOVER) — this swaps the HOST, not the protocol.
- **AppImage:** the bundled helper lives under the temporary APPDIR mount, but shims and
  CLI configs must outlive the app — `node-helper.ts` copies the helper into the same
  persistent per-version runtime dir the satellites use (content-stamped, tmp+rename so a
  live old daemon's binary is never written through). This replaces the old
  `stableRuntimeExecutable` `$APPIMAGE` trick, with the same inherited-env validations.
- **The fuse flips:** `electronFuses.runAsNode: false` (electron-builder.yml), and the
  FUSES gate asserts DISABLE off the packaged artifact.

## Proven by (the gates the flip is conditioned on)

- **SURVIVE** — the ADR 0006 invariant on the NEW host: both phases now also prove the
  daemon pid's OS process image *is* the helper binary; a pane surviving on the wrong
  host fails.
- **CONTROL** — the full `mogging` control API (list/send/send-key/capture + the three
  auth refusals) through the helper, no `ELECTRON_RUN_AS_NODE` anywhere.
- **RUNTIMESPLIT** (new, `MOGGING_RUNTIMESPLIT`, verdict `out/runtimesplit-result.json`) —
  helper present, daemon image = helper, house MCP answers a real initialize under the
  helper, `mogging list` works, on-disk shims are env-free, and `runAsNode: false` is
  declared. **Release blocks unless SURVIVE + CONTROL + RUNTIMESPLIT are green**
  (release.yml runs exactly these three on every OS row before packaging).
- **FUSES** — `RunAsNode = DISABLE` read off the artifact; **BYTECODE** — the daemon-plain
  exception asserted; **PROTOVER** — v9 unchanged.

## Residual (state it, never round it up)

- **The helper is still a Node interpreter.** Anyone can run `mogging-node evil.js`. What
  changed is *whose identity* that grants: the helper is a smaller, **GUI-less,
  no-Keychain-entitlement, no-app-identity** target — running script under it gains an
  attacker nothing they don't get from any Node download. The signed, entitled Electron
  binary is what stopped being an interpreter.
- The helper and its natives sit **outside `app.asar`** like the rest of the unpacked set
  (docs/18 §honest limits): covered by the bundle **signature** (the operator's deferred
  step — on macOS it must be signed as nested code), not by the integrity fuse.
- The macOS `com.apple.security.cs.allow-dyld-environment-variables` entitlement existed
  for the Electron-as-Node daemon; the operator's signing step should now be able to drop
  it (`build/entitlements.mac.plist`, `verify-signing-readiness.mjs`) — verify on real
  signed builds, not here.
- **Costs, plainly:** ~70–110 MB installed (~25–30 MB compressed) per platform for the
  helper + its natives; a second pinned runtime to patch (bump `HELPER_NODE_VERSION` for
  Node security releases — the build probe and the three gates re-certify the bump); and
  the daemon graph is readable JS again (the bytecode friction now covers the index entry
  only — docs/18 says so).

## Consequences for ADR 0006

Everything ADR 0006 promises still holds and is still gated (SURVIVE); only its
"Architecture › Daemon runtime" bullet changes: *launch via Electron's own binary as
Node* becomes *launch via the bundled standalone helper*. The daemon still needs no
system Node, still loads node-pty (now from the helper's tree), and still survives the
app. ADR 0006 carries a pointer here rather than a rewrite — the survival design is its;
the host is ours.
