import type { BoardGhWorld } from './fixture-port'

/**
 * Deterministic gh/git world for the BOARDGH gate (finding-41 discipline: this
 * module exists only in the DEV module graph — harness-install wires it; the
 * production fixture hook stays null, so the shipped app can only ever run the
 * user's real gh). The smoke sets the world, drives the real handlers, and
 * asserts what they DID — zero network, zero real gh.
 */

let world: BoardGhWorld | null = null

/** Armed (and re-armed, mid-run) by the BOARDGH smoke. */
export function setBoardGhWorld(next: BoardGhWorld | null): void {
  world = next
}

export function currentBoardGhWorld(): BoardGhWorld | null {
  return world
}
