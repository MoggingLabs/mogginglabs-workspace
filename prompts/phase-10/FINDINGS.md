# FINDINGS — Agents on real logged-in sessions vs. Perplexity Comet

Captured 2026-07-05, after shipping 6/05b (agent browser control via MCP). This
is the durable record of the "make it work like Comet" analysis so we can pick
it up cold. No code decision has been made — this is the map, not the route.

## 1. What we shipped (the baseline)

The browser dock (6/05) + agent control (6/05b): agents drive a `WebContentsView`
via MCP tools (navigate/snapshot/screenshot/click/type/scroll/select/eval/
console/network_failures/wait_for), consent-gated per workspace, visible
possession + instant Stop. **Crucially, the dock runs
`session.fromPartition('persist:browser-dock')` — an isolated partition that
starts empty.** Agents act only with whatever is signed in *there*. This is
ADR 0002 made concrete: we broker no credentials, touch no cookies.

## 2. How Perplexity Comet differs

Comet is a full Chromium browser meant to be your PRIMARY one. You sign into
your accounts in it, and its agent acts **on those live sessions** — email,
calendar, shopping, etc., authenticated as you. That "acts as you across your
logged-in web life" is Comet's whole value proposition and its whole risk.

**Where ours already matches Comet:** the perception+action mechanic (a real
Chromium view the agent reads and manipulates). Verb set is comparable.

**Where ours deliberately diverges:**
- Sessions: Comet = your real logins; ours = empty isolated partition. THE
  crux.
- Driver: ours = MCP, so any hosted CLI (Claude/Codex/Gemini) drives it;
  Comet = Perplexity's own baked-in agent.
- Scope: ours = a preview dock in a dev tool; Comet = a whole browser.

## 3. The fork — what "real logged-in sessions" means

The effort/risk differs by an order of magnitude depending on interpretation.

### Branch A — sessions established INSIDE the dock
The dock partition is already `persist:`. If the user signs into a site in the
dock once, that session persists and agents can act on it **today, with zero
new session-plumbing.** Real cookies, real auth, persistent, and
consented-by-construction (the human logged in on purpose).
- Work: a "this browser keeps its own logins — sign in here once" affordance;
  per-origin consent; maybe a "clear agent browser logins" control.
- Size: a STEP (1–2), not a phase. ~80% already works.
- ADR 0002 impact: minimal — we still never READ the user's other credential
  stores; the user hands the dock a session by logging in.
- Gets ~80% of the practical value ("the agent can work on the handful of
  sites I care about") with the blast radius contained.

### Branch B — inherit the SYSTEM browser's sessions
Read Chrome/Edge/Safari cookie stores (encrypted cookie DBs + the OS keychain
for the decryption key — same mechanism usage-trackers like CodexBar use to
read dashboards) so the agent is already logged in everywhere the user is.
- Work: pointing a view at imported cookies is modest CODE; the PHASE is the
  security design around it (see §4).
- Size: a genuine PHASE.
- ADR 0002 impact: **direct reversal.** "Your keys, your CLIs, we broker
  nothing" is the product identity; reading the system cookie store crosses
  exactly the line ADR 0002 drew. Requires a new ADR, not a flag.

### Branch C (middle path worth naming) — a dedicated "agent browser" profile
A persistent profile separate from BOTH the empty partition AND the system
browser; the user logs into it once and treats it as the agent's workspace
browser. Functionally Branch A with a first-class profile identity + management
UI. Safer than B (no system-cookie reading), more deliberate than A.

## 4. What a responsible Branch-B phase contains

The code is small; THIS is the work, and it's non-negotiable given the stakes.

1. **ADR (0011+) revising ADR 0002's boundary.** Defines precisely when/how a
   real session may be used, which stores may be read, and what stays
   forbidden. Load-bearing product-identity decision. Nothing else starts
   until it lands.
2. **Session sourcing** — per-OS cookie/keychain read (Chrome/Edge/Safari
   profiles; Windows DPAPI / macOS Keychain / Linux libsecret). Fragile,
   per-OS, versioned by browser. The dangerous plumbing.
3. **Per-ORIGIN consent + sensitive-origin blocklist.** Per-workspace on/off
   is the floor; real logins need "agents may act on github.com, NEVER on my
   bank." Sensitive origins (banking, email, gov) blocked by default.
4. **Prompt-injection becomes the central threat, not a footnote.** A hostile
   page injecting instructions into a snapshot can steer an agent holding your
   cookies into acting as you. Defenses: read-vs-act distinction per origin;
   human-in-the-loop confirmation for state-changing verbs (send/buy/delete/
   post); origin-change alerts; the visible-possession + Stop we already have.
5. **Audit trail with teeth** — "what did the agent do on which authenticated
   origin," reviewable, retained locally (ADR 0005: never telemetry).
6. **Honest consent copy + a threat-model doc** — the flow must say plainly:
   an agent on your live sessions can be manipulated into acting as you.

## 5. Recommendation on record

- Do **Branch A** (or C) first regardless — cheap, safe, real, and it may fully
  satisfy the actual use case ("let the agent work on the sites I choose").
- Reach for **Branch B** only if the requirement is genuinely "already logged
  in everywhere I am the moment I open it." If so, treat it as a phase whose
  deliverables are the ADR + injection defenses + per-origin consent — the
  browser plumbing is the easy 20%.
- Open question to resolve at pickup: which does Pedro actually want —
  "log the agent's browser into a few sites" (A/C) or "inherit my whole
  logged-in web life from Chrome" (B)? That answer sizes everything.

## 6. Pointers
- Baseline code: `src/main/browser-dock.ts` (the `persist:browser-dock`
  partition is the single line Branch B would change), `bin/mogging-mcp.mjs`,
  `docs/13-browser.md` (§ "The session, honestly" is the current honest story
  this phase would revise).
- Trust boundary being crossed: `docs/adr/0002-*` (never broker credentials).
- Consent pattern to extend: 6/05b's per-workspace toggle (Settings § Browser).
