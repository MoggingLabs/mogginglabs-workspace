# 06 — The silent reconciler: drift becomes "Needs attention → Fix"

Read README + the survey first. Builds on steps 03 and 05.

## Goal
Retire the drift/apply/adopt/forget VOCABULARY without losing one byte of its safety.
The mgr engine (surgical writes, backups, marked-entries-only) stays the mechanism;
the user sees a tool whose Claude Code config needs fixing, and a Fix button.

## Deliverables
1. **Classification stays, presentation collapses.** Backend mgr states
   (`not-applied` / `applied` / `drift-edited` / `drift-missing`) survive untouched.
   On the tool card: healthy = silent (applied is the invisible normal); otherwise
   `Needs attention` with ONE user-words sentence in the detail ("Claude Code's
   config for this tool was edited by hand" / "…was removed outside the app") and ONE
   primary verb:
   - `drift-edited` → **Fix** = re-apply our block (backup first, as ever); quiet
     secondary link "keep my edit" (runs adopt — worded exactly that way);
   - `drift-missing` → **Fix** = re-apply; secondary "forget this tool on Claude
     Code" (runs the forget path);
   - `not-applied` where the user chose the cliOwned method → the step-05 chooser
     handles it; no drift language anywhere.
2. **Reconcile on the heartbeat.** Step 03's engine re-reads mgr status per beat
   (cheap stat/parse via the existing status-snapshot machinery and its
   request→push contract — no subprocess storms; respect the beat's wall-clock
   budget). Background drift raises the same attention path as a failed verify.
   **NO auto-write, ever** — Fix is always a click; the
   surgical-writes-on-your-click law survives verbatim.
3. **The mgr panel dies as a surface.** openPanel's preview/apply/adopt/forget UI is
   replaced by the detail's Fix flow — which KEEPS the diff preview before writing
   (the trust artifact), retitled "what Fix will change". Backups line stays, plainly
   worded ("we keep backups — latest: {ts}").
4. **Claude Code only.** Reconciliation renders only for claude-code this phase.
   Other CLIs' drift stays detected (backend truth intact) but surfaces NOWHERE — a
   coming-soon CLI must not raise attention the user cannot act on.
5. TOOLWORDS enforcement extends to every new reconciler string.

## Gate — TOOLFIX
Env-gated smoke with a scratch CLI-config fixture — the gate-isolation laws are
BINDING here (config-dir pointers into the smoke sandbox, NEVER the real user config;
the AGENTCFG/SETAGENTCFG leak lesson): (a) hand-edit the marked block → heartbeat
classifies, card shows Needs attention, detail shows the user-words sentence + diff
preview, Fix re-applies byte-identically, backup file created; (b) delete the block →
Fix restores it; (c) "keep my edit" adopts — config untouched, status healthy;
(d) **the no-unclicked-write proof**: with drift present across two accelerated
beats, config mtime unchanged until Fix is clicked; (e) a codex-config drift raises
nothing. Mutation-red ×2: break the classifier mapping ((a) red); break the
click-only guard so the reconciler auto-applies ((d) red).

## Guardrails
- Zero new writers — every write path is the existing mgr channel.
- Run in worktree/sandbox isolation (single-gate run hygiene; sweep orphaned
  electron processes between runs).

## Done when
TOOLFIX green with both mutation-reds (including the auto-write mutation); sweep
green vs baseline; no UI string carries drift/apply/adopt vocabulary (TOOLWORDS
enforcing passes).
