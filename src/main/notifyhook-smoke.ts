// Env-gated notify-hook smoke (MOGGING_NOTIFYHOOK=1) — windowless, no daemon boot.
// Gates the "always rings the bell" layer (backend/features/agents/notify-hook.ts +
// main/notify-hook.ts) that wires every app-launched CLI to ring its pane:
//  - the generated script exists in userData and the invocation is shell-portable;
//  - each per-CLI builder emits its documented dialect (Claude hooks fragment, Codex
//    OSC-9 TOML args, Gemini/OpenCode merged-through settings, aider env) and
//    bellLaunchExtras routes them without touching any user-owned file;
//  - the generated script actually SPEAKS THE WIRE: run under node against a fake
//    daemon socket it must handshake (hello + token), send a notify carrying the pane
//    id from MOGGING_PANE_ID and the mapped event (Codex JSON blob → house vocabulary,
//    label only — the blob's content never rides along), and always exit 0 — including
//    outside a pane (the silent no-op contract; a hook must never fail its agent).
import { app } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import {
  NOTIFY_HOOK_SOURCE,
  aiderBellEnv,
  claudeNotifyHooks,
  codexBellArgs,
  geminiSystemSettings,
  opencodeConfig,
  opencodePluginSource,
  opencodeTuiConfig
} from '@backend/features/agents'
import { bellLaunchExtras, notifyHookInvocation, notifyHookPath } from './notify-hook'

interface WireResult {
  exitCode: number | null
  helloOk: boolean
  notify: { id?: string; event?: string; message?: string } | null
}

/** Fake daemon: one named pipe / unix socket that answers hello→welcome and records
 *  the notify. Returns what the hook said and how it exited. */
function runHookAgainstFakeDaemon(
  script: string,
  args: string[],
  paneEnv: Record<string, string | undefined>,
  tag: string
): Promise<WireResult> {
  return new Promise((resolve) => {
    const token = 'smoke-token-' + tag
    const address =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\mogging-notifyhook-smoke-${process.pid}-${tag}`
        : path.join(app.getPath('userData'), `nhs-${tag}.sock`)
    const result: WireResult = { exitCode: null, helloOk: false, notify: null }
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      try {
        server.close()
      } catch {
        /* closed */
      }
      resolve(result)
    }
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8')
      let buf = ''
      sock.on('data', (chunk: string) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line) continue
          let m: { t?: string; v?: number; token?: string; id?: string; event?: string; message?: string }
          try {
            m = JSON.parse(line)
          } catch {
            continue
          }
          if (m.t === 'hello') {
            result.helloOk = m.token === token && m.v === 5
            sock.write(JSON.stringify({ t: 'welcome', panes: [] }) + '\n')
          } else if (m.t === 'notify') {
            result.notify = { id: m.id, event: m.event, message: m.message }
            sock.write(JSON.stringify({ t: 'notified' }) + '\n')
          }
        }
      })
      sock.on('error', () => undefined)
    })
    server.listen(address, () => {
      const epFile = path.join(app.getPath('userData'), `nhs-endpoint-${tag}.json`)
      fs.writeFileSync(epFile, JSON.stringify({ address, version: 5, token, pid: process.pid }))
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MOGGING_DAEMON_ENDPOINT: epFile
      }
      // An EXPLICIT undefined in paneEnv means "must be absent" (the no-op case, and
      // it scrubs any value inherited from a Mogging pane this dev shell runs in).
      for (const [k, v] of Object.entries(paneEnv)) {
        if (v === undefined) delete env[k]
        else env[k] = v
      }
      // The hook needs `node` on PATH — its documented requirement.
      const child = spawn('node', [script, ...args], { env, stdio: 'ignore' })
      child.on('exit', (code) => {
        result.exitCode = code
        // Give a just-written notify a beat to flush through the pipe.
        setTimeout(finish, 150)
      })
      child.on('error', () => {
        result.exitCode = -1
        finish()
      })
    })
    setTimeout(finish, 8000) // never hang the smoke on a wedged child
  })
}

export async function runNotifyHookSmoke(): Promise<void> {
  const write = (o: object): void => {
    try {
      const out = path.join(app.getAppPath(), 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'notifyhook-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: notifyhook smoke did not complete' })
    app.exit(1)
  }, 45000)

  try {
    // ── the generated script + invocation ──
    const script = notifyHookPath()
    const inv = notifyHookInvocation()
    const scriptOk =
      !!script && fs.existsSync(script) && fs.readFileSync(script, 'utf8') === NOTIFY_HOOK_SOURCE
    const invOk = !!inv && !!script && inv === `node "${script}"`

    // ── per-CLI builders ──
    const claude = claudeNotifyHooks('INV') as Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>
    const claudeOk =
      claude.Notification?.[0]?.hooks?.[0]?.command === 'INV --event needs-input' &&
      claude.Notification?.[0]?.hooks?.[0]?.type === 'command' &&
      claude.Stop?.[0]?.hooks?.[0]?.command === 'INV --event done' &&
      claude.SubagentStart?.[0]?.hooks?.[0]?.command === 'INV --event subagent-start' &&
      claude.SubagentStop?.[0]?.hooks?.[0]?.command === 'INV --event subagent-stop' &&
      claude.UserPromptSubmit?.[0]?.hooks?.[0]?.command === 'INV --event turn-start'

    // Codex needs BOTH channels: OSC 9 (ambiguous — fires on complete AND on approval) and
    // the notify program (turn-complete ONLY), whose `done` is what lets the tracker resolve
    // a completion to green instead of red. The notify value is a TOML LITERAL array: single
    // quotes (no cmd/sh/PowerShell escaping) and the inner spaces force buildLaunchCommand's
    // outer double-quoting, which is what keeps those single quotes literal under sh.
    const codexBase = '-c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always'
    const codexOk =
      codexBellArgs().join(' ') === codexBase &&
      codexBellArgs('C:\\App Data\\notify.mjs').join(' ') ===
        `${codexBase} -c notify=[ 'node', 'C:/App Data/notify.mjs' ]` &&
      // A path a TOML literal cannot express (an apostrophe) must DROP the arg, never emit
      // broken TOML — a launch must never break over the bell.
      codexBellArgs("C:\\Users\\O'Brien\\notify.mjs").join(' ') === codexBase

    // Merge-through: the admin's/user's own keys survive; only the switch is added. Gemini's
    // notification covers "action-required prompts AND session completion" in ONE switch, so
    // it needs the AfterAgent hook (its done) to be legible — and an admin's own hooks must
    // survive alongside ours (the schema's own mergeStrategy for hook arrays is CONCAT).
    type GemHook = { hooks: Array<{ type: string; command: string }> }
    const gem = JSON.parse(
      geminiSystemSettings({ general: { vimMode: true }, telemetry: false, hooks: { AfterAgent: ['ADMIN'] } }, 'INV')
    ) as {
      general?: { enableNotifications?: boolean; vimMode?: boolean }
      telemetry?: boolean
      hooks?: { AfterAgent?: unknown[]; BeforeAgent?: GemHook[] }
    }
    const gemAfter = gem.hooks?.AfterAgent
    const geminiOk =
      gem.general?.enableNotifications === true &&
      gem.general?.vimMode === true &&
      gem.telemetry === false &&
      gemAfter?.[0] === 'ADMIN' && // the admin's hook is not clobbered
      (gemAfter?.[1] as GemHook)?.hooks?.[0]?.command === 'INV --event done' &&
      gem.hooks?.BeforeAgent?.[0]?.hooks?.[0]?.command === 'INV --event turn-start' &&
      // No script -> no hooks, and the notification-only baseline still applies.
      JSON.parse(geminiSystemSettings({}, undefined) as string).hooks === undefined

    const oc = JSON.parse(opencodeTuiConfig({ theme: 'mono', attention: { sound: false } })) as {
      theme?: string
      attention?: { enabled?: boolean; notifications?: boolean; sound?: boolean }
    }
    // OpenCode has no hook config — its only verdict channel is the generated PLUGIN, and the
    // spec MUST be a file:// URL: a bare path is read as an npm package and OpenCode HANGS
    // fetching it, freezing the launch.
    const ocCfg = JSON.parse(opencodeConfig('C:\\App Data\\plugin.mjs')) as { plugin?: string[] }
    const ocPlugin = opencodePluginSource('C:\\App Data\\notify.mjs')
    const opencodeOk =
      oc.attention?.enabled === true &&
      oc.attention?.notifications === true &&
      oc.attention?.sound === false && // the user's sound preference survives, never forced
      oc.theme === 'mono' &&
      ocCfg.plugin?.[0] === 'file:///C:/App Data/plugin.mjs' &&
      // The plugin must split root from child: a subagent going idle is NOT the main's done.
      ocPlugin.includes('session.idle') &&
      ocPlugin.includes('parentID') &&
      ocPlugin.includes("'subagent-stop'") &&
      ocPlugin.includes("'done'") &&
      ocPlugin.includes(JSON.stringify('C:\\App Data\\notify.mjs'))

    const aider = aiderBellEnv('INV')
    const aiderOk = aider.AIDER_NOTIFICATIONS === 'true' && aider.AIDER_NOTIFICATIONS_COMMAND === 'INV --event done'

    // ── routing: bellLaunchExtras hands each CLI its dialect, generated files live in
    //    userData (session-scoped — never a write to the user's own config). ──
    const exCodex = bellLaunchExtras('codex')
    const exGemini = bellLaunchExtras('gemini')
    const exOpencode = bellLaunchExtras('opencode')
    const exAider = bellLaunchExtras('aider')
    const exClaude = bellLaunchExtras('claude') // Claude rides its --settings overlay (context.ts)
    const exUnknown = bellLaunchExtras('custom-thing')
    // resolve() both sides: userData may arrive as a forward-slash MOGGING_USERDATA
    // while join() builds backslash paths — a raw startsWith can never match.
    const userData = path.resolve(app.getPath('userData'))
    const inUserData = (p: string | undefined): boolean =>
      !!p && path.resolve(p).startsWith(userData) && fs.existsSync(p)
    const extrasOk =
      // Routed WITH the notify script: the real launch must carry codex's done channel,
      // and its path must be the generated script inside userData.
      exCodex.args.join(' ').startsWith(codexBase) &&
      exCodex.args.join(' ').includes("-c notify=[ 'node', '") &&
      inUserData(notifyHookPath() ?? undefined) &&
      inUserData(exGemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) &&
      inUserData(exOpencode.env.OPENCODE_TUI_CONFIG) &&
      // OpenCode's verdict channel: the generated plugin must actually be routed, or the
      // pane only ever sees the ambiguous chime and reads every completion as attention.
      inUserData(exOpencode.env.OPENCODE_CONFIG) &&
      exAider.env.AIDER_NOTIFICATIONS === 'true' &&
      exClaude.args.length === 0 && Object.keys(exClaude.env).length === 0 &&
      exUnknown.args.length === 0 && Object.keys(exUnknown.env).length === 0

    // ── the wire itself ──
    const direct = script
      ? await runHookAgainstFakeDaemon(script, ['--event', 'needs-input'], { MOGGING_PANE_ID: '7' }, 'direct')
      : null
    const directOk =
      !!direct && direct.exitCode === 0 && direct.helloOk && direct.notify?.id === '7' && direct.notify?.event === 'needs-input'

    // Codex hands its event as a JSON blob — only the TYPE may cross, mapped to the
    // house vocabulary; the blob's message content must not ride along.
    const codexBlob = script
      ? await runHookAgainstFakeDaemon(
          script,
          ['{"type":"agent-turn-complete","last-assistant-message":"SECRET CONTENT"}'],
          { MOGGING_PANE_ID: '7' },
          'codex'
        )
      : null
    const codexBlobOk =
      !!codexBlob &&
      codexBlob.exitCode === 0 &&
      codexBlob.notify?.event === 'done' &&
      !JSON.stringify(codexBlob.notify ?? {}).includes('SECRET')

    // Outside a pane (no MOGGING_PANE_ID): silent no-op, still exit 0.
    const noop = script
      ? await runHookAgainstFakeDaemon(script, ['--event', 'done'], { MOGGING_PANE_ID: undefined }, 'noop')
      : null
    const noopOk = !!noop && noop.exitCode === 0 && noop.notify === null

    const pass =
      scriptOk && invOk && claudeOk && codexOk && geminiOk && opencodeOk && aiderOk && extrasOk &&
      directOk && codexBlobOk && noopOk
    write({
      pass,
      scriptOk, invOk, claudeOk, codexOk, geminiOk, opencodeOk, aiderOk, extrasOk,
      directOk, codexBlobOk, noopOk,
      direct, codexBlob, noop,
      extras: {
        userData,
        codexArgs: exCodex.args,
        gemini: exGemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
        opencode: exOpencode.env.OPENCODE_TUI_CONFIG,
        aider: exAider.env,
        claude: exClaude,
        unknown: exUnknown
      }
    })
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e) })
    app.exit(1)
  }
}
