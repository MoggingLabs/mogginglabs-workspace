# Anti-crack implementation report — the full build spec

**Date:** 2026-07-15 · **Status:** implementation spec, no code changed yet ·
**Decision context:** we are **staying on Electron** (rationale: hardening doc §0a). This is the
consolidated, concrete list of everything to **implement or change** to make cracking as hard as
realistically possible.

**Companions:** [accounts/business plan](2026-07-productization-accounts-subscriptions.md) ·
[hardening deep-dive](2026-07-electron-hardening-and-enforcement.md) ·
[anti-piracy strategy](2026-07-anti-piracy-plan.md). This report is the *execution* view of
those three.

---

## 1. What "hardest possible" means, and the ground rules

We cannot make the client uncrackable (no one can — hardening §0a). We **can** make a cracked
copy **inert, traceable, evident, and stale**, and make the paid value **impossible to fake
offline**. This report delivers that as concrete work items.

Two ground rules gate every item (from anti-piracy plan §1):

- **No feature loss.** The detached daemon, the scriptable `mogging` CLI, offline/local-first
  operation, cross-platform parity, and the never-touch-provider-auth boundary are untouchable.
- **No perf regression.** Boot passed at **145.9ms / 150ms** — ~4ms headroom. **Every** runtime
  anti-crack check runs *after first paint, async, cached*. Nothing new goes on the boot
  critical path or the render loop.

---

## 2. Current-state audit (verified in code today)

| Area | Current state | File | Verdict |
|---|---|---|---|
| Renderer isolation | `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false` | window.ts:45-57 | ✅ keep |
| Preload | generic bridge, allowlisted to typed contracts | preload/index.ts:8-24 | ✅ keep |
| Renderer CSP | present: `default-src 'self'; …; script-src 'self'` | renderer/index.html:6-8 | ⚠️ tighten (§4.6) |
| Main-window navigation guard | **none** — guards exist only on the browser-dock guest | window.ts (absent); browser-dock.ts:178,187 | ❌ add (§4.6) |
| Electron fuses | **none flipped** (no `@electron/fuses`, no `electronFuses` config) | package.json, electron-builder.yml | ❌ add (§4.1) |
| ASAR integrity | **off** (no fuse, no integrity header) | electron-builder.yml | ❌ add (§4.1) |
| Code signing | config-READY, **certs pending** | electron-builder.yml:41-69, docs/10 | ❌ buy + wire (§4.2) |
| Secret custody | safeStorage ciphertext, refuse-on-unavailable, no IPC getter | vault.ts:13-79 | ✅ keep; extend to tokens |
| Token binding | none yet (no account system) | — | ❌ build hardware-bound (§4.4) |
| Bytecode / source protection | none | electron.vite.config.ts | ❌ add main-only (§4.5) |
| `runAsNode` | **enabled & load-bearing** (daemon+MCP+CLI shims) | daemon-client.ts:234, mcp-manager.ts:78, cli-runtime.ts:63-67 | ❌ split then disable (§4.7) |
| Integrity self-check | **none** | grep: absent | ➕ optional (§4.8) |
| Leak attribution | none | — | ➕ add watermark (§4.9) |
| Entitlement bypass surface | `MOGGING_REGISTRY_BASE` env repoints shipped catalog | catalog.ts:145 | ❌ close (§3) |
| Prod artifact hygiene | harness + gate triggers stripped, gate-enforced | electron.vite.config.ts:41-56 | ✅ keep; extend banlist |

**Reading:** the isolation/custody foundation is excellent. The gaps are all *build-pipeline and
enforcement* work, plus one architectural epic (`runAsNode`).

---

## 3. Prerequisite (must land first): close `MOGGING_REGISTRY_BASE`

Open audit item, `backend/features/integrations/catalog.ts:145`: an env var repoints where a
**shipped** build fetches its catalog. Benign for a catalog; a **licensing bypass and a MITM
door** the moment an entitlement/IdP endpoint exists (`MOGGING_ENTITLE_BASE=https://attacker/…`).

**Change:** remove the env override; make the entitlement, IdP, and update origins **in-code
constants**, not env-readable. Add all three to the banned-trigger allowlist that
`scripts/check-prod-artifact.mjs` already enforces (electron.vite.config.ts:41-56), so a
reintroduction fails the build. **~1 day. Blocks everything else.**

---

## 4. The work items

Ordered by ROI. Each item: what to change · concrete notes · what it buys · guardrails.

### 4.1 Flip Electron fuses + embed ASAR integrity — *Step 4/5, ~1–2 days*

**Add dependency:** `@electron/fuses` (dev). **Preferred wiring:** electron-builder ≥26 supports
an `electronFuses` config block that flips fuses during pack and auto-embeds the ASAR integrity
header — cleaner than a hand-rolled `afterPack`. Add to `electron-builder.yml`:

```yaml
electronFuses:
  runAsNode: false                       # ← ONLY after §4.7 split; keep true until then
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
  # loadBrowserProcessSpecificV8Snapshot: true   # optional, later
```

**Concrete notes:**
- **Ship the four safe ones now** (`enableCookieEncryption`, `enableNodeOptionsEnvironmentVariable:
  false`, `enableNodeCliInspectArguments: false`, and the two ASAR fuses). Leave `runAsNode: true`
  until §4.7 lands — flipping it early breaks the daemon/MCP/CLI.
- **Before flipping `enableNodeOptionsEnvironmentVariable: false`,** grep the build/test/daemon
  paths for `NODE_OPTIONS` reliance (none expected in production, but verify).
- **ASAR-integrity caveat (must document):** our `asarUnpack` list (node-pty, better-sqlite3,
  `bin/**` — electron-builder.yml:28-32) sits **outside** app.asar, so the integrity fuse does
  **not** cover it. Those files are covered only by the **bundle code signature** (§4.2). That's
  the highest-value tamper target (the CLI shims), so §4.2 and §4.7 matter more here than the hash.
- Electron 39 is well past the ≤22 integrity-bypass CVE.

**Buys:** tamper-evident app.asar; no `--inspect` debugger attach on the packaged app (the
Signal-style attack); no `NODE_OPTIONS` injection; encrypted cookie store.
**Guardrail:** add a **`FUSES` CI gate** — `npx @electron/fuses read --app <packaged>` asserts the
exact fuse wall; ship it in the static-gate family beside `PRODARTIFACT`/`NPMCONFIG` so a
regression fails the release. **Perf:** integrity check is one-time at load, off the hot path (I7 ✅).

### 4.2 Code signing + fail-if-unsigned gate — *the floor, ~2–3 days + $*

Nothing above holds without a trusted signature (integrity assumes it; an unsigned app is
re-signable by anyone). Config is dry-run-READY (docs/10:17-23).

- **Windows:** Azure Trusted Signing (~$10/mo) — cloud signing, best SmartScreen reputation
  (docs/10:26-37). Switch electron-builder to `win.azureSignOptions` (small config change) or keep
  the wired `CSC_LINK`/`CSC_KEY_PASSWORD` path.
- **macOS:** Apple Developer Program ($99/yr) → Developer ID + notarization (already wired,
  electron-builder.yml:50-69); also unlocks macOS auto-update.
- **Change:** add the CI secrets; add a release-gate step that **fails if any artifact is
  unsigned/un-notarized** (extend the existing `signing-dryrun` / feed-verify discipline in
  `.github/workflows/release.yml`).

**Buys:** a repackaged crack **loses your identity** → Gatekeeper hard-refuses, SmartScreen warns,
auto-update replaces tampered-but-still-yours installs. This is the single highest-leverage dollar
spend.

### 4.3 Account flow with sender-constrained tokens (PKCE + DPoP) — *Step 4/7, +3–5 days on the account work*

Build the account system (accounts plan §4) with **DPoP (RFC 9449)** from day one so tokens are
**sender-constrained**: bound to a key pair the client proves possession of on every request.

- **New module `src/main/account.ts`:** PKCE login via `shell.openExternal` + ephemeral
  `127.0.0.1` loopback (lift the machinery from `connections.ts`), refresh serialized via the same
  promise-map pattern (ADR 0014:100-109). Access token in memory only; refresh token as vault
  ciphertext.
- **DPoP:** every token request and entitlement call carries a signed DPoP proof JWT. A refresh
  token lifted from the vault is then **inert without the private key**.
- **IdP requirement:** pick an IdP that supports DPoP (Auth0 does today; confirm for Clerk/
  Supabase). Make RFC 9449 support a selection criterion.

**Buys:** a stolen vault token can't be replayed off-device. Sets up §4.4 (bind the DPoP key to
hardware). **Guardrail:** login/refresh are async and user-initiated — never on the boot path (I7 ✅).

### 4.4 Hardware-bound device key — the inert-copy layer — *Step 7, ~2–3 weeks · HIGHEST anti-piracy ROI*

Bind the account/entitlement to a **non-exportable device key** and use it as the DPoP key (§4.3).

- **New native addon** (or vetted npm binding) `src/backend/platform/device-key/`:
  - **Windows:** TPM via CNG **Platform Crypto Provider** (or DPAPI-NG) — non-exportable.
  - **macOS:** **Secure Enclave** (`kSecAttrTokenIDSecureEnclave`) — non-exportable by construction.
  - **Linux:** TPM 2.0 where present; else a `safeStorage`-wrapped key with an **honest documented
    downgrade** (same pattern the vault already ships for `basic_text`, vault.ts:13-25).
- **New module `src/main/entitlements.ts`:** fetch/cache/verify the **Ed25519-signed entitlement
  JWT** (pinned public key, in-code — not env, §3), owns the **offline-grace clock (7–30 days)**,
  exposes a typed `{plan, features, limits, graceState}` snapshot. Server sender-constrains the
  entitlement to this device key at issuance.

**Buys:** copying an installed, logged-in app to another machine yields **device-locked tokens the
copy can't use** — it can't refresh, can't re-license, and degrades to Free when grace expires.
This kills the most common real-world piracy: "copied to my other laptop" / "shared my login."
**Guardrails:** I1 (offline grace built in), I2 (free tier unaffected), I5 (per-OS + honest Linux
fallback), I7 (device-key ops async, post-boot, cached), I8 (one new native addon — justified; it
joins node-pty/better-sqlite3 in the ABI-rebuild set).

### 4.5 V8 bytecode for the main process + secret obfuscation — *Step 2, ~2–3 days*

Enable electron-vite's `bytecodePlugin` for the **main process only**.

- **Do NOT apply it to preload** — bytecode there requires `sandbox:false`, and we ship
  `sandbox:true` (window.ts:49), a hardening win we keep. The preload is 44 lines of allowlist
  glue with nothing to hide (preload/index.ts). **Main-only.**
- Turn on the plugin's **string-obfuscation** for the `account.ts`/`entitlements.ts` constants
  (the entitlement public key survives as a string otherwise — bytecode hides logic, not strings).
- Per-arch build (bytecode is bound to V8 version + CPU arch) — fits the existing matrix; add the
  build step per target.

**Buys:** the logic a cracker must patch isn't readable JS. Raises Step 2 from "open in an editor"
to "reverse V8 bytecode." **Honest limit:** friction, not a wall — that's why it's a speed bump,
not the foundation. **Perf:** ~zero runtime cost, slight startup *improvement* per plugin docs
(I7 ✅ — may even help boot).

### 4.6 Tighten the renderer network/navigation lockdown — *~1 day*

Two concrete changes:

1. **Harden the existing CSP** (renderer/index.html:6-8). Current: `default-src 'self'; style-src
   'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'`. Add explicit
   `connect-src 'none'` (all network lives in main — the renderer should reach nothing),
   `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, and a `frame-src` scoped to the
   webview partition. Also emit it as an `onHeadersReceived` response header on the main session
   (defense-in-depth over the meta tag).
2. **Add a main-window navigation guard** (currently absent — window.ts has none; guards exist
   only on the browser-dock guest, browser-dock.ts:178-187). In `window.ts`, add
   `setWindowOpenHandler(() => ({action:'deny'}))` and a `will-navigate`/`will-redirect` handler
   that denies any navigation off the local app origin, so the trusted renderer can never be
   driven to a remote page.

**Buys:** collapses the XSS→exfiltration and phishing-redirect surface to near zero. Protects the
account flow. **Guardrail:** verify the in-DOM `<webview>` browser dock (window.ts:50-56) is
unaffected — it's a separate guest with its own handlers; the deny applies to the *trusted*
renderer only.

### 4.7 Split the Node runtime, then disable `runAsNode` — *Step 4, ~3–5 weeks · ADR 0017*

The prize, and the one item that can break invariants if rushed — so it's sequenced last and
verified by existing smokes.

**Problem (hardening §0):** our signed binary can be run as a generic Node interpreter
(`ELECTRON_RUN_AS_NODE=1`), a keychain-theft vector *and* a cracker's convenience. But that flag
is the runtime for the detached daemon (daemon-client.ts:234), the house MCP server
(mcp-manager.ts:78), and every `mogging`/`mogging-connection` shim (cli-runtime.ts:63-67).

**Change (Route B):**
1. Build a **minimal standalone Node runtime** (Node SEA — native-addon support since Node 24 — or
   `@yao-pkg/pkg`; node-pty must be rebuilt/bundled into it) that runs the daemon + MCP + shims.
2. Repoint `daemon-client`, `mcp-manager.houseServerEntry`, and `cliShimSource` at that helper
   instead of `process.execPath` + `ELECTRON_RUN_AS_NODE`.
3. Flip `electronFuses.runAsNode: false` (§4.1) and re-run the **`FUSES`** gate.

**Buys:** the signed **app** can no longer be used as a Node interpreter — closes the keychain
vector and a repackaging shortcut. The helper is a smaller, GUI-less, no-Keychain-entitlement
target. **Guardrails (the whole point of sequencing it last):** land the helper *first*, flip the
fuse *second*, and gate the change on the **existing daemon-survival and control-API smokes**
(daemon-survive-smoke, control-smoke, cwd-smoke) so I1 (daemon outlives app) and I3 (CLI
scriptability) are proven intact before release. Write **ADR 0017** — it touches ADR 0006.

### 4.8 Runtime tamper self-check + piracy telemetry — *Step 6, optional, ~2–3 days*

On boot (async, post-paint — I7), verify the app's own signature and the unpacked `bin/` shims
against a signed manifest (a natural extension of `native-preflight.ts`, which already dlopens the
addons at boot). If tampered, **withhold vaulted-token/paid operations** — the free app still runs
(I2). Emit an **opt-in boolean** "modified build" telemetry signal (I6) so you can *measure*
piracy rate and feed server-side revocation.

**Buys:** attribution + a revocation trigger; a metric for how much piracy actually happens.
**Honest limit:** a patched fork can strip this too — evidence, not prevention. Low priority.

### 4.9 Forensic activation watermark — leak attribution — *Step 6, ~1 week*

Embed a **per-account fingerprint** in the entitlement/activation record (v1 — cheapest,
attributive) so a leaked license or shared build traces to the account that leaked it. Later,
extend into the binary/config carriers if leak volume justifies it.

**Buys:** turns "anonymous crack on a forum" into "leaked from account #4821" → revoke/ban.
Deters *sharing*, the main spread vector. **Guardrail:** account ID only — never a credential,
never terminal content (I4/I6 ✅); applied at activation, not runtime (I7 ✅).

### 4.10 The strategic throughline: server-authoritative paid value — *Step 3/7, roadmap*

The only *unpatchable* gate. Steer the flagship Pro/Team features to have a genuine server
dependency (shared/team state, cross-device sync, org policy, centralized MCP tool plans) so a
cracked client has nothing to fake — the Cursor/Windsurf model. Free local core stays local (I2).
This is a product-roadmap commitment, not a code change, but it's what makes gating *real*.

---

## 5. New artifacts this creates

**New source modules:**
- `src/main/account.ts` — token holder (PKCE + DPoP), vault custody
- `src/main/entitlements.ts` — signed entitlement JWT verify/cache/grace + `Entitlements` port
- `src/contracts/ipc/account.ipc.ts` — `account:status|login|logout`, `entitlements:snapshot|changed` (claims cross IPC; **tokens never do**)
- `src/backend/platform/device-key/` — per-OS hardware key native addon
- (§4.8) integrity self-check module; (§4.9) watermark issuance (mostly server-side)

**New CI gates (static-gate family):**
- `FUSES` — assert the exact fuse wall on the packaged artifact
- `SIGNED` — fail the release if any artifact is unsigned/un-notarized
- `ENTITLE` — smoke the entitlement paths: expired, offline-grace, tampered JWT, device-mismatch, downgrade-to-Free
- extend `PRODARTIFACT` banlist with the pinned entitlement/IdP/update origins (§3)

**New ADRs/docs:**
- **ADR 0016 — accounts & entitlements** (scope, custody, freemium boundary)
- **ADR 0017 — splitting the Node runtime to disable `runAsNode`** (touches ADR 0006)
- update `scripts/check-credential-wording.mjs` so retired "no account/no server" absolutes can't creep back (docs/adr/0014:166-173 precedent)
- rewrite the positioning copy (docs/00 non-goals, README tagline) to "free local core + optional Pro"

**New dependencies:** `@electron/fuses` (dev), electron-vite `bytecodePlugin` (already in
electron-vite), a DPoP/JOSE lib, the device-key native binding, plus the runtime-split helper
toolchain (Node SEA or `@yao-pkg/pkg`).

---

## 6. Sequenced plan & effort

| Phase | Items | Effort | Blocks revenue? | Arch change |
|---|---|---|---|---|
| **P0 — pre-revenue floor** | §3 close env override · §4.1 four safe fuses + `FUSES` gate · §4.2 signing + `SIGNED` gate · §4.6 CSP + nav guard | **~1 wk** + certs | **yes** (signing, env) | no |
| **P1 — accounts** | §4.3 PKCE + DPoP · `account.ts` · `account.ipc.ts` · Settings UI | 2–4 wk | for paid | no |
| **P2 — inert copies** | §4.4 hardware device key · `entitlements.ts` · `ENTITLE` gate | 2–3 wk | for strong enforcement | new native addon |
| **P3 — deterrence** | §4.5 bytecode (main-only) · §4.9 watermark · §4.8 tamper self-check | 1–2 wk | no | no |
| **P4 — server moat** | §4.10 first server-backed Pro/Team feature | roadmap | — | server |
| **P5 — runAsNode epic** | §4.7 runtime split → `runAsNode:false` · ADR 0017 · re-gate | 3–5 wk | no | **yes** |

**After P0–P2** (~5–6 weeks incl. the account system): a copied install is a device-locked shell
that degrades to Free, a casual patcher hits bytecode + signed integrity, a leaked license is
traceable, and unsigned forks are OS-rejected and auto-updated away. That already puts you **ahead
of the typical commercial Electron app**. P4 makes the paid value genuinely unpirateable; P5
closes the last ambient-code vector.

---

## 7. Definition of done (the acceptance bar)

- [ ] `MOGGING_REGISTRY_BASE` gone; entitlement/IdP/update origins are in-code constants on the `PRODARTIFACT` banlist.
- [ ] `npx @electron/fuses read` on the shipped artifact shows: cookie-encryption ON, nodeOptions OFF, cliInspect OFF, both ASAR fuses ON — enforced by the `FUSES` gate. (`runAsNode` OFF after P5.)
- [ ] Every shipped artifact is signed + (mac) notarized; `SIGNED` gate fails the release otherwise.
- [ ] Renderer CSP includes `connect-src 'none'`; main-window navigation is denied to remote origins.
- [ ] Account tokens live only as vault ciphertext / in memory; **no IPC channel returns a token** (assert as a gate).
- [ ] Refresh token + entitlement are DPoP-bound to a **non-exportable hardware key**; a copied install cannot refresh or re-license (proven by the `ENTITLE` device-mismatch smoke).
- [ ] Offline grace works: pull the network, app keeps Pro for the grace window, then degrades to Free — never bricks (I1).
- [ ] Boot budget still green: **≤150ms**, no anti-crack work on the critical path (re-run the MILESTONE gate).
- [ ] Free tier still opens with **no account, fully offline**; `mogging list/send/capture` still ungated (I2/I3).
- [ ] ADR 0016 + ADR 0017 written; positioning copy updated; credential-wording gate extended.

---

## 8. The honest ceiling, restated

This makes you as hard to crack as a mainstream commercial Electron app (1Password-class): a
lifted vault is inert, a copied install won't re-license, a debugger won't attach to production, a
patched fork is OS-rejected and self-updates away, and leaks are traceable. It does **not** make
the local client uncrackable — nothing does (hardening §0a; Denuvo fell to zero in 2026). The
uncrackable part is the **server-authoritative paid value** (§4.10), and it's the one thing on
this list that no client patch can ever defeat. Everything here is achievable **on Electron, with
zero feature loss and zero perf regression**, because the plan was built around those as hard
constraints.
