import { DAEMON_PROTOCOL_VERSION } from '@contracts'

// The statusline relay SOURCE — generated to disk by src/main/context.ts at launch
// time (nothing to package; dev and installed builds identical) and executed by
// Claude Code as its statusline command inside app-launched panes. Lives here,
// Electron-free, so the verification suite can run the exact shipped script.
//
// The sink dir it writes must match what readers.ts reads. Being a plain-Node script the
// relay cannot import the contract, so it restates the channel derivation exactly as the
// other plain-Node satellites do (bin/mogging.mjs, bin/mogging-mcp.mjs); the protocol
// version is INTERPOLATED from the contract below, never restated.
export const RELAY_SOURCE = `// MoggingLabs Workspace context relay — GENERATED, do not edit (rewritten on app start).
// Claude Code invokes this as its statusline command inside app-launched panes. It
// forwards Claude's OWN context numbers (used_percentage — the /context value — and
// the true context_window_size) to a per-pane sink file the app polls, then runs the
// user's real statusline command transparently. Counts and a model id only: no prompt
// text, no credentials, nothing leaves this machine.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, userInfo, homedir } from 'node:os'
import { spawn } from 'node:child_process'

// Sink dir = tmpdir + username + CHANNEL/version segment (the same namespace the daemon's
// socket/lock/endpoint use). Pane ids are per-app: an installed release and a dev build both
// have a pane 1, and a segment-less dir made their relays overwrite each other's sink — each
// app's context bar then read the OTHER app's numbers. MOGGING_CHANNEL is inherited from the
// daemon that spawned this pane, so the relay lands in the dir its OWN app polls.
const SEGMENT = (process.env.MOGGING_CHANNEL === 'dev' ? 'dev-v' : 'v') + ${DAEMON_PROTOCOL_VERSION}

const readStdin = async () => {
  let d = ''
  process.stdin.setEncoding('utf8')
  for await (const c of process.stdin) d += c
  return d
}

const main = async () => {
  const raw = await readStdin()
  try {
    const paneId = process.env.MOGGING_PANE_ID
    if (paneId && /^[\\w.-]+$/.test(paneId)) {
      const p = JSON.parse(raw)
      const cw = p?.context_window ?? {}
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const out = JSON.stringify({
        at: Date.now(),
        usedPct: num(cw.used_percentage),
        windowTokens: num(cw.context_window_size),
        usedTokens: num(cw.total_input_tokens),
        model: typeof p?.model?.id === 'string' ? p.model.id : null
      })
      const dir = join(tmpdir(), 'mogging-ctx-' + userInfo().username + '-' + SEGMENT)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, paneId + '.json')
      writeFileSync(file + '.tmp', out)
      renameSync(file + '.tmp', file) // the app never reads a half-written sink
    }
  } catch {
    /* never break the statusline over a payload surprise */
  }
  // Passthrough: the user's own configured statusline still renders. Their command
  // comes from the SAME settings file claude reads; ours arrived via --settings and
  // never lands there, but the self-check guards a copy-paste anyway.
  try {
    const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const s = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
    const cmd = s?.statusLine?.command
    if (typeof cmd === 'string' && cmd && !cmd.includes('context-relay')) {
      const child = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'ignore'] })
      const t = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        process.exit(0)
      }, 2000)
      child.on('exit', () => {
        clearTimeout(t)
        process.exit(0)
      })
      child.on('error', () => {
        clearTimeout(t)
        process.exit(0)
      })
      child.stdin.end(raw)
      return
    }
  } catch {
    /* no user statusline — print nothing */
  }
  process.exit(0)
}
void main()
`
