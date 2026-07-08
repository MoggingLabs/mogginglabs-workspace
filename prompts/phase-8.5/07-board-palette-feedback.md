Board, palette, and the feedback language (Phase-8.5/07). The app talks to
the user through cards, toasts, confirms, empty states, and the palette —
each grown ad-hoc across phases with its own paddings and tones. This step
unifies them into ONE feedback language on the 01 system, and gives the
board (the orchestration heart since Phase 3) the visual weight its job
earned: lanes that breathe, cards that carry their chips cleanly.

## Steps
1. **Board** (`src/ui/features/board/`): lanes get token gutters + a
   sticky lane header (name · count pill); cards become proper `Card`s —
   title, note preview, then ONE aligned chip row (bound-pane state dot,
   attention ring, worktree branch, the 8/12 PR/issue service chip with
   its review/checks states) instead of chips wrapping wherever they
   land. Drag affordance + drop targets get visible (grab cursor, insert
   line); the card ⋯ menu items order by frequency (Start agent · Link
   PR · Move · Remove) per AUDIT.md. All board channels + the
   `data-attention` / chip classes the BOARD and INTEG gates assert stay.
2. **Palette** (`src/ui/features/palette/`): result rows on the rhythm —
   icon · title · hint column · shortcut chip right-aligned; a section
   order that ranks verbs by context (workspace verbs first in a
   workspace); match highlighting; an empty-query state listing the top
   verbs instead of a blank list. Every existing verb id unchanged.
3. **Toasts + confirms** (`src/ui/components/toast.ts` / `confirm.ts`):
   one visual family — tone stripe (info/success/warn/error), consistent
   padding, max-width, stacking gap, and ONE animation curve; confirms
   get the danger-action pattern (destructive verb red, safe verb ghost,
   focus lands on safe). The WS-01 close-undo toast and single-fire
   needs-auth toasts (7/09 discipline) keep their exact trigger logic.
4. **Empty states everywhere**: sweep every feature for bare "nothing
   here" text and route it through the house `EmptyState` (icon · line ·
   action) — board lanes, trail, recents, registry results, usage
   history. AUDIT.md's list is the checklist.
5. **BOARDUX smoke** (`MOGGING_BOARDUX`, env-gated, qa-smokes.sh):
   fixture board — (a) a card with pane + service-link fixtures renders
   ONE chip row, aligned (bounding-box assert: chips share a baseline);
   (b) lane headers show counts and stick under scroll; (c) palette opens,
   empty-query shows top verbs, a query highlights matches, Enter runs
   the verb (existing behavior re-asserted); (d) a success + an error
   toast render the tone family and stack with the token gap; (e) a
   destructive confirm focuses the SAFE action first; (f) two EmptyState
   consumers render icon + action (board lane, trail). Verdict
   `out/boardux-result.json`.

## Files
- `src/ui/features/board/` · `src/ui/features/palette/` ·
  `src/ui/components/toast.ts` / `confirm.ts` / `empty-state.ts` ·
  feature CSS blocks on tokens · `src/main/boardux-smoke.ts` · main
  dispatch · qa-smokes.sh row · gallery (both themes)

## Definition of Done
- One feedback language: any toast/confirm/empty state anywhere is
  visually the same family; grep finds no feature-local toast styling.
- The board reads at a glance: lane → card → chips, no wrapped clutter.
- BOARD, INTEG, WSCLOSE, GATE gates still green (they drive these
  surfaces); BOARDUX green; count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- Trigger logic is sacred: what fires a toast/confirm and how often
  (single-fire, undo grace) does not change — only how it looks.
- Palette verb ids are an API (smokes + muscle memory) — rename nothing.
