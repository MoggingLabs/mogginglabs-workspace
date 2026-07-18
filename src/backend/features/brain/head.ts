import { execFile } from 'node:child_process'

// HEAD moves (ADR 0018, step 04). The branch probe already surfaces HEAD per root on the
// shared tick; when it MOVES (checkout, rebase, merge, commit), the delta between the two
// commits is the exact set of paths the index may now be wrong about — and NOTHING else.
// This file is the pack's ONE new git invocation TYPE: fired on a head move only, never
// periodic, never a rebuild. The freshness smoke counts reparsed files and asserts
// delta-only, which is what keeps a branch switch on a 50k-file repo costing tens of
// files instead of the tree.
//
// `--name-status` where the goal's shorthand said `--name-only`, deliberately: same single
// spawn, but a rename under --find-renames must surface its OLD path too — --name-only
// prints only the new one, the old row would survive as a ghost, and the determinism arm
// (incremental dump == rebuild dump) would catch the drift. Both sides of every entry are
// fed through the same incremental path; a path that no longer exists simply resolves as
// a tombstone at drain time.

/** Head-move diff spawns, read by the BRAINFRESH smoke: this may only ever move when a
 *  HEAD move was observed — a periodic caller would show up here as a runaway count. */
let headDiffSpawns = 0
export function headDiffSpawnsForSmoke(): number {
  return headDiffSpawns
}

/** Parse `git diff --name-status -z` output: NUL-separated records of a status token
 *  followed by one path (M/A/D/T/U) or two (R/C carry old THEN new). Every path named is
 *  a candidate — old and new alike. */
export function parseNameStatusZ(out: string): string[] {
  const tokens = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]
    if (!status) continue
    const first = tokens[++i]
    if (first === undefined) break
    paths.push(first)
    if (status[0] === 'R' || status[0] === 'C') {
      const second = tokens[++i]
      if (second !== undefined && second !== '') paths.push(second)
    }
  }
  return paths.filter(Boolean)
}

/**
 * The paths that differ between two commits, or null when git cannot answer (an oid gone
 * to gc, a repo mid-surgery) — null tells the caller "reconcile against the walk", never
 * "assume nothing changed". Read-only, bounded, windowsHide — the probe.ts posture.
 */
export function diffHeadMove(root: string, fromOid: string, toOid: string): Promise<string[] | null> {
  headDiffSpawns++
  return new Promise((resolve) => {
    execFile(
      'git',
      [
        '-C',
        root,
        '--no-optional-locks',
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        '--end-of-options',
        fromOid,
        toOid
      ],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) resolve(null)
        else resolve(parseNameStatusZ(stdout))
      }
    )
  })
}
