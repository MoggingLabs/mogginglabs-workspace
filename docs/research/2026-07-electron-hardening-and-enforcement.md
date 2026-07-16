# Electron hardening & enforcement — how far we can actually go

**Date:** 2026-07-15 · **Status:** research + implementable plan, no code changed ·
**Companion to:** `2026-07-productization-accounts-subscriptions.md` (this drills into §5–6 of that report).

**The question this answers:** *how secure can we make the app, how hard can we make it to
extract/tamper, and how strongly can we enforce accounts + payments — given Electron?*

**The one-sentence honest answer:** you can raise the bar from "any curious user with
`npx asar extract`" to "only a determined, skilled attacker who is willing to strip a signed
binary" — that is a real and worthwhile jump — but you **cannot** make a locally-running
feature unbreakable, so the maximum *enforceable* security comes from moving the things worth
paying for behind our server and **binding tokens to hardware** so a copied install is inert.
Every item below is sorted by that reality: **Tier 1** genuinely raises security, **Tier 2**
raises the cost of piracy (tamper-evidence/obfuscation), **Tier 3** is the only thing that is
actually unbeatable (server-side).

---

## 0a. "Should we leave Electron for something uncrackable?" — decision record

**Question asked:** is there a framework (Tauri, fully-native Rust/C++/Qt) that would make the
app uncrackable, and should we migrate to it?

**Answer: no — nothing that runs on the user's machine is uncrackable, in any language, and a
migration would cost us the wedge while buying almost no anti-piracy.** This is a settled
question, not a matter of effort. The evidence, current as of July 2026:

- **Denuvo** — the most sophisticated, most expensive commercial anti-tamper on earth, native
  code, kernel/hypervisor-grade obfuscation — reached **zero uncracked single-player titles for
  the first time in its 12-year history (April 2026)**, including a AAA release **cracked 40
  days after launch**. If the gold standard of anti-tamper, backed by studio money and native
  binaries, cannot stay uncracked, a desktop dev tool will not either. "Uncrackable client" is
  not a product you can buy or build.
- **And it proves the performance cost we refuse to pay:** measured cracked-vs-protected, the
  *cracked* Denuvo builds ran **~5% higher FPS and ~1GB less RAM**. Client-side anti-tamper is
  in direct tension with exactly the budgets this app is built on (145.9ms/150ms boot, 142fps,
  20MB heap — invariant I7 in the anti-piracy plan). Server-side enforcement has no such cost.

**Why the framework barely matters for crackability.** Language changes only Step 2 of the
kill-chain (*reading* the code) — the least important link. Native binaries are cracked every
day by locating the one branch instruction behind the license check and flipping it; a compiled
Rust license gate is a `jz`/`jnz` a skilled reverser finds in minutes. The links that actually
decide crackability — Step 3 (is the gate even in the client?) and Step 7 (is the value local
or server-side?) — are **framework-independent**. You do not need to leave Electron to fix
them, and leaving Electron does not fix them.

**Tauri specifically — a bad trade for THIS app** (verified July 2026):

- Tauri still **does not bundle a rendering engine**: WebView2 on Windows, WKWebView on macOS,
  WebKitGTK on Linux. That is the **exact two-engine divergence ADR 0001 rejected** — and it is
  the root cause of BridgeSpace's multi-month terminal-freeze/render bug history, which is our
  headline competitive wedge (docs/00:30-34). Migrating to Tauri would *reintroduce the
  competitor's core weakness into our own product.*
- The Servo/Verso "evergreen bundled webview" that would close this gap is **still experimental,
  not production**, as of mid-2026.
- The anti-piracy gain is marginal anyway: a Tauri app's **frontend is still HTML/JS in a
  WebView** (readable), and its Rust backend is a native binary that is still patchable. You'd
  trade the wedge for a Step-2 speed bump you can get on Electron with V8 bytecode.

**Fully native (Rust/C++/Qt) — worst trade for this app.** Hardest to *read*, yes — but: (a)
still crackable (see Denuvo); (b) a **total rewrite** that throws away the xterm.js + node-pty +
WebGL terminal stack (VS Code's exact stack) that gives us tuned-once-identical-everywhere
rendering; (c) reopens every cross-platform-parity problem ADR 0001 closed; and (d) **still
needs the same server-side enforcement and hardware binding to actually stop piracy.** You'd
spend a year rewriting to arrive at "still crackable, now also worse at the thing we're best
at."

**What actually gives you the "uncrackable" property — and it's framework-independent:**

1. **Server-authoritative paid value** — the feature can't run without our server, so there's
   nothing on the client to patch (anti-piracy plan §3; the Cursor/Windsurf lesson).
2. **Hardware-bound tokens (TPM/Secure Enclave + DPoP)** — a copied install is inert because the
   device key can't leave the machine (§1.3/1.4).

Both work **on Electron, today**, with no migration. They deliver essentially all of the
realistic anti-piracy benefit a native rewrite could, without sacrificing the rendering
fidelity, the stack, or the performance budgets.

**Decision: stay on Electron.** Invest the anti-piracy budget in the two framework-independent
levers above (which are already the center of the plan) and the cheap client speed-bumps (fuses,
bytecode, signing). Revisit *only* if a future paid feature is a hard-real-time or
kernel-level capability Electron genuinely can't host — which none of the roadmap is. Capture
this in **ADR 0016/0016** so the question isn't relitigated every quarter.

---

## 0. The finding that reframes everything: `ELECTRON_RUN_AS_NODE` is load-bearing here

The highest-value Electron hardening lever in 2026 is **disabling the `runAsNode` fuse**. It
closes the CVE-2024-23738 family: with `runAsNode` enabled (the default), *any* local process
can relaunch our **signed** binary as a generic Node interpreter
(`ELECTRON_RUN_AS_NODE=1 /path/to/MoggingLabs "evil.js"`), inheriting our code-signing
identity and — critically on macOS — our **Keychain/TCC entitlements**, then call
`safeStorage.decryptString` on our own vault. The signature stays valid because only the main
executable is checked, not the script it runs. This is *the* documented way Electron apps get
their stored secrets stolen.

**We cannot disable it as the app is built today.** `ELECTRON_RUN_AS_NODE=1` is not incidental
— it is the runtime for three separate subsystems:

| Uses Electron-as-Node | Where | Why it's load-bearing |
|---|---|---|
| The **detached PTY daemon** | `src/main/daemon-client.ts:233-234` (`spawn(process.execPath, [daemonEntry], { env: { ELECTRON_RUN_AS_NODE: '1' }})`) | Must **outlive the app** (ADR 0006) — so it can't be a `UtilityProcess` (those die with the parent). It needs node-pty (native addon). |
| The **house MCP server** | `src/main/mcp-manager.ts:78` | Spawned as a stdio child by CLIs; runs our binary as Node. |
| Every **`mogging` / `mogging-connection` pane shim** | `src/main/cli-runtime.ts:63,67` (`set "ELECTRON_RUN_AS_NODE=1"` / `ELECTRON_RUN_AS_NODE=1 exec …`) | Written to disk, put on the pane's PATH, invoked by agents and CLI config files. This is how the whole control API reaches the daemon without a system Node install. |

Flip the fuse naively and the daemon never starts, the built-in MCP server dies, and every
scripted `mogging …` verb breaks. The mac entitlement `allow-dyld-environment-variables` and
`build/installer.nsh:57` both exist *specifically* to serve this design.

**So the plan has to earn the fuse, not just flip it.** Three routes, in increasing order of
effort and payoff (this is the central architectural decision of the whole hardening effort):

- **Route A — accept it, contain it (ship this first).** Keep `runAsNode` on; make theft
  worth less. Bind secrets to hardware (Tier 1.4) so a `safeStorage` decrypt yields a
  *device-locked* refresh token that is useless off-box; keep access tokens short-lived; make
  revocation server-side. The attack still exists but the loot is inert. **Zero architecture
  change; ~1 week.**
- **Route B — split the runtime (the real fix).** Ship a **separate, minimal Node/helper
  binary** (a `@yao-pkg/pkg` or Node SEA build, or a tiny purpose-built native host) that runs
  the daemon + MCP + shims, and disable `runAsNode` on the **Electron** binary. Now the
  signed *app* can't be used as a Node interpreter; the helper is a much smaller, non-GUI,
  no-Keychain-entitlement target. node-pty (native `.node`) must be rebuilt/bundled into that
  helper — non-trivial but well-trodden (SEA supports native addons as of Node 24; yao-pkg
  handles node-pty). **~3–5 weeks; this is the item that actually removes the limitation.**
- **Route C — daemon as its own signed service.** Fullest separation: the daemon is an
  independently code-signed sidecar with its own hardened runtime and no ambient
  entitlements. Overkill pre-revenue; note it and move on.

**Recommendation:** ship **Route A** for launch (contain the blast radius), schedule **Route
B** as the first post-launch hardening epic. Track it as **ADR 0017 — splitting the Node
runtime to disable `runAsNode`**, because it touches ADR 0006 (detached daemon) and needs to
be reasoned about in one place.

---

## Tier 1 — Real security wins (do these; they change the threat model)

### 1.1 Flip the safe Electron fuses now

None are flipped today (no `@electron/fuses` dependency, no `afterPack` hook — verified). Add
`@electron/fuses` + an `afterPack` in `electron-builder.yml` and set:

| Fuse | Set to | Effect | Caveat for us |
|---|---|---|---|
| `EnableEmbeddedAsarIntegrityValidation` | **on** | app.asar contents checked against a build-time header hash on Win+macOS — tamper-**evident** | pairs with the next; needs the electron-builder integrity block |
| `OnlyLoadAppFromAsar` | **on** | refuses to load app code from `app/` or `default_app.asar` search paths — no side-loading unvalidated code | none |
| `EnableCookieEncryption` | **on** | encrypts the cookie store at rest (OS crypto) | one-way; harmless for us |
| `EnableNodeOptionsEnvironmentVariable` | **off** | kills `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS` injection vector | **verify** no build/test path relies on `NODE_OPTIONS` first |
| `EnableNodeCliInspectArguments` | **off** | blocks `--inspect`/`--inspect-brk` debugger attach on the packaged app (the Signal-style attack) | dev builds unaffected — only flip on packaged |
| `RunAsNode` | **off** ← *only after Route B* | closes the keychain-theft vector in §0 | **blocked today** (§0); this is the prize Route B unlocks |

`embeddedAsarIntegrityValidation` had a bypass in Electron ≤22 via a file-type confusion in
`.app/Contents/Resources`; we ship Electron 39, well past it. Validate the shipped result in
CI: `npx @electron/fuses read --app <path>` → assert the expected fuse wall, and add it as a
static gate (`FUSES`) in the same family as `PRODARTIFACT`/`NPMCONFIG` so a regression fails
the release rather than shipping soft.

**Effort:** ~1 day for the four safe ones + the gate. **Payoff:** high, immediate, no
architecture change.

### 1.2 ASAR integrity end-to-end (not just the fuse)

The fuse checks the hash; electron-builder must *embed* the hash. Turn on the
`asarIntegrity`/`onlyLoadAppFromAsar` path in the builder config so packaging computes and
signs the header. Note the interaction with our `asarUnpack` list
(`node-pty`, `better-sqlite3`, `bin/**` — electron-builder.yml:28-32): **unpacked files sit
outside app.asar and are NOT covered by asar integrity.** That is precisely our native modules
and the `bin/` shims — the highest-value tamper targets. They are protected instead by the
**code signature of the whole app bundle**, which is why signing (§1.5) and Route B (moving the
shims into a signed helper) matter more here than the asar hash. Say this out loud in the ADR;
don't let "ASAR integrity: on" imply the shims are covered — they aren't.

### 1.3 Sender-constrained tokens (DPoP, RFC 9449) — the answer to token theft

This is the highest-leverage *enforcement* upgrade and it sidesteps `safeStorage`'s weakness
entirely. Instead of a bearer refresh token (steal the string → use it anywhere), bind every
token to a key pair the client proves possession of on each request (a signed DPoP proof JWT).
A refresh/access token lifted from our vault by the §0 attack is then **inert without the
private key**. Combined with 1.4 (hardware-held key), the private key can't be exfiltrated at
all, so a copied install cannot mint proofs off-box.

- Our IdP must support it: **Auth0 supports DPoP today**; check the chosen provider (Clerk/
  Supabase) for RFC 9449 support and make it a selection criterion in the main report's §3.1.
- Implementation lands in the new `src/main/account.ts` — the same module that already will
  do PKCE (lifted from `connections.ts`). DPoP is ~an afternoon on top of a working PKCE flow.

### 1.4 Hardware-backed device key — make a copied install worthless

The durable fix for "user copies the app + its vault to another machine and it just works" is
to **bind the account to a non-exportable device key**:

- **Windows:** a key in the **TPM** via CNG/Platform Crypto Provider (Microsoft Platform Crypto
  Provider), or DPAPI-NG. Non-exportable; sign challenges with it.
- **macOS:** a key in the **Secure Enclave** (`kSecAttrTokenIDSecureEnclave`) — non-exportable
  by construction.
- **Linux:** TPM 2.0 where present; else fall back to a `safeStorage`-wrapped key and accept
  the weaker guarantee (document it — same honesty as the vault already shows for `basic_text`).

Use this key as the DPoP key (1.3) and/or to sign the device attestation the entitlement
server checks at issuance. Result: the entitlement JWT is **sender-constrained to this
physical machine**; copying the install to a second machine fails the device check and gets no
fresh entitlement — the offline-grace cache expires and it degrades to Free. This is the single
most effective anti-piracy mechanism available to a desktop app, because it doesn't rely on
hiding anything in the (readable) bundle.

- **Cost:** needs a small **native Node addon** (or a vetted npm binding) per-OS for
  TPM/Enclave access — this is the one genuinely new native component. Node's native-addon
  build chain is already a first-class citizen in this repo (node-pty, better-sqlite3 from
  source, README:120-160), so the toolchain exists.
- **Effort:** ~2–3 weeks incl. per-OS testing. **Payoff:** this is what "enforce accounts to
  the fullest extent" actually means in practice.

### 1.5 Code signing — the floor under all of the above (already config-READY)

Nothing above matters if the binary isn't signed: integrity fuses assume a trusted signature,
and an unsigned app can be re-signed by anyone. The config is dry-run-READY (docs/10:17-23);
this is a purchase + CI secrets:
- **Windows:** Azure Trusted Signing (~$10/mo) — cloud signing, reputation accrues to a durable
  identity, best SmartScreen story (docs/10:26-37).
- **macOS:** Apple Developer Program ($99/yr) → Developer ID + notarization; also unlocks
  macOS auto-update.
Add a CI gate that **fails the release if artifacts are unsigned** — no accidental unsigned
ship once customers exist.

### 1.6 Renderer network lockdown

Enforce a strict `Content-Security-Policy` on the local renderer (`default-src 'self'`,
`connect-src 'none'` — all network lives in main), and add a `will-navigate` /
`setWindowOpenHandler` deny-list so the trusted renderer can never be navigated to a remote
origin (the webview browser dock is already out-of-process and isolated, window.ts:50-56). This
shrinks the XSS→exfiltration path to nothing and is ~an hour.

---

## Tier 2 — Raise the cost of extraction (tamper-*evidence* and friction, not a wall)

Be clear-eyed: these deter casual copying and make forks obviously-modified; they do **not**
stop a determined attacker. They are worth doing *because* they're cheap, not because they're
strong.

### 2.1 V8 bytecode compilation for the main process (electron-vite `bytecodePlugin`)

Compiles our JS to V8 bytecode so the shipped files aren't human-readable source. Real caveats,
some specific to us:

- **Strings survive in the clear** — tokens, URLs, the entitlement public key, feature flags
  remain greppable. So bytecode hides *logic*, not *secrets*. Pair with the plugin's
  string-obfuscation transform for the sensitive constants (still not "secure", just harder).
- **Preload conflict (specific to this app):** bytecode for preload requires `sandbox: false`,
  but we ship `sandbox: true` (window.ts:49) — a genuine hardening win we must **not** trade
  away. **Conclusion: apply bytecode to the main process only; leave the preload as sandboxed
  source.** The preload is 44 lines of allowlist glue (src/preload/index.ts) with nothing worth
  hiding, so this costs us nothing.
- **Architecture-bound:** bytecode is tied to the exact V8/Electron version + CPU arch, so each
  platform/arch artifact compiles its own — fits our per-arch build matrix but adds build
  steps.
- **Put the entitlement/account logic behind it** as the highest-value module to compile.

**Effort:** ~2–3 days incl. cross-arch build validation. **Payoff:** medium deterrent; do it,
but don't oversell it internally.

### 2.2 Keep the smoke harness and gate triggers out of production (already done — keep it)

`PRODARTIFACT` already strips the ~100-module smoke harness and every `MOGGING_<GATE>` env
trigger from the shipped graph (electron.vite.config.ts:41-56, AUDIT report §41). This matters
for *this* effort too: those triggers were env-driven behavior switches — exactly the surface
an attacker probes. The gate already fails the build if one returns. **Extend the same
discipline:** the entitlement bypass in §3 (`MOGGING_REGISTRY_BASE`) is the same class and must
join the banned list.

### 2.3 Runtime self-check (belt, not armor)

On boot, optionally verify the app's own signature (`app.isPackaged` + OS APIs) and the
integrity of the unpacked `bin/` shims against a signed manifest, refusing to run vaulted-token
operations if tampered. A patched fork can strip this check too — so it's tamper-*evidence* for
telemetry ("N% of launches are modified builds") more than prevention. Low priority.

### 2.4 What NOT to bother with

- **Full JS obfuscation of the whole app** — big perf/debuggability cost, defeated by
  deobfuscators, and irrelevant once the code is bytecode + the secrets are server-side. Skip.
- **Private/gated auto-update feed** — punishes lapsed-but-honest users into stale, insecure
  builds and is trivially bypassed. **Gate features, not updates** (industry standard). Keep the
  feed public.
- **DRM/anti-debug packers** — flagged by AV/SmartScreen, hurt the signing reputation you're
  paying to build. Actively counterproductive.

---

## Tier 3 — The only thing that is actually unbeatable: server-side enforcement

A locally-running feature is honor-system, full stop — `asar extract`, patch the
`entitlements.allows()` call to `return true`, repackage. Fuses and bytecode make that *harder
and evident*; they don't make it *impossible*. The only enforcement a pirate cannot remove is
one where **the feature literally cannot run without our server**:

- **Design the paid moat to be server-backed.** The main report's **Team tier** (shared
  workspace/policy sync, roster/roles, centralized MCP tool plans, SSO) is the first feature
  where the value lives on our infra — so gating it is real, not cosmetic. Steer the roadmap so
  the most valuable Pro capabilities have a server dependency (even a thin one: a policy the app
  fetches and can't fabricate, a sync the app can't fake).
- **Short entitlement TTL + hardware-bound refresh (Tier 1.3/1.4)** means even the *local*
  gates get real teeth: a cracked local build can flip a boolean, but it can't obtain a valid,
  device-bound, non-expired entitlement without passing our server's device + subscription
  check. Revocation latency = the TTL you choose (24–72h typical).
- **Meter server-side.** Anything usage-limited that touches our infra is counted on our infra;
  local-only usage limits are soft by definition — price around that (limit *scale/glue*, not
  the local core; main report §8).

**The mental model to adopt:** client hardening (Tiers 1–2) protects *the user's secrets and
our reputation* and stops casual piracy; **server-side design protects revenue.** Spend the
big architecture budget (Route B, hardware keys, Team-tier server features) on the second.

---

## 3. Must-fix before any of this ships: `MOGGING_REGISTRY_BASE`

Open audit item (AUDIT_REMEDIATION_REPORT §"Open", `backend/features/integrations/catalog.ts:145`):
an environment variable can repoint where a **shipped** build fetches its catalog. Harmless for
a catalog; **fatal** the moment an entitlement or IdP endpoint exists — the same one-line
pattern becomes `MOGGING_ENTITLE_BASE=https://attacker/always-pro`, i.e. a licensing bypass
*and* a phishing/MITM vector against the account flow. Close it the way the report recommends
(remove the env override; pin the entitlement + IdP + update origins as in-code constants), and
add them to the banned-trigger allowlist `PRODARTIFACT` already enforces. This is a
prerequisite, not a nice-to-have.

---

## 4. Prioritized implementation checklist

| # | Item | Tier | Effort | Blocks revenue? | Arch change |
|---|---|---|---|---|---|
| 1 | Close `MOGGING_REGISTRY_BASE` + pin entitlement/IdP/update origins | — | 1 d | **yes** | no |
| 2 | Buy certs, flip signing CI secrets, add "fail-if-unsigned" gate | 1.5 | 2–3 d | **yes** | no |
| 3 | Flip 4 safe fuses (asar integrity ×2, cookie enc, nodeOptions off, cliInspect off) + `FUSES` CI gate | 1.1/1.2 | 1–2 d | no | no |
| 4 | Renderer CSP + navigation deny-list | 1.6 | ~1 d | no | no |
| 5 | Account flow with **PKCE + DPoP** sender-constrained tokens | 1.3 | 3–5 d (on top of PKCE reuse) | for paid | no |
| 6 | V8 bytecode for **main only** (preload stays sandboxed source) + string-obfuscate secrets/entitlement module | 2.1 | 2–3 d | no | no |
| 7 | **Hardware-backed device key** (TPM/Secure Enclave native addon) binding the entitlement to the machine | 1.4 | 2–3 wk | for strong enforcement | new native addon |
| 8 | **Route B: split the Node runtime**, then disable `runAsNode` fuse + re-run FUSES gate | 0/1.1 | 3–5 wk | no | **yes (ADR 0017)** |
| 9 | Ensure the flagship paid features are **server-backed** (Team tier) | 3 | roadmap | — | server |

**Sequencing:** 1–4 are the pre-revenue hardening floor (do first, ~1 week total). 5 lands with
the account work in the main report's Phase B. 6 is a cheap deterrent bundled into Phase C. 7
and 8 are the two post-launch epics that actually *remove* Electron limitations rather than
paper over them — 7 makes copies inert, 8 closes the keychain-theft vector. 9 is the strategic
throughline: it's what makes gating real.

---

## 5. Bottom line for the founder

- **You can get genuinely hard-to-abuse**, not just hard-to-read: signed builds + integrity
  fuses + DPoP + a hardware-bound device key means a lifted vault is inert, a copied install
  won't re-license, and a debugger won't attach to production. That is a serious posture — as
  good as a mainstream Electron app (1Password-class apps live in exactly this envelope).
- **You cannot make a local feature unpirateable**, and chasing that wastes budget. Anyone
  selling you "uncrackable Electron" is selling a packer that will hurt your signing reputation.
- **The real enforcement lever is architectural**, and it's two decisions: (a) **split the Node
  runtime** so the signed app can't be used as a Node interpreter (Route B → `runAsNode` off),
  and (b) **make the money-features server-backed** so gating them isn't a client-side boolean.
  Both are on the roadmap above; both are the difference between "honor system with speed bumps"
  and "actually enforced."

---

## 6. Sources

Codebase: `src/main/{window,daemon-client,mcp-manager,cli-runtime,vault}.ts`,
`electron.vite.config.ts`, `electron-builder.yml`, `build/installer.nsh`,
`AUDIT_REMEDIATION_REPORT_2026-07-13.md`, docs/06, docs/10, ADR 0006/0008/0014.

Web (July 2026):
- Fuses: [Electron — Fuses tutorial](https://www.electronjs.org/docs/latest/tutorial/fuses) · [HackTricks — macOS Electron injection & RunAsNode CVE-2024-23738 family](https://book.hacktricks.xyz/macos-hardening/macos-security-and-privilege-escalation/macos-proces-abuse/macos-electron-applications-injection) · [deepstrike — pentesting Electron apps](https://deepstrike.io/blog/penetration-testing-of-electron-based-applications)
- ASAR integrity: [Electron — ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) · [electron-vite — source code protection](https://electron-vite.org/guide/source-code-protection)
- safeStorage weakness: [Electron — safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) · [electron#42318 — safeStorage limitations](https://github.com/electron/electron/issues/42318) · [Stealing macOS Keychain entries](https://wojciechregula.blog/post/stealing-macos-apps-keychain-entries/)
- Bytecode: [electron-vite bytecodePlugin](https://electron-vite.org/guide/source-code-protection) · [vite-plugin-v8-bytecode](https://github.com/biw/vite-plugin-v8-bytecode)
- Runtime split options: [Node.js — Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) · [Joyee Cheung — improving SEA builds (2026)](https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/) · [yao-pkg/pkg](https://github.com/yao-pkg/pkg)
- Sender-constrained tokens: [RFC 9449 (DPoP)](https://www.rfc-editor.org/info/rfc9449/) · [WorkOS — DPoP explained](https://workos.com/blog/dpop-rfc-9449-explained) · [Auth0 — DPoP docs](https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop)
