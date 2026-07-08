Board + palette (Phase-8.5/07). The board has been the orchestration heart since
Phase 3 and still renders as a bare list: phantom flex items waste **29%** of a
card, chips wrap wherever they land, the ⋯ menu is clipped by its own lane
scroller, and `Delete card` is irreversible with no confirm. The palette's empty
query is "the first 12 commands whose feature mounted first".

## Steps
1. **Board** (`features/board/`): lanes get token gutters and a sticky header
   (name + `CountBadge`). Cards become `Card`s — title, note preview, then ONE
   aligned chip row (bound-pane state dot, attention ring, worktree branch, the
   8/12 PR/issue service chip with its review/checks states) instead of chips
   wrapping. Delete the phantom flex items. Fix the ⋯ menu clipped by the lane
   scroller. Drag affordance + drop targets become visible (grab cursor, insert
   line). Order the ⋯ items by frequency (Start agent · Link PR · Move · Remove).
   All board channels and the `data-attention` / chip classes the BOARD and INTEG
   gates assert stay exactly as they are.
2. **Bug #7 (safety)**: `Delete card` (`board/index.ts:328`) is irreversible with
   **no confirm**, contradicting `confirm.ts`'s own doc comment ("wire the
   confirm", not "remember to"). Wire it, with the 07b danger pattern.
3. **Palette** (`features/palette/`): result rows on the rhythm — icon · title ·
   hint column · shortcut chip right-aligned. Rank by context (workspace verbs
   first in a workspace). Match highlighting. An empty query lists the top verbs,
   not registration order. Every existing verb id unchanged — they are an API
   (smokes + muscle memory).
4. **Removals + drift**: #7 — `.board-lane-count` → `CountBadge()`, which brings
   `tabular-nums`, so **the count stops jittering as cards drag**. #8 — the dead
   `CountBadge` / `TextInput` / `mount` exports (adopt `CountBadge` per #7 first,
   then it is live). #18 — `?? el('span', {})` ×2, since `el()` already drops
   nulls, and `.board-card-foot { min-height: 16px }` with them. Clear this
   surface's bucket rows: `.board-chip`, `.board-lane-count`, `.board-link-chip`,
   `.palette-item` — **plus** `.palette-overlay { padding-top: 12vh }`, a bypass
   `check-spacing.mjs` cannot see (it reads px only).
5. **BOARDUX smoke** (`MOGGING_BOARDUX`, env-gated, qa-smokes.sh): fixture board —
   (a) a card with pane + service-link fixtures renders ONE chip row, aligned
   (bounding-box assert: chips share a baseline); (b) lane headers show counts and
   stick under scroll; (c) the ⋯ menu opens fully inside the viewport, not clipped;
   (d) `Delete card` raises a confirm, and cancelling keeps the card; (e) palette
   opens, an empty query shows top verbs, a query highlights matches, Enter runs
   the verb; (f) computed: lane gutter ≥ `--sp-4`, card padding ≥ `--sp-4`;
   (g) AA on card + lane text, four themes, via `aa-probe.ts` (06). Verdict
   `out/boardux-result.json`.

## Files
- `features/board/` · `features/palette/` · `components/pill.ts` (CountBadge) ·
  `components/{input,dom}.ts` (dead exports) · board + palette CSS blocks ·
  `src/main/boardux-smoke.ts` · main dispatch · qa-smokes.sh row · gallery

## Definition of Done
- AUDIT grades **Board D → A**, **Palette C− → A**.
- BOARD, INTEG, GATE, LEDGER green (they drive these surfaces); BOARDUX green.
- REMOVE #7, #8, #18 ✅; bug #7 ✅. The board/palette rows leave the `feedback`
  bucket; 07b takes the rest.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- Palette verb ids are an API — rename nothing.
- Board channels + `data-attention` are a compatibility surface; restyle around.
- A destructive action gets a confirm; a confirm gets a safe default (07b).
