The feedback language (Phase-8.5/07b). Toasts, confirms, modals, empty states — one
family, grown ad-hoc: five widths, three radii, only the toast animates out. Under
the styling sit three real defects. **The most destructive confirm in the app can be
permanently silenced.** The review modal puts the danger button before Cancel and
never focuses the safe one. And **2 of 26** "nothing here" surfaces use the house
`EmptyState`.

## Steps
1. **One family** (`components/{toast,confirm,modal}.ts`): tone stripe, one padding,
   one radius, one `max-width`, one stacking gap, ONE curve — in and out. The WS-01
   close-undo toast and the single-fire needs-auth toasts (7/09) keep their trigger
   logic. **Bug #6**: `.btn--danger` carries no emphasis.
2. **Bug #8 — the safety bug.** Closing a workspace with a live agent passes
   `rememberKey: 'workspace.close'` (`workspace/controller.ts:451`): tick once,
   never asked again, agent killed silently forever after. Remove the key. A
   confirm you can permanently silence is not a confirm.
3. **Review modal (D)** (`features/review/`): `footer.append(input, go, cancel)`
   puts the destructive action *before* Cancel; focus never lands on the safe one;
   the gated CTA reads "Override & merge" as a filled primary. Safe-first,
   safe-focused, danger de-emphasized. The typed confirmation stays — it is the
   actual guard. **Bug #2**: `review-smoke.ts:115` calls `m.parentElement.remove()`
   on what `modal.ts:102` returns as the OVERLAY — it removes `<body>`. Fix.
4. **Blocker 2** (AUDIT § Blockers — owned by nobody until now):
   `.review-gate-open` / `.review-gate-closed`, the reviewer sign-off indicator and
   the whole point of the 4/03 gate, have **no smoke coverage at all**, and differ
   by colour alone. Give them a non-colour difference (icon or word) and a gate.
5. **Empty states**: route all 26 "nothing here" surfaces through `EmptyState`
   (icon · line · action), replacing six hand-rolled classes. Its `action?: Node`
   has **no caller anywhere** — give it its first. AUDIT § "Empty states" lists them.
6. **Removals + drift**: #5 (`.review-footer::before`, the double divider's
   surviving half), #9 (`.pill--accent/-success/-danger`, dead tones). **UNSURE
   (audit, no owner)**: `resetConfirmSkipsForSmoke` has zero grep-visible callers,
   yet commit `a74a68d` fixed a Windows-CI confirm race with it — decide with
   evidence. Clear the rest of the `feedback` bucket (`.toast`, `.menu-item`,
   `.menu-empty`, `.review-gate`, `.pill`) **plus `.segmented-item`**, the lone
   no-owner row.
7. **FEEDBACKUX smoke** (`MOGGING_FEEDBACKUX`): (a) success + error toasts share
   the tone family, stack at the token gap, both animate out; (b) a destructive
   confirm focuses the SAFE action and emphasizes its danger verb; (c) closing a
   workspace with a live agent ALWAYS confirms — twice, no remember-me (bug #8's
   regression test); (d) both `.review-gate-*` states render, distinguishable
   without colour; (e) the review footer is safe-first; (f) two `EmptyState`
   consumers render an `action`; (g) AA via `aa-probe.ts`. Verdict
   `out/feedbackux-result.json`.

## Files
- `components/{toast,confirm,modal,empty-state,pill,segmented}.ts` ·
  `features/review/` · `workspace/controller.ts` · the six hand-rolled empty classes
  · CSS · `feedbackux-smoke.ts` · `review-smoke.ts` · dispatch · qa-smokes.sh

## Definition of Done
- AUDIT grades **Toasts/confirms/modal C → A**, **Review modal D → A**, **Empty
  states F → A**. Blocker 2 discharged.
- `feedback` bucket **0** and the shared `—` row **0**.
- REVIEW, GATE, WSCLOSE, BOARD green; FEEDBACKUX green. REMOVE #5, #9 ✅; bugs
  #2, #6, #8 ✅; the UNSURE item resolved.

## Checks that must be green
- typecheck 0; build ok; boundaries clean; full local sweep.

## Guardrails
- Trigger logic is sacred — **except bug #8, where "how often" IS the bug**.
- Colour is never the only carrier of a safety state.
