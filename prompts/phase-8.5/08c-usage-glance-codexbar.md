The Usage GLANCE, recut to the CodexBar dropdown (Phase-8.5/08c). This step **recuts the
popover** (7/03; tokens fixed in 05b) into an exact copy of the CodexBar dropdown — provider
tabs, then a provider's windows · credits · cost · actions · footer — on OUR data; the gauge
is UNTOUCHED. Slots we can't back (a `$` cap, a Sonnet meter, in-popover add-account) are
dropped, never invented.

## Steps
1. **Provider tabs** (replace the `.usage-switcher` `<select>`): one tab per ENABLED provider
   (`isEnabled`) — glyph + label + mini-bar (`usedPct`), selected lit — plus **All** · **Auto**.
   A click reuses today's state: `usage:displaySet {mode:'pinned', pin:id}` (All→`merged`,
   Auto→`auto`); KV `usage.display.*` unchanged.
2. **Header**: name (bold) · freshness (`fmtAge`) · plan tier (`planLabel`).
3. **Windows** (the active lane): a row per `UsageWindow` — Session, Weekly, any extra
   (`Weekly (Opus)`; NOT a faked Sonnet): label · bar (`.usage-fill.is-hot` ≥90) · `{n}% used`
   · `.usage-reset` (`resetText`). Under Weekly, the pace line: `.usage-verdict` = `pace.text`
   VERBATIM (golden-locked) + a new `.usage-pace-delta` = `pace.deltaText`; ink `sev-${severity}`.
4. **Credits + cost**: CodexBar's "Extra usage" has no cap — `plan.credits`→`{remaining}
   {label}`, else `plan.spend`→`{cur}{amount}`, else omit; never a `$X/$Y`. **Cost** (`›` →
   § Usage → History): `usage:cost`→`CostScan`, `Today {cur}{sum} · {tok}` / `Last 30 days …`;
   no cost log → `—`.
5. **Actions + footer** (icon rows): `Add Account…` / `Usage Dashboard` →
   `requestSettingsTab('usage')` · `Status Page` → the `statusUrl` via `browser:openExternal` ·
   `Settings…` (keep `.usage-gear`) · `About` → `requestSettingsTab('about')`. KEEP the
   `.usage-foot`/`.usage-age`/`.usage-refresh` footer (05b's theme check). Profiles: the active
   lane IS the stack; siblings become a switch row keeping `.usage-tile`+`data-profile`,
   `.is-active`, Enter→`switchActiveProfile`, `.usage-switch-hint`.
6. **USAGEGLANCE smoke** (`MOGGING_USAGEGLANCE`, env-gated, qa-smokes.sh) on fixtures:
   (a) a tab click sets KV `usage.display.mode`=`pinned`+`pin`; (b) opens `<100ms` from cache;
   (c) `.usage-verdict`===`pace.text` verbatim, `.usage-pace-delta` matches `/[+−]?\d+%/`,
   `.usage-reset` starts `resets in`; (d) Enter on a sibling flips order-0, `.usage-switch-hint`
   shows `running panes keep`; (e) Esc/away close; (f) gauge track + `.usage-foot` border
   re-theme (bug #4); (g) `Status Page` calls `browser:openExternal`. Verdict
   `out/usageglance-result.json`. **Re-baseline USAGEUI**: drop its grouped-popover asserts
   (tileCount/groupCount/`.usage-switcher`), keep it gauge-only.

## Files
- `features/usage/index.ts` · popover CSS (`global.css` ~5211–5392) ·
  `src/main/usageglance-smoke.ts` · `src/main/usageui-smoke.ts` (re-baselined) · main dispatch ·
  qa-smokes.sh row · `AUDIT.md` · gallery (both themes)

## Definition of Done
- The popover reads as the CodexBar dropdown; tokens only; both themes AA; gauge UNCHANGED.
- USAGEGLANCE green; USAGEUI re-baselined green; SETUSAGE, USAGESET, WEBUSAGE, USAGECLI, PROFILES
  and the pace golden green UNMODIFIED. No invented data.
- AUDIT: Usage-popover row stays **A**, owner `done (05b; recut 08c)`; a § Deviation (Resolved)
  for the recut + USAGEUI re-baseline; new breaks → § Bugs (owner 08c, ✅); `settings` bucket 0.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run — budgets unchanged.
- `check-spacing.mjs --max 0` — `settings` bucket still 0.

## Guardrails
- Copy the LAYOUT, not the data: every element backed by IPC; unbacked slots drop, never
  faked. Pace/reset wording is contract — render `pace.text`/`resetText` verbatim.
- The gauge is out of scope (meter/states/literals unchanged). Opens on cache;
  refresh in place (7/03). Telemetry stays counts/booleans (ADR 0005).
