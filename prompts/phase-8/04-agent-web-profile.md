The Comet resolution, the safe branch: a dedicated **agent web profile**
— real logins the user creates ON PURPOSE inside the dock, separate from
the preview session AND the system browser (FINDINGS Branch C). Agents
act as the user — only on granted origins, never on the blocklist,
reads/acts separated, every act trailed (0008.e).

## Steps
1. **Two partitions, one dock**: `persist:browser-dock` stays the
   PREVIEW profile, byte-for-byte. Add `persist:agent-web` — same
   hardening via an extracted `hardenSession()` on both — and a
   dock-chrome switch (Preview ⇄ Agent web, per-workspace persisted).
   Two lazy views, attach-swapped. Persistence is VAULT-CONDITIONED
   (0008.h): Chromium cookie encryption rides the same OS facility as
   our vault — a vault-less machine (7/05 probe) gets a NON-persist
   partition + honest copy ("no at-rest encryption here — logins last
   until the dock closes"). Sign-ins live ONLY in agent-web; a quiet
   banner says sessions persist and agents act on granted origins.
2. **Grant enforcement** (the `web`/`actOrigins` half; 03 shipped the
   store): READ tools work as today; ACT tools (click/type/select/eval/
   navigate) require the page origin ∈ `actOrigins` — computed AT
   DISPATCH TIME inside `agentAct()`, the one choke point every
   transport funnels through. Refusal names grant + origin, CLI-worded.
   `SENSITIVE_ORIGIN_PATTERNS` refuse at BOTH ends: editor won't save,
   dispatch refuses even if persisted. Cross-origin iframes: act refuses
   unless BOTH origins granted. Preview ignores `actOrigins`. Instrument
   NOW: `agentAct()` emits acts/refusals/confirms/origin-changes via the
   `recordTrail()` stub (no-op until 05) — origins + verbs only.
3. **Human-in-the-loop, session-scoped**: the first ACT per granted
   origin per possession raises the banner confirm ("allow acting on
   {origin} this session") — one click, then quiet; cleared on Stop.
   Cross-origin navigation lands an origin-change alert + trail event.
4. **Session controls**: dock menu gains "Signed-in sites…" — origins
   with cookies in agent-web (our OWN partition), each with forget
   (cookies.remove + clearStorageData) + "Clear all agent logins".
   Minimal grant editor (06 is the home).
5. **AGENTWEB smoke** (`MOGGING_AGENTWEB`, env-gated, in qa-smokes.sh):
   localhost fixture site (login → cookie session → a state-changing
   button; second port = foreign origin): (a) preview = shipped behavior;
   (b) ungranted → snapshot OK, click REFUSED naming grant + origin;
   (c) granted + confirmed → click lands; (d) origin-change alert on
   cross-port nav; (e) blocklisted pattern (test-only env) refused at
   save AND dispatch; (f) forget-site kills the session; (g) cookie
   survives dock close/reopen; (h) vault-less arm (probe hook) →
   non-persist partition + the copy rendered. Verdict
   `out/agentweb-result.json`; zero external network.

## Files
- `src/main/browser-dock.ts` · `src/ui/features/browser/` ·
  `@backend/features/integrations` · agentweb-smoke.ts · qa-smokes.sh ·
  gallery (both themes)

## Definition of Done
- Dev-verified (books): sign into a real site in agent-web, grant the
  origin, an agent completes a task; ungranted → reads, cannot act.
- Preview unchanged (BROWSER + BROWSERCTL untouched-green).
- AGENTWEB gate green; docs/13 § "The session, honestly" updated for two
  profiles + the custody rule; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; MILESTONE + PERCEPTION re-run.

## Guardrails
- NO system-browser cookie/keychain reads — Branch B stays parked; this
  step must not create its plumbing.
- `browser_eval` counts as ACT in agent-web — no read-tier exception.
- Trail emissions record origins/refs only — never page content, eval
  bodies (6/05b lesson), or cookies. Telemetry: counts/booleans; origins
  never leave the machine (ADR 0005).
