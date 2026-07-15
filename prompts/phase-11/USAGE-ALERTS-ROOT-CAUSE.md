# Usage alerts — root-cause audit

Direction: Pedro, 2026-07-14 — "review the alerts regarding the usage across all AI providers,
these are not working properly ... find the root cause of all problems regarding the full scope
of this feature."

Method: a 10-dimension multi-agent fan-out (one specialist per surface — engine, provider
coverage, credits class, poller seam, pace engine, UI-receive, Claude adapter, status/enrich,
KV durability, gate blind-spot), each finding then attacked by three adversarial verifiers
(does it trace / is it a real gap in the promise / would this user hit it). 80 raw findings →
23 survived 2-of-3 verification before the run hit the weekly model limit. The orchestrator
(me) then re-verified every decisive claim directly against the code, and recovered the
findings whose verifiers were lost to the rate limit. Findings below are marked
**[code-verified]** where I confirmed them line-by-line myself.

The scope word matters: this is the **usage** alert system (`thresholds.ts` → house toast),
not the phase-11 attention/pulse dots. They are unrelated.

---

## The verdict

The alert engine models every provider as **one window with one percentage**, and reads only
`p.windows[0].usedPct`. Everything that is not that exact shape is invisible to it — your weekly
limits, every credit/balance provider, every spend cap. On top of that, the two providers that
*do* fit the shape (Claude, Codex) only ever have their **session** lane watched, and the
alert, once computed, is fired into a renderer that often is not listening yet — after the
engine has already marked it "spent" forever. So the honest answer to "why aren't my usage
alerts working across my AI providers" is: **for all but two providers there is no reading to
alert on; for those two, half the limits are never checked; and even a correct alert is
routinely thrown away undelivered.**

Coverage headline: of the **50** providers in the catalog, exactly **2** can fire a usage
threshold alert out of the box (Claude, Codex — session lane only), and **2 more** (OpenRouter,
ElevenLabs) can if you paste an API key. The other **46 cannot alert at all**, and several of
them display a green "detected / live" tile that says otherwise.

---

## Root causes, ranked by how much silence they cause

### RC1 — The engine only understands a single percentage-window (`windows[0]`) — the master cause

`evaluateThresholds` does `const w = p.windows[0]; if (!w) continue` (`thresholds.ts:87`) and
never looks at any other window, nor at `credits`, nor at `spend`. This one decision produces:

- **Your weekly limit is never evaluated.** `parseLanes` (`claude-adapter.ts:117`) returns
  `[Session (5h), Weekly, Weekly (Fable), …]`; only index 0 (session) is ever checked. A
  verifier reading your live credentials found your session at **9%** while your all-model
  **Weekly was 93%** and your **Fable Weekly was 100% — fully exhausted** — with no alert ever
  emitted. **[code-verified]**
- **The predictive "runs-out" tap can't reach the weekly either.** `paceOf` falls back to the
  plan pace only when `windows.length <= 1` (`thresholds.ts:43`), so on a multi-lane plan the
  one escape hatch that could have warned about the weekly is also locked to the session lane.
  **[code-verified]**
- **An expired session window mutes the whole plan.** `if (w.resetsAt && Date.parse(w.resetsAt)
  <= now) continue` (`thresholds.ts:94`) `continue`s the entire provider loop, not just window
  0 — so a lapsed 5h window also suppresses a Weekly sitting at 99%. **[code-verified]**
- **Credit / balance providers are structurally invisible.** Roughly half the catalog is
  credit/balance-shaped (`credits: true`, rolling, `windowMs: 0`). Their real signal lives in
  `credits.remaining`, which the alert path reads **nowhere**. $0.40 left of $200 of OpenRouter
  credit → no alert is even expressible. **[code-verified]**
- **Spend caps are invisible.** Claude's pay-as-you-go overage carries a real dollar `amount`
  and a real monthly `limit` (`parseExtraUsage`, `claude-adapter.ts:132`), and the renderer
  already computes the percentage — but `spend` never enters the engine, so you can run to your
  overage cap unwarned. **[code-verified]**
- **Failover suggests an exhausted sibling.** `suggestFailover` judges the sibling account on
  `o.windows[0].usedPct < 50` (`thresholds.ts:66`) — the session lane only — so it can offer a
  one-click switch onto an account whose weekly is at 99%. **[code-verified]**

### RC2 — Single-fire state never re-arms for half the providers, and mis-fires for the rest

The single-fire key is `usage.thr.<provider>.<profile>` with the window epoch inside
(`thresholds.ts:24,95`). That machinery is broken in both directions:

- **Rolling/credit providers fire once per install, ever.** `epoch = w.resetsAt ?? 'static'` —
  a provider with no reset gets `'static'`, which never changes, so `fired[]` is written once
  and never cleared. Top up your OpenRouter balance and burn it down again → **no second
  warning, for the life of the install.** **[code-verified]**
- **Claude may re-fire on *every poll* (needs a 30-second live re-confirm).** `pctWindow` stores
  Anthropic's `resets_at` string verbatim (`claude-adapter.ts:47`) and the engine uses it as the
  window identity. One verifier, probing your real credentials, saw **4 distinct `resets_at`
  strings across 4 calls 584ms apart**, and reproduced the consequence by running the real
  `evaluateThresholds` over real consecutive payloads: with usage flat, **polls 2 and 3 each
  emitted a spurious `Claude — fresh Session window` toast and wiped the single-fire state.** If
  that churn is real (verify: log `resets_at` on three consecutive polls), it is *the* "not
  working properly" symptom — constant fake reset toasts plus a threshold that re-fires every
  five minutes. Code path is confirmed; the empirical churn needs one re-check before you fix it.
- **Reset + threshold on the same tick.** The rollover branch re-arms `fired: []` and then
  **falls through** (no `continue`) to the crossing check (`thresholds.ts:98→116`), so a window
  that rolls over while already past quiet emits "a full window ahead" **and** "80% used" as two
  contradictory toasts in one tick. **[code-verified]**
- **`profileId` flips out from under the state.** The poller uses `profile?.id ?? 'default'`
  (`index.ts:219`); after login auto-discovery a lane becomes `login-<provider>`
  (`profiles.ts:143`). The state key changes with it, so every already-crossed threshold
  re-arms and re-fires minutes after first launch. **[code-verified]**
- **A key swap silences the new account.** State is keyed by (provider, profile) only, not by
  which credential — swap an API key to a different account and the old account's "already
  fired" state carries over and mutes the new one. **[verified via 2/3 lenses]**
- **Editing quiet/warn re-fires stale thresholds.** `fired[]` stores the pct *values*, so
  lowering `warn` from 95 to 85 while sitting at 90 fires "85% used" — a number you set moments
  ago. **[code-verified]**
- **State is never evicted.** The settings store has no delete path for `usage.thr.*`, so state
  for removed providers / deleted profiles accumulates, and a resurrected profile id inherits a
  stale epoch → false "fresh window" toast. **[verified — no delete path found in store]**

### RC3 — A computed alert is fired into the void, and marked spent before it is delivered

- **The boot race.** `boot.ts:307` starts the poller (first poll ~1.5s later) *before*
  `boot.ts:309` opens the window; the renderer only subscribes to `usage:alert` once its JS runs
  (`ui/features/usage/index.ts:750`). On a cold start where you are already over a threshold, the
  first poll runs `evaluateThresholds` → **marks the threshold fired in SQLite** → `webContents
  .send` into a renderer with no listener → the toast is dropped, and single-fire means it never
  returns. The gauge still paints the right number (it pulls the cached snapshot via `usage:list`
  on mount, line 754), so the meter looks correct while the shoulder-tap silently never comes.
  **[code-verified — ordering + timing]**
- **State is committed before the send, with no ack.** `evaluateThresholds` calls `kv.set(...)`
  to mark fired, then `pushAlerts` does a fire-and-forget `webContents.send` (`usage.ts:294`).
  Any dropped send (boot race, `getWin()` null, window closed to tray) permanently spends the
  alert. **[code-verified]**
- **The toast host silently evicts unseen alerts.** `while (stack.childElementCount > MAX_STACK)
  stack.firstElementChild?.remove()` (`toast.ts:98`) drops the **oldest** toast when a batch
  exceeds the cap — and `pushAlerts` sends the whole batch in one synchronous loop, so a
  multi-provider crossing destroys the oldest toasts before a frame paints, while the KV has
  already spent them. **[code-verified]**
- **Push is the only delivery path.** The renderer re-derives the gauge from cache on mount but
  never re-derives *alerts* — there is no "any missed alerts?" query — so a missed push is gone.
  **[code-verified]**
- **The poller pauses when the window is hidden/minimized** (`setVisible(false)` on `hide`/
  `minimize`, `usage.ts:551-557`). No samples, no alerts during exactly the hours you work in
  another app; the catch-up poll on restore can then fire a stale reset toast for usage you have
  already burned. **[code-verified — setVisible path]**

### RC4 — Only 2 of 50 providers can alert, but the UI presents many more as live

- 10 of 12 `cli-store` readers are `notWired` (`cli-store.ts:132`) → permanently `unconfigured`.
- 15 `api-key` rows are in `API_KEY_PENDING` (`api-key.ts:115`) → permanently `unconfigured`.
- All 15 `web-session` rows return `unconfigured` with `windows: []` **even when the cookie
  resolves** (`web-session.ts:71`) — there is no parse spec, so a correctly pasted cookie arms
  nothing.
- DeepSeek / Moonshot / Deepgram (`api-key.ts:61,74,106`) and Vertex / Bedrock
  (`cloud-cli.ts:58,95`) return `health: 'fresh'` with a **hardcoded `usedPct: 0`** — a
  permanently-green 0% bar that can never cross a threshold, and which rings a fake 0 into the
  history sparkline on every poll. Bedrock even discards real AWS Cost Explorer dollars into a
  display string instead of the `spend` block.
- `api-key` / `cloud-cli` / `web-session` default **OFF** (`index.ts:163-168`); only `cli-store`
  + `local` default on. Of the 13 default-on rows, 11 return a constant `unconfigured`. Net:
  **Claude + Codex are the only providers polled and alertable out of the box.**
- Meanwhile the Settings § Usage grid shows `notWired` rows as **enabled with a green "detected"
  chip** (`settings/usage.ts:217`), and the health pill is computed once from an empty plans
  array and **never repainted** (`settings/usage.ts:744`) — so the one label that would say
  "unconfigured" is dead on arrival. The user is shown a wall of live-looking providers, which
  is exactly why the belief "I have alerts across all my providers" formed.

**[all code-verified]**

### RC5 — The Claude adapter degrades to permanent silence on two ordinary conditions

- **Token expiry.** `fetchPlan` reads only `claudeAiOauth.accessToken` and ignores the
  `refreshToken` / `expiresAt` sitting beside it (`claude-adapter.ts:159-164`). When the on-disk
  access token expires, the endpoint returns 401 → the adapter throws → health `error`/`stale` →
  the engine skips it (`health !== 'fresh'`). Claude usage goes silent until *you* happen to run
  `claude` in a terminal and refresh the token the app is holding but won't use. **[code-verified]**
- **Relocated config dir.** `resolveHome` reads `CLAUDE_CONFIG_DIR` only from a MoggingLabs
  profile's env map, never from `process.env` (`homes.ts:37-48`). If you relocate your Claude
  config the documented Claude-Code way (an actual env var) without a matching profile, the app
  reads `~/.claude`, finds no credentials, and reports Claude `unconfigured` with the factually
  false reason "not signed in on this machine." **[code-verified]**
- **Forward-compat fragility.** The `limits[]` parser accepts only `kind: 'weekly_scoped'`
  (`claude-adapter.ts:99`); session and `weekly_all` still come exclusively from the legacy flat
  keys. If Anthropic ever ships `limits[]`-only, session + weekly vanish silently. Latent, not
  live. **[code-verified]**

### RC6 — None of this could have been caught, because no gate renders an alert

- **Not one usage gate subscribes to `usage:alert` or reads a `.toast`.** The entire delivery
  chain (`pushAlerts → webContents.send → bridge.on → showToast`) is executed by zero asserts.
- **The threshold fixture `mk()` emits exactly one window** (`usage-smoke.ts:607`), making the
  `windows[0]`-only defect structurally undetectable by all 11 threshold asserts.
- **`USAGEGLANCE` ships a Session 45% / Weekly 82% fixture through the real poller and passes
  green** (`usageglance-smoke.ts:97`) — it literally exercises the weekly bug, because nobody
  looks at the toast.
- **`catalogOk` is a shape-lint** that `notWired` / `API_KEY_PENDING` rows pass unchallenged
  (`usage-smoke.ts:160`).
- **The gallery and the smoke form a circular alibi**: the gallery hand-writes a fake
  `UsageAlert` straight onto the channel (`gallery.ts:244`) citing the smoke; the smoke asserts a
  pure function's return value and never renders a toast. Neither runs the real path.

**[all code-verified]**

---

## Not bugs — verified refutations (do not spend time here)

These were raised and then knocked down by a skeptic reading the actual code. Recording them so
they are not re-litigated:

- **`windowMsFor` label-matching does not cost any live provider its pace.** Every provider that
  can pace either sets `windowMs` explicitly (ElevenLabs, Bedrock) or is a rolling lane that is
  not paceable by design; Claude's labels all match. A thorough trace could not produce a single
  live pace loss. Leave it.
- **`manual` cadence does not kill alerts.** `poll()` is not cadence-gated; opening the popover,
  the refresh buttons, and the CLI all call `service.refresh()` → `poll` → `onChange` →
  `pushAlerts`. A manual provider still alerts when polled by any of those.
- **The ollama / notWired stubs are harmless at runtime** (zero I/O, documented pending
  pattern). The problem is only that the UI *presents* them as live — which is RC4, not this.
- **Pace-for-credits is a missing feature, not a broken guard** — the "runs out before reset"
  verdict is reset-relative and genuinely undefined for a balance. Building balance-depletion
  forecasting is new work, out of current scope.
- **The alert-config card cannot render empty**; the rejection path that would empty it can't
  actually fire.
- **The KV write itself is durable** — `setSetting` is a synchronous better-sqlite3 UPSERT that
  throws rather than silently dropping, so single-fire state persists reliably. (The problem is
  that it persists a *spent* state for an *undelivered* alert — RC3 — not that it fails to write.)

---

## Fix plan

Split deliberately: **Part A makes the promise true for the providers that already work** (this
is what stops your Claude/Codex alerts being wrong or silent — days of work). **Part B is
coverage** — wiring the providers that have no reader — which is genuine phase-of-work under the
repo's "dev-verify every endpoint" discipline. **Part C locks it down.**

### Part A — correctness (do first)

1. **Evaluate every window, not `windows[0]`.** `thresholds.ts`: loop over `p.windows`, keying
   `fired` state per window label so Session, Weekly, and each model-weekly alert independently.
   Change the expired-window `continue` (`:94`) to skip only that window. Run the pace tap per
   window. Fix `suggestFailover` to judge the sibling on its worst window. — closes most of RC1.
2. **Re-verify then fix the `resets_at` epoch.** First confirm the churn (log `resets_at` on
   three consecutive Claude polls). If it churns: derive the epoch from a *stable* identity
   (e.g. round `resets_at` to the window boundary, or treat only a meaningful forward jump as a
   rollover). Add `continue` after the reset branch so a rollover tick can't also fire a
   crossing. Re-arm `'static'` epochs on a material downward transition (store `lastPct` in
   `ThrState`). — closes RC2.
3. **Fix delivery.** Add a renderer→main `usage:ready` handshake (or replay the last unacked
   alert batch on renderer mount), so the first poll's alerts survive the boot race; don't mark a
   threshold spent until it is actually delivered. Stop the toast host from silently evicting
   alert-tone toasts (raise the cap or queue them). — closes RC3.

### Part B — coverage & honesty

4. **Teach the engine to speak balances and spend.** Add a `credits.remaining <= floor` branch
   and a `spend.amount / spend.limit >= pct` branch to `evaluateThresholds`; extend
   `UsageAlertConfig` with a per-provider credit floor and spend-cap pct. Stop returning
   `usedPct: 0` — a provider with no proportion returns `windows: []` and carries its number in
   `credits`/`spend`. — closes RC1-credits, RC4-fabricated-zero.
5. **Make the UI honest now (cheap, high-value — consider doing this first of all).** Stop
   painting `notWired`/pending/unconfigured rows as enabled + green "detected"; repaint grid
   health from the real plans; surface *which* providers are actually being watched. This alone
   reframes the complaint from "alerts are broken" to "only two providers are wired, and now I
   can see that." — closes RC4-UI.
6. **Wire the missing readers** — the `notWired` cli-store rows, the `API_KEY_PENDING` specs, the
   `web-session` parse specs — each dev-verified against a real login per the repo's discipline.
   This is the long tail and the real "phase of work." — closes RC4-coverage.
7. **Harden the Claude adapter.** Use `refreshToken`/`expiresAt`; fall back to
   `process.env.CLAUDE_CONFIG_DIR`; accept `limits[]` session/`weekly_all` as a flat-key
   fallback. — closes RC5.

### Part C — gates (build alongside Part A so the fixes can't rot)

8. Drive the **real** `evaluateThresholds` through a **multi-window** fixture and assert a Weekly
   crossing fires (fix `mk()` to emit >1 window first).
9. A UI gate that **subscribes to `usage:alert` and asserts a toast renders** (title, body,
   failover action) — and a boot-race variant that subscribes *after* the first poll and asserts
   the alert still arrives.
10. An epoch gate: identical `resets_at` across polls → **0** reset toasts; churning `resets_at`
    → still **0** reset toasts (locks the RC2 fix).
11. A credits gate: OpenRouter at 96% fires; top-up to 40% then back to 96% fires **again**
    (locks the re-arm).
