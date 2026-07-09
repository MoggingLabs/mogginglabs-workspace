# 05 — Positioning, the contradiction, and the tier split

Read this one first. The blocker here is not technical, and no amount of good
engineering in `03` and `04` will route around it.

## 1. Our own founding documents forbid this project

Verbatim, from the working tree:

> `docs/00-vision-and-positioning.md:56`
> **Non-goals:** *"No hosted/cloud backend, no credits, no account system."*

> `docs/00-vision-and-positioning.md:35-37`
> *"**(b) Free / open / local / no account.** BridgeSpace charges $16–80/mo and
> requires a BridgeMind account even though you bring your own agent auth. We are
> free, local-first, no account."*

> `README.md:8`
> *"Your keys, your CLIs — **no subscription to us**."*

> `README.md:30`
> *"**BridgeSpace** — covers the most surface, but is **closed, $16–80/mo + account
> required**…"*

The product's entire competitive identity **is being the thing that does not
require an account**. Requiring one turns us into the competitor we defined
ourselves against. That is a legitimate call to make. It is a **repositioning**,
not a feature, and it must be made on purpose rather than discovered halfway
through wiring Stripe.

## 2. The escape hatch that keeps the wedge intact

**The local tool stays free and account-free forever. The account buys cloud
things.**

Free users keep "your keys, your CLIs, no subscription to us" — true, verbatim,
still on the README. Pro buys sync, history, and team features, which are exactly
the things that **cannot be cracked**, because they run on our server (`02` §2).

This resolves the strategy problem and the security problem with one move. It is
Obsidian's model precisely: an Electron, local-first, files-on-your-disk tool
people love *because* it works without an account, monetized on paid Sync and
Publish — both server-side. **Nobody has ever cracked Obsidian Sync, because there
is nothing to crack.**

And the cautionary case is closer to home. **Postman** removed Scratch Pad — its
offline, no-account mode — in September 2023, moving collections to its cloud by
default. **Insomnia**, which had been the refuge for people fleeing Postman, did
the same thing weeks later in v8.0 under Kong: forced account creation, cloud
sync, and it locked users out of existing local data on update *without warning*.
The GitHub issue is titled ["enshittification / needing an account"](https://github.com/Kong/insomnia/issues/6577);
it [reached the HN front page](https://news.ycombinator.com/item?id=37680522).
Both pushed a documented migration to [Bruno](https://dev.to/_d7eb1c1703182e3ce1782/postman-vs-insomnia-vs-bruno-best-api-client-in-2026-1pf7)
(open-source, offline-first, collections as plain files in git) and Hoppscotch.

**Insomnia retreated.** Local-only projects [returned in 8.3](https://github.com/Kong/insomnia/discussions/6626)
a few months later. They shipped forced accounts, took the damage, and reversed.

> **Precision, since this is ground truth:** what is documented is a large,
> sustained backlash, a real migration to Bruno/Hoppscotch, and a vendor
> climbdown. Permanent-churn numbers are *not* public. Do not claim a quantified
> exodus.

### The lesson is procurement, not grumbling

The sharpest detail: organizations had chosen Insomnia **specifically because
Postman's forced cloud accounts failed their security review** — and then Insomnia
broke the same rule and became unusable for them too
([issue #6624](https://github.com/Kong/insomnia/issues/6624), *"Employer
REQUIREMENT: Cloud syncs are forbidden"*).

This app spawns PTYs against customer **source code** and sits next to their **AI
provider keys**. A mandatory account plus cloud sync does not merely annoy an
individual developer — it can **disqualify the product at enterprise security
review**, which is the segment that would pay the most. `README.md:8` and ADR
0002's *"the user's keys never leave their machine"* are not only positioning;
they are what gets us *through* procurement.

This is the strongest argument in the pack for keeping the local tier
account-free. Developer tools are the one category where an account wall reads as
betrayal rather than formality — which our own README already knows, since it uses
exactly that argument against BridgeSpace.

## 3. The tier split

Grounded in the actual feature inventory (`01` §3) and the five buckets (`03` §1).

### Free — no account, ever
The bare terminal multiplexer. Multi-pane PTY, agent launcher, workspaces, git
chips, worktrees, local usage glance (24h), the browser dock, the CLIs.

*This is also the empty room.* A cracked Pro client degrades to exactly this,
which is why the crack is worthless.

### Pro — account required
- **Usage history + cost analytics.** Unlimited retention, aggregated across every
  machine, month-over-month spend, pace/threshold alerts, failover suggestions.
  Already built (`src/backend/features/usage/`) — just local and ephemeral today.
  **Strongest candidate: it exists, and its value compounds with retention, so the
  longer someone pays the more it costs to leave.**
- **Workspace / profile / template sync.** Canonical server-side, cached locally.
- **Curated content**, served not shipped: presets, MCP catalog, layout presets,
  and `MODEL_PRICES` (which *must* be served — a stale price table silently
  produces wrong cost figures).
- **Device cap: 3.**

### Team — per seat
- **Shared board + ownership ledger across machines.** `src/pty-daemon/ledger.ts`
  is one machine today; across a team it becomes inherently server-coordinated.
  **Multi-party coordination is definitionally uncrackable — the other parties are
  real and they talk to our server.**
- Shared integration grants, hosted event bridge with delivery log, audit trail,
  org SSO, seat management.

## 4. What "our UI is the moat" actually means

The instinct is that the functionality, the organization, the ease, the UI is what
the login should protect. Half right.

**The rendered chrome cannot be protected.** Panes, terminal canvas, CSS,
interaction handlers — they ship in the bundle and run on the user's GPU. There is
no version where the pixels come from our server without becoming a remote-desktop
product, which destroys the latency and reliability that are the entire wedge.

**But "the UI" is not the pixels.** It is *decisions and content*, and both live on
the server perfectly well — buckets 2, 3, 4 of `03` §1. A cracked client boots into
an app with no templates, no presets, no catalog, no workspaces, no board, no
history, and cost analytics frozen at the version it was cracked.

**And the threat to a UX moat is imitation, not piracy.** Nobody needs to crack the
app to copy the design; they watch a demo video. A competitor with a designer and
three months takes the organizing metaphor and ships it, and every lock we built
does nothing, because they never touched the binary. Meanwhile the pirate who *did*
crack it was never going to pay.

What protects a UX moat is shipping faster than the imitators, and customers whose
accumulated state — workspaces, templates, a year of usage history — makes leaving
expensive. That state lives on our server. Same answer, from the other direction.

## 5. Commercial blockers, ranked

1. **The positioning contradiction** (§1). Unresolved, everything else is premature.
2. **The repo is public.** `gh repo view` → `PUBLIC`, **0 forks, 0 stars**
   (2026-07-09). Flip it private now. The `LICENSE` is proprietary,
   all-rights-reserved — *"No license to use, copy, modify, or distribute is
   granted at this time"* — so nobody has the **right** to fork the pre-paywall
   build. That is the saving grace, and the window to close this cleanly is open.
3. **`docs/00:56` must be superseded** by ADR 0009 (§6).
4. **Nothing is signed.** No cert on either platform; macOS auto-update is inert
   until signed (`docs/10-distribution.md`). Ship signing before charging money.
5. **Telemetry / privacy posture changes materially** once accounts exist. PostHog +
   Sentry are already dependencies (ADR 0005); there is no privacy policy in `docs/`.
   Write one before the first paid signup.
6. **The final license is still TBD.** `LICENSE` says non-AGPL, with Apache-2.0 or
   a BSL/Elastic-style source-available posture "under consideration." A paid
   product wants source-available or closed, not permissive. Decide before launch.

## 6. What ADR 0009 must say

- **Supersedes** the `docs/00:56` non-goal ("no hosted/cloud backend, no credits,
  no account system") and the `docs/00:35-37` "no account" positioning claim.
- **Amends** `README.md:8` and `:30` — the free tier remains account-free, so "no
  subscription to us" stays true *for the local tool*, and the BridgeSpace critique
  must be narrowed to "account required *to use the app at all*."
- **Leaves ADR 0002 untouched, explicitly.** Our own account is not brokering
  *provider* auth. We still never store, proxy, pool, resell, or meter provider
  credentials or usage. ADR 0002's closing line already anticipated this: *"We
  forgo any revenue model based on marking up AI usage. Monetization, if any, must
  come from the app/experience, not from being an AI middleman."* This pack is that
  monetization.
- **Records the hybrid** (`04` §1) and the fail-open ladder (`04` §4) as binding.
- **Records the device-cap decision** (`02` §7): per-plan device caps, not
  single-active-session.
