# Hardening implementation plan — closing Electron's limitations, measure by measure

**Date:** 2026-07-15 · **Status:** research + implementation plan, no code changed ·
**Companion to:** [2026-07-productization-accounts-subscriptions.md](2026-07-productization-accounts-subscriptions.md)
(§5–6 there names the limitations; this doc is the countermeasure for each, with the exact
mechanism, the repo-specific change, and what it honestly buys).

**Framing.** "Remove the limitation" means one of two things, and the difference is the whole
plan: **eliminate** (rearchitect so the weakness no longer exists — possible for token theft,
Node-mode abuse, secrets-in-bundle, and everything server-side) or **raise the cost**
(tamper-evidence and unreadability — possible up to a ceiling stated in §7). Every measure
below is labeled with which one it is.

---

## 1. Threat model — who we are defending against

| # | Attacker | Example | Verdict after this plan |
|---|---|---|---|
| A | **Casual unlocker** — bored dev, 20 minutes, a blog post | edits `app.asar` to flip `plan: 'pro'` | **defeated** (fuses + ASAR integrity + bytecode + signed builds) |
| B | **Cracker** — skilled, hours-to-days, redistributes a patched build | strips entitlement module, re-signs with own cert | cost raised sharply; **local** features unlockable at effort; server-backed features + updates + support stay closed to the crack |
| C | **Infostealer** — same-user malware exfiltrating files | steals vault 