A new user should reach a working agent workspace in five minutes, guided by the
product — and existing users should get updates with one click. First-run experience
+ update UX, both honest and dismissible.

## Steps
1. **First-run checklist** (Home, `src/ui/features/home/`): a dismissible "Get set
   up" card shown until completed or dismissed (localStorage), with LIVE state — not
   a static tour: ① Agent CLIs — re-uses `agents:detect`; per-CLI found/missing with
   the provider's install one-liner (copy button; we never install for them) ②
   First workspace — done when a workspace exists; button opens the wizard ③ Optional
   power-ups — profile added / SSH host added / board visited (checks the real
   stores). Each row: state icon + one action. Completing all three collapses the
   card into a small "setup complete" toast, once.
2. **Empty-state polish**: the wizard's Agents step when NOTHING is installed
   currently shows a bare roster — give it the same install-hint treatment (detect →
   per-CLI copyable install command + a "re-check" button that re-runs detect
   without reopening).
3. **Update UX** (`src/main/updater.ts` + a small renderer feature): electron-updater
   already checks the feed in packaged builds. Wire its events over a new
   `UpdateChannels = { state }` push: `checking/available/downloading(pct)/ready/
   error` → a quiet titlebar dot while downloading → ONE toast when ready: "v0.x.y
   ready — Restart now / Later" (restart = `quitAndInstall`; Later = nothing until
   next launch, no nagging). Dev builds: the feature no-ops (updater inactive) but a
   `MOGGING_FAKE_UPDATE=<version>` env drives the whole renderer flow for the smoke.
4. **Docs touch**: README Quickstart gets the 5-minute path (install CLI → open app →
   checklist); `docs/10-distribution.md` (from 02) gains the update-feed story.
5. **Smoke** (`MOGGING_FIRSTRUN`): isolated boot (fresh state) → checklist card
   present with ① reflecting real detection (claude found on this machine) and ②
   incomplete → create a workspace via the dev handle → row ② flips done (poll DOM)
   → dismiss → card gone → reload → STAYS gone (persisted). Then the update flow:
   relaunch path not needed — with `MOGGING_FAKE_UPDATE=9.9.9` assert the titlebar
   dot during fake download, the ready toast with BOTH actions, and that "Later"
   dismisses without re-toasting (poll 10 s).

## Files
- `src/ui/features/home/` (checklist) · wizard Agents-step empty state ·
  `src/contracts/ipc/update.ipc.ts` + channels · `src/main/updater.ts` ·
  `src/ui/features/updates/` (+ CSS) · README · `docs/10-distribution.md`
- `src/main/firstrun-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Fresh state boots into a checklist that tells the truth (live detection, live
  completion), completes itself as the user progresses, and never returns once
  dismissed.
- A ready update is one click to install, zero clicks to ignore.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_FIRSTRUN` green isolated; SMOKE + PERCEPTION still green (Home renders
  more — the hero/scaling budget must hold).

## Guardrails
- The checklist NEVER installs anything, runs no elevated commands, and phones
  nothing home — it reads local detection and local stores only. Telemetry:
  `firstrun_completed`/`firstrun_dismissed` booleans at most.
- Update toasts appear at most once per ready version per session; "Later" is a
  first-class choice, not a snooze-nag.
- No new dependencies (electron-updater is already in).
