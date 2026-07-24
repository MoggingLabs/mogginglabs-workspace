# Phase 11 — REPORT (receipts)

Measured numbers, platform finds, and root causes. Everything here is a number a
gate printed, not a number anyone hoped for. Errata live here and nowhere else.

**Environment for every figure below:** local Windows 11, `npm run dev` under
`scripts/qa-smokes.sh` isolation (fresh `MOGGING_USERDATA` + a fresh detached
daemon per gate). Dates 2026-07-11 / 07-12.

---

## 1. The seven gates, and what each one measured

### FSLIST (11/01) — the read service, zero UI

| Claim | Measured |
|---|---|
| files AND dirs, dirs-first, case-insensitive | `Apple, banana, locked, many, repo, Zeta, alpha.txt, Beta.md, dead-link, zulu.log` |
| hidden filtered; `showHidden` reveals both kinds | `.hushdir` + `.hushfile` appear only with the flag |
| cap + `truncated` | 1500 siblings → **1000 entries**, `truncated: true` |
| all four typed refusals | `denied` (a real deny ACE, verified to bind) · `missing` · `not-a-directory` · `invalid` |
| `isRepo` exactly on the repo dir | true on `repo/`, false everywhere else; absent on files |
| broken symlink | listed as a **file**, no throw |
| FOLDERPICK parity after the fs-paths extraction | `fs:listDir` byte-identical: dirs only, crumbs + parent + drive roots intact |

### FILETREE (11/02) — the virtualized tree

| Claim | Measured |
|---|---|
| 10k rows, scrolled end-to-end | **10,011 rows**; 251 frames; **0 frames > 100ms** |
| DOM row count bounded | peak **32** DOM rows against a computed bound of **32** |
| lazy | mount issues **1** listing (the root); each dir listed exactly on first expand |
| APG keyboard, mouse-free | full walk green; roving tabindex = exactly one `0` |
| virtualized-tree ARIA | `aria-level/setsize/posinset` correct on a 5-deep chain |
| hostile filename | `<img src=x onerror=…>` rendered as **text**; no element injected, no script ran |

### EXPLORER (11/03) — the dock

| Claim | Measured |
|---|---|
| re-root on workspace switch | **48ms** (budget 100ms) |
| width drag clamps | greedy drag capped at **432px** — the *content floor* bound first (1200 − 288 rail − 480 grid) |
| width floor | **240px** |
| KV persistence | drag settled at **360px**; `explorer:init` read back **360** |
| no-folder workspace | EmptyState, **0 rows**, **0 listing calls** |
| focus never stolen | `xterm-helper-textarea` kept the caret across close→open |
| toggle is the rightmost control | right of Settings, hit-testable, **29px** (the CHROMEUX hitbox contract) |

### TREELIVE (11/04) — the liveness law

| Claim | Measured |
|---|---|
| an agent's write → on screen | create **178ms** · delete **170ms** · rename **171ms** (budget 1s) |
| selection + scroll survive an update | selection kept; `scrollTop` 120 → **120** |
| a collapsed dir costs zero | **0 batches** from 20 writes into it |
| torrent coalesces | 500 files / 5 dirs → **1 batch**; **0 frames > 100ms**; max gap **7ms** |
| pool caps | 102 visible dirs → **64 handles / 38 polls** |
| an evicted dir stays alive | revived via poll in **550ms**; the row reached the screen |
| hidden window | **0 handles, 0 polls, suspended**; **0 blind batches**; **1** reconcile batch on re-show; caught up in **189ms** |
| closed explorer | **0 handles, 0 polls** before opening and after closing |

### TREEGIT (11/05) — the decorations

| Claim | Measured |
|---|---|
| letters + tones per state | M/A/U/C correct; a clean file wears **nothing** |
| folder propagation | `src` = **conflicted** (the loudest thing beneath it), `deep` = **modified**; both **letterless** |
| the Changes count | **6** = porcelain's 6 |
| an idle repo | **0** `git:filesChange` messages across two-plus full 2.5s ticks |
| a touched file | badge flipped in **610ms** |
| ignore dimming spawn budget | **1** `check-ignore` spawn per dir → **still 1** after re-expanding (the cache answered, not git) |
| a non-repo workspace | **0** git traffic, **0** check-ignore spawns, no lens chip |
| AA, 4 themes × 3 fills | worst **plain 4.97 · hover 4.52 · selected 5.04** — zero failures |

### FILEACT (11/06) — the actions

| Claim | Measured |
|---|---|
| open/reveal reach the OS | the spy received the **exact absolute path**, once each |
| refusals are typed | `outside-root` · `missing` · `invalid` — and **not one refused path reached the shell** |
| copy | absolute + relative both landed on the system clipboard |
| send-to-pane | insert = `"src\main.ts"`, carrying **no carriage return** |
| **nothing executes** | after typing **8** hostile paths (`$(rm -rf).txt`, `&echo pwned&.txt`, `%USERPROFILE%.txt`, …) the pane still shows **ONE prompt**; nothing echoed; **all 8 files survived** |
| the menu | 5 items at exactly **28px**; Shift+F10 opens it; Esc returns focus **to the row** |
| the drag payload | `text/plain` = the quoted insert; private marker present; `text/uri-list` = `file://…` |
| AA, menu inks, 4 themes | worst **4.52** — zero failures, zero missing |

### FILESMILESTONE (11/07) — the whole promise, composed

One fixture world: a git workspace with a **real shell pane**, a folderless
workspace, 16 panes, and a write torrent.

| Claim | Measured |
|---|---|
| the far-right toggle opens a tree on the workspace folder | ✅ |
| the visible set is watched, and nothing else | root + 3 expanded = **4 handles, 0 polls** |
| **a scripted pane** (a real shell process) writes | file appeared in **185ms**; deletion in **177ms**; **2** coalesced batches |
| decorations flip on the shared tick | `U` on the agent's new file, `M` on the modified; folder colour, no letter; count = porcelain |
| the lens | filters to the changed set; exit restores expansion **exactly** |
| the verbs | open reached the spy; outside-root refused; copy landed; send-to-pane left prompts **5 → 5** — **nothing ran** |
| workspace switch, explorer open | **50ms** (budget 100ms), 3 dirs remembered |
| a folderless workspace | EmptyState in **35ms**, **0 listings** |
| closed explorer | **0 handles, 0 polls, 0 git events** |
| **attention is sacred** | a pane that needed input at the start still needed it at the end |
| **budgets on the composed surface** (16 panes + explorer + torrent) | **avg 142.5 fps · worst gap 29.2ms · 0 frames > 100ms · heap 20MB** (budgets: ≥30fps · ≤150ms · ≤300MB) |

---

## 2. Platform finds, and their root causes

### (a) The Windows parent-watcher bubble — this one *shaped the architecture*

Writing a file inside a **collapsed** subdirectory bumps that subdirectory's
last-write time, which **fires the parent's non-recursive `fs.watch`**. A real OS
event, about a directory whose *listing* did not move.

A naive implementation forwards that event and "a collapsed directory costs zero"
becomes false on Windows — the renderer is woken, re-lists, and finds nothing
changed. **Root cause fix:** the pool never trusts an event. An event only marks a
directory dirty; the flush then re-reads its children and emits **only if the
kinds+names actually changed** (`watch.ts`, rule 2). That is why TREELIVE measures
**0 batches** from 20 writes into a collapsed directory instead of ~20 wasted
wake-ups, and it is why the liveness law is a fact rather than an aspiration.

### (b) `aa-probe.ts` silently misread every `color-mix()` colour as near-black

Chromium serializes a resolved `color-mix()` as **`color(srgb 0.96 0.71 0.31)`** —
components are **0..1 floats, not 0..255**. The probe's bare `/[\d.]+/g` scrape read
them as ~black.

**The tell:** four *different* inks measuring an *identical* ratio within a theme
(1.43 / 2.29 / 1.90). Identical numbers across genuinely different colours means the
parser collapsed them.

This is a landmine well beyond Phase 11: `global.css` uses `color-mix()` in dozens
of places, many as **backgrounds** — and `bgOf()` composites ancestor backgrounds,
so a mixed background poisons every measurement inside it, and on a light theme a
misread-as-black background can make a bad pair *pass*. Fixed in `aa-probe.ts`;
**all seven AA-dependent gates re-run green** (SETSHELL · HOMEUX · BOARDUX ·
FEEDBACKUX · CHROMEUX · DOCKUX · UXMILESTONE), so nothing was papering over a real
failure.

### (c) The selected-row inks failed AA — a real defect the probe caught

The selection wash (`--accent-weak`, a warm rgba) lifts the background enough that
`--success` and `--danger-ink` landed at **4.23–4.43** on nord, and the ignored
`--text-lo` dim at **4.10** on nord / **4.36** on midnight — against the 4.5 floor.

**Fix:** on a selected row the inks mix toward `--text-hi` (which strengthens in
*both* directions — lighter on dark themes, darker on light), and the ignored dim
yields entirely: a selected row is the one you are reading, and mixing the dim
toward `--text-hi` would *invert* the affordance on light themes, where "dimmer"
means lighter, not darker. Selected now measures **5.04**.

**Recorded deviation from the step spec:** 11/05 asked for deleted → `--danger`.
The token block says plainly that `--danger` is a *fill* and "anything rendering
danger as words takes `--danger-ink`" (it measures 2.93:1 on nord's elevated
surface). Deleted and conflicted are *words*, so both take `--danger-ink` and are
told apart by **form** — strikethrough vs weight. Measured, not assumed.

### (d) `git stash pop` is refused during an unresolved merge

TREEGIT's fixture needs one of *every* state at once, including a real conflict.
Building the dirty states first and then stashing to make the conflict fails:
`error: Merging is not possible because you have unmerged files`. **Fix:** build the
conflict FIRST on a clean tree, then layer the other states on top — working-tree
edits and `git add` of *new* files are both legal mid-merge.

### (e) Windows filename restrictions

`<`, `>` and `"` are **illegal in Windows filenames**, so the `<img src=x
onerror=…>.md` hostile fixture cannot exist there — it is not an attack surface on
that platform at all. FILEACT asserts it where the filesystem allows it and says so
plainly where it does not; FILETREE covers that render path everywhere by using a
**synthetic in-renderer listing** instead of the disk.

### (f) A smoke-authoring trap: virtualized rows are not all in the DOM

Two TREELIVE probes looked for rows (`RENAMED.txt`, `burst-099.txt`) that the tree
genuinely held but had never rendered — they sat far outside the scrolled window.
The tree was right; the assertions were looking in a place that never renders.
**Fix:** name the fixture so it sorts into view, or `reveal()` it first. Any future
gate that greps `rowNames()` must remember this.

### (g) `__mogging.panes` accumulates across workspaces

FILESMILESTONE's 16-pane count came back **17**: the folderless workspace has a pane
too. **Fix:** filter by workspace ordinal (pane ids are `ordinal*100 + slot`) — the
MILESTONE convention.

---

## 3. Perf: the honest state of the two budget gates

**FILESMILESTONE measured the budgets on the composed surface** — 16 panes + the
explorer open + a write torrent — and they hold with room to spare:
**avg 142.5 fps · worst gap 29.2ms · 0 frames > 100ms · heap 20MB**.

**MILESTONE and PERCEPTION could not be certified on this machine**, and the reason
is the machine, not the code:

- The box ran **four other Claude Code sessions** throughout. Measured load:
  **24.2 CPU-seconds consumed in a 4-second window** — roughly six cores pegged.
- **MILESTONE** fails on a single long frame (173–236ms vs the 150ms cap) — but the
  **certified v0.8.1 baseline fails it identically**: stashing all Phase-11 work and
  re-running on `HEAD` measured **215.3ms / 1 long frame / 56.5 fps**, versus
  **173.6ms / 1 / 81.5 fps** on the changed tree. The Phase-11 tree is *faster than
  the code without it* on the failing metric. Heap (45–51MB) and WebGL (16/16) are
  far inside budget throughout.
- **PERCEPTION** fails only on the *first* (cold) workspace switch (146–149ms vs the
  100ms cap); the other five switches land at 36–91ms, and every churn test reports
  **0 frames over 100ms**. The same code **passed PERCEPTION twice** when the box was
  quieter (**switchMax 53.4ms** and **76.1ms**). Baseline `HEAD` under comparable load
  measured **218.5ms** — again worse than the Phase-11 tree's 146.5ms.

- **FLICKER** (added to this list after a late regression pass) fails on the same class
  of metric: its churn phase — 8 panes streaming output, the CPU-heaviest thing the app
  does — hit **159.8ms** against a 100ms ceiling. Its *zoom* phase, which is lighter, is
  clean at **27.9ms / 0 long frames**, and every functional assertion passes (content
  intact, no cross-pane bleed, buffers kept, 8/8 panes back on WebGL). Baseline `HEAD`
  with **zero Phase-11 code** measured **131.9ms / 3 long frames** on the same phase, with
  the same clean zoom. It, too, is load-bound. (The first baseline attempt could not even
  *complete* inside qa-smokes' 240s watchdog — which is itself a measure of the load.)

**The tell, in all three gates:** contention scatters the samples (a few bad, the rest
fine) while `avgFps` stays healthy and the *lighter* measured phases stay clean. A real
renderer regression depresses the average and produces *many* long frames across every
phase. And in all three, the certified baseline fails at least as badly as the Phase-11
tree — twice, it fails **worse**.

**Mechanism check (why no regression is plausible):** during MILESTONE, PERCEPTION and
FLICKER the explorer is **closed** — the state TREELIVE proves costs literally zero. The
only Phase-11 code in the terminal is `terminal-pane.ts`'s drag *acceptance* test, which
runs on drag events and nothing else, and one `setPaneWriter` closure at feature mount.
The ~250 new lines of CSS match no element that exists while the dock is shut.

**Therefore:** both budgets are believed unmoved, and FILESMILESTONE demonstrates
that directly on the composed surface — but **certifying MILESTONE and PERCEPTION
requires a quiet machine**, and that run is the operator's to make.

---

## 4. What remains before the pack is certified frozen

Two items, both deliberately left to the operator:

1. **The full uncut local sweep** (all 198 gates). Not run here: the operator's
   standing instruction is that Claude never runs the full sweep — targeted subsets
   only. Every one of the seven new gates has been run and is green, as have every
   gate they could plausibly disturb (see §5).
2. **The three-OS CI dispatch.** Requires a push, which was not requested. `ci.yml`
   needs **no edit**: sweep jobs already take a `MOGGING_GATES` input where empty =
   *all* gates, so the seven new rows in `qa-smokes.sh` are swept automatically.

Until both land, the § Freeze table in `README.md` carries **PENDING** in its
certification row rather than a number nobody measured.

### The two commands that close it

```bash
# 1. The full uncut local sweep (198 gates, ~4h). Run it on a QUIET machine:
#    the three frame-budget gates (MILESTONE · PERCEPTION · FLICKER) are the
#    only ones that need one, and §3 shows why. Strip the Electron env leak
#    first if this shell is itself a Mogging pane.
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_CLI_ARGS -u ELECTRON_EXEC_PATH \
    -u NODE_ENV_ELECTRON_VITE -u MOGGING_PANE_ID -u MOGGING_DAEMON_ENDPOINT \
    -u MOGGING_BROWSER_ENDPOINT -u MOGGING_CHANNEL \
  bash scripts/qa-smokes.sh

# 2. The three-OS CI dispatch. `gates` EMPTY = all 198 gates; no ci.yml edit is
#    needed, because the sweep jobs already take that input.
gh workflow run ci.yml -f gates='' -f sweeps='linux,macos,windows'
gh run watch   # …then paste the run id into README § Freeze
```

When both are green, replace the two **PENDING** rows in
[`README.md` § Freeze](README.md#freeze--phase-1107-2026-07-12) with the run id and
the date. Nothing else in this pack changes.

---

## 5. Regression coverage actually run (targeted, not full)

Every gate that the Phase-11 changes could plausibly disturb, re-run and green:

| Why it was at risk | Gates re-run |
|---|---|
| `fs-paths` extraction from fs-browse | **FOLDERPICK · WIZARDUX** |
| the titlebar gained a slot after Settings | **CHROMEUX · DOCKUX · UXMILESTONE** |
| `file-tree.ts` changed in 03/04/05/06 | **FILETREE · EXPLORER · TREELIVE · TREEGIT** |
| `git/probe.ts` + `monitor.ts` reworked | **GIT · WORKTREE** |
| `aa-probe.ts` parser fixed (shared) | **SETSHELL · HOMEUX · BOARDUX · FEEDBACKUX · CHROMEUX · DOCKUX · UXMILESTONE** |
| `terminal-pane.ts` drop handler extended | **SMOKE · MULTIPANE · CLIPBOARD · STATE · BLOCKS · PANEOPS · ATTENTION** |
| `core/commands/shortcuts.ts` gained a Tools row (`Ctrl+Shift+E`) | **KBSHORTCUTS** |

---

## 6. Errata

- The `ci.yml` header comment said "Full 35-gate sweeps" — stale since long before
  this pack (the sweep is 83 gates at freeze). Corrected here.
- `docs/16-files.md` §7's table cites the gate that owns each number; if a number ever
  moves, that gate is the one to re-run, not this file to re-edit.
- **Gallery hygiene, pre-existing, not introduced here.** The explorer's own crumb is
  clean by construction — the shots are staged on a root-level fixture
  (`C:\mogging-showcase-repo`), so no username is ever rendered in a path the explorer
  draws. But the *pane* in those frames prints its shell prompt, which on a folderless
  workspace is `$HOME` (`C:\Users\<name>>`). This is true of every grid shot the gallery
  has ever taken (see `55-dark-grid-4-chips.png`, which predates this pack) and is a
  property of photographing a real terminal, not of the explorer. Worth a dedicated pass
  if the gallery is ever published; out of scope here.

## 7. Gallery — Phase-11 states, both themes

Twelve new frames, `out/gallery/errors.json` = `{ "count": 0 }`:

| State | Dark | Light |
|---|---|---|
| the open, badged tree | `62-dark-explorer-dock` | `99-light-explorer-dock` |
| the house context menu | `63-dark-explorer-context-menu` | `100-light-explorer-context-menu` |
| the Changes lens | `64-dark-explorer-changes-lens` | `101-light-explorer-changes-lens` |
| both docks open (grid keeps its floor) | `65-dark-explorer-both-docks` | `102-light-explorer-both-docks` |
| a refusal row (a folder the OS won't open) | `66-dark-explorer-refusal-row` | `103-light-explorer-refusal-row` |
| the no-folder EmptyState | `67-dark-explorer-no-folder` | `104-light-explorer-no-folder` |

The `-dock` frame is the pack in one picture: **Changes 4**, `M` on `tokens.css` and
`main.ts`, `U` on `roadmap.md`, the colour propagated up `design-system` / `docs` /
`web-app` / `src` **without a letter**, and `build/` + `debug.log` dimmed because git
ignores them.
