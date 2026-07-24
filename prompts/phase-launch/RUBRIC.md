# RUBRIC — what counts as a finding

The six lenses Part I sweeps every `INVENTORY.md` row through, and the boundary
that keeps the sweep terminating.

> **THE ONE LAW.** A finding is **a defect** or **a violation of a stated rule**.
> Never a preference.
>
> "I'd have named it differently", "this file feels long", "I prefer early
> returns" — none of those are fileable. That boundary is not politeness; it is
> what makes **must-fix** survivable. Every finding in `FINDINGS.md` must be
> fixed or DISPROVEN, with no `defer` and no `wontfix` available. A ledger that
> accepts taste is a ledger that never empties, and a queue that never empties is
> one you learn to ignore — which is how the defects hide.

## The trigger test

Before filing, answer: **could a competent reader disagree about whether the
trigger fired?**

- **No** → the trigger is objective. File it.
- **Yes** → it is not a finding yet. Either find the stated rule it violates and
  cite it, or reduce it to a reproducible defect. If neither exists, drop it.

A trigger fires on **evidence**, not on reading. "This looks racy" is a
hypothesis; "two callers write `paneState` in the same tick and the second read
returns the first's value, here" is a trigger. The evidence column in
`FINDINGS.md` is where you show it fired.

---

## (a) `corr` — correctness

**OBJECTIVE TRIGGER.** An enumerated edge case produces a **wrong or silent**
outcome. The enumeration is fixed, so coverage is checkable rather than
imagined — walk all six for the row's surface:

| edge | the question |
| --- | --- |
| **empty** | zero rows, zero panes, no repo, no network, an empty string |
| **huge** | 10k tree rows, a 1.15 MB scroll burst, 16 panes, a 500 MB file |
| **concurrent** | two writers in one tick; a second call before the first settles |
| **offline** | the network is gone, or worse, present-but-hanging |
| **malformed** | truncated JSON, a hostile filename, an unknown enum member |
| **cancel-mid-flight** | the user closes/navigates/aborts while it is in flight |

**FILEABLE.** A wrong value, a crash, a hang, a silent no-op where the user
expected an effect, an error swallowed with nothing shown, a state that survives
into the next session.

**NOT FILEABLE.** A path that is merely *untested* — absence of a test is a gap
for the owning gate to close, not a defect. File it only once you have shown the
behavior is wrong.

**IN-REPO PRECEDENT.** The updater's missing-feed boot crash: a dir-only build
ships without `app-update.yml`, `checkForUpdates()` rejects, `src/main/fatal.ts`
sees an `unhandledRejection`, and the app calls `app.exit(1)`. The **offline**
edge on a surface nobody thought had one, and the outcome was the app refusing
to boot at all. Fixed by absorbing the rejection at all four call sites.

---

## (b) `smell` — a named anti-pattern

**OBJECTIVE TRIGGER.** The construct matches a **named** anti-pattern from this
list. The name is the discipline: if you cannot name which one, you are
describing taste.

- **god-object** — one module owning ≥3 unrelated concerns, where "unrelated"
  means a change to one cannot affect the others.
- **boolean-trap param** — a call site reading `f(x, true)` where the flag's
  meaning is unrecoverable without opening the callee.
- **stringly-typed state** — a domain state carried as a bare `string` when a
  union type is available in `src/contracts/`, so a typo compiles.
- **fail-open guard** — a check that returns "permitted" on the error path.
- **silent catch** — `catch {}` with no rethrow, no log, no state change.

**FILEABLE.** A match against one of those five, at a `file:line`.

**NOT FILEABLE.** "This is a bit much" with no name attached. Adding a **new**
anti-pattern to the list is allowed and expected — but you add it *here*, and it
then applies to **every** row (see Amendments), never to the one file that
annoyed you.

**IN-REPO PRECEDENT.** BOARDFAIL's root cause: the fleet's `isAgentCliId` guard
blocked the **fail-closed sentinel** from reaching its handler, so the failure
path quietly became a permit path — a *fail-open guard* dressed as a type check.

---

## (c) `spag` — spaghetti

**OBJECTIVE TRIGGER.** One of:

1. **untraceable control flow** — reaching an observable effect from its trigger
   requires more than **three** hops across module boundaries, *and* at least one
   hop is dynamic (an event name, a channel string, a registry lookup) so the
   path cannot be followed by "go to definition".
2. **hidden coupling** — two modules that share no import must nonetheless
   change together, and nothing in either one says so.

**FILEABLE.** The hop chain, written out. If you can list the hops, the trigger
fired; if you cannot, you have not found the coupling yet.

**NOT FILEABLE.** Indirection that is *documented and typed* — an ADR-sanctioned
port, a contract in `src/contracts/`, an IPC channel in the preload allowlist.
That is architecture, and `CHANNELS`/`PTYSEAM` already hold those seams.

**IN-REPO PRECEDENT.** The pane-close conhost flash: a visible terminal window
per pane at undo-grace lapse, whose cause was `node-pty`'s **kill fork** inheriting
a console because the daemon spawned it without `windowsHide` — the effect (a
flash in the UI) and its cause (a child-process option in the daemon) shared no
import and no name. Fixed by a windowless-children wrapper over every daemon
`child_process` entry point.

---

## (d) `dup` — duplication

**OBJECTIVE TRIGGER.** Two or more implementations with the **same AST shape**
(same branches, same arithmetic, same mapping) in **different homes**, where a
change to one is a change the other needs.

**FILEABLE.** Both `file:line`s, plus the statement of what a divergence would
cost. Copy-paste that has **already** diverged is S1 by default — the drift is no
longer hypothetical.

**NOT FILEABLE.** Coincidental similarity — two functions that look alike but
answer to different owners and are free to diverge. Also not fileable: a
deliberate, documented second copy (a shipped shim that cannot import the app)
**when a parity gate holds the two together**.

**IN-REPO PRECEDENT.** `bin/mogging.mjs` and the generated notify-hook script
carry the same notification mapping in two homes, and they **drifted**: the
`unknown-type → notice` fix landed in the generated script only. The duplication
here is forced (the shim cannot import the app), so the resolution was not
deletion but the `NOTIFYPARITY` gate, which runs the whole corpus through both
and fails on any divergence. That is the shape of a correct `dup` resolution
when one home cannot be removed.

---

## (e) `eff` — inefficiency

**OBJECTIVE TRIGGER.** One of, **with a measurement**:

1. **a poller with no idle-proof** — a timer/interval/watcher that keeps firing
   when its surface is hidden, unfocused, or unchanged, and cannot be shown to
   cost zero when idle.
2. **a measured super-linear cost** — an N² (or worse) walk on a collection the
   product allows to grow, with the growth curve shown.
3. **needless re-render or allocation** on a hot path — a per-frame or per-chunk
   allocation, or a render triggered by state that did not change.

**FILEABLE.** The measurement. `docs/05-perf-budget.md` states the standing
budget (worst frame gap **≤ 150 ms** under the 16-pane stress fixture), so a
regression against it is a violation of a stated rule and files without argument.

**NOT FILEABLE.** "This could be faster" with no number. Micro-optimizations
off the hot path. A cost that the budget already absorbs — the budget is the
stated rule, and beating it is not a requirement.

**IN-REPO PRECEDENT.** The `USAGESET` red at v0.13.0 bundled a **fast-poller
churn** alongside a real product bug; the poller kept working with nothing to
show, and its cost only became visible as gate flake under load. Idle-proof is a
property you assert, not one you assume.

---

## (f) `debt` — refactor debt

**OBJECTIVE TRIGGER.** One of:

1. **an unreferenced export** — exported, and no importer in `src/`, `bin/`, or
   `scripts/`. Proven by search, not by belief.
2. **a dead affordance** — a UI control, menu item, setting, or CLI flag that is
   reachable by a user and does nothing (or nothing it claims).
3. **a module past a STATED size budget** — see the note below.

**FILEABLE.** For (1) the search that came back empty; for (2) the click path and
what fails to happen; for (3) the budget, cited, and the measurement.

> **Honest scope note on (3).** This repo does **not** currently state a
> per-module LOC budget anywhere, so as of step 01 there is **no stated rule** to
> violate and (3) is **inert** — filing "this file is long" under it would be
> exactly the preference this rubric forbids. Step 05 writes the `MAINT` gate;
> if it declares a budget, (3) becomes live **for every row at once**, and this
> note is replaced by the citation. Until then, `debt` files on (1) and (2) only.

**NOT FILEABLE.** Code that is merely old. An abstraction you would not have
chosen. A `TODO` comment — a note about future work is not a defect unless the
current behavior is wrong, in which case file it under `corr`.

**IN-REPO PRECEDENT.** Finding 41: `src/main/index.ts` imported ~100 `run*Smoke`
modules, so roughly a third of `out/main/index.js` — globbed into `app.asar` —
was a **test rig every user downloaded**, wakeable by an env var. Dead weight
that had crossed into the shipped artifact. Split into `index.dev.ts` /
`index.ts` over one `boot.ts`, and `PRODARTIFACT` now greps the production
bundle so it cannot re-accrete.

---

## Severity — it orders the queue, it never excuses one

| | meaning |
| --- | --- |
| **S1** | data loss, a wrong money/licensing/custody outcome, a crash on a normal path, a secret exposed, a security control that fails open |
| **S2** | a wrong outcome on a reachable edge, a silent failure, a stated-budget regression |
| **S3** | everything else that cleared the trigger test |

**Severity decides what you fix FIRST. It never decides WHETHER.** An S3 and an
S1 have the same two possible endings. This is the rule that makes the grade
derivable: if severity could excuse a finding, "A" would mean "no findings we
felt like fixing", which is not a measurement of anything.

## Verdicts — there are two

| verdict | what it requires |
| --- | --- |
| **`fixed`** | the defect is gone **and** an assertion exists that goes **red on the pre-fix bytes**. Fix without a bite proof is a story about a fix. |
| **`invalid`** | the claimed behavior **does not reproduce**. The evidence must say **DISPROVEN** and show the attempt. |

`defer`, `wontfix`, `open`, `accepted`, `known` do not exist in this pack. The
gate names them explicitly and reds — they are the vocabulary of shipping a
defect you have already found, and having found it is the expensive part.

`invalid` is a real and honorable outcome, but it is **disproof, never
argument**. "I don't think that can happen" leaves the finding open. "I ran it,
here is the output, it does not happen" closes it.

## Grades are DERIVED — nobody types a letter

For every (row, lens): **A ≡ zero unresolved findings**. That is the whole
definition, and `scripts/check-launch-audit.mjs` computes it from `FINDINGS.md`.

The lens cell in `INVENTORY.md` therefore records **provenance, not
self-assessment** — `~03` means "step 03 owns this sweep, not yet done", `03`
means "step 03 swept it". A lens cell can never say how it went, because a
surface grading itself is the failure mode phase-8.5 was built to catch: an
audit found "Settings — Usage" sitting at D− with nobody's name on it, and it
had been sitting there in plain sight.

## Amendments — a rule that proves wrong is amended HERE

If a trigger fires on something that is plainly fine, the trigger is wrong.
Then:

1. Amend the trigger **in this file**, visibly, with the case that broke it.
2. Re-run the amended trigger against **every row already swept** — a rule that
   changed is a rule that was applied inconsistently until it did.
3. Record the amendment in the step's notes.

**Never waive a rule for one instance.** A per-instance waiver is a `wontfix`
with better manners, and it silently drops the coverage this pack exists to
prove. There are no silent drops: a rule either binds everywhere or it is
rewritten everywhere.
