# Anti-piracy plan — maximum difficulty, zero feature loss

**Date:** 2026-07-15 · **Status:** detailed implementable plan, no code changed ·
**Companions:** [`2026-07-productization-accounts-subscriptions.md`](2026-07-productization-accounts-subscriptions.md)
(the business/accounts plan) and
[`2026-07-electron-hardening-and-enforcement.md`](2026-07-electron-hardening-and-enforcement.md)
(the security hardening). **This doc is the anti-piracy strategy specifically**, written under
one hard constraint: **nothing we add may weaken the efficiency, the functionality, or the
architecture-driven features that make this app what it is.**

---

## 0. The two goals, stated honestly

1. **Make piracy as expensive and unrewarding as possible** — raise the cost at every link of
   the pirate's chain, and make a cracked copy *inert* rather than merely "unlocked."
2. **Break nothing.** The detached daemon, the scriptable CLI, local-first/offline operation,
   cross-platform parity, the privacy guarantee, and the performance budgets are the product.
   An anti-piracy measure that damages any of them is a net loss even if it stops 100% of
   piracy — because it hands the wedge back to BridgeSpace.

The strategy that satisfies both is **not** "lock the client harder" (that fights physics and
risks goal 2). It is: **keep the free local core free** (nothing to pirate), **make the paid
value depend on our server** (nothing a client patch can fabricate), and **bind the paid
identity to hardware** (a copied install can't re-license). Client hardening (bytecode, fuses,
tamper-evidence) is the *speed-bump layer* on top — real, cheap, but never the load-bearing
wall.

---

## 1. The invariants — what anti-piracy must NEVER break

Every measure in §4 is checked against this list. These are the app's identity, sourced from
the code and ADRs:

| # | Invariant | Source | What it forbids |
|---|---|---|---|
| I1 | **The daemon outlives the app and restores sessions offline** | ADR 0006; `daemon-client.ts` | No "must be online to launch." No detonating a running daemon on a failed license check. Offline grace is mandatory, not optional. |
| I2 | **Free local core needs no account, works fully offline** | wedge pillar (b), docs/00:35-37,56 | The *free* tier must never require login, a server round-trip, or a heartbeat to function. Gating applies to *paid* features only. |
| I3 | **tmux-grade scriptable CLI + control API** | wedge pillar (d), docs/06 | No crippling the `mogging` socket or verbs for anti-piracy. `list/send/capture` stay ungated (they ARE the wedge). |
| I4 | **Never broker/touch provider auth** | ADR 0002 | Anti-piracy telemetry/watermarking must never read, embed, or transmit a provider credential or terminal content. |
| I5 | **Identical on Windows + macOS (+ Linux)** | wedge pillar (a), ADR 0001 | No OS-only enforcement that forks behavior. Every measure needs a cross-platform story (or an explicit, honest degradation — as the vault already does for Linux `basic_text`). |
| I6 | **Privacy: terminal content never leaves the machine** | ADR 0002/0005, docs/06:62-68 | Watermarks and anti-piracy signals carry IDs and booleans only — never scrollback, never file contents, never argv. |
| I7 | **Performance budgets: boot ≤150ms (at 145.9ms today), 142fps, heap 20MB** | AUDIT report §Performance; docs/05/07 | **Anti-piracy work must stay off the hot path.** No synchronous signature/integrity/network check on the boot critical path or the render loop. The budget headroom is ~4ms — a blocking check would blow it. |
| I8 | **Native-from-source ABI chain is a real recurring cost** | README:120-160 | Each new native addon must be rebuilt every Electron major. Add them only when the payoff is high (the hardware-key addon qualifies; little else does). |

**I7 is the "keep the efficiency" answer, made concrete:** the boot milestone gate passed at
**145.9ms against a 150ms bar** — ~4ms of headroom. Therefore every anti-piracy check runs
**after first paint, asynchronously, and cached** — signature self-check, integrity verify, and
entitlement refresh all happen in the background once the window is up, never before it. The
free app opens at the same speed whether or not a license is present. This is a firm
engineering rule, not a preference.

---

## 2. The piracy kill-chain — where cost is actually added

A pirate must complete every step below. We raise the price of each; the chain is only as
cheap as its most expensive *required* link, so the goal is to make at least one link
**economically or technically prohibitive** while keeping the others non-trivial.

| Step | What the pirate does | Our countermeasure | Breaks an invariant? |
|---|---|---|---|
| 1. **Acquire** | Downloads the public installer | *(none — don't fight this)* | — |
| 2. **Read** | `asar extract`; reads our JS | V8 bytecode (main), string-obfuscate secrets, fuses | No |
| 3. **Locate** | Greps for the entitlement gate | **Design so the gate isn't in the client** (server-authoritative, §3) | No |
| 4. **Patch** | Flips `allows()`→`true`, edits cached JWT | Tamper-evidence (ASAR integrity fuse), Ed25519-signed entitlement they can't forge, hardware-bound claims | No |
| 5. **Repackage** | Re-zips, re-signs | They **lose our code signature**; Gatekeeper/SmartScreen flag the fork; auto-update replaces it | No |
| 6. **Distribute** | Shares the crack / a leaked license | **Forensic build watermark** traces the leaker; server-side **revocation**; device-cap | No (I6-safe: IDs only) |
| 7. **Run** | Uses the cracked copy | **Hardware-bound tokens** → copied install is inert; **server-backed features** simply don't work | No (I1/I2 preserved: free tier still runs) |

The two links that are genuinely prohibitive — and that don't touch any invariant — are
**Step 3 (the gate isn't there to patch)** and **Step 7 (the loot is inert / the value lives
on our server)**. Everything else is friction that buys time and traces leaks. **Spend the
architecture budget on 3 and 7.**

---

## 3. The load-bearing move: server-authoritative value (Step 3 + 7)

This is the whole game, and the market proves it. **Cursor and Windsurf are Electron/VS Code
forks** — their client bundles are exactly as extractable as ours. They are not meaningfully
pirated anyway, because the thing you pay for (model inference) runs on **their** servers; a
cracked client is an empty shell that can't call the paid backend without a valid, metered
account. The client is not the moat. The server is.

Our challenge is that our value is **mostly local** (PTY terminals, git, orchestration) — which
is our privacy/cost advantage (I2, I6) and must stay that way for the free tier. So the plan is
**not** "move the local core to the cloud." It is: **make the *paid* tier's marquee features
have a genuine server dependency**, so gating them is physics, not a boolean.

Concrete features that are server-authoritative by nature (and align with the main report's
Pro/Team tiers) — none of these compromise the free local core:

- **Team/shared state** — shared workspace layouts, roster/roles, org policies, centralized MCP
  tool plans. The data lives on our server; a cracked client has nothing to sync *with*.
- **Cross-device sync** — workspace/session config that follows the user. Server-held by
  definition.
- **Server-issued, hardware-bound entitlement (below)** gates even *local* Pro features with
  real teeth, because the client cannot manufacture a valid entitlement — only replay a cached
  one until it expires (revocation latency = TTL you choose, 24–72h).
- **Hosted convenience endpoints** that are legitimately ours to run (e.g. a policy/registry
  service the app fetches and cannot fabricate) — *not* AI proxying (ADR 0002 forbids it).

Design rule going forward: **when you add a Pro feature, ask "can a patched client fake this
offline?" If yes, it's a soft gate (honor-system + speed bumps). If it needs our server, it's a
hard gate.** Steer the flagship paid features toward the second. This is the single most
important anti-piracy decision and it's a *product/roadmap* decision, not a code trick.

---

## 4. Defense-in-depth — the client-side layers (Steps 2, 4, 5, 6)

These don't stop a determined cracker (nothing local does) but they (a) stop *casual* piracy —
the 90% who won't run a debugger, (b) make cracked builds **evident and traceable**, and (c)
protect honest users' stored secrets. All are invariant-safe and mostly cheap.

### 4.1 Sender-constrained + hardware-bound entitlement (the inert-copy layer) — **highest ROI**

The core anti-piracy primitive. Detailed in the hardening doc §1.3/1.4; the anti-piracy framing:

- The account's refresh token and the entitlement JWT are **bound to a non-exportable device
  key** (Windows TPM / macOS Secure Enclave / Linux TPM-or-degraded) via **DPoP (RFC 9449)**.
- **Effect on piracy:** copying an installed, logged-in app to another machine yields a vault
  whose tokens are **useless off the original hardware** — the device key can't be exfiltrated,
  so the copy can't prove possession, can't refresh, and can't obtain a fresh entitlement. When
  the cached entitlement's offline grace expires, the copy silently degrades to Free.
- **Invariant check:** I1 ✅ (offline grace built in), I2 ✅ (free tier unaffected), I5 ⚠️
  (per-OS backends + an honest Linux fallback — same pattern the vault already ships), I7 ✅
  (device-key ops are async, post-boot, cached), I8 ⚠️ (one new native addon — justified).
- **Cost:** ~2–3 weeks (the native addon dominates). **This is what makes "copied it to my
  other laptop" and "shared my login" stop working — the most common real-world piracy.**

### 4.2 Forensic build watermarking (the leak-attribution layer)

Give each authenticated download/build a **unique, invisible per-user fingerprint** so a leaked
installer or license can be traced to the account that leaked it.

- **How:** at download/first-activation, embed a per-account identifier — distributed across
  benign carriers (a signed manifest field, ordering of non-semantic config, a watermark in the
  entitlement issuance record) so removing all copies is hard and the presence of one is enough
  to attribute. This is the software analog of per-recipient forensic watermarking used for
  media leak attribution.
- **Effect on piracy:** turns "anonymous crack shared on a forum" into "this leaked from
  account #4821" → revoke, ban, or pursue. Deters *sharing*, which is how most license abuse
  actually spreads.
- **Invariant check:** I4/I6 ✅ — the watermark is an **account ID only**, never a credential,
  never terminal content. I5 ✅ (cross-platform, it's data not OS APIs). I7 ✅ (applied at
  build/activation, not at runtime).
- **Cost:** ~1 week for a v1 (watermark the entitlement/activation record); more if embedding in
  the binary itself. Start with the activation record — cheapest, still attributive.

### 4.3 V8 bytecode + secret obfuscation (the un-readable-source layer) — Step 2

From hardening doc §2.1: compile the **main process** to V8 bytecode (not preload — it needs
`sandbox:false`, which we refuse to give up, I-safe), string-obfuscate the entitlement/account
module's constants.

- **Effect on piracy:** the logic a cracker must understand isn't sitting in readable JS. Raises
  Step 2 from "read it in a text editor" to "reverse V8 bytecode." Deters casual patching.
- **Honest limit:** strings survive; a skilled attacker with a bytecode decompiler gets through.
  It's friction, not a wall — which is exactly why it's Tier 2, not the plan's foundation.
- **Invariant check:** I7 ✅ (bytecode has ~zero runtime cost, slight startup improvement per the
  plugin docs — *helps* the boot budget if anything). I5 ✅ (per-arch build, matches our matrix).
- **Cost:** ~2–3 days incl. cross-arch validation.

### 4.4 Tamper-evidence + signing (the can't-repackage-cleanly layer) — Steps 4, 5

From hardening doc §1.1/1.2/1.5: ASAR-integrity fuses, `OnlyLoadAppFromAsar`, disable
`--inspect`/`NODE_OPTIONS`, and **code signing** (the floor under all of it).

- **Effect on piracy:** a patched app.asar fails integrity; a repackaged fork **loses our
  signature**, so it hits Gatekeeper's hard refusal (macOS) and SmartScreen's warning (Windows)
  — the crack looks and behaves like malware to the OS, and our **auto-update** silently
  replaces tampered-but-still-our-identity installs with clean ones.
- **Invariant check:** I5 ✅ (both OSes), I7 ✅ (integrity check is at load, one-time, not the hot
  path). Note the `asarUnpack` caveat (hardening §1.2): the native modules + `bin/` shims live
  outside the asar and are covered by the **bundle signature**, not the asar hash — another
  reason signing is non-negotiable.
- **Cost:** certs (money) + ~1–2 days wiring + a `FUSES` CI gate.

### 4.5 The `runAsNode` split (removes the ambient-Node attack + a repackaging shortcut) — Step 4

From hardening doc §0. Today our **signed binary can be run as a generic Node interpreter**
(`ELECTRON_RUN_AS_NODE=1`), which is both a keychain-theft vector *and* a piracy convenience (a
cracker can drive our own signed binary to run arbitrary logic). Disabling the `runAsNode` fuse
closes it — but it's **load-bearing** for the daemon, MCP server, and CLI shims (I1, I3), so it
requires **Route B: split off a minimal Node/SEA helper** to run those, then disable the fuse on
the Electron app.

- **Invariant check:** this is the one measure that *could* break I1/I3 if done wrong — which is
  exactly why it's a scheduled epic (ADR 0016) with the daemon/CLI moved to the helper *first*,
  fuse flipped *second*, verified by re-running the control-API and daemon-survival smokes.
- **Cost:** ~3–5 weeks. High value (security + anti-piracy), but sequenced after launch.

### 4.6 Runtime tamper self-check + piracy telemetry (the measure-and-revoke layer) — Step 6

On boot (async, post-paint — I7), optionally verify the app's own signature and the `bin/`
shims against a signed manifest; refuse *vaulted-token operations* if tampered (the free app
still runs — I2). Emit an **opt-in, boolean** telemetry signal for "modified build detected" so
you can *measure* piracy rate and revoke abused licenses server-side.

- **Invariant check:** I2 ✅ (free tier runs even if the check trips — we withhold paid unlocks,
  not the app), I6 ✅ (boolean only), I7 ✅ (async). A patched fork can strip this check too — so
  it's evidence + revocation input, not prevention. Low priority; do after the essentials.

---

## 5. What we deliberately will NOT do (protects the invariants and the reputation)

- **No always-online requirement / license heartbeat on launch.** Violates I1, I2, and the
  wedge. Offline grace (7–30 days) is mandatory. A dev on a plane must keep working.
- **No gating the free local core or the CLI verbs** (`list/send/capture`). That's I2/I3 — it's
  the funnel and the wedge, not the paywall. Gate *scale and glue*, never the core loop.
- **No commercial DRM packers / anti-debug obfuscators.** AV and SmartScreen flag them, which
  **destroys the code-signing reputation you're paying to build** — a direct hit to Step 5's
  own defense. Net negative.
- **No full-app obfuscation.** Perf + debuggability cost for marginal deterrence once bytecode +
  server-side + hardware-binding are in place.
- **No private/gated auto-update feed.** Punishes lapsed-but-honest users into stale, insecure
  builds and is trivially bypassed. **Gate features, not updates.**
- **No OS-divergent enforcement.** Violates I5; creates the exact cross-platform-parity gap we
  beat BridgeSpace on.
- **Never watermark or transmit terminal content / provider creds.** I4, I6 — non-negotiable.

---

## 6. Sequenced implementation plan

Ordered so the highest-ROI, invariant-safe work lands first, and the two big architectural
epics are scheduled deliberately.

| Phase | Anti-piracy work | Kill-chain step | Invariant risk | Effort |
|---|---|---|---|---|
| **P0 — pre-revenue floor** | Code signing + fail-if-unsigned gate; flip the 4 safe fuses + `FUSES` gate; close `MOGGING_REGISTRY_BASE`; renderer CSP | 4, 5 | none | ~1 wk |
| **P1 — with the account system** | PKCE + **DPoP** sender-constrained tokens; entitlement JWT (Ed25519, short TTL, offline grace) | 4, 7 | I1 (grace) — designed in | +3–5 d on account work |
| **P2 — the inert-copy layer** | **Hardware-bound device key** (TPM/Enclave native addon) → copied install can't re-license | 7 | I5, I8 — honest Linux fallback, justified addon | ~2–3 wk |
| **P3 — deterrence + attribution** | V8 bytecode (main only) + secret obfuscation; **forensic activation watermark**; runtime tamper self-check + piracy telemetry | 2, 6 | none | ~1–2 wk |
| **P4 — server-authoritative moat** | Ship the first genuinely **server-backed Pro/Team feature** (shared state / sync / policy) — the gate that can't be patched | 3, 7 | none (adds infra) | roadmap |
| **P5 — the `runAsNode` epic** | **Route B:** split daemon/MCP/CLI to a minimal Node/SEA helper → disable `runAsNode` fuse; ADR 0016; re-run control-API + daemon-survival smokes | 4 | **I1, I3** — mitigated by sequencing + smoke gates | ~3–5 wk |

**Reading of the sequence:** after **P0–P2** (~5–6 weeks incl. the account system), a pirate who
copies an installed app gets an inert, device-locked shell that degrades to Free; a casual
patcher hits bytecode + signed integrity; a sharer gets traced. That already makes you **harder
to pirate than the typical commercial Electron app**. **P4** is what makes the paid value
genuinely unpirateable (server-authoritative). **P5** closes the last ambient-code vector. None
of it costs a single feature, a millisecond of boot budget, or the offline/local-first/
scriptable/cross-platform guarantees — because the plan was built around those as hard
constraints, not afterthoughts.

---

## 7. The bottom line

- **You cannot make the local client uncrackable** — that's physics, and fighting it with
  packers would damage the very signing reputation and performance that are your assets. So
  don't aim there.
- **You can make piracy not worth it:** a copied/shared install is **inert** (hardware-bound
  tokens), a leaked license is **traceable and revocable** (watermark + server revocation), a
  patched fork is **evident and self-updating-away** (signing + integrity + auto-update), and
  the **flagship paid value simply doesn't run without our server** (server-authoritative
  design). Casual piracy — the vast majority — dies at the first layer; determined piracy gets
  an empty shell.
- **And you keep everything that matters:** the daemon still outlives the app and restores
  offline; the free core still opens in 145.9ms with no account; the CLI is still fully
  scriptable; behavior is still identical across OSes; no terminal byte ever leaves the machine.
  The anti-piracy plan and the product's identity are not in tension — because this plan refused
  to let them be.

---

## 8. Sources

Codebase & ADRs: `daemon-client.ts`, `cli-runtime.ts`, `mcp-manager.ts`, `vault.ts`,
`window.ts`, `electron-builder.yml`, `electron.vite.config.ts`, `AUDIT_REMEDIATION_REPORT_2026-07-13.md`
(§Performance — 145.9ms/150ms), docs/00 (wedge), docs/06 (control API), ADR 0001/0002/0006/0008/0014.

Web (July 2026):
- Forensic/per-user watermarking for leak attribution: [vdocipher — forensic watermarking types & implementation](https://www.vdocipher.com/blog/forensic-watermarking/) · [steg.ai — content leak protection & tracing](https://steg.ai/products/leak-protection/) · [scoredetect — fingerprinting vs watermarking](https://www.scoredetect.com/blog/posts/fingerprinting-vs-watermarking-key-differences)
- Sender-constrained tokens: [RFC 9449 (DPoP)](https://www.rfc-editor.org/info/rfc9449/) · [WorkOS — DPoP explained](https://workos.com/blog/dpop-rfc-9449-explained)
- Server-authoritative precedent (Electron dev tools gate value server-side): [Cursor vs Windsurf 2026 pricing/architecture](https://www.roborhythms.com/cursor-vs-windsurf-2026/)
- Electron client hardening (full detail in the companion doc): [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) · [electron-vite source protection](https://electron-vite.org/guide/source-code-protection)
