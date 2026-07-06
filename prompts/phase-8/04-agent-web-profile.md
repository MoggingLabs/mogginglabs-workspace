The Comet resolution, the safe branch: a dedicated **agent web profile** —
real logins the user creates ON PURPOSE inside the dock, separate from the
empty preview session AND the system browser (FINDINGS Branch C). Agents
act as the user — only on granted origins, never on the blocklist, reads/
acts separated, every act instrumented for 05's trail (ADR 0008.e).

## Steps
1. **Two partitions, one dock**: `persist:browser-dock` stays the PREVIEW
   profile, byte-for-byte. Add `persist:agent-web` — same hardening via
   an extracted `hardenSession()` on both — and a dock-chrome switch
   (Preview ⇄ Agent web, per-workspace choice persisted). Two lazy views,
   attach-swapped (a partition is fixed at creation). Sign-ins live ONLY
   in agent-web; a quiet banner says sessions persist and agents act on
   granted origins.
2. **Grant enforcement** (the `web`/`actOrigins` half; 03 shipped the
   store): READ tools (snapshot/screenshot/console/network/wait_for) work
   as today; ACT tools (click/type/select/eval/navigate) require the page
   origin ∈ `actOrigins` — computed AT DISPATCH TIME inside `agentAct()`,
   the one choke point every transport funnels through. Refusal names the
   grant + origin, CLI-worded. `SENSITIVE_ORIGIN_PATTERNS` refuse at BOTH
   ends: editor won't save, dispatch refuses even if persisted. Cross-
   origin iframes: act refuses unless BOTH origins granted. Preview
   ignores `actOrigins`. Instrument the choke point NOW: `agentAct()`
   emits acts/refusals/confirms/origin-changes via a `recordTrail()` stub
   (no-op until 05) — origins and verbs only, never selectors, text, or
   eval bodies.
3. **Human-in-the-loop, session-scoped**: the first ACT per granted
   origin per possession raises the banner's confirm ("allow acting on
   {origin} this session") — one click, then quiet; cleared on Stop/
   possession end. Cross-origin navigation lands an origin-change alert
   in the banner + a trail event.
4. **Session controls**: dock menu gains "Signed-in sites…" — origins
   with cookies in agent-web (our OWN partition, `session.cookies`), each
   with forget (cookies.remove + clearStorageData) — plus "Clear all
   agent logins". Minimal grant editor (06's section is the home).
5. **AGENTWEB smoke** (`MOGGING_AGENTWEB`, env-gated, in qa-smokes.sh):
   localhost fixture site (login → cookie session → a state-changing
   button; second port = foreign origin): (a) preview = shipped behavior;
   (b) ungranted → snapshot OK, click REFUSED naming grant + origin;
   (c) granted + confirmed → click lands; (d) origin-change alert on
   cross-port nav; (e) blocklisted pattern (test-only
   `MOGGING_TEST_BLOCK_ORIGIN`) refused at save AND dispatch; (f) forget-
   site kills the session; (g) cookie survives dock close/reopen. Verdict
   `out/agentweb-result.json`; zero external network.

## Files
- `src/main/browser-dock.ts` · `src/ui/features/browser/` ·
  `src/backend/features/integrations` · `src/main/agentweb-smoke.ts` ·
  qa-smokes.sh gate row · gallery (both themes)

## Definition of Done
- Dev-verified (books): sign into a real site in agent-web, grant the
  origin, an agent completes a task there; ungranted → reads, cannot act.
- Preview behavior unchanged (BROWSER + BROWSERCTL untouched-green).
- AGENTWEB gate green; docs/13-browser.md § "The session, honestly"
  updated for two profiles; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- NO system-browser cookie/keychain reads — Branch B stays parked; this
  step must not create its plumbing.
- `browser_eval` counts as ACT in agent-web — no read-tier exception, ever.
- Trail emissions record origins and refs only — never page content, eval
  bodies (the 6/05b leak lesson), or cookies. Telemetry: counts/booleans;
  origins never leave the machine (ADR 0005).
