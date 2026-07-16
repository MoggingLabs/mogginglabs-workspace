import { homedir } from 'node:os'
import { join } from 'node:path'

// THE per-user runtime base + run-file path, shared by the three bin satellites
// (mogging, mogging-mcp, mogging-connection). Each satellite ran its own byte-identical
// copy of this derivation — and it MUST match src/backend/platform/runtime-paths.ts, or
// the CLI looks for the daemon's socket/endpoint in a directory the app never wrote.
// These are plain-Node processes spawned separately from the app, so they cannot import
// the TS helper; this is the closest single source they can share. Copied into the
// private runtime alongside them (cli-runtime.ts SATELLITES), like endpoint-client.mjs.

/** The OS base under which MoggingLabs runtime paths live. */
export function runtimeBase() {
  return process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_RUNTIME_DIR || join(homedir(), 'Library', 'Application Support')
}

/** A file inside the per-channel, per-version runtime dir. `runSegment` is each
 *  satellite's own version-pinned segment (`v<N>` / `dev-v<N>`) — deliberately kept
 *  per-file so scripts/check-protocol-version.mjs can pin each one independently. */
export function runFile(runSegment, name) {
  return join(runtimeBase(), 'MoggingLabs', 'run', runSegment, name)
}
