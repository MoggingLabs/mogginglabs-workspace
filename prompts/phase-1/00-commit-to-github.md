# 00 — Commit Phase 0 and push to GitHub (MoggingLabs) — DONE

**Status:** DONE 2026-07-01. **Shared context:** see `README.md`.

## Goal
Commit all Phase-0 work and push it to a new **private** GitHub repo under the
**MoggingLabs** org, so the validated milestone is versioned and shareable.

## Steps (as executed)
1. `git -C <repo> add -A`
2. `git -C <repo> commit -F <message>` (milestone message + `Co-Authored-By` trailer)
3. `git -C <repo> branch -M main`
4. `gh repo create MoggingLabs/mogginglabs-workspace --private --source <repo> --remote origin --push`

## Result
- Repo: **github.com/MoggingLabs/mogginglabs-workspace** (private, org `MoggingLabs`).
- Branch `main`, initial commit `8812f64`, SSH remote, `origin/main` tracking set.
- `node_modules/` and `out/` excluded via `.gitignore`; source + docs + prompts +
  lockfile committed.

## Files
- Repo-wide (initial commit). `.gitignore` (excludes build/deps), `package-lock.json`.

## Definition of Done
- Private repo exists under MoggingLabs; `main` pushed.
- Build output + dependencies excluded; no secrets committed (the app holds none — see
  the ADR 0002 credential audit).

## Checks that must be green
- `gh repo view MoggingLabs/mogginglabs-workspace` succeeds.
- `git -C <repo> status` clean; `git log --oneline -1` shows the milestone commit.

## Guardrails
- **Private** (pre-launch experiment). Do not make public without an explicit decision.
- Never commit secrets. (Name note: `mogginglabs-workspace`, matching the MoggingLabs
  branding — not "moking".)
