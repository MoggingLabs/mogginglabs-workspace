Freeze the pack the house way (Phase-11/07): write the book
(docs/16-files.md), finish the gallery, and prove the whole promise in ONE
composed milestone smoke — a scripted agent writes into the workspace and
the explorer shows it, decorated, live, actionable — then certify the full
sweep on all three CI OSes.

## Steps
1. **docs/16-files.md**: the custody stance (ADR 0010); the liveness law
   + pool/coalescing/fallback semantics; the decoration table (letters,
   tokens, propagation, ignored); the Changes lens; the keyboard map;
   per-OS notes (drive roots, Explorer/Finder labels, quoting); measured
   perf numbers; a scripted demo (only `mogging …` + the app). Update
   `docs/02-mvp-and-roadmap.md` (Phase 11 section), `prompts/README.md`
   (phases row → done), the README roadmap line; RESEARCH.md stays the
   sourced record.
2. **Gallery completeness**: `part()`s in BOTH themes for — the open tree
   (badged), the Changes lens, the context menu, the no-folder
   EmptyState, a refusal row; staged on the fixture world (no usernames
   in visible crumbs; `out/gallery/errors.json` empty).
3. **`MOGGING_FILESMILESTONE`** (env-gated, fixture git workspace + the
   shell provider, zero network, zero vendor CLIs): one composed run —
   open via the FAR-RIGHT toggle → tree on the workspace folder → expand
   three dirs → a scripted pane writes/modifies/deletes files →
   coalesced batches land ≤ 1s, badges flip on the next tick, the
   Changes count matches porcelain → lens on/off restores expansion →
   open + copy + send-to-pane verbs hit the spy / clipboard / pane tail
   correctly → workspace switch re-roots ≤ 100ms with remembered
   expansion → a no-folder workspace shows the EmptyState → close the
   explorer → watchStats 0 handles, 0 polls, zero `git:files*` traffic.
   Assert attention untouched: a seeded attention chip survives the
   whole run. Verdict `out/filesmilestone-result.json`.
4. **Budgets, measured DURING the composed surface**: MILESTONE (16
   panes + the open explorer + a write torrent: worst gap ≤ 150ms, avg
   fps ≥ 30, heap ≤ 300MB) and PERCEPTION (workspace switch ≤ 100ms with
   the explorer open; 0 frames > 100ms under torrent) — UNCHANGED
   numbers, recorded per-OS in REPORT.md.
5. **Sweep + freeze**: all seven gate rows (FSLIST, FILETREE, EXPLORER,
   TREELIVE, TREEGIT, FILEACT, FILESMILESTONE) wired into
   `scripts/qa-smokes.sh` docs + CI; the full uncut sweep green — local
   Windows AND the three CI OSes in one clean dispatch; README § Freeze
   ledger (per-step commits, run ids); REPORT.md receipts (measured
   numbers, platform finds, root causes); errata go to REPORT.md only.

## Files
- `docs/16-files.md` · `docs/02-mvp-and-roadmap.md` ·
  `prompts/README.md` · `src/main/filesmilestone-smoke.ts` ·
  `src/main/gallery.ts` (parts) · main dispatch · qa-smokes.sh + CI
  workflow rows · `prompts/phase-11/README.md` (§ Freeze) · REPORT.md

## Definition of Done
- The full sweep — every gate, including the seven new ones — green on
  local Windows AND all three CI OSes in one clean dispatch; both perf
  budgets numerically unchanged.
- One glance at the open explorer answers: what is here, what changed,
  what my agents just touched — and the docs/16 demo works on a fresh
  machine exactly as written.
- The pack is frozen: README § Freeze filled, REPORT.md carries the
  receipts.

## Checks that must be green
- typecheck 0; build ok; static gates (AUDIT · SPACING · PTYSEAM ·
  PROTOVER); the FULL sweep on all environments; both perf budgets.

## Guardrails
- The milestone smoke is the ONLY authority on "Phase 11 done" — no
  partial credit, no gate skipped on any OS.
- ADR 0005 sweep before freeze: grep telemetry calls for path/filename
  strings — counts and booleans only.
- ADR 0010 sweep before freeze: grep the explorer channels for any write
  verb — there must be none; protocol still v5.
