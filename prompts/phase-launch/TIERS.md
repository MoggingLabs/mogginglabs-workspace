# TIERS — the plan matrix (single source of truth)

What each plan GRANTS, in the mechanism the code actually reads:
`limits{}` rows (`ENTITLEMENT_LIMIT_NAMES` in `src/contracts/entitlements/
index.ts`) and `features[]` strings (`entitlements.allows()`). Prices live
in `../MoggingLabs-Website/PRICING-STRATEGY.md`; this file is what 08
ratifies, 10 bills against, 11 mints, and 18 renders. **If a benefit is not
a row or a flag here, it is not enforceable — do not sell it as live.**

> **v1 scope law.** Only **Free** and **Pro** are DELIVERABLE at v1. Team
> and Enterprise are **waitlist-only**: no Stripe product, no price id, no
> entitlement path, no org schema. A tier with no mechanism must never be
> presented as purchasable.

## The matrix

| | **Free** | **Pro** | **Team** | **Enterprise** |
|---|---|---|---|---|
| Status | LIVE | LIVE | **waitlist** | **waitlist** |
| Price | $0 | $19/mo · $15/mo annual | $29/seat (not sellable at v1) | contact sales |
| Account required | **no** | yes | — | — |
| `maxWorkspaces` | **2** | unlimited | — | — |
| `maxPanes` | **4** | **16** (app ceiling) | — | — |
| `maxConnections` | **25** | **25** | — | — |
| `maxSwarmRoles` | **4** | **16** | — | — |
| `maxRemotes` | **10** | unlimited | — | — |
| `maxDevices` | n/a (no claim) | **3** | — | — |
| `features[]` | `[]` | `[]` | — | — |

`unlimited` = the row is ABSENT from the claim, so `limit()` fails open to
`Infinity` (the shipped contract, `entitlements/index.ts:60`). Never mint a
sentinel number for unlimited.

## Notes that bind the steps

- **`maxWorkspaces` and `maxDevices` are NEW rows.** Neither exists today;
  both must be added to `ENTITLEMENT_LIMIT_NAMES` with a real gate point,
  or Free's 2-workspace limit silently fails open. 08 decides, the app
  enforces workspaces, 11 enforces devices at issuance.
- **`maxSwarmRoles` tracks `maxPanes`.** Free at 4 panes with the shipped
  16 swarm roles is incoherent; it moves to 4.
- **Integrations are NOT a paywall** (the funnel decision): `maxConnections`
  is 25 on both live tiers. The paid levers are workspaces, panes, swarm
  roles, remotes, devices.
- **`features[]` is empty on every live tier at v1 — by design.** Every Pro
  differentiator is a LIMIT, not a flag. Do not invent flag strings in 11.
  The first real flag will be `sync`, when sync actually ships.
- **Free needs no account and mints no claim**, so no device cap applies to
  it. Free is the `FREE_ENTITLEMENTS` baseline, reached with no login, no
  network, or expired grace (ADR 0016 §2).

## Not-live claims (must be labelled, never sold as present)

- **Cross-machine sync** — a Pro benefit in the pricing copy, **not built
  in this pack**. It has no `features[]` flag and no backend. `/pricing`
  must label it in-development; it may not appear as a delivered Pro
  bullet, and no gate may assert it.
- **Team / Enterprise** — shared workspaces, shared memory, roles, central
  billing, SSO/SCIM, audit, policy, SLA, self-host. None have schema or
  code. Waitlist framing only.

## Annual + plan changes

Pro carries **two Stripe price ids** (monthly, annual). An interval or plan
change arrives as `customer.subscription.updated`; the entitlement is
re-derived from the new price id, Stripe handles proration, and the claim
re-issues on next refresh. Downgrades revert at **current period end**,
never mid-period (10's lifecycle law).
