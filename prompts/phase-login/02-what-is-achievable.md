# 02 — What is achievable, and what is not

The four stated requirements were: (a) accounts with plans and per-plan feature
gating; (b) "as secure as possible", auth wired into every moving part; (c)
nobody can use the app without authenticating; (d) the same account cannot be
used on more than one device at a time.

Three are achievable. One is not. This file is about which, and why.

## 1. Two claims that must not be conflated

**"You can require a login before the app is usable."** Trivially achievable.
Slack, Discord, Notion, Linear, Figma, Teams, Postman, 1Password and Cursor are
all Chromium-shell apps that show a login wall and nothing else. There is no
obstacle to doing the same, and against essentially every real user, it holds.

**"That login cannot be removed by someone who wants to remove it."** False —
for every Electron app, including all of the above. The login gate is not what
protects their revenue. Something else is.

## 2. The empty-room test

> **If an attacker deletes the login check entirely, what do they have?**

Patch the auth out of Slack: a perfect Slack client with **zero messages**, because
the messages live on Slack's servers behind a token you don't have. Patch it out
of Figma: an editor with no documents. Patch it out of Cursor: an editor whose
AI features round-trip to a server that won't answer. **The login screen is not a
lock. It is a door in front of an empty room.**

Now run the test on MoggingLabs Workspace as it stands. Patch out the login and
you get: the multi-pane xterm.js terminal, `node-pty` spawning the user's own
CLIs under the user's own keys, local git status, worktrees, workspace
persistence in local SQLite, the daemon, the board, the templates. **That is the
entire product**, at full fidelity, offline, forever.

Not because the login was badly written. Because there was never anything on the
other side of the door. This is *architectural*, and it cannot be closed with
better client-side code.

## 3. Why client hardening has a low ceiling

`app.asar` is a zip. `npx asar extract` it, find the boolean, flip it, repack.
Against an unhardened build that is a ten-minute job
([fasterthanli.me](https://fasterthanli.me/articles/cracking-electron-apps-open),
[taner-dev](https://taner-dev.com/articles/crack-electron)).

**Attackers do not attack the check. They attack the call site.** It does not
matter whether the entitlement verifier is JavaScript, Rust, or hand-tuned
assembly, nor whether it validates an Ed25519 signature perfectly. It returns a
boolean, and somewhere there is an `if` that consumes it. In a compiled binary
that `if` is one conditional jump. **The strength of the verifier is irrelevant
to the strength of the gate.** Verification strength only matters when the
verifier *produces something you actually need* — a decryption key, a server
response. Which is the server-side-value argument again.

Then amortization finishes the job: a crack is a **one-time cost, globally
amortized**. One person spends an afternoon, publishes the patch, everyone else
pays zero. You don't have to defeat every attacker — you have to defeat the single
most motivated one, forever, on every release. Our users are professional
developers. That population *is* our addressable market.

## 4. What hardening does buy (do it anyway — it's cheap)

Worth a few days, not a quarter:

- **Electron Fuses** ([docs](https://www.electronjs.org/docs/latest/tutorial/fuses)):
  `RunAsNode`, `EnableNodeCliInspectArguments`, `EnableNodeOptionsEnvironmentVariable`
  **off**; `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` **on**
  (both default-off; they must be enabled *together*, or the `app/`-directory
  fallback sidesteps validation —
  [asar-integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)).
- **Code signing + notarization.** On the attacker's own machine they strip the
  signature, patch, recompute the integrity hash and ad-hoc re-sign
  ([writeup](https://infosecwriteups.com/electron-js-asar-integrity-bypass-431ac4269ed5)).
  The real value is that **Gatekeeper/SmartScreen reject the cracked copy**, so it
  cannot *spread* to non-technical users. That is the threat that costs money.

Net effect: ten minutes → an afternoon, for one person, once. Worth having.
Not a license.

## 5. Would Tauri help? Marginally — and here, net-negative

Two things genuinely change: frontend assets are embedded in a compiled Rust
binary rather than a zip, and release builds disable devtools by default. If the
check lived in Rust, the attacker moves from reading JS to Ghidra. Ten minutes
becomes hours.

It changes nothing else. §3's call-site argument is language-agnostic, and the
crack still amortizes to zero.

**And the cheap Tauri port buys nothing at all.** `src/backend/` is deliberately
"ALL Node-side logic; Electron-free" — that is ADR 0001's own hedge, so the engine
"could be re-hosted in Tauri or a native shell later without a rewrite." The
natural port therefore keeps the TypeScript engine as a **Node sidecar**, which
has *exactly* Electron's crackability: same JS, same interpreter, launched by a
Rust process instead of a Chromium one. To gain anything you would rewrite the
engine in Rust (`node-pty` → `portable-pty`, `better-sqlite3` → `rusqlite`, the
OSC parser, session store, orchestration, daemon). That is a second product.

**And it costs the wedge.** `README.md:30` attacks BridgeSpace precisely for being
"built on Tauri's *two* divergent WebView engines" with "a multi-month history of
terminal-rendering/freeze bugs." ADR 0001 says the same at length: WebView2 on
Windows vs WKWebView on macOS, two sets of render/perf/clipboard/font quirks.
We would reintroduce the exact bug class we market against, in the exact
subsystem — a WebGL terminal renderer under many streaming panes — where it hurts
most, in exchange for hours of one-time crack resistance.

ADR 0001's "when we'd revisit" lists footprint and a native GPU renderer.
Anti-piracy is not on that list and should not be added to it.

## 6. Verdict

| Requirement | As stated? | What to build instead |
|---|---|---|
| (a) Accounts + plans + per-plan gating | ✅ | Server-issued Ed25519 entitlement tokens. Gate *server* features by plan; client gating is UX, never the boundary. |
| (b) "As secure as possible," auth in every moving part | ⚠️ Partly | The client cannot be made trustworthy. Secure the **server**. Harden the client cheaply (fuses, signing) to stop casual cracks and redistribution. |
| (c) Nobody uses the app without authenticating | ❌ Not enforceably | Require login anyway — it stops ~everyone. But make the paid capability **server-resident**, so a cracked client is a *useless* client, not a *blocked* one. |
| (d) One device at a time | ⚠️ Enforceable, but wrong | See §7. |

## 7. The contradiction nobody named

We want paid plans **and** single-device enforcement. But look at what is left to
sell. The CLIs run locally under the user's own keys — ADR 0002 forbids brokering
that, correctly. Terminal, panes, git, worktrees, templates: all local, all
patchable. The only things here that can become genuine server-side value are
**cross-device**: syncing workspaces/profiles/templates, usage history aggregated
across machines, a shared board and ownership ledger for teams.

**Cross-device sync is the product. "One device at a time" destroys it.** We would
be charging for the ability to work on a laptop and a desktop, then forbidding it.

Single-active-session fits seat-licensed software (JetBrains) and streaming
(Spotify). For a sync-based dev tool it is an anti-feature. Cursor took real
reputational damage in 2025 when users merely *believed* a one-device policy
existed ([HN](https://news.ycombinator.com/item?id=43683012)).

**Build instead: device registration with a per-plan cap** (Free 1, Pro 3, Team
per-seat), enforced by a server lease, plus a self-service "sign out my other
device." Same anti-sharing effect, none of the pain. See `04` §3.

## 8. Recommended posture (five bullets)

- **Make the crack worthless, not impossible.** Move the paid capability
  (sync, history, team coordination, curated content) server-side.
- **Harden the client as cheap speed bumps only.** Fuses + signing + notarization.
  A few days. Then stop.
- **Auth = system-browser OAuth + PKCE (RFC 8252)**, loopback `127.0.0.1:<random>`,
  never a custom scheme (hijackable), never an embedded login form.
- **Single-device via a server lease with a per-plan device cap**, soft-enforced,
  with "sign out other device." Never trust a hardware fingerprint as identity;
  never hard-brick on a missed heartbeat.
- **Cap anti-piracy at a few days of work.** Our customers are elite crackers.
  Compete on service and freshness. Spend the saved engineering on the product.
