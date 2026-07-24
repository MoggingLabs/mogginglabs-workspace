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
        model: typeof p?.model?.id === 'string' ? p.model.id : null,
        // The EXACT session file this pane is living in — the identity the app's
        // log matcher otherwise has to guess from mtimes (and can guess wrong when
        // two panes share a cwd). A path on this machine, never content.
        transcriptPath: typeof p?.transcript_path === 'string' ? p.transcript_path : null
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
  // Passthrough: the user's own configured statusline still renders. Ours arrived via
  // --settings (CLI-arg precedence — it beats every file for the session), so their
  // command is read back from the settings files in the CLI's own file order:
  // local > project > user. Claude runs the statusline at the session's cwd, so the
  // project files resolve against process.cwd(). A file whose statusline IS this
  // relay (a copy-paste) is skipped, never exec'd — no recursion — and the next
  // scope down still gets its turn.
  try {
    const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const scopes = [
      join(process.cwd(), '.claude', 'settings.local.json'),
      join(process.cwd(), '.claude', 'settings.json'),
      join(home, 'settings.json')
    ]
    let cmd = null
    for (const file of scopes) {
      let c
      try {
        c = JSON.parse(readFileSync(file, 'utf8'))?.statusLine?.command
      } catch {
        continue // absent or unreadable scope — the next one still applies
      }
      if (typeof c === 'string' && c && !c.includes('context-relay')) {
        cmd = c
        break
      }
    }
    if (cmd) {
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
