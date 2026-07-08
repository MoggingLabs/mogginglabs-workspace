The browser dock + shortcuts overlay (Phase-8.5/08b). This step exists for **AUDIT
§ Blockers #1**, the pack's most serious finding: the surface that tells a user *an
agent is holding the wheel of their browser* has **no CSS rule and no test**.
`.browser-agent-label`, `.browser-confirm-text` and `.browser-agentweb-note-text`
are unstyled spans inheriting `--fs-11`, and **no smoke asserts any `.browser-*`
class** — every browser smoke drives main-process state and never reads rendered
DOM. The guardrail says these "may be restyled, never dimmed." Today nothing — not
a token, not a rule, not a gate — would object.

## Steps
1. **Land the guard FIRST, before a single dock pixel moves.** A smoke asserting
   that while `driving === true`: `.browser-dock` carries `agent-driving`;
   `.browser-agent-banner` is not `hidden`; `.browser-agent-stop` is present and
   hit-testable (a real bounding box, in the viewport); `.browser-agent-label` has
   non-empty `textContent` at computed `font-size >= 11px`, non-transparent,
   AA-measured against its real composited background (`aa-probe.ts`, 06). Write it
   against TODAY's DOM, watch it pass, then restyle.
2. **Dock chrome**: header on the 01 rhythm, possession UNMISSABLE — banner, Stop
   control and agent label get real rules, real weight, and a tone that reads as
   *possession*, not decoration. Consent copy keeps its exact meaning (ADR 0002).
   REMOVE #13: `.browser-ws-chip:hover {}` is an EMPTY ruleset, and it is the one
   dock button with no hover feedback. REMOVE #14:
   `trailBtn.classList.remove('is-hidden')` — never added, no rule.
3. **Shortcuts overlay** (B−) and **Settings § Shortcuts** (B): the `?` overlay
   becomes a two-column token grid fed from Settings' own data — KB-01, one source,
   already CI-enforced. `.shortcuts-row { padding: 5px 0 }` and its `0.08em`
   tracking are the *only* reason both surfaces grade B; they are also the last row
   of the `chrome` bucket. Fix them once, in `shortcuts.ts`'s own CSS, and both
   grades move.
4. **DOCKUX smoke** (`MOGGING_DOCKUX`, env-gated), zero network: (a) step 1's
   guard, verbatim, still passing after the restyle; (b) with `driving === false`
   the banner is hidden and Stop absent — the guard proves presence, this proves it
   is not always-on; (c) `.browser-confirm-text` and `.browser-agentweb-note-text`
   have rules of their own (computed size/colour differ from a bare `<span>` in the
   same place) — the "no CSS rule" finding, closed and asserted; (d) the `?`
   overlay's row count equals Settings § Shortcuts' (KB-01); (e) computed:
   `.shortcuts-row` padding is a `--sp-*` stop, every dock control ≥28px; (f) AA on
   the possession text, four themes. Verdict `out/dockux-result.json`.

## Files
- `features/browser/` (dock chrome) · `features/shortcuts/` ·
  `core/commands/shortcuts.ts` · browser + shortcuts CSS blocks ·
  `src/main/dockux-smoke.ts` · main dispatch · qa-smokes.sh row ·
  gallery (both themes, driving + idle)

## Definition of Done
- **AUDIT § Blockers #1 discharged**, and provably: the possession surface has
  rules AND a gate, written before the restyle and green after it.
- AUDIT grades **Browser dock B / C-on-contract → A**, **Shortcuts overlay
  B− → A**, **Settings § Shortcuts B → A**.
- The `chrome` bucket reaches **0** (`.shortcuts-row` was its last row).
- BROWSER, BROWSERCTL, AGENTWEB, PERWSAGENT, KBSHORTCUTS green UNMODIFIED;
  DOCKUX green. REMOVE #13, #14 ✅.

## Checks that must be green
- typecheck 0; build ok; boundaries clean; full local sweep.
- PERCEPTION + MILESTONE re-run.

## Guardrails
- **Safety surfaces may be restyled, never dimmed, shrunk, or hidden** — and now a
  gate says so. If the restyle needs the guard relaxed, the restyle is wrong.
- A page an agent reads is untrusted content; the dock's session stays empty.
- One source for shortcuts: the overlay renders Settings' data, never a copy.
