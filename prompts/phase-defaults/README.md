# Phase Defaults — one settings baseline across every account

Profiles (`phase-4/04`) gave a provider many accounts; ADR 0013 made sessions follow
them. But each account reads only its OWN config home (`~/.claude`, `~/.claude-work` …),
so a setting changed for one account never reaches the other. This pack adds a
**provider-level default tier** that fans out to every account's home, with
**per-account pins** that win and **live inheritance** between them. It extends the
agent-CLI configuration control plane (ADR 0011), touches no network, and removes
nothing: the free, offline, account-free core is untouched. Same format as
`prompts/phase-1..11/` — each step is self-contained and pasteable as a `/goal`,
**≤ 3950 chars**. Execute in order.

The engine is `src/main/agent-settings.ts`; the model `src/contracts/domain/agent-settings.ts`;
the desired-state store is behind `getSettingsStore()` (`src/main/app-settings.ts`, where
profile + override rows already persist); the surface is `src/ui/features/settings/agent-config.ts`.

> **The resolution law (binding on every step)**: `value(account P, setting S) =
> pin(P,S) ?? accountDefault(S) ?? P's own file value` — resolved BEFORE any file write,
> then enforced into each account's home. It slots into the EXISTING cascade as
> `session > project > local > pin > account-default > file > system`; a per-project
> setting still beats a cross-account default (more specific intent wins).

> **Shared by default**: a value you set is a cross-account default unless you mark that
> key "this account only". Sameness is the norm; a pin is the exception; a pin affects
> ONLY its own key — every other key keeps tracking the default, and changing a default
> propagates to all unpinned homes LIVE.

> **The primary home is a full member**: defaults enforce into the default profile's real
> `~/.claude` too — "all accounts" means all. The first cross-account write is ANNOUNCED
> in the UI ("this now manages this setting across all N of your <provider> accounts,
> including your primary"); the per-account pin is the escape hatch; drift is restored,
> never silently.

> **ADR 0002 stands entirely**: defaults hold NON-secret values only; the persistence
> deny-list refuses secret-shaped defaults exactly as it refuses secret-shaped pointer
> envs. This feature never reads, stores, or brokers a *provider* credential.

> **Local + offline, perf-safe**: every smoke boots isolated with ZERO network; the free
> core keeps working account-free. The fan-out/enforce pass is async/post-paint/debounced —
> nothing new touches the boot critical path; MILESTONE + PERCEPTION are re-measured
> UNCHANGED after the UI step.

> **Numbering deconfliction**: this pack takes **ADR 0022** (shared account defaults) and
> `docs/22-shared-defaults.md`, and grows the sweep by four gates. Steps say "the sweep
> grows by one / the next free ADR" so the pack survives other work landing first;
> `scripts/check-gate-count.mjs` is the mechanized count.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-default-model.md` | ADR 0022 + the default-tier record (`tier: 'default' \| 'pin'`) + persistence + deny-list; **DEFAULTSTORE** |
| 02 | `02-resolution-and-fanout.md` | Resolution (`pin ?? default ?? file`) + fan-out into EVERY account home, primary included; **PROFILEDEFAULTS** |
| 03 | `03-inheritance-lifecycle.md` | Live propagation, new-account auto-adopt, keep-in-sync drift restore, pin & reset-to-default; **PROFILEDEFAULTS** (extended) |
| 04 | `04-defaults-ux.md` | Per-setting "All accounts / This account only" toggle + Reset + smart-promote chip + first-write consent; **DEFAULTSUX** |
| 05 | `05-defaults-milestone.md` | `docs/22` + the composed baseline milestone, end-to-end on FAKE; **DEFAULTSMILESTONE** |

## Overall Definition of Done
- A default set once appears in EVERY account's config home for that provider — the
  primary `~/.claude` included; changing it later re-reaches every unpinned home live.
- Pinning one account differs ONLY that key there; "Reset to default" makes it inherit again.
- A new/detected account adopts all current defaults immediately; a hand-edit that drifts
  from a default (or a pin) is restored.
- A secret-shaped default value cannot be SAVED; no provider credential ever enters the app.
- The free/offline core is unchanged; both perf budgets numerically unchanged.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; static gates green (AUDIT · SPACING
  `--max 0` · boundary greps clean).
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation; existing
  `MOGGING_AGENTSETTINGS` + `MOGGING_PROFILES` still green; MILESTONE + PERCEPTION re-run
  after step 04.
- Grep-clean: no secret in logs, telemetry, or any `out/*-result.json`; setting VALUES
  never enter telemetry (IDs + booleans only, ADR 0005).

## Guardrails
- **No feature loss** — the existing scopes (session/project/local/profile/user/system)
  and their smokes keep passing; this ADDS a tier, it re-wires nothing.
- **ADR 0002 sweep before freeze** — defaults are non-secret; the deny-list is the wall.
- **Honest cross-account writes** — the first enforce into a shared/primary home is
  announced; drift is restored visibly, not silently.
- **Perf is the veto** — fan-out/enforce is async, post-paint, debounced.

## Parallelization
01 → 02 → 03 is the engine spine (order-strict — resolution needs the record, lifecycle
needs the fan-out). 04 is the surface (after 03). 05 needs all. House rule: no parallel
agents — solo execution runs 01 → 05 in order.
