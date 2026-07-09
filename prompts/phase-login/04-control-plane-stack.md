# 04 — The control plane: cloud vs local, stack, lease, offline, cost

## 1. Cloud or local? Answered.

**Neither extreme works.**

*Purely local* cannot enforce accounts, plans, or single-device: there is no
**trust anchor**. A local binary can be patched, its checks NOP'd, and it has no
way to know "am I the active device?" without a shared coordination point.

*Fully cloud* destroys the product. It spawns PTYs against the user's source tree
with the user's own API keys. Move that to a server and we are a cloud IDE
reading customers' code — a different, worse business, and a direct violation of
ADR 0002's spirit.

**The answer is the industry-standard hybrid: a local-first app plus a thin cloud
control plane.** The control plane holds identity, subscription state,
entitlements, the device lease, and billing. It never sees source code, terminal
I/O, or provider keys. Signed short-TTL entitlement tokens cached on disk provide
offline grace.

This is exactly how [Tailscale splits control plane from data plane](https://tailscale.com/kb/1508/control-data-planes)
so nodes keep working if the control plane blips; how 1Password keeps an encrypted
local vault with cloud licensing; how Cursor and Warp run a local editor/terminal
with cloud auth; how [JetBrains licenses locally with an offline grace window](https://youtrack.jetbrains.com/issue/IDEA-235906).

**What must never leave the machine:** source code, provider API keys, PTY bytes,
scrollback. The control plane sees identity, plan, device, token counts, cost
figures. Never content. `src/backend/features/review/redact.ts` already
establishes that discipline. **This constraint is simultaneously the marketing
asset** — the 1Password ("we can't see your vault") / Tailscale ("we can't see
your traffic") playbook.

## 2. Recommended stack

| Component | Choice | Why |
|---|---|---|
| **Auth** | **WorkOS AuthKit** | Free to **1M MAU**, PKCE via system browser, refresh rotation + reuse-detection built in ([pricing](https://workos.com/pricing), [sessions](https://workos.com/docs/authkit/sessions)) |
| **Control plane** | **Cloudflare Workers** | $0 → $5/mo, ~0 cold start, edge-global, DDoS included, near-zero ops ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)) |
| **Device lease** | **Cloudflare Durable Objects** | Single-threaded per object → the lease CAS is atomic with no locks. See §3. |
| **Database** | **Cloudflare D1** | Free 5M row-reads/day, SQLite co-located with Workers ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)) |
| **Billing** | **Polar** (or Paddle) | **Merchant of record** — absorbs EU VAT / US sales tax. Entitlements ("benefits") built in. ([fees](https://polar.sh/docs/merchant-of-record/fees)) |
| **Client** | local-first Electron | Signed short-TTL token cached on disk; code + keys never leave |

**Second choice, if you distrust a vendor:**
- *Cloudflare lock-in / want boring Postgres* → Fly.io or Hetzner + a small
  Node/Bun API + **Neon** Postgres, lease via `SELECT … FOR UPDATE` (or Upstash
  Redis `SET NX EX`).
- *WorkOS's B2B tilt* → **Clerk** (50k MAU free, cleanest
  [`revokeSession()`](https://clerk.com/docs/reference/backend/sessions/revoke-session);
  watch the per-MAU cliff) or self-hosted **better-auth**.
- *Polar* → **Paddle** (most-proven indie MoR) or **Stripe Managed Payments**
  (Stripe's own MoR, same 5%+50¢). **Avoid Lemon Squeezy** for new builds — post-
  acquisition it is invite-gated.

**On billing, the axis that matters is merchant of record.** A solo founder selling
desktop software worldwide has real EU VAT (€10k threshold) and US sales-tax
exposure. [Stripe Tax calculates but you remain the merchant](https://fungies.io/stripe-tax-limitations-understanding-the-difference-from-the-merchant-of-record-model/)
— you register, file, and remit in every jurisdiction. An MoR absorbs all of it
for ~5% + 50¢. Stripe's Entitlements API is GA and usable, but with an MoR you use
*their* benefits system instead.

**Checkout from a desktop app:** open the system browser to hosted checkout,
return via the same loopback/deep-link as auth. This is the blessed pattern and
[Stripe documents it](https://docs.stripe.com/mobile/digital-goods/checkout).
Subscription management → open the hosted customer portal.

## 3. The device lease

**Do not route device-kicking through the auth provider's session-revoke API.** A
stateless access JWT stays valid until it expires, no matter what any vendor's
docs imply. Every provider in the comparison shares this property. Keep access
tokens at **5–15 minutes** and use auth revocation only for "log out everywhere /
account compromise."

**Kick through your own lease.** A [Durable Object](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
is a single-threaded, globally-unique instance that processes one request at a
time — "no race conditions, no distributed locks." **One DO per account *is* the
lease**: check-current-holder-and-swap runs with zero concurrency, so two devices
physically cannot both win. It is co-located with the Worker serving the
heartbeat. This is the strongest single reason to pick Cloudflare here.

Alternatives, for the record: Postgres `SELECT … FOR UPDATE` (correct and boring,
needs a live connection per check, more latency); Redis `SET NX EX` (atomic,
auto-expiring, weaker durability, extra dependency).

**Parameters:** heartbeat every 60–120s; lease TTL ~10 minutes (Keygen's default
heartbeat window is 10 min). Plus a self-service **"sign out my other device."**

**Never trust a hardware fingerprint as identity.** Windows `MachineGuid` is shared
across cloned/imaged VMs unless sysprepped and resets on reinstall; macOS
`IOPlatformUUID` regenerates when NVRAM is cleared. Treat a fingerprint as a
*hint*.

**And per `02` §7: enforce a per-plan device cap (Free 1, Pro 3, Team per-seat),
not one-device-at-a-time.** We are selling cross-device sync; forbidding a second
device sells against ourselves.

## 4. Offline grace and fail-open

The control plane signs a short-TTL entitlement JWT; the app verifies it against
an embedded public key with **no network needed**. Each successful heartbeat
slides the window forward. Standard grace in this category is **7–30 days**.

**Degradation ladder when the control plane is unreachable:**

| Outage | Behaviour |
|---|---|
| **1 hour** | Zero user impact. Cached token valid; heartbeat retries with backoff. The device **assumes it still holds the lease** (fail-open) — two-device abuse during an outage is negligible next to bricking a payer. |
| **1 week** | Token nearing expiry. Soft "reconnect soon" banner. Full function retained. |
| **1 month** | Token long expired. **Fall back to Free tier. Never a hard lock.** |

This app spawns the user's own tools against the user's own source code. Locking
someone out of their own work because a Worker had a bad day is not a bug you
recover from reputationally.

The **kill-switch still works while online**: revoking the lease in the DO takes
effect within one heartbeat.

## 5. What breaks first

**The billing-webhook → entitlement sync.** Webhooks are at-least-once,
out-of-order, and drop during provider outages. Handlers must be **idempotent
(keyed on event id)** and backed by a **periodic reconcile poll** against the
billing API — or a paying customer quietly loses Pro.

Sync pattern: billing webhook (signature-verified, idempotent) → update
`subscriptions` → mint a fresh signed entitlement token → the app picks it up on
the next heartbeat.

## 6. Cost model

Heartbeat modeled at ~1,500 Worker+DO requests/user/month. $20/mo price point.
**Free-tier users consume auth MAU and heartbeats too — model them, not just payers.**

| Paying users | Revenue | Auth | Hosting | DB | Billing (MoR) | **Total cost** |
|---|---|---|---|---|---|---|
| 0 | $0 | $0 | $0 | $0 | $0 | **~$0** |
| 100 | $2,000 | $0 | $5 | $0 | ~$150 | **~$155** |
| 1,000 | $20,000 | $0 | $5 | $0–5 | ~$1,500 | **~$1,510** |
| 10,000 | $200,000 | $0 | ~$10 | ~$5 | ~$10,200* | **~$10,215** |

\* At 10k, move to Polar Scale ($400/mo + 3.4%+30¢).

**Where free tiers end:** Workers free → $5 paid once traffic is real (removes the
100k req/day cap); WorkOS free to 1M MAU (effectively never); D1 free to 5M
reads/day; **MoR charges from dollar one.**

**Infra is a rounding error at every scale. The ~7.5% MoR haircut is the entire
cost.** That is the price of never touching a VAT return.

## 7. Five things that will bite you

1. **You cannot instantly kill a stateless JWT.** Kick via the lease, not the auth
   provider. Keep access tokens 5–15 min.
2. **Webhook races silently strip access.** Idempotent handlers + reconcile poll,
   or paying users lose Pro at random.
3. **Offline-grace clock abuse.** Cached-TTL trusts the client clock. Cap total
   offline days, check issued-date-not-in-future, keep a monotonic max-seen
   timestamp — and **accept some leakage**. Fail-open is the point.
4. **MoR migration is a trap.** Switching means re-subscribing every customer;
   card data is not portable. Choose once.
5. **Custom-protocol deep links are hijackable.** Any app can register `mogging://`.
   Use loopback + PKCE + `state`. And keep **our own `users` table as source of
   truth** so the auth vendor stays a swappable verifier, not a lock-in.
