# Phase 7 — Usage meters: know your pace before the limit does

Sequenced task prompts for Phase 7 of **MoggingLabs Workspace**: the swarm burns
plan quota all day — now the app must SHOW the burn. A CodexBar-grade usage
surface (steipete's menu-bar app is the reference: session + weekly gauges,
reset countdowns, pace deltas, run-out forecasts, account switching without
credential copying) built the house way: provider adapters behind one seam,
profile-scoped plans, a titlebar gauge with a quick-check popover, and the
pace engine that says plainly whether you'll run out early, land on pace, or
leave quota unused. Same format as `prompts/phase-1..6/` (each step
self-contained + pasteable as a `/goal`, < 4000 chars). Execute in order.

> **Surface decision (made here, binding)**: the primary surface is a POPOVER
> dropping from a titlebar usage icon — usage is a glance ("can I keep
> going?"), not a destination, and the reference app is itself a menu-bar
> dropdown. Configuration gets a FULL Usage tab in Settings (06): its own
> left-nav section holding every knob, the plans×profiles management table,
> and the privacy story. The tab configures and explains — it never becomes
> a dashboard; analytical depth needs a later phase to earn it.

> **Auth stance (binding, extends ADR 0002)**: usage adapters RIDE the
> sessions the CLIs already own — token read from the CLI's own store at
> request time, held in memory for the one request, never persisted, copied,
> or displayed. A profile points at WHICH store to read (the same pointer
> philosophy CodexBar uses for "switchable accounts without copying their
> credentials"). Codified as ADR 0007 in step 01.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-usage-core-and-adr.md` | ADR 0007 + `@contracts/usage` + adapter seam + FAKE adapter + Claude adapter; USAGE smoke green on fixtures (zero network in smokes) |
| 02 | `02-pace-engine.md` | Pure pace module: signed pace delta, run-out ETA, the three verdicts with house wording; golden fixtures asserted by the smoke |
| 03 | `03-titlebar-gauge-and-popover.md` | Two-bar titlebar gauge (session/weekly) + quick-check popover, design-system compliant; USAGEUI smoke + both perf budgets green |
| 04 | `04-openai-gemini-adapters.md` | Codex/OpenAI + Gemini adapters on the same seam, per-OS credential paths, stale/error states; adapter authoring guide |
| 05 | `05-profiles-plans-and-alerts.md` | Plans × profiles switcher (N plans per provider), threshold notifications through the house notify system, failover suggestion feed |
| 06 | `06-usage-settings-tab.md` | The FULL Usage tab in Settings: own nav section, providers block, plans×profiles table, pace/alerts editors, privacy story; USAGESET smoke green |
| 07 | `07-usage-milestone.md` | All three CI sweeps green with the new gates; docs/12-usage.md; pack freeze + per-OS numbers |

## Overall Definition of Done
- One glance at the titlebar answers "can I keep working, and until when?" for
  the ACTIVE profile; one click answers it for every plan on every provider.
- Claude, OpenAI/Codex, and Gemini usage load from the user's own sessions on
  Windows, macOS, and Linux — no logins, no stored secrets, no new auth.
- The pace verdict (run-out / on pace / surplus) is computed by one pure,
  fixture-tested module and worded identically everywhere it appears.
- Multiple plans per provider (via profiles) are all visible and switchable.
- Settings has a full Usage tab — every knob the feature owns lives there,
  and the plans table renders from the popover's exact snapshot.
- The full sweep — WITH the new usage gates — is green on all three CI OSes.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation; both
  perf budgets (MILESTONE + PERCEPTION) re-run after any renderer-touching step.
- Gallery states staged for every new visual surface (both themes).

## Guardrails
- **ADR 0002/0007**: no credential is ever persisted, copied between homes,
  logged, or shown. Adapters read known per-CLI locations only. A smoke never
  performs OAuth; smokes run on the FAKE adapter's fixtures exclusively.
- **ADR 0005**: usage numbers, plan names, and account identifiers NEVER
  enter telemetry — counts and booleans only.
- The daemon protocol stays at v3 — usage lives in the app backend, not the
  daemon; panes carry zero new wire surface.
- Platform differences live in adapter path resolution + CI config only.
- Poll politely: per-provider cadence presets (manual · 1m · 2m · 5m · 15m),
  jittered, paused when the window is hidden; never hammer on errors
  (exponential backoff, dimmed-stale UI instead of retries).

## Parallelization
01 → 02 → 03 is the spine (each builds on the last). 04 parallels 03 (same
seam, no UI dependency). 05 needs 03 + 04; 06 needs 05. 07 freezes the
pack. One lane is fine; two lanes = (03) and (04) after 02 lands.
Before executing any step, read `IMPLEMENTATION.md` — the best-path
decisions surveyed against shipped code.
