# Phase Accounts — the paid tier, made hard to crack

Sequenced task prompts for the productization phase of **MoggingLabs Workspace**:
`phase-login/` researched *whether* an account/subscription is achievable; this pack
**builds it**, and hardens the app so a cracked copy is inert, traceable, evident, and
stale. The free local core stays free, account-free, and fully offline — we add a lane, we
remove nothing. Same format as `prompts/phase-1..11/` (each step self-contained + pasteable
as a `/goal`, **≤ 4000 chars**). Execute in order.

Grounded in the sourced plan: `docs/research/2026-07-productization-accounts-subscriptions.md`,
`…-electron-hardening-and-enforcement.md`, `…-anti-piracy-plan.md`,
`…-anti-crack-implementation-report.md`.

> **The custody stance (ADR 0015, binding on every step)**: account tokens rest ONLY as
> `safeStorage` ciphertext (or in memory), decrypt at the single point of use; **no IPC
> channel ever returns a token** (extends the 8/08 write-only discipline). Claims cross IPC,
> secrets never do. The free tier needs no account and works fully offline; **offline grace
> never bricks** the app. ADR 0002 stands entirely: our account is OUR credential — we still
> never broker, store, or meter a *provider* login.

> **The enforcement doctrine (honest by construction)**: a local check is UX, not security —
> anything on the client is patchable. Real enforcement is exactly two things: **(a)
> hardware-bound tokens** so a copied install is inert, and **(b) server-authoritative paid
> value** so the gate can't be faked offline. Local gates are honor-system + speed bumps;
> no step is allowed to pretend otherwise.

> **The performance veto (invariant I7)**: boot passed at **145.9ms / 150ms** — ~4ms
> headroom. Every anti-crack check runs **after first paint, async, cached**. Nothing new
> touches the boot critical path or the render loop. MILESTONE + PERCEPTION are re-measured
> after any step that could move them, numbers UNCHANGED.

> **The invariants (never broken)**: the detached daemon outlives the app (ADR 0006); the
> scriptable `mogging` CLI stays ungated — `list/send/capture` are the wedge (docs/06); OS
> behavior stays identical (ADR 0001); terminal content, filenames, and argv never enter
> telemetry (ADR 0005) — IDs and booleans only.

> **FAKE-first**: a FAKE identity provider and a FAKE billing/entitlement issuer are
> first-class citizens forever (the phase-7 rule). Every gate boots on them — **zero network
> in any smoke, ever**. The real IdP/merchant-of-record/backend and code-signing certs are
> the **operator's later wiring**, deliberately OUT of this pack.

> **Numbering deconfliction**: this pack takes **ADR 0015** (accounts & entitlements) +
> **ADR 0016** (splitting the Node runtime), `docs/18-accounts.md`, and ten new gates (steps
> say "grows by one" so the pack survives other work landing first). The daemon **wire
> protocol stays v9** throughout — step 09 changes the HOST that speaks it, not the protocol;
> `PROTOVER` keeps proving v9.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-origin-pinning.md` | ADR 0015 + close `MOGGING_REGISTRY_BASE`, pin origins as in-code constants; **ORIGINPIN** static gate |
| 02 | `02-electron-fuses.md` | `@electron/fuses`: cookie-enc on, nodeOptions/cliInspect off, both ASAR fuses on; **FUSES** artifact gate |
| 03 | `03-renderer-lockdown.md` | Tighten CSP + add the missing main-window navigation deny; **LOCKDOWN** |
| 04 | `04-account-core.md` | `account.ts`: PKCE + DPoP, `account.ipc.ts`, vault custody, FAKE IdP; **ACCOUNT** |
| 05 | `05-entitlements.md` | `entitlements.ts`: signed JWT verify/cache, offline grace, `Entitlements` port + gate points; **ENTITLE** |
| 06 | `06-hardware-device-key.md` | TPM/Secure-Enclave device key binds the grant; copies can't re-license; **DEVICEKEY** |
| 07 | `07-bytecode.md` | V8 bytecode for MAIN only (preload stays sandboxed) + secret obfuscation; **BYTECODE** |
| 08 | `08-watermark-and-tamper-check.md` | Per-account activation watermark + runtime tamper self-check; **WATERMARK** |
| 09 | `09-runtime-split.md` | ADR 0016: split daemon/MCP/CLI to a helper, disable `runAsNode`; **RUNTIMESPLIT** + extend SURVIVE/CONTROL |
| 10 | `10-product-milestone.md` | docs/18 + the composed paid-tier milestone, hardened, end-to-end; **PRODMILESTONE** |

## Overall Definition of Done
- A user can create an account, subscribe (FAKE MoR in smokes), and unlock Pro; logout
  and the app returns to the free tier cleanly.
- A copied/logged-in install moved to another machine **cannot refresh or re-license** —
  it degrades to Free when offline grace expires (DEVICEKEY device-mismatch smoke).
- Pull the network: Pro holds through the grace window, then degrades to Free — the app
  **never bricks** (ENTITLE offline-grace smoke).
- The free tier still opens with **no account, fully offline**; `mogging list/send/capture`
  still ungated; both perf budgets numerically unchanged.
- `npx @electron/fuses read` on the shipped artifact shows the exact fuse wall (FUSES); no
  IPC channel returns a token (asserted); tokens live only as ciphertext / in memory.
- ADR 0015 + 0016 written; `docs/18-accounts.md` is the book; positioning copy updated to
  "free local core + optional Pro"; the credential-wording gate extended.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; static gates green (AUDIT · SPACING
  `--max 0` · PTYSEAM · PROTOVER — protocol v9).
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation; MILESTONE +
  PERCEPTION re-run after any renderer- or boot-touching step.
- Grep-clean: no token/entitlement secret in logs, telemetry, or any `out/*-result.json`.

## Guardrails
- **No feature loss** — the daemon still outlives the app, the CLI stays scriptable, the
  free core stays offline. A step that breaks an invariant is a review rejection.
- **No perf regression** — anti-crack work is async/post-paint/cached; budgets are the veto.
- **Honest enforcement** — a local gate is never described as unbreakable; the durable moat
  is hardware binding + server-side value.
- **FAKE-first, zero network** in every smoke; real IdP/MoR/backend + signing certs are the
  operator's later wiring, not this pack.
- **ADR 0002 sweep before freeze** — no provider credential ever enters this process.

## Parallelization
01 → 02 → 03 harden the shell (independent, can interleave). 04 → 05 → 06 is the account
spine (order-strict). 07 · 08 are deterrence (after 05). 09 is the runtime-split epic (after
the account spine; it re-runs SURVIVE/CONTROL). 10 needs all. House rule: no parallel agents
— solo execution runs 01 → 10 in order.

## Freeze — phase-accounts/10 (2026-07-16)

Every step shipped with its gate green, and `MOGGING_PRODMILESTONE` — the pack's **only
authority on "phase-accounts done"** — composes the whole promise in one run on FAKE
services with zero network: subscribe → device-bound Pro; offline → grace → Free, never
bricks; copied to new hardware → inert, no re-license; tampered → free-only; logout →
anon-free; the `mogging` wedge ungated throughout; both budgets measured ON the composed
surface. Receipts, measured numbers, and platform finds: [`REPORT.md`](REPORT.md). The
book: [`docs/18-accounts.md`](../../docs/18-accounts.md).

| Step | Gate | Done |
|---|---|---|
| 01 — ADR 0015 + origin pinning | ORIGINPIN | ✅ |
| 02 — the Electron fuse wall | FUSES | ✅ (incl. `RunAsNode: DISABLE` + the tamper bite) |
| 03 — renderer lockdown | LOCKDOWN | ✅ |
| 04 — the account core (PKCE + DPoP, vault custody) | ACCOUNT | ✅ |
| 05 — signed entitlements + offline grace + the port | ENTITLE | ✅ |
| 06 — the hardware device key (copies are inert) | DEVICEKEY | ✅ (`tpm` leg here; per-OS = operator dispatch) |
| 07 — V8 bytecode, main only | BYTECODE | ✅ |
| 08 — watermark + tamper self-check | WATERMARK | ✅ |
| 09 — the runtime split (ADR 0016), `runAsNode` off | RUNTIMESPLIT | ✅ |
| 10 — the book, the gallery, the composed milestone | **PRODMILESTONE** | ✅ |

**The freeze ledger** (this worktree's commit series on `mogging/0d5688ec`; the sweep
grew 134 → **144**):

- `9376748` — **feat: phase-accounts 01-10 — the paid tier, hardened (implementation)**:
  the whole pack's code (origins/fuses/lockdown/account/entitlements/device-key/bytecode/
  watermark/runtime-split) + step 10's composed smoke, account panel, gallery states, and
  the sweep/CI wiring. Frozen as one self-consistent commit — the pack landed in this
  worktree uncommitted, so a fabricated per-step history would risk broken intermediates;
  the step→gate mapping above is the real ledger, each gate independently reproducible.
- `<this commit>` — **docs: the book (docs/18-accounts.md), ADRs 0015/0016, the roadmap,
  and the freeze ledger.**

Gate run context (this machine, 2026-07-16): every gate above reproduces via
`MOGGING_GATES=<GATE> bash scripts/qa-smokes.sh`; PRODMILESTONE green at 31/31 on the
final code (`out/prodmilestone-result.json`), FUSES green with `RunAsNode: DISABLE` + the
tamper bite (`out/fuses-result.json`).

**Deliberately the operator's, not this freeze's**: the full uncut 144-gate sweep, the
three-OS CI dispatch, wiring the real IdP/MoR/issuer origins, and **the code-signing
certificates — the deferred final step** (docs/18 §honest limits names exactly what it
covers). FAKE-first stands: every gate above runs with zero network, protocol v9.
