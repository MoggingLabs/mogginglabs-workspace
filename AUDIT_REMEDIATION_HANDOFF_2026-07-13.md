# Audit remediation handoff — 2026-07-13

This file is the continuation record for the repository-wide audit and remediation effort.
It is intentionally self-contained enough for a new Codex thread or another engineer to
resume without relying on the prior conversation.

## Objective

Re-audit the supplied findings against the current product wording and implementation,
identify any new audit-worthy problems introduced by newer work, fix every confirmed issue
in priority order (P0, P1, P2), add regression coverage for every fix, run the complete
verification matrix, and finish with a refreshed audit plus UI/UX concerns.

Completion has **not** been claimed. P0 and P1 are certified; P2 is in progress.

## Authoritative audit provenance

- Original audit: `C:\Users\pedro\AppData\Local\Temp\mogginglabs-audit-remediation-2026-07-13.md`
- SHA-256: `321255057178E2C71B7D30DC40DFA28E532781B07CC5F4ABB890C1DD1C3CA60E`
- Findings: 42 total — P0 1–6, P1 7–23, P2 24–42.
- Baseline package version: `0.9.0`.
- Baseline runtime registry: 82 runtime gates; 78 passed and four performance gates failed
  (`MILESTONE`, `FLICKER`, `PERCEPTION`, `PRODUCT`).
- Baseline gallery: 125 screenshots, both themes at 1600×950, no 600px coverage.

The checklist near the end of this document preserves every finding and required outcome.
Use the original file above when exact original source-line citations are needed.

## Repository state

- Workspace: `C:\Users\pedro\Documents\GitHub\MoggingLabs-Workspace`
- Branch: `codex/audit-remediation-20260713`
- Base/HEAD before commits: `bfe35e64d065a872f48db0dc8adc4e4ffcd5666e`
- No remediation commit has been made yet.
- The worktree is intentionally large and dirty; it contains the audit fixes and gates.
- `.aider.chat.history.md` is unrelated user/Aider state. Preserve it and do not add, edit,
  delete, or commit it.
- `.npmrc` is intentionally deleted as the partial implementation of finding 42.

Latest checks at handoff creation:

```text
npm.cmd run typecheck   PASS (2026-07-13)
git diff --check        PASS (2026-07-13)
```

Use `git status --short` for the authoritative current file list. Do not reset or discard
the dirty worktree.

## Progress summary

| Priority | Findings | State |
|---|---:|---|
| P0 | 1–6 | Complete and regression-certified |
| P1 | 7–23 | Complete and regression-certified |
| P2 | 24–42 | In progress; 24–26 have unverified/incompletely wired edits |
| Final verification | all 42 | Not started as a complete matrix |
| Updated audit/UI report | final deliverable | Not written |

At least 23 of 42 findings are currently certified. Do not count findings 24–26 as complete
until the interrupted gate work is wired and run.

## Certified work: P0 findings 1–6

All six P0 findings were fixed before this handoff. The critical regression set includes
`BOARDFAIL`, `MCPLOOP`, and `REVIEWSNAP`; related existing gates (`GATE`, `REVIEW`,
`MCPWRITE`, `BROWSERCTL`, `TOOLPLAN`, `PERWSAGENT`, and `VAULTKEYS`) cover the composed
contracts.

1. **Reviewer identity and approval binding** — mandatory pane credentials; daemon-derived
   identity; approvals bind repository identity plus immutable snapshot; merge atomically
   revalidates. Missing/wrong token, spoofing, moved tip, other repo, and valid approval are
   covered.
2. **MCP/Browser pane spoofing** — pane-bound capabilities replace trust in a global token
   plus caller pane ID; unknown/dead panes fail closed with no workspace/grant inheritance.
3. **Board prose shell execution** — delivery requires positively confirmed agent readiness
   and the same pane generation; failures surface retry/cancel and never type prose at a shell.
4. **False review success** — exact snapshot/base/repository are carried through; dirty,
   untracked, changed, truncated, binary/mode-only, and already-up-to-date edge cases cannot
   produce a false merge success.
5. **MCP status feedback loop** — one-way scheduled/manual refresh with event deduplication;
   hidden cadence and subprocess/IPC counts are gated.
6. **Service-key overexposure** — keys are authorized by workspace/server/key plan; plain
   shells and unrelated workspaces receive none; deletion/revocation is covered.

Important P0 gate/helper files added or substantially changed include:

- `src/main/boardfail-smoke.ts`
- `src/main/mcploop-smoke.ts`
- `src/main/reviewsnap-smoke.ts`
- `src/main/reviewer-smoke-helper.ts`
- `src/main/pane-mcp-smoke-client.ts`
- daemon protocol/transport, review backend/main, MCP endpoint, pane environment, service
  keys, tool-plan and related UI/contracts.

## Certified work: P1 findings 7–23

The combined P1 certification command was:

```bash
MOGGING_GATES='GATE,REMOTE,WSCLOSE,BROWSERCTL,TOOLPLAN,WORKTREE,ROLERACE,BROWSERRACE,EXPLORERRACE,RESPONSIVE,PERSISTHEALTH,PROFPERSIST_A,PROFPERSIST_B,AGENTREGISTRY,WIZARDFAIL,MUTATIONRACE,AUTHRUNNER' bash scripts/qa-smokes.sh
```

All 17 selected gates passed in 413.9 seconds.

| # | Finding | Certified evidence |
|---:|---|---|
| 7 | Pane token scrub omission | `GATE` and pane-environment assertions |
| 8 | Deleted remote host becomes local | `REMOTE` cold/stale-host paths |
| 9 | Broken remote launch semantics | `REMOTE` cwd, cross-OS shell and auth-prompt paths |
| 10 | Destructive paths bypass safety | `WSCLOSE` centralized close-policy entry points |
| 11 | Browser Stop/possession promise | `BROWSERCTL` long wait, dock closed, Board/Settings, revoke/cancel |
| 12 | Tool plan non-atomic/untruthful | `TOOLPLAN` pre-launch persistence, rejection and no global fallback |
| 13 | Worktree removal from live cwd | `WORKTREE` real pane menu, dirty flow, two Windows lock failures, event order |
| 14 | Role publish race | `ROLERACE` slow spawn plus daemon reconnect/replay |
| 15 | Browser workspace async races | `BROWSERRACE` delayed profile/consent/navigation/sites/grants and retained callback |
| 16 | Explorer race/containment | `EXPLORERRACE` delayed roots, empty clear, `src` vs `src2` containment |
| 17 | Impossible minimum geometry | `RESPONSIVE` 600/800/1200, rail+docks, keyboard resize, ARIA and overflow |
| 18 | Invisible persistence/daemon degradation | `PERSISTHEALTH` visible degraded/retry/export/recovery states |
| 19 | Deleted profiles remain referenced | `PROFPERSIST_A/B` persisted-reference behavior across restart |
| 20 | Stale CLI launch surfaces | `AGENTREGISTRY` shared reactive roster across every launch surface |
| 21 | Wizard failure/consistency | `WIZARDFAIL` transactional failures, normalization and async cancellation |
| 22 | Permission/profile mutation races | `MUTATIONRACE` versioned/field-level mutations and profile switching |
| 23 | Authorization uses agent prompt | `AUTHRUNNER` selected auth kind, plain terminal/dedicated process, success/error |

Notable new P1 implementation/gate files:

- `src/main/worktree-audit-faults.ts`, `src/main/worktree-smoke.ts`
- `src/main/browser-race-audit-faults.ts`, `src/main/browserrace-smoke.ts`
- `src/main/explorer-race-audit-faults.ts`, `src/main/explorerrace-smoke.ts`
- `src/main/responsive-smoke.ts`, `src/ui/core/layout/dock-budget.ts`
- `src/main/persisthealth-smoke.ts`, `src/main/runtime-health.ts`
- `src/main/rolerace-smoke.ts`, `src/main/agentregistry-smoke.ts`
- `src/main/wizard-audit-faults.ts`, `src/main/wizardfail-smoke.ts`
- `src/main/mutation-audit-faults.ts`, `src/main/mutationrace-smoke.ts`
- `src/main/authrunner-audit-faults.ts`, `src/main/authrunner-smoke.ts`
- `src/ui/features/settings/auth-runner.ts`, `src/ui/core/agents/registry.ts`

One real P1 bug found while gating worktree removal was fixed in
`src/ui/features/terminal/terminal-pane.ts`: dirty-path comparison now normalizes Windows
backslashes to forward slashes before comparison.

## Interrupted P2 work on disk

These edits compile, but their runtime gates have **not** been run after the latest changes.

### Finding 24 — Copy Patch is invalid

Current product code already chose the allowed honest-action branch: the button is named
**Copy visible hunks**, is disabled for an empty artifact, awaits clipboard IPC, reports a
success only after resolution, and reports a danger toast on rejection.

Latest unverified additions:

- `src/main/clipboard-audit-faults.ts` can fail the next clipboard write.
- `src/main/review-smoke.ts` now asserts the copied bytes equal the exact visible redacted
  hunks, contains no patch headers or planted secrets, exercises write rejection, requires a
  danger toast with no success toast, and checks the empty fixture is disabled with no
  misleading “Copy Patch” label.
- `src/ui/features/review/index.ts` extends the existing dev fixture with an optional empty
  state so the production footer behavior can be exercised.

Next action: run `REVIEW`; repair any result. Decide/document that the application-check
requirement applies only to the alternative that claims to copy a valid patch. This product
now explicitly copies visible hunks, not an applicable patch. If reviewers require an actual
patch, replace this branch with a full-header patch contract and add `git apply --check`.

### Finding 25 — Updater error ignored

Re-audit result: the current renderer already handles error phase in both
`src/ui/features/updates/index.ts` and `src/ui/features/settings/updates.ts`. It displays a
rail error row, a retry action, a settings status, and the human error. The original audit was
stale on that implementation point, but there was no deterministic regression gate.

Latest unverified additions:

- `src/main/updater.ts` now supports `MOGGING_UPDATEFAIL`, drives checking → error with the
  actionable reason “Could not reach the signed update feed. Check your connection and try
  again,” and repeats the lifecycle on retry.
- `src/main/updatefail-smoke.ts` was added and compiles. It asserts visible error state in the
  rail and Settings, enabled retry, actionable reason, and that clicking the real rail retry
  produces a second checking → error cycle with a newer timestamp.

**Interrupted wiring still required:**

1. Import `runUpdateFailSmoke` in `src/main/index.ts`.
2. Add `MOGGING_UPDATEFAIL` to `SMOKE_ENV`.
3. Add a dispatcher branch calling `runUpdateFailSmoke(win)`.
4. Add `run_smoke UPDATEFAIL MOGGING_UPDATEFAIL 1 120 updatefail` to
   `scripts/qa-smokes.sh`.
5. Update gate counts only in the later finding-40 documentation/count pass.
6. Run `UPDATEFAIL` and fix any timing/DOM issues.

### Finding 26 — Clipboard history privacy

Latest unverified implementation:

- `src/main/clipboard.ts` boots with recording **off**.
- `clipboard:historySet` enables only for `payload.enabled === true` (fail-closed).
- Startup no longer primes by reading the global clipboard.
- Background poll exits before any read while disabled.
- All main-side reads now pass through audited wrappers.
- Text matching the existing review secret detector is copied to the system clipboard but is
  refused by the history ring.
- Clipboard write wrappers support deterministic failure injection for finding 24.
- Renderer preference fallback in `src/ui/core/clipboard/clipboard-port.ts` is now false.
- Settings disclose that enabling history checks the machine-wide clipboard about every
  800ms, includes other apps, retains up to 100 in-memory non-secret entries, and is off by
  default. The disabled empty state says the app is not reading/remembering the clipboard.
- `src/main/clipboard-smoke.ts` now asserts default-off UI/disclosure, zero audited reads at
  boot and across a focus event plus a poll interval, secret-not-retained/system-copy-still-
  works, clear behavior, and the pre-existing restore/remove/image/drop/paste contracts.

Next action: run `CLIPBOARD`. Inspect `out/clipboard-result.json` on failure. In particular,
confirm `bootReadsNone`, `offReadsNone`, `sensitiveFilterObserved`, and `defaultUi.pass`.

### Finding 27 — Credential/trust wording

Not yet implemented. Known contradictory candidates include:

- `src/ui/features/wizard/index.ts` — “no keys stored.”
- `src/ui/features/settings/index.ts` About/privacy copy — broad “never stores a credential.”
- `src/ui/features/settings/integrations.ts` — broad “never holds a credential.”
- `docs/00-vision-and-positioning.md`, `docs/02-mvp-and-roadmap.md`, `docs/12-usage.md`,
  and README phase copy contain variants that need contextual review.

Required wording contract: the app does not broker or store **provider CLI login/auth
credentials**; CLIs authenticate themselves. It can store **integration service keys and
webhook URLs only when explicitly pasted/vaulted**, encrypted through the OS-backed vault,
and materializes authorized values only into the intended pane environment. Add a static or
runtime content gate that rejects the broad contradictory phrases on user-facing surfaces.

## Remaining audit checklist

The status below is the authoritative continuation list.

### P0 — complete

1. Reviewer identity/approval binding — pane authentication; immutable repo/snapshot binding;
   atomic merge revalidation; spoof/moved-tip/other-repo/valid gates.
2. MCP/Browser identity spoofing — pane-bound immutable capability; unknown/dead fail closed;
   cross-workspace isolation gates.
3. Board prose fallback — positive agent readiness and pane generation; retry/cancel; failure
   and success gates.
4. Review false success — exact reviewed snapshot/base/repo; reject incomplete/unreviewable;
   verify landed tree; edge-case gates.
5. MCP status feedback loop — one-way scheduled/on-demand refresh, dedupe, hidden cadence and
   call-count gate.
6. Service-key overexposure — explicit workspace/server/key authorization; no plain/unrelated
   pane injection; revocation gates.

### P1 — complete

7. Scrub every pane-bound identity/capability variable from nested launches.
8. Deleted remote hosts must never silently fall back to local execution.
9. Preserve remote cwd/OS/shell and never type agent commands into SSH auth prompts.
10. Central close policy for mouse, keyboard, API, pane close, last pane and layout shrink.
11. Browser Stop must cancel/revoke; possession remains visible globally until completion.
12. Tool plan must persist/validate before launch and never silently use global fallback.
13. Move/close live shells before worktree removal; dirty refusal and Windows locks.
14. Role binding acknowledged at session generation; slow-spawn/reconnect behavior.
15. Generation/captured workspace checks on all Browser async work and retained callbacks.
16. Atomic Explorer root generation, empty clear and path-aware containment.
17. Shared responsive budget at 600/800/1200 and keyboard/ARIA dock resizing.
18. Visible persistence/daemon degradation, rejected saves, retry/export and honest recovery.
19. Profile deletion must block/migrate/mark unresolved; never silently use another account.
20. Shared reactive CLI registry across all launch surfaces.
21. Transactional Wizard, honest isolation failures, normalized counts, cancellable async work.
22. Versioned/field-level grants, atomic profile switch and concurrency gates.
23. Integration authorization runs in plain terminal/dedicated process, honors selection, and
   displays completion/error.

### P2 — incomplete

24. Copy valid unified patch **or** honestly copy visible hunks; empty/failure cannot report
   success; appropriate artifact/application gate. **Edits present, gate not rerun.**
25. Show a visible retryable updater error and gate error/retry phase. **Smoke added but not
   wired or run.**
26. Clipboard history explicit opt-in/disclosure, secret filtering/clear and zero reads off.
   **Edits present, gate not rerun.**
27. Consistently distinguish CLI-auth custody from explicitly vaulted encrypted integration
   secrets; content gate. **Not started.**
28. Use the platform modifier helper everywhere; Board/Browser must work with `metaKey` on
   macOS; keyboard gates. **Not started.**
29. Central command context with enabled predicate/reason; modal/editable guards; disabled
   palette explanations; gates. **Not started.**
30. Modal focus trap/inert background/title ARIA; full palette combobox semantics and focus
   return; valid workspace-tab primitive without nested interactive control; accessibility
   gates. **Not started.**
31. Keyboard/APG equivalents for menus, gutters, dock handles, custom scrollbars, Board/lane
   and workspace reorder, and spinbutton stepper semantics; gates. **Not started.**
32. Usage no-plan full reset, Escape propagation, honor/remove order/pin, accessible progress
   and tabs; gates. **Not started.**
33. Zero-workspace Browser must be explicitly disabled with explanation or use a real guest
   context; consent cannot visually change without persistence; gates. **Not started.**
34. Decide and implement Home navigation contract after workspaces exist; remove stale IA/docs;
   gate. **Not started.**
35. Secret forms clear only on success, retain on recoverable error, roll back orphan vault
   entries and scrub hidden forms; gates. **Not started.**
36. No nonessential infinite animation under reduced-motion/calm settings; CSS/static gate.
   **Not started.**
37. Board keyed updates or explicit focus/scroll restoration and listener cleanup; keyboard
   movement; gates. **Not started.**
38. Folder filter retains focus; refusal state remains navigable; file-tree double-click,
   typeahead cycling/reset and valid APG descendants; gates. **Not started.**
39. Shared async loading/error/disabled/finally/generation policy across Home, Review, Board,
   Browser, Settings, Activity, Usage and Integrations; failure-injection gates for every
   representative feature. **Not started.**
40. Correct QA/CI gate counts, distribution versions, usage/roadmap/Browser/Phase-11 docs and
   add doc consistency checks where practical. Do this after gates stabilize. **Not started.**
41. Remove smoke/gallery harness from production artifact using a dev/test entry or dynamic
   tree-shaken registry; packaged artifact gate proves smoke symbols and env triggers absent.
   **Not started.**
42. Remove unsupported `.npmrc build_from_source=true` and add warning-free config/install
   gate. **Deletion present; gate not added.**

## Performance findings to re-run

The original baseline had four functional-pass/performance-fail gates:

- `MILESTONE`: max stress gap 194.4ms vs 150ms; 97fps average; 49MB heap.
- `FLICKER`: max gap 111.1ms with two frames over 100ms; buffers/content correct.
- `PERCEPTION`: workspace switches max 128.4ms vs 100ms.
- `PRODUCT`: functional phase A true; 19-pane max gap 187.5ms vs 150ms; 112.6fps;
  44MB heap.

The MCP feedback loop was a confirmed contributor and is fixed. Re-run these after the P2
behavioral work and again in final certification; do not waive them based on old results.

## Immediate continuation sequence

1. Wire `UPDATEFAIL` as described above.
2. Run the interrupted P2 subset:

   ```powershell
   $env:MOGGING_GATES='REVIEW,UPDATEFAIL,CLIPBOARD'
   & 'C:\Program Files\Git\bin\bash.exe' scripts/qa-smokes.sh
   Remove-Item Env:MOGGING_GATES
   ```

3. Fix failures and rerun until all three pass.
4. Implement finding 27 plus its content gate.
5. Continue findings 28–39 in coherent batches, adding real-entry regression gates for each.
6. Complete findings 40–42 after the runtime registry is final.
7. Run typecheck, every static check, dependency audit, **all** runtime gates in isolation,
   fresh gallery including narrow widths, production packaging/artifact inspection, and the
   four performance gates.
8. Build a 42-row evidence matrix mapping each requirement to code and passing evidence.
9. Write the updated audit and final UI/UX concern section.
10. Only then mark the persistent goal complete.

Useful commands:

```powershell
npm.cmd run typecheck
git diff --check
$env:MOGGING_GATES='GATE_NAME'
& 'C:\Program Files\Git\bin\bash.exe' scripts/qa-smokes.sh
Remove-Item Env:MOGGING_GATES
```

Result artifacts are written to `out/<gate>-result.json`. The QA runner also keeps isolated
per-gate logs under its printed temporary isolation root.

## Completion proof required

Before calling this work complete, prove every numbered requirement against current source
and runtime evidence. Tests count only after confirming they exercise the required entry
point and negative case. Required final checks include:

- isolated branch and preservation of unrelated user files;
- all 42 findings resolved or explicitly re-audited as stale with current proof;
- regression coverage registered in dispatcher, smoke allowlist and QA runner;
- typecheck, static gates, dependency audit and full runtime sweep;
- fresh gallery with relevant responsive/accessibility states;
- production artifact free of test/gallery harness;
- warning-free npm configuration;
- performance reruns;
- final evidence matrix and updated audit with UI/UX concerns.

