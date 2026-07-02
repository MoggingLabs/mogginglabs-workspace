# 04 — Pre-ship diff review (secret-redacting, injection-resistant)

**Prereq:** `03` green. **Shared context:** `prompts/phase-3/README.md` + ADR 0002/0005
+ `docs/03-research-synthesis.md` §risk "agents shipping unreviewed changes".

## Goal
NOTHING an agent wrote lands without a human reading it. A per-worktree **Review**
surface: the full diff versus the base branch, rendered safely (no markup execution, no
terminal escapes), with secrets redacted, and an explicit, guarded path to merge.

## Steps
1. **Backend** (`src/backend/features/review/`): `diffWorktree(repo, worktree)` →
   `git -C <worktree> diff <base>...HEAD --unified=3 --no-color` + `--stat` (execFile;
   base = the branch the worktree forked from, recorded by 03). Output cap (e.g. 2 MB —
   beyond that return the stat + per-file on demand).
2. **Redaction pass** (pure, tested): before ANY diff text leaves the backend, run a
   deny-pattern scrub (AWS/GCP keys, `-----BEGIN … PRIVATE KEY`, `ghp_…`/`github_pat_…`,
   `sk-…`, JWT-shaped, `password/token/secret = <value>` pairs) → replace the value with
   `«redacted»`. Patterns in one reviewed module with unit-style asserts in the smoke.
3. **Contracts**: `ReviewChannels = { diff:'review:diff', merge:'review:merge' }`;
   `ReviewDiff { files: { path, additions, deletions, hunks: string[] }[], truncated }`.
   `merge` performs `git -C <repo> merge --no-ff <branch>` ONLY when the repo is clean,
   returns a typed success/conflict result — never auto-resolves.
4. **UI** (`src/ui/features/review/`): pane ⋯ menu + palette: **"Review changes…"** →
   a wizard-shell modal: file list (stat) → per-file hunks rendered as TEXT NODES into
   `<pre>` (never innerHTML — injection-resistant by construction), add/del line tinting
   via `--success`/`--danger`, mono everything. Footer: [Copy patch] [Merge into <base>…]
   (typed confirm) [Close]. Merge conflicts surface as a neutral "resolve in a terminal"
   state — we never mutate beyond the guarded merge.
5. **Smoke** (`MOGGING_REVIEW`): temp repo + worktree with (a) a normal edit and (b) a
   planted fake `ghp_XXXX` secret → assert: diff arrives, secret is `«redacted»`, hunks
   render as text (a `<script>` string in a diff line stays inert — assert no element
   was created), merge lands the branch (clean case) and reports conflict (dirty case).

## Files
- `src/backend/features/review/` (+ redaction module) · `src/contracts/ipc/review.ipc.ts`
- `src/main/review.ts` + `src/main/index.ts` · `src/ui/features/review/`
- `src/main/review-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Worktree → Review → redacted, safely-rendered diff → explicit merge or explicit stop.
- A planted secret never reaches the DOM; a hostile diff line never becomes markup.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_REVIEW` green isolated; `MOGGING_WORKTREE` still green.

## Guardrails
- Diff text is user content: render via textContent ONLY; never innerHTML/insertAdjacentHTML.
- Diff content never enters telemetry, logs, or persisted state (counts are fine).
- Merge is the ONLY mutating verb, gated on clean state + typed confirmation.
