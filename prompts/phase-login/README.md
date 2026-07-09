# Phase Login — accounts, plans, entitlements, and the empty room

**Status: RESEARCH ONLY. No prompts written yet. No code changed.**

This pack is the research substrate for turning MoggingLabs Workspace into a
paid product with accounts, plans, per-plan feature gating, and single-device
enforcement. It exists because that goal, taken literally, **contradicts the
product's own founding documents** — and because the naive implementation
(a login wall in front of a local app) protects nothing.

Read `05-product-positioning-and-tiers.md` first if you read only one file.

## The conclusion, in one paragraph

You cannot enforce accounts, plans, or single-device in a purely local app —
there is no trust anchor. You also cannot move this app to the cloud — it
spawns PTYs against the user's own source code with the user's own API keys.
The answer is the standard hybrid: **a local-first app plus a thin cloud
control plane** (auth, entitlements, device lease, billing), with signed
short-TTL entitlement tokens cached on disk for offline grace. A login wall is
worth building — it stops effectively every real user — but it is *not* what
protects revenue. What protects revenue is that the paid features **execute on,
or hold their state on, our server**, so that a cracked client unlocks an empty
room. The empty room and the free tier turn out to be the same room.

## Documents

| File | What it settles |
|---|---|
| `01-architecture-as-is.md` | Trust-boundary map of the app today, with `file:line`. The five entry points, not one. |
| `02-what-is-achievable.md` | The hard limits. Why a login wall is crackable, why Tauri doesn't help, and the empty-room test. |
| `03-enforcement-surfaces.md` | The concrete gates: the entitlement table, the one IPC choke point, the daemon, the MCP endpoint, the CLIs. |
| `04-control-plane-stack.md` | Cloud vs local answered. Recommended stack, the device lease, offline grace, fail-open, cost model. |
| `05-product-positioning-and-tiers.md` | The contradiction with `docs/00` + `README.md`. The tier split. What ADR 0009 must say. |
| `SOURCES.md` | External research, with links. |

## The one decision that gates everything

**Does the local tool stay free and account-free?**

- **Yes** → ~4–6 weeks. The security model is sound because the paid surface is
  server-resident. `README.md`'s "no subscription to us" stays honest. The
  cracked client yields a bare terminal multiplexer, which is what the free tier
  is anyway.
- **No** (the local app itself requires login) → months of client hardening that
  a motivated developer defeats in an afternoon, the stated positioning breaks,
  and we ship DRM to the audience least willing to tolerate it. The research is
  unambiguous: don't.

Nothing in this pack should be turned into a prompt until that is answered.

## Do these two things before any prompt runs

1. **Flip the repo private.** It is public today with **0 forks, 0 stars**
   (`gh repo view`, 2026-07-09). The `LICENSE` is proprietary, all-rights-reserved,
   so nobody has the *right* to fork the pre-paywall build — but the window to
   close this cleanly is open and will not stay open once there is a paywall
   worth patching out.
2. **Write ADR 0009**, superseding the non-goal at
   `docs/00-vision-and-positioning.md:56` — *"No hosted/cloud backend, no
   credits, no account system."* It must state explicitly that **ADR 0002 is
   untouched**: our own account is not brokering *provider* auth, and never will be.

## When the prompts get written

Same format as `prompts/phase-1..8.5/` — each step self-contained, pasteable as a
`/goal`, **≤ 3950 characters** (the `/goal` hard cap is 4000 and you prepend a
preamble). Verify after editing:

```
python3 -c "import sys;[print(len(open(f,encoding='utf-8').read()),f) for f in sys.argv[1:]]" prompts/phase-login/[0-9]*.md
```

Suggested sequence, cheapest-and-most-informative first:

1. **The entitlement table** (`03`, §2). One day, breaks nothing, and forces a
   tier decision on all 119 IPC handlers. Do this first — the exercise itself
   tells you how much of the product is even chargeable.
2. **Control plane + auth** (`04`). Workers + Durable Object + WorkOS + Polar.
3. **One server-resident feature end-to-end** — usage history, since it already
   exists (`src/backend/features/usage/`). Learn the sync pattern on low-risk ground.
4. **The five gates** (`03`, §3).
5. **Fuses, `utilityProcess`, signing, notarization** (`03`, §4). Last: it buys
   the least, and it's easiest to get right once nothing else is moving.

## Provenance

Compiled 2026-07-09 from a direct read of the repo at `6c03c35` plus two
web-research passes (see `SOURCES.md`). File and line references were verified
against the working tree at that commit; re-check them before relying on a line
number, since this pack will outlive the lines.
