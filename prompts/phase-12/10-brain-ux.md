The Brain becomes visible: one full-app view — status, the
force-directed graph lens, the memory reader, every consent in one
place. House primitives, tokens only, both themes — a surface that
would grade A in the 8.5 audit.

## Steps
1. **The view** (`src/ui/features/brain/`, the board/settings
   full-app-view precedent): opened from the palette ("Brain"); NO
   new titlebar button (8.5 restraint); shortcut `Ctrl+Shift+M`
   (verify free at build time; fallback `Ctrl+Shift+K`; record
   which). Left rail = status + lenses; main = graph canvas OR
   memory reader; right = inspector.
2. **Status card** (Card/SectionHeader/FieldGroup): generation,
   dirty (live via `brain:changed`), files/nodes/edges, language
   counts, ref fidelity, cache hit-rate, library ecosystems, memory
   count + dangling links — numbers the backend already reports. Actions: Rebuild (`busy` honesty) + the two consents
   (orientAtLaunch, fetchLibraryDocs — the SAME settings the
   Settings cards own, two-way live). EmptyState for no-folder
   workspaces; a "first index" progress state, never frozen.
3. **The graph lens** (canvas, house code, zero deps): force layout
   (spring + repulsion, seed positions from node-id hash — layout
   DETERMINISTIC per generation; reduced-motion shows the settled
   frame directly). NEVER the whole graph: a FOCUS neighborhood —
   pick a node (search box, type-ahead over defs + memory slugs) →
   ≤ 150 nodes by rank around it, edge kinds token-colored, memory
   nodes distinct. Click → inspector (kind, sig, file:line,
   neighbors, backlinks); double-click a code node → reveal in the
   explorer (delegate, never embed an editor); a memory → the
   reader.
4. **The memory reader**: rendered from the indexed body —
   `textContent`-only (agent-written = UNTRUSTED; no innerHTML);
   `[[wikilinks]]` become house buttons that navigate the lens;
   dangling targets dimmed, "wanted"-affixed. No editor — memories
   are edited by agents or the user's own tools (ADR 0010's
   delegation extended).
5. **Gallery + a11y**: gallery states both themes (status,
   progress, empty, graph focus, reader, dangling); AA measured for
   every new ink/fill (measure resolved colors — the color-mix
   caveat); full keyboard path search → results → focus →
   inspector; reduced-motion = zero animation frames.
6. **BRAINUX smoke** (`MOGGING_BRAINUX`, dispatch branch,
   qa-smokes.sh row): fixture indexed, real window — (a) palette +
   shortcut open the view; (b) status equals `brain_status` truth;
   a shell-pane edit moves dirty→0 live on screen (polled);
   (c) search the known hub → focus renders ≤ 150 nodes, hub
   present (canvas probed via the __mogging handle); (d) inspector
   shows the hub's sig/file; double-click reveals in the explorer
   (spy the seam); (e) the reader renders the hostile-bytes memory
   INERT (textContent asserted), wikilink click navigates, dangling
   dimmed; (f) reduced-motion: two frames identical; (g) no focus
   steal from a busy pane on open; (h) telemetry: booleans/counts
   only. Verdict `out/brainux-result.json`.

## Files
- `src/ui/features/brain/` (view, canvas, reader, inspector) ·
  palette verb · shortcut · settings wiring · gallery states ·
  `smokes/brainux-smoke.ts` · qa-smokes.sh row

## Definition of Done
- BRAINUX green; the sweep count grows by one.
- Pedro can open the view on a real repo and FIND something —
  manual pass first (the manual-first rule), then the smoke.
- Explorer, palette, and shortcut gates green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (AUDIT · SPACING
  · reduced-motion); MILESTONE + PERCEPTION re-run; the ten brain
  gates green in isolation.

## Guardrails
- The lens is a WINDOW, never a 50k-node render — focus + cap.
- Untrusted text discipline everywhere: textContent only.
- Zero new runtime deps; budgets are the veto.
