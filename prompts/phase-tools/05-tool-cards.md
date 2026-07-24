# 05 — Tool cards + the detail: the catalog made visible

Read README + the survey first. The big UI step; steps 01–04 feed it.

## Goal
Settings § Integrations becomes a grid of TOOL cards; a tool opens its DETAIL with the
method chooser, identity, scoping, and keys — everything rendered FROM the catalog.
One tool = one card, whichever route holds its credential.

## Deliverables
1. **The card**: logo · name · status tag (`✓ Connected · verified {n}m ago` /
   `Needs attention` / `Not connected` / `Connecting…` — step 03's `verifiedAt`) ·
   identity line (step 04 precedence). Groups: Connected → Needs attention → Not
   connected(-but-known). Filter field stays. A service present on both routes is ONE
   card — merge key = catalog service id; the detail shows both facts.
2. **The detail** (expand-in-place or panel per house pattern): status + Check +
   Disconnect; identity row + "Add a note…"; **the chooser** when not connected —
   the catalog's `methods[]` in rank order with ADR 0020 outcome wording, each with
   its one-line custody subtitle in fine print. Method kinds map: `oauth` → "Sign in
   with your browser"; `apiKey` → "Paste an API key" (typed input fields from the
   catalog: labels, help text, secret masking — the Activepieces pattern; includes
   `connectionConfig` fields like instance URLs); `cliOwned` → "Let Claude Code sign
   in itself (advanced)" (Route B apply + authorize, claude-code only, one fold).
   Existing forms move in with retain/scrub laws intact (SECRETFORMS /
   submitWithRetain — do not re-derive). The no-DCR client-id form renders the
   catalog's `setupGuideUrl` as a real link ("create your client here").
3. **Humanized scopes** (Metorial): the "Can:" line renders scope `title`s from the
   catalog, raw scope string in the title attribute; unknown scopes fall back to the
   raw string. Granted-but-uncataloged never hidden.
4. **Scoping inside the detail**: today's scopePanel (per-workspace checkboxes)
   renders in the detail for a connected tool. Workspace-tools card shrinks to the
   power-user matrix + write grant (mechanics unchanged, caption updated).
5. **Key slots in the detail**: `${VAR}` paste fields relocate here (vault semantics
   unchanged); Service-keys card stays the audit view.
6. **Claude Code first**: primary surfaces speak only of Claude Code; Codex/Gemini
   are greyed `coming soon` rows in the advanced fold, zero handlers. Backend
   three-CLI truth (HOSTED etc.) untouched — presentation filters only.
7. **The differentiator, stated**: the custody caption gains the survey-earned line —
   sign-in runs entirely on this machine; no vendor cloud ever sees a token. Must
   pass `check-credential-wording.mjs`.
8. `McpPreset` consumers retire onto the catalog (step 01's shim deleted). The
   Library reads the same catalog; its Route-B fold keeps registry search/import.
9. **TOOLWORDS flips to ENFORCING** for every file this step rewrote.

## Gate — TOOLCARDS
Env-gated smoke on the fixture AS: (a) dual-route fixture service → ONE card (single
node per service id); (b) status tag tracks `verifiedAt` and flips on fixture kill;
(c) chooser renders exactly the catalog's methods, rank order, ADR strings verbatim,
setup link present for a no-DCR fixture; (d) scope titles humanized, raw in title
attr, unknown scope falls back; (e) a detail workspace checkbox mutates the plan
(planGet asserts) and the matrix agrees; (f) coming-soon rows: dispatched click
invokes nothing. Mutation-red ×2: break the merge key ((a) red); break method rank
ordering ((c) red).

## Guardrails
- Zero new write paths — every mutation rides existing channels.
- Existing gates reconciled IN THE SAME COMMIT that moves their DOM: integux,
  SETINTEG, MUTATIONRACE anchors, CONNPURE UI asserts, AUTHRUNNER, MCPCAT. Same
  guarantees, new selectors — never deleted.

## Done when
TOOLCARDS green ×2 mutation-reds; sweep green vs baseline; TOOLWORDS enforcing.
