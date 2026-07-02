Freeze Phase 6 the house way: ONE asserted proof that a stranger's machine goes from
installer to a working swarm — then v0.4.0 on all three platforms, with the sweep
recorded per-OS.

## Steps
1. **Smoke** (`MOGGING_PRODUCT`, two-phase like every milestone):
   - **Phase A — the five-minute path, asserted.** Isolated FRESH boot → first-run
     checklist present (05) → wizard opened via its CTA → a real workspace with the
     Swarm preset (shell provider for determinism) at a temp repo → roles chipped,
     worktrees created, a per-slot profile chosen (03: it must survive the smoke's
     restart phase) → the checklist collapses (all three rows true) → a browser
     pane opens beside the agents (04, localhost page served by the smoke) →
     `mogging mail/claim/approve` one-liners prove the swarm substrate is
     reachable from the panes → review → gated merge lands.
   - **Phase B — budgets with EVERYTHING on.** Board visited, browser pane live,
     checklist rendered, 12+ panes, 3 s torrent + 4 switches: machine budget
     unchanged (≤150 ms / ≥30 fps / ≤300 MB); PERCEPTION re-runs in the sweep.
2. **Full sweep, three platforms**: run `bash scripts/qa-smokes.sh` locally (Windows)
   and via the 01/02 CI jobs (Linux, macOS). All gates — now including PROFPERSIST,
   BROWSER, FIRSTRUN, PRODUCT — must pass on all three. Record the per-OS numbers in
   `prompts/phase-6/README.md` (milestone/perception per platform).
3. **Release v0.4.0 — "Product"**: clean tree, bump, `npm run dist`, commit, push,
   `gh release create v0.4.0` with notes (browser pane, first-run, update UX,
   three-platform parity, per-OS numbers). The tag's release workflow attaches
   win NSIS + mac dmg/zip + linux AppImage/deb to the same release; verify all
   artifacts landed + `latest.yml`/`latest-mac.yml`/`latest-linux.yml` feeds exist.
   Installer copy to the Desktop. Regenerate the winget/homebrew manifests (02) from
   the new artifacts; open the submission checklist in `docs/10-distribution.md`.
4. **Docs close-out**: README status → Phase 6; roadmap checkboxes in `docs/02`;
   pack README rows → DONE with numbers; the sweep record section (mirror phase-4's
   close).

## Files
- `src/main/product-smoke.ts` + `src/main/index.ts` · `scripts/qa-smokes.sh`
- package.json · README · `docs/02-mvp-and-roadmap.md` · `docs/10-distribution.md`
- `packaging/` manifests · `prompts/phase-6/README.md`

## Definition of Done
- `MOGGING_PRODUCT` green: installer-fresh state → guided setup → swarm + browser,
  all in one asserted flow, budgets intact.
- The full sweep green on Windows, Linux, AND macOS — recorded per-OS.
- v0.4.0 live with artifacts + update feeds for all three platforms; manifests
  regenerated and validation-green.

## Checks that must be green
- `npm run typecheck` → 0; build ok everywhere; boundary greps clean.
- Every `MOGGING_*` gate isolated via qa-smokes.sh, three platforms.
- No URLs, card/mail text, paths, or hostnames in telemetry (final
  phase-wide grep, recorded in the pack README).

## Guardrails
- Never tag on a red or partial sweep — on ANY platform. If macOS/Linux CI is red,
  the release waits.
- Do NOT relax budgets to pass Phase B with the browser surface on — it was built
  off the hot path; keep it there (01's CI-GPU mode exists ONLY for
  xvfb CI, never desktop).
- Deterministic shell provider everywhere; local HTTP for the browser assertions;
  vendor TUIs stay unasserted (OSC over hooks, hooks over parsing).
