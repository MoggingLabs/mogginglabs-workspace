# Shared account defaults — one settings baseline across every account

Profiles gave one provider many accounts; [ADR 0013](adr/0013-sessions-follow-profiles.md)
made sessions follow them. But each account reads only its OWN config home
(`~/.claude`, `~/.claude-work`, …), so a setting changed for one account never reached
the others. The shared-defaults tier ([ADR 0022](adr/0022-shared-account-defaults.md))
closes that: a value authored ONCE applies to every account of a provider, with
per-account pins that win — riding the configuration control plane
([ADR 0011](adr/0011-agent-cli-configuration-control-plane.md)) end to end.

## The resolution law

```
value(account P, setting S) = pin(P, S) ?? accountDefault(S) ?? P's own file value
```

Resolved BEFORE any file write, then enforced into each account's home. In the full
cascade the tier sits exactly here:

```
session > project > local > pin > account-default > file > system
```

A per-project setting still beats a cross-account default — more specific intent wins.
A user-authored scoped override at an account layer is an **implicit pin**: the fan-out
never touches it.

## The three doctrines

- **Shared by default.** A value you set from the account layers is a cross-account
  default unless you mark that key "this account only". Sameness is the norm; a pin is
  the per-key exception — it never freezes a whole account, and every unpinned key
  keeps tracking the default live.
- **The primary home is a full member.** Defaults enforce into the default profile's
  real `~/.claude` too — "all accounts" means all. The primary carries its own profile
  identity, so a pin on the primary resolves like any other.
- **ADR 0002 stands entirely.** Defaults hold non-secret values only. The deny-list
  refuses secret-shaped values at the persistence boundary itself (`saveAccountDefault`
  throws) — map keys via the agent-settings detector, string shapes via the review
  redactor — and the promote scan excludes them before a suggestion ever crosses IPC.

## Mechanics — what, never how

Authored tiers are two row kinds in the existing desired-state store (one additive
`tier` column): `tier: 'default'` keyed `(provider, settingId)` under the `__all__`
sentinel, and `tier: 'pin'` keyed by its profile (stored under a `__pin__:` target
namespace so a pin can never collide with its own home's compiled row). **The
blindness law**: authored tier rows are input only — the legacy override listing never
returns them, so no reconcile can enforce a sentinel as a home.

Fan-out (`applyAccountDefaults`) compiles what each home should hold into ordinary
`tier: 'compiled'` enforce rows and drives THE existing writer. There is no second
writer: baseline capture, CAS-guarded atomic mutation, drift restore, launch
reconcile, and release semantics are inherited, not reimplemented. The fan-out is
idempotent — a key that stops resolving releases its compiled row and the file keeps
its last value.

## The lifecycle

- **Propagate**: changing a default re-reaches every unpinned home through one
  debounced apply per provider (a burst of triggers costs one fan-out, never a loop).
- **Adopt**: a new or newly discovered account inherits all current defaults on the
  same signal the profiles feature already fires; startup schedules one healing apply
  for providers with authored tiers, off the critical path.
- **Restore**: a hand-edit that drifts a managed key is restored by the existing
  reconcile tick — there is no second drift detector.
- **Reset**: clearing a pin makes the home re-inherit the shared value live; removing
  a default releases every managed key — values are kept, never blanked, and a
  subsequent hand-edit sticks.

## The UX contract

In the one settings home (no parallel screen), an eligible row gains:

- **Applies to** — *All accounts* (the default selection) vs *This account only*.
  "This account" is resolved main-side: a profile target pins that profile, a user
  target pins the primary.
- **Honest labels** — an *Account default* / *Pinned* badge, and the Desired line
  names the tier as its source.
- **Reset to default** on a pinned key; **Stop managing everywhere** on a default.
- **The promote chip** — a key ≥2 homes already agree on is offered back as a
  one-click default. A suggestion only; it never writes without a click.
- **First-write consent** — the first save that reaches across accounts is announced
  (account count and the primary home named); the session opt-out keeps it from
  becoming a nag. Pinning is never announced — it narrows, not widens.

## Honest limits

- Sameness is enforced through the app's own writer: a CLI edited entirely outside
  the app between reconcile ticks is **transiently divergent** until the next tick.
- **Rollout is per-provider, Claude Code first** (`DEFAULTS_PROVIDERS`): each
  provider's home enumeration and codec behavior is certified by its own gate before
  the tier reaches it. The engine underneath is provider-generic.
- Setting values never enter telemetry; counts of managed defaults may (ADR 0005).

## The gates

`DEFAULTSTORE` (the model + the deny-list + the blindness law) ·
`PROFILEDEFAULTS` (resolution + fan-out + the whole lifecycle on three isolated
homes) · `DEFAULTSUX` (the face, composed in the real Settings UI) ·
`DEFAULTSMILESTONE` (the one composed authority — see
`prompts/phase-defaults/REPORT.md` for receipts).
