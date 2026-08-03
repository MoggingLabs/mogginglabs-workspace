// Session-generation policy. Deliberately NOT in protocol.ts: that file is the WIRE
// SHAPE, fingerprinted and pinned to DAEMON_PROTOCOL_VERSION (scripts/check-protocol-version.mjs),
// and this moves no byte on the wire — it only decides WHICH generation goes in a field
// the wire already had. Keeping it here would burn a re-pin on every future edit.

/** The generation to stamp on a command for `id`, decided from the map the RELAY owns.
 *
 *  Identity minted by a lower layer is stamped by the layer holding the authoritative
 *  map — never carried by a client across a boundary the minting layer can re-cross. A
 *  renderer learns its gen once, from its own spawn reply; the daemon remints generations
 *  from 1 on every restart, in restore order. So after a heal the renderer's copy can name
 *  a generation this daemon gave to a different pane, and the gen gate then drops its every
 *  keystroke and resize with no exit event and no banner — a pane that just stops taking
 *  input. Main's map is refreshed ahead of every replay, so main is the one that stamps.
 *
 *  'drop'      — the app closed this pane; the command is refused outright.
 *  a number    — stamp it; the daemon's gate compares against the live session.
 *  undefined   — we have not learned a gen yet; the daemon accepts an unstamped command
 *                by design, so this preserves the ungated behavior rather than inventing one. */
export function stampGen(gens: ReadonlyMap<string, number | 'killed'>, id: string): number | 'drop' | undefined {
  const g = gens.get(id)
  if (g === 'killed') return 'drop'
  return typeof g === 'number' ? g : undefined
}
