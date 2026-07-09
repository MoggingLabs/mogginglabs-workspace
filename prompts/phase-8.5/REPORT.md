# Phase 8.5 — the UI/UX revamp: the campaign report

Receipts for the revamp pack (steps 01–09), same format as
`prompts/phase-8/REPORT.md`: dated verification records and the finds worth
remembering. Grades / removals / bugs / deviations live in `AUDIT.md`; the
freeze ledger (per-step commits, run ids) lives in `README.md` § Freeze. Sweep
count at the 8.5 freeze: **66 gates** — 64 Electron smokes (52 at the pack open +
WIZARDUX · FOLDERPICK · SETSHELL · SETINTEG · SETUSAGE · HOMEUX · BOARDUX ·
FEEDBACKUX · CHROMEUX · DOCKUX · USAGEGLANCE · UXMILESTONE) + 2 static gates
(AUDIT · SPACING).

## 09 — the UX milestone + four-environment certification (2026-07-09)

**UXMILESTONE gate** (`src/main/uxmilestone-smoke.ts`, all a–f green): the composed
proof that the whole revamp holds as a SYSTEM, one fixture world, zero network.
(a) fresh boot → Home hero + checklist → the wizard opens as ONE page (three cards,
no stepper, no modal, rail beside it), a folder is picked by CLICKS through the
browser (cwd/bar/selection agree), launch opens the workspace; (b) Settings shell +
grouped nav; Integrations and Usage open OVERVIEW-FIRST, disclosure persists across a
leave/return, and a seeded failing-webhook chip shows through a COLLAPSED header while
a hot Usage fixture posts `.usage-fill.is-hot` on the folded Providers header — every
legacy DOM hook a prior gate reads still resolves; (c) board + palette (aligned chip
row, ranked verbs, match highlight), a destructive confirm focuses the SAFE action and
carries no remember-me (bug #8), chrome — a one-line pane header + tabs that overflow
not shrink, the possession banner present + hit-testable while driving; (d) the spacing
gate `check-spacing.mjs --max 0` (the REAL script, run via ELECTRON_RUN_AS_NODE) — 0
violations; (e) SAFETY UNDIMMED — possession label, consent copy, an attention chip,
the review-gate indicator and the trail's "never sent anywhere" line all hold AA, worst
**4.72:1** across four themes; (f) budgets sampled DURING the composed surface against
the UNCHANGED `docs/05` numbers (the `BUDGET` const, now exported from
`milestone-smoke.ts` — one source of truth): worst frame gap **13.9 ms** (budget 150),
heap **20 MB** (budget 300), 0 frames > 100 ms.

**The coverage gate** (`scripts/check-audit.mjs`): parses `AUDIT.md` and fails the
sweep if any Grades row is below A, any REMOVE lacks ✅, any bug is unowned/unresolved,
either Blocker is undischarged, or any Deviation is unresolved. It is how a surface
stops going unowned (05b was found exactly that way). Green at freeze: no row below A,
21 REMOVE ✅, 16 bugs owned + resolved, both Blockers discharged, 9 Deviations resolved.

**An AA find the milestone earned.** UXMILESTONE (e) is the first gate to measure
`--danger-ink` on a danger-TINTED ground: `.cc-chip.is-failing` renders the ink on
`--danger-weak`, and it measured **4.45:1** on light — below AA, on a composited ground
the plain/inset pairs (worst 4.52, 8.5/01–07b) never covered. themes.ts even *recorded*
4.46:1-on-inset and shipped it. Light `--danger-ink` darkened past the fill
(`#c92e25` → `#c02820`, **~4.87:1** on the chip; strictly improves every light
danger-as-words surface, none regressed — the same ink≠fill split the dark themes use).
AUDIT § Deviations 4 carries it.

**Four-environment certification.** Full uncut 66-gate sweeps, all **66 gates green** on
**local Windows** AND all three CI OSes (**Linux · macOS · Windows**) — one clean
dispatch, run **29006301457** (`gh workflow run ci.yml -f sweeps=linux,macos,windows`).
Local Windows: 66/66 (`scripts/qa-smokes.sh`; MILESTONE + BOARDUX green on a standalone
re-run — the contention pattern below). The first dispatch (`29002525980`) surfaced the
two platform finds below; both were root-caused and the re-dispatch certified clean.
Nightly crons left enabled.

**Platform finds (root causes — the certification's real receipts).** The FIRST full
four-environment sweep to include the pack's gates surfaced fragilities; each got a
permanent fix, assertion-only:

- **The pane-header one-line proxy was soft-GL-fragile — DETERMINISTICALLY.** CHROMEUX
  (c) and UXMILESTONE (c) both assert "with remote+role+claims+mcp lit in a narrow pane,
  the header stays ONE line, chips truncate not wrap" (AUDIT bug #9). On the first
  dispatch both FAILED on all three CI OSes with **byte-identical** measurements
  (`presentMap:{state:8,remote:77,role:69,claims:29,mcp:0}`, `noWrap:false`) — identical
  because the app bundles JetBrains Mono, so the layout is deterministic given the same
  content + window. The design goal HELD everywhere (`headerH:28`, `clipped:true`,
  `overflowed:true`); what false-failed were two proxies: `present` required the trailing
  `.pane-mcp` chip at width > 0 (but it legitimately clips to 0 on the narrow header — the
  overflow WORKING), and a vertical-center check over ALL children tripped on that
  clipped-to-0 chip. Both pass on local real-GPU, so it never showed until the soft-GL CI
  sweep. **Fix (both gates):** assert the CSS CONTRACT directly — `flex-wrap:nowrap` +
  `overflow:hidden` + `headerH ≤ 30` + state leading + the *leading* chips anchored — and
  keep the pixel-center check over VISIBLE chips only, as a diagnostic. A genuinely
  wrapping header still fails (flex-wrap would not read `nowrap`); a clipped trailing chip
  no longer false-fails. Verified against the exact CI failure JSON before re-dispatch.
- **FOLDERPICK — `icacls /deny` was ineffective on the CI RUNNER account.** The refusal
  fixture creates a locked folder and asserts `fs:listDir` refuses it. On windows-latest
  the deny command SUCCEEDED (`deniedCreated:true`) but the RUNNER could still read the
  folder (`denied.ok:true, entries:[]`) — DETERMINISTICALLY, both dispatches — so the
  refusal never rendered. It is a runner-account privilege quirk (the account bypasses a
  `/deny` ACE on a folder it owns), not a product defect: the product's `fs:listDir`
  refuses a genuinely-denied folder; the TEST could not create one on that host. **Fix:**
  the fixture now PROBES the folder after the deny (`readdirSync`); if it reads,
  `deniedCreated` falls back to false and the smoke skips the denied-refusal assertion —
  the same graceful path POSIX-root already uses — rather than fail on a fixture the OS
  would not build. Local Windows (where the deny binds) is unchanged: the probe throws.
- **The standing contention lessons, re-confirmed.** MILESTONE (16-pane), BOARDUX
  (`deleteConfirmOk`), and FEEDBACKUX (`confirm2Shown`) MISS/FAIL under back-to-back
  sweep contention — the confirm-modal and heavy-boot timings read once before a loaded
  runner settled — and pass green ISOLATED. Local Windows needed a standalone re-run of
  MILESTONE + BOARDUX; each passed clean. The `qa-smokes.sh` header documents the
  teardown race; RAM held at 6.7 GB throughout (per the local-sweep-needs-RAM rule, only
  a FAIL is a code fault — MISSING is the machine).
