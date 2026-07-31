# Phase Defaults — receipts

Executed 2026-07-31 on branch `mogging/phase-defaults` (5 commits, steps 01→05 in
order, solo). The pack ran as authored with three adaptations, each recorded in its
step's commit message and below.

## What shipped

- **ADR 0022** + the default-tier record: `tier: 'default' | 'pin'` (authored, blind
  to the legacy listing) and `'compiled'` (engine-written, fully visible) on
  `app_agent_config_overrides` — ONE additive column, NULL meaning exactly what a row
  meant before.
- **The engine**: `resolveDefault` (the law as a pure function, unit-tested as a
  precedence table), `providerHomes` (the primary is a full member carrying its own
  profile identity), `applyAccountDefaults` (idempotent fan-out compiling into the
  EXISTING enforce writer — no second writer, so baseline/CAS/drift/launch/release
  semantics are inherited).
- **The lifecycle**: one debounced apply per provider off the main-side profile
  signals (save + discovery), startup healing, drift restore via the existing
  reconcile (zero new code), release-keeps-values.
- **The face**: Applies-to (defaulting to All accounts), once-per-provider consent
  naming the account count and the primary home, Account default / Pinned badges +
  honest Desired sources, Reset to default / Stop managing everywhere, the
  smart-promote chip (main-side scan, both secret detectors applied before IPC).
- **The book**: `docs/22-shared-defaults.md`.

## The gates (sweep 199 → 203)

| Gate | Proves | Verdict |
|---|---|---|
| `DEFAULTSTORE` | round-trip both tiers · legacy blindness under every filter · 4 secret shapes + 3 malformed tiers refused persisting NOTHING · tier-scoped removal · createdAt stable · migration idempotent · JSON-safe · the pin/compiled PK-collision bite (3b) | PASS (Windows) |
| `PROFILEDEFAULTS` | one default → three homes (primary INCLUDED, foreign bytes kept) · pin moves one home · honest snapshot labels · implicit pin holds · secret refused · **lifecycle**: change follows live, fourth account adopts via the debounced trigger, hand-edit restored by reconcileAll, pin-clear re-inherits, release keeps values | PASS (Windows) |
| `DEFAULTSUX` | 23 bites in the REAL Settings UI: control renders + defaults to All · consent once then QUIET · saves land in all homes · chip honest + converts · pin moves one home + Reset re-inherits · no path leak | PASS (Windows) |
| `DEFAULTSMILESTONE` | THE composed authority: set → pin → change → adopt → drift-restore → reset → release → deny-secret, one story on four claude homes, zero network, values never in the result JSON | PASS (Windows) |

Regressions held at every step: `AGENTCFG`, `PROFILES`, `SETAGENTCFG`,
`PERCEPTION` re-run green; unit suite 27 files / 217 tests; all statics green;
counts derived at 203 (13 claims agree).

## Finds the battery earned

1. **The pin PK collision (defaults/02).** An authored pin for profile P shared its
   primary key `(provider, 'profile', P, surface, settingId)` with the compiled
   enforce row fan-out writes for that same home — the first apply silently
   swallowed the pin (files right, truth gone; caught by the snapshot-label bite).
   Pins now live under a `__pin__:` storage namespace — written on save, stripped
   on read, mapped on remove, reaped with their profile — and DEFAULTSTORE carries
   the collision bite, proven red on the pre-fix bytes.
2. **`rememberKey` remembers only when ticked (defaults/04).** The house
   confirmDialog's session opt-out is the checkbox, not the confirm — the
   "once, not twice" bite drives it the way a user would.
3. **MILESTONE red on this machine — and equally red on unmodified main.** Branch
   135.5 fps / 152.6 ms worst gap vs main 135.0 fps / 159.5 ms on the same box
   (budget: 150 ms): the stress frame-gap budget misses by ~5% on this
   non-canonical machine regardless of checkout. PERCEPTION green outright
   (echo median 1.4 ms, worst switch 32.6 ms). Numbers vs baseline: unchanged.
   Three-platform certification on the canonical harness remains the operator's
   step.

## Adaptations from the pack as authored

- `announceProfilesChanged()` is a **renderer** port, not `src/main/profiles.ts` —
  the auto-adopt trigger hooks the main-side mutations instead (the save handler +
  the discovery path), which is where the profile rows actually change.
- **Claude-first rollout** (the operator's directive): the engine is
  provider-generic, but fan-out UX renders only for `DEFAULTS_PROVIDERS = ['claude']`
  until live validation on real Claude Code passes; widening that set is the whole
  rollout step for the next provider.
- The step-02/03 smokes merged into ONE growing gate (`PROFILEDEFAULTS`), as the
  pack itself prescribed ("no new gate id — the assertion set grows").

## Live validation (2026-07-31, operator-approved)

Before any allowlist widening, the whole arc ran against the operator's REAL
`~/.claude` (their live Claude Code home, notify-hooks wired) plus one disposable
pointer home, via a temporary MOGGING_LIVEDEFAULTS smoke (a verify-skill temp
edit, reverted after evidence — deliberately NOT a committed gate, since gates
never touch real homes). Key: `cleanupPeriodDays` (inert, non-danger, absent
beforehand). All seven bites green — lands-everywhere · pin-differs ·
change-follows · drift-restored-on-the-real-file · pin-cleared · released ·
clean-restore (the file ended semantically identical to how the run found it,
hooks intact; the key removed again). The operator launched the run themselves.
**Claude Code is validated live; `DEFAULTS_PROVIDERS` may widen.**

## Environment notes (this execution)

- Fresh clone, no MSVC/Python toolchain: natives satisfied via prebuilds —
  better-sqlite3 (official electron-v140 asset), node-pty (its shipped Node-API
  prebuilds mirrored into `build/Release`, the layout its loader checks first),
  device-key (the installed v0.16.0 app's ABI-stable copy; sources unchanged since
  that release). `npm run rebuild:native` still wants the real toolchain.
- A main-checkout electron-vite crash-loop (natives absent there) was found holding
  port 5173 and starving gates mid-session; reaped with `kill-devservers.mjs`. Gate
  teardown here always reaps dev servers + the isolated daemon.
