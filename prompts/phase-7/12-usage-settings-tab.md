Usage gets a FULL tab in Settings — its own left-nav section, the home for
~57 providers across five classes. The popover stays the glance; this tab
is where a user finds, enables, keys, and configures any provider, plus the
pace/display/privacy controls. Research: `docs/research/`.

## Steps
1. **The nav section** (`src/ui/features/settings/`): a `Usage` entry +
   `usage.ts` module (the `profiles-hosts.ts` pattern; index.ts stays an
   assembler). 03's minimal stub is ABSORBED here and deleted — one home.
2. **The provider catalog grid** — the CodexBar "Settings → Providers"
   analog for the full catalog (04–06): a SEARCHABLE, class-grouped grid of
   `USAGE_PROVIDERS`. Per row: label + class chip, enable toggle, and the
   class's control — cli-store/cloud-cli show a detected chip (`agents:
   detect` + a probe); api-key shows the PASTE-ONCE field —
   after save it becomes "Key saved · Replace · Delete", masked forever
   (0007.a write-only; an env-ref slot is the Advanced alternative);
   web-session shows the same paste control + the "read my browser
   session" opt-in (06, default OFF). Detected/enabled sort first; the rest a search
   away. Per-enabled-row health + refresh.
3. **Plans × profiles table**: every (provider, profile) pair the poller
   fans out (09) — plan label, profile, miniature gauges, spend where known
   (07), the verdict line, active-profile identity, and a "switch for new
   launches" action (the popover's exact path).
4. **Pace, display & alerts blocks**: work-day baseline editor (feeds 02),
   per-plan threshold editors (09 rules inline) + reset-confetti toggle,
   the display options (10), and a "test notification" button firing a
   fixture toast.
5. **History + cost**: per enabled provider, the sparkline (07) and an
   on-demand cost-scan panel (Codex/Claude logs) — the fuller view the
   popover defers here.
6. **Privacy story, in place**: the ADR 0007/.a/.b words — "sessions read
   in place; keys encrypted by your OS, never shown again; browser reads
   opt-in, off by default" — with a link to docs/12.
7. **USAGESET smoke** (`MOGGING_USAGESET`, env-gated, in qa-smokes.sh):
   FAKE world — the grid renders all five classes; search filters; enable
   reaches the poller live; a pasted key flips to the saved/masked state with NO way to reveal it
   (Replace and Delete work; the DOM never re-contains the value); an
   env-ref slot refuses a secret literal; a web-session opt-in persists
   (OFF = fixture keychain untouched); the plans table matches the popover's tile set exactly; a
   switch flips the active profile; display + reset-time changes apply;
   privacy panel present. Verdict via `out/usageset-result.json`.

## Files
- `src/ui/features/settings/usage.ts` (+ index.ts nav entry; stub removal) ·
  `src/backend/features/usage/` (settings IPC growth) · `src/main/usageset-
  smoke.ts` · `scripts/qa-smokes.sh` (gate row) · `src/main/gallery.ts`
  (tab states, both themes)

## Definition of Done
- Settings shows a Usage entry; every catalog provider is findable +
  configurable there by its class; every knob lives THERE (grep proves
  none render elsewhere); the popover gear deep-links to it.
- The plans table + popover render from the same snapshot (asserted equal).
- USAGESET gate green; gallery carries the tab (all five class controls) in
  both themes; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- The tab CONFIGURES and explains; never a live dashboard — the popover
  stays the glance; history/cost here are compact.
- Every mutation goes through the poller's IPC — no settings-only side
  channel; keys stay env-ref pointers, web reads stay opt-in/OFF.
- Provider names, keys, cookies, numbers stay out of telemetry (ADR 0005).
- Design-system compliant: tokens, division rhythm, AA both themes.
