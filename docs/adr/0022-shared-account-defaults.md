# ADR 0022 — Shared account defaults

- **Status:** Accepted (2026-07-31)
- **Context:** Profiles (Phase-4/04) gave one provider many accounts, and
  [ADR 0013](0013-sessions-follow-profiles.md) made sessions follow them — but each
  account reads only its OWN config home (`~/.claude`, `~/.claude-work`, …), so a
  setting changed for one account never reaches the others. The configuration control
  plane ([ADR 0011](0011-agent-cli-configuration-control-plane.md)) already knows how
  to observe, validate, write, and drift-restore a provider key at every honest layer
  — it just has no tier that names *all of a provider's accounts at once*. The user
  who holds two subscriptions ends up hand-mirroring every preference change into
  every home, and forgetting one is silent.

## Decision

**A provider-level default tier in the desired-state store, resolved per account and
enforced into every account's config home by the existing enforce machinery.** The
resolution law, binding on every consumer:

```
value(account P, setting S) = pin(P, S) ?? accountDefault(S) ?? P's own file value
```

resolved BEFORE any file write, then enforced into each account's home. In the
existing cascade the tier slots in as
`session > project > local > pin > account-default > file > system` — a per-project
setting still beats a cross-account default, because more specific intent wins.

Mechanically:

- A `tier: 'default'` row is keyed `(provider, settingId)` under the sentinel
  `targetId` `__all__` — it names every account, not a home. A `tier: 'pin'` row keeps
  `targetId = profileId`. The `AgentConfigScope` union is untouched: the tier is
  orthogonal to the real provider layers it compiles into.
- **The blindness law:** authored tier rows are desired-state *input* only. The legacy
  override listing never returns them, so `reconcileAll` and the launch reconcile
  cannot try to enforce a sentinel as if it were a home. Fan-out
  (`applyAccountDefaults`) compiles resolved values into ordinary per-home enforce
  rows and drives THE existing writer — resolution decides *what* each home holds,
  never *how* it is written. There is no second writer.
- **Shared by default:** a value you set is a cross-account default unless you mark
  that key "this account only". A pin is the per-key exception — it never freezes a
  whole account; every unpinned key keeps tracking the default, and changing a default
  propagates to all unpinned homes live.
- **The primary home is a full member:** defaults enforce into the default profile's
  real `~/.claude` too — "all accounts" means all. The first cross-account write is
  announced in the UI; the per-account pin is the escape hatch; drift is restored,
  never silently.
- **[ADR 0002](0002-never-broker-provider-auth.md) stands entirely:** defaults hold
  non-secret values only. The deny-list refuses secret-shaped defaults at the
  persistence boundary itself (`saveAccountDefault` throws) — secret-shaped map keys
  via the agent-settings detector, secret-shaped string values via the review
  redactor, the same patterns that refuse a secret-shaped profile pointer env.

## Rationale

- **One writer, one drift story.** The 0011 enforce path already owns baseline
  capture, CAS-guarded atomic mutation, per-file grouping, and drift restore. A
  parallel "defaults writer" would be the two-implementations disease; compiling the
  tier into the existing rows means every lifecycle guarantee (restore on reconcile,
  honest sync states, release semantics) is inherited, not reimplemented.
- **Pointer identity, like sessions.** Accounts are profile config homes
  (ADR 0013's identity), so "every account" is enumerable without guessing: the
  provider's pointer-env profiles plus the primary user home.
- **Per-key pins beat per-account forks.** The alternative — cloning a whole settings
  home per account — recreates exactly the drift this ADR removes. Sameness is the
  norm; a pin is the deliberate, visible exception.

## Consequences

- The tier enforces sameness through the app's own writer: a CLI edited entirely
  outside the app between reconcile ticks is transiently divergent until the next
  tick. That is the honest limit, and the docs say it.
- A pin saved on a key that already carries a profile-scoped override adopts that
  row (same primary key) — the pin subsumes the narrower intent, which is what the
  user meant by pinning.
- Provider rollout is deliberately incremental: fan-out and its UX are enabled
  per-provider (Claude Code first), because each provider's home enumeration and
  codec behavior is certified by its own gate before the tier reaches it.
- Rows live in the existing `app_agent_config_overrides` table (one additive `tier`
  column, NULL = legacy scoped override unchanged) — no new store, no migration risk
  beyond an idempotent `ALTER`.
- Setting values never enter telemetry; counts of managed defaults may (ADR 0005).
