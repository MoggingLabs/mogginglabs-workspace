# Phase Tools — REPORT

Executed 2026-07-24 on `mogging/8ab071d3` (Windows, the canonical dev box), steps 01–07
in order, one commit per step. The OSS survey's verdict held throughout: ADR 0014
hold-and-proxy custody untouched; the feature rebuilt on the declarative provider
catalog (ADR 0020).

## Per step

| Step | Commit | Landed | Gate (bite proof) |
|---|---|---|---|
| 01 | d46f444 | ADR 0020 + the 60-row provider catalog (landing dark behind the preset shim), naming/IA decisions recorded | **CATSCHEMA** (`--selftest`: every rule catches its fixture) + **TOOLWORDS** (report-only burn-down from 86) |
| 02 | 4f9c88f | Canonical credential + `normalizeTokenResponse` (one seam, JSON + form-encoded), `RefreshCoordinator` (lock + margin + cooldown + re-check-after-lock), prove-before-save, catalog-driven proxy retry | **TOOLCRED** — 29 asserts, mutation-red ×2 LIVE (lockless coordinator double-hits; JSON-only parser fails the form body) |
| 03 | dd53732 | ONE verify engine (`verifyConnection`, cause-stamped), heartbeat (budgeted/jittered/cursor), page-entry sweep, pre-launch budget, attention edges, shared reachability classifier (moved out of updater.ts) | **TOOLPULSE** — mutation-red ×2 LIVE (broken offline classifier: blackhole rings; broken budget: launch waits 5025ms vs 1537ms) |
| 04 | 5ae79f9 | Catalog-driven identity ladder (oidc → rest → allowlisted tool), `accountProfile`/`accountSource`, account notes (KV outside the meta — survives disconnect), probed-beats-noted wording helper, CATSCHEMA profile rules | **TOOLWHO** — mutation-red ×2 LIVE (broken allowlist calls the no-whoami fixture; inverted precedence flips the DOM row) |
| 05 | 9ceb737 | Tool-card grid (one tool = one card, merge key = service id), the four status tags, the catalog chooser (ADR strings verbatim, custody subtitles), humanized scopes, detail scoping + key slots, CC-first coming-soon, catalog flipped to RUNTIME source (presets.json deleted, shim deleted), TOOLWORDS per-file enforcement | **TOOLCARDS** — mutation-red ×2 LIVE (broken merge key splits the dual-route card; broken rank reverses the chooser). Post-landing fix from the milestone: bridge rows now carry `cliState` so a drifted BRIDGE config can surface Fix |
| 06 | 978dede | The silent reconciler: drift → `Needs attention → Fix` (sentence + preview + backup, existing mgr channels only), heartbeat drift scan (stat/parse, no subprocess), separate drift ledger, mgr panel retired, Claude-Code-only surfacing, TOOLWORDS category enforcement (drift/apply/adopt) | **TOOLFIX** — sandboxed CLI home; mutation-red ×2 LIVE (blinded classifier never raises; auto-applying reconciler moves the mtime unclicked) |
| 07 | (this commit) | Gate audit (below), straggler wording sweep (burn-down 86 → 23, remaining hits pinned or out-of-surface), docs/14 rewritten tool-first, composed milestone | **TOOLSMILESTONE** — the whole walk, every arrow an assert, wording assert red-bracketed |

## Deviations from the prompts (each with its reason)

- **Step 05, servers/vault cards kept (demoted, not deleted).** The IA spec omits
  them, but SECRETFORMS/LIBRARYUX/SETINTEG anchor the add-server form, key slots and
  hit-target math there. They were demoted to explicitly-advanced audit surfaces
  ("On your CLIs (advanced)"), the mgr panel died in step 06, and every everyday verb
  moved to the tool cards. Deleting the audit surfaces outright is future polish, not
  a custody or wording violation — TOOLWORDS pins their fine print by review.
- **Step 05, `McpPreset` type survives as a projection.** The prompt retires the shim;
  what shipped deletes presets.json and `providerToPreset` (the step-01 shim) and
  derives `MCP_PRESETS` from the catalog via `presetFromProvider`. Consumers now read
  catalog-derived data with zero drift possible (the unit suite pins projection
  equality); collapsing the projection type itself would have churned every registry
  writer for no data-model gain.
- **Step 06/07 "TOOLWORDS enforcing".** Full-scope `--enforce` would fail on honest
  English ("theme applies immediately") and on agent-config's own apply vocabulary
  (SETAGENTCFG anchors those strings; a different feature). What shipped: per-FILE
  enforcement for every rewritten integrations file, per-CATEGORY enforcement
  (drift/apply/adopt) across all integrations files, and ALLOWED pins (each with a
  reason) for the ADR's intended fine-print survivors. Burn-down: 86 → 23, every
  remaining hit outside the integrations surface (activity ledger vocabulary,
  agent-config, theme/usage/update captions).
- **Step 07 "full sweep at baseline and at HEAD".** The full 191-gate sweep is a
  multi-hour operator run (the phase-11 convention). Every gate this phase touched —
  the 7 new ones plus the 11-gate reconciliation battery below — ran green at each
  step's HEAD on this box; the full-sweep certification rows are left to the operator
  exactly as prompts/phase-11/README.md does.
- **TOOLPULSE (e) "fixture killed".** A killed listener classifies as network-down
  by design (ECONNREFUSED is machine-vocabulary), so the "real failure" leg uses a
  reached-and-refused fixture (JSON-RPC error) and the blackhole leg a destroyed
  socket — the honest split of the two cases the law distinguishes.

## The gate audit (deliverable 1)

For every existing gate touching this surface: what it proved before, what it proves
now, and where each moved assertion lives. **No assertion was retired.**

| Gate | Proved before the phase | Proves now | Moved assertions |
|---|---|---|---|
| CONNPURE (74) | Landed-grant law, enrichment stamp guard, cancel races, redirect-drift repair, retry grammar | Unchanged — same 74 asserts, plus the same laws now bind every verify cause (TOOLPULSE re-proves them under heartbeat/page-entry/pre-launch) | None — pure suite untouched, green at every step |
| CONNLIVE | Connected-before-probe, cancel no-op, enrichment fill-in, no probe downgrade | Identical, on the same fixture AS | None; `probeConnection` gained `skipAccount` (verify path only — connect-time enrichment untouched) |
| TOOLCRED | Credential core: seam, lock, margin, cooldown, rotation, prove-before-save | Unchanged | None |
| PREREGCLIENT (43) | No-DCR client custody | Unchanged | None |
| SETINTEG | Integrations shell: hooks, folds, band stats, hit targets | Same guarantees on the new page | `.mgr-chip` hit-target math already tolerated absence (`=== null ||`); chips kept the class as inert facts. All INTEG_HOOKS selectors intact |
| integux | Legacy hooks + `mgrPreview` backend read | Unchanged (drives backend fns, not the panel DOM) | None |
| MUTATIONRACE | Single-fire grant/plan switches | Same clicks, same races | Its two caption anchors were reworded with the surface — smoke selectors updated in the SAME commit (978dede-adjacent, step 07 wording pass): 'which write tools agents get', 'Which of your tools reach this workspace' |
| SECRETFORMS | Add-server form retain/scrub + rollback | Unchanged — the form survives on the advanced audit card with its `data-mgr-*` hooks | None |
| AUTHRUNNER | Re-authorize flow toasts/runner | Unchanged — needs-sign-in chips keep the ONE honest verb | None |
| MCPCAT | Catalog/registry backend | Unchanged; now reads the provider catalog through the projection (unit-pinned no-drift) | None |
| MCPMGR / MCPSTATUS | mgr engine + status poller | Unchanged backend; `resolveCliHomes` gained the gate-guarded sandbox seam (honored only with isolated userData) | None |
| LIBRARYUX | Store/inventory split, key vaulting, route badges | Same guarantees | Card key slots moved to their OWN class namespace (`.conn-keyslot`) so the servers-block `.mgr-keyslot` anchors stay first-match — found and fixed by this very gate going red |
| USAGESET (integrations edges) | Usage keys separate from MCP keys | Untouched surface, caption unchanged (on the burn-down list, out of this phase's files) | None |
| Wording gates (CUSTODY) | No claim the vault contradicts | Same, over the new captions including the local-only differentiator line | None |

**Baseline discipline:** each step ran the full reconciliation battery
(TOOLPULSE/TOOLWHO/TOOLCARDS/TOOLFIX as they landed + CONNLIVE, SETINTEG, INTEGUX,
MUTATIONRACE, AUTHRUNNER, MCPCAT, MCPMGR, MCPSTATUS, SECRETFORMS, LIBRARYUX, TOOLPLAN,
UPDATEOFFLINE, UPDATEFAIL + the full static battery) green before its commit; the only
reds ever observed were the two smoke-fixture bugs documented in the step memories
(both fixed same-session, both re-run green). Full-sweep rows:

| Environment | Sweep | Result |
|---|---|---|
| local Windows (targeted) | the 7 new gates + every reconciled gate above, at each step's HEAD | ✅ green |
| local Windows (full, 191 gates) | — | **PENDING** (operator) |
| CI linux · macOS · windows | — | **PENDING** (operator dispatch) |

## Coming-soon honesty (deliverable 3)

One caption everywhere: `Codex — coming soon` / `Gemini — coming soon`, disabled
buttons with zero handlers (TOOLCARDS (f) dispatches clicks and asserts nothing
invokes). Backend three-CLI truth untouched: detection, capability table, writers,
plan matrix all still speak all three; codex/gemini config drift is detected and
deliberately surfaces nowhere (TOOLFIX (e)).
