# Usage alerts — rebuild plan

Direction: Pedro, 2026-07-15 — fix every finding in [USAGE-ALERTS-ROOT-CAUSE.md](USAGE-ALERTS-ROOT-CAUSE.md)
properly, no patches; follow the actual structure of the providers; use steipete/CodexBar as the
reference implementation for both mechanics and visuals; simplify the gauge; gate everything.

## What CodexBar taught us (studied 2026-07-15, commit HEAD of steipete/CodexBar)

1. **Prune-on-descent replaces epoch identity** (`QuotaWarningNotificationLogic.thresholdsToClear`):
   a fired threshold is cleared the moment usage falls back below it. Resets, top-ups, account
   swaps all re-arm automatically — no window-identity string to get wrong. We add a 5-point
   hysteresis so boundary jitter cannot re-fire.
2. **Reset boundaries compare with tolerance, never equality**
   (`areEquivalentPlanUtilizationResetBoundaries`, tolerance = **2 minutes**; a rollover requires
   the boundary to *advance* beyond it — `limitResetBoundaryAdvanced`). This kills the
   `resets_at`-churn false rollovers.
3. **Every window warns independently** — `QuotaWarningEvent` carries a `windowID`
   (`claude-weekly-scoped-fable`) and display label; scoped weeklies are first-class.
4. **Token expiry is solved by delegation, not by using the refresh token**
   (`ClaudeOAuthDelegatedRefreshCoordinator`): run `claude /status` in a short PTY session — the
   CLI refreshes its *own* credentials — then observe the credential store change and re-read.
   Cooldown 5 min (20 s after failure), single-flight, user action bypasses cooldown. Never
   touch the refresh token; rotation stays the CLI's.
5. **Truthfulness is a first-class field**: `usageKnown: Bool` per window,
   `dataConfidence: exact | estimated | percentOnly | unknown` per snapshot. Unknown is rendered
   as unknown, never as 0%.
6. **Claude OAuth details**: UA header `claude-code/<detected CLI version>`; 429 honors
   Retry-After behind a persistent rate-limit gate; plan label from `subscriptionType` /
   `rate_limit_tier` ("Max 20x"); `seven_day_oauth_apps` + routines lanes exist; `limits[]`
   carries the scoped weeklies going forward.
7. **Stale-source discipline (Codex)**: an observation that does not advance `observedAt` is
   ignored (`staleCodexObservation`); a depleted→restored transition needs the reset boundary to
   have genuinely advanced, or two consecutive fresh positive samples.
8. **The visual language** (docs/codexbar.png): provider tab strip with a tiny severity underline
   per tab; ONE provider's card at a time; per-window sections = bold label, thin muted bar,
   one line "N% used · Resets in Xh Ym"; a single quiet "Pace: …" line; plan badge in the
   header; cost as two short lines. No walls of text.

## Execution order (each step compiles + is gated before the next)

### 1. Engine rewrite — `thresholds.ts` (RC1 + RC2, tasks #2 #3)
- `evaluateThresholds` walks **every window** of every fresh plan. Per-lane state keyed by
  window label inside one KV blob per (provider, profile): `{ v: 2, lanes: { [label]:
  { boundary, fired[], paceFired, lastPct } }, spendFired?, creditsFired? }`. Legacy v1
  `{epoch, fired}` migrates into the primary lane. State for `login-<provider>` adopts
  `default`'s blob once (the profile-flip orphan).
- Boundary rules per lane: drift < 2 min = same window (roll the stored boundary forward);
  advance > 2 min = rollover (clear lane state; emit `reset` only if the lane had fired levels
  AND no crossing fires this same tick — one voice per lane per tick); regression > 2 min =
  stale sample, skip the lane; expired boundary skips the lane only, not the plan.
- Re-arm: prune fired levels when `usedPct <= level - 5` (prune-on-descent + hysteresis).
  `paceFired` clears with any prune.
- Crossings: title names the READING, not the threshold ("Claude — 87% of Weekly used").
  Highest new crossing wins the toast; all crossed levels spend. Severity = loudest level.
- Credits branch: `p.credits && floor > 0 && remaining <= floor` → warn-level alert, single-fire
  until remaining rises above floor ×1.25 (prune-on-ascent). Floors per provider in KV
  (`usage.alert.floor.<id>`), default off (we cannot guess what "low" means in ¥/ACUs).
- Spend branch: `p.spend?.limit` → evaluate `amount/limit×100` against quiet/warn like a window,
  lane label `spend`, epoch = the spend month (rolls when the provider resets `amount`). Title
  names money: "Claude — $190 of $200 extra usage".
- `suggestFailover` judges the sibling on its **worst** window.
- Per-window pace tap (each window's own `pace`), not the plan's.

### 2. Guaranteed delivery (RC3, task #4)
- KV-persisted outbox `usage.alert.outbox` (cap 20, 24 h expiry): `pushAlerts` appends, then
  sends `usage:alert` with an id; renderer acks (`usage:alertAck`); renderer mount drains
  (`usage:alertDrain`). The boot race and the null-window drop become replays, not losses.
- `toast.ts`: a full stack queues new toasts; nothing is evicted before it is seen.

### 3. Truthful readers (RC4, task #5)
- DeepSeek / Moonshot / Deepgram: `windows: []` + real `credits`; no fabricated 0 % lane.
- Bedrock: Cost Explorer dollars into `spend {amount, currency}`; Vertex: honest presence
  (no zero window). History ring stops recording fabrications automatically (iterates windows).
- Settings § Usage grid: pending/notWired rows stop painting green "detected"; health pill
  repaints from live plans; rows say *watched / needs key / not wired yet* truthfully.

### 4. Claude adapter hardening (RC5, task #6)
- Read `expiresAt`; expiring soon → background delegated refresh (node-pty `claude /status`,
  8 s cap, auto-Enter, 5 min cooldown in KV, single-flight); expired → refresh, observe
  `.credentials.json` change, re-read, then fetch; else honest reason.
- UA `claude-code/<version>` (cached `claude --version`); 429 Retry-After gate.
- `resolveHome`: profile pointer → `process.env` pointer → per-OS default (all providers).
- `limits[]` fallback parses `session` / `weekly_all` kinds when flat keys vanish.
- Plan label from `subscriptionType` / `rate_limit_tier`.
- Codex reader: `fetchedAt` (rollout mtime) that does not advance ⇒ the seam marks the sample
  stale rather than fresh-forever (CodexBar's stale-observation rule).

### 5. Wire providers CodexBar documents (task #7)
Port endpoint + parse per docs/: Gemini (oauth_creds.json + cloudcode-pa quota API + Google
token refresh + June-2026 consumer-deprecation sentinel), Copilot, Cursor (api/usage with
WorkosCursorSessionToken). Each ships with a fixture; `verifiedAt` only after a real login
check. Rows stay honestly pending where we cannot verify.

### 6. Visual redesign (task #8)
Popover per the CodexBar anatomy above; titlebar gauge defaults to bars only. Detail moves to
Settings. Keep the APG tablist keyboard work and reduced-motion twins.

### 7. Gates (task #9)
- `mk()` fixture builder emits multi-window plans; Weekly crossing fires (kills the
  windows[0]-only class).
- Epoch: drifting `resets_at` (< 2 min) → 0 reset toasts, 0 re-fires; advance (> 2 min) with
  prior fired → exactly 1 reset; regression → lane skipped.
- Re-arm: 96 % → fired; drop to 40 % → pruned; climb to 96 % → fires again.
- Delivery: alert enqueued with no listener → drain returns it once, then empty; ack removes.
- Truthfulness: no fresh plan may carry a `usedPct: 0` window while its real signal sits in
  credits/spend (assert over the real specs' fixture parses).
- UI: usage:alert → a rendered `.toast` with title/body/failover action.
