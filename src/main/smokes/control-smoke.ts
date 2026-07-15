import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from '@contracts'

// Env-gated control-API smoke (MOGGING_CONTROL, Phase-3/01): prove tmux-grade
// scriptability end to end by running the REAL `bin/mogging.mjs` as a child process
// (under Electron-as-Node — no system Node required) against the live daemon:
//   list         -> pane 1 enumerated
//   send         -> typed text echoes in the pane
//   send-key c-c -> interrupts a long-running command; the shell answers again after
//   capture      -> scrollback tail arrives on the CLI's stdout
//   auth         -> a wrong token is refused (exit 4); a bogus key is rejected (exit 2);
//                   an unknown pane fails cleanly (exit 1)
export function runControlSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')

  interface CliResult {
    code: number
    stdout: string
    stderr: string
  }
  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
          timeout: 15000,
          windowsHide: true
        },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((err as unknown as { code: number }).code as number)
              : err
                ? 1
                : 0
          resolveCli({ code, stdout: String(stdout), stderr: String(stderr) })
        }
      )
    })

  const paneText = (): Promise<string> =>
    ES<string>(
      `(()=>{const p=(window.__mogging.panes||[]).find(x=>x.id===1);return p?p.text():'';})()`
    )
  const waitForText = async (marker: string, tries = 30): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if ((await paneText()).includes(marker)) return true
      await sleep(400)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // Launcher-first boot: provision Workspace 1 (pane 1) + let its shell prompt.
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()'
      )
      await sleep(3500)

      // 1) list — pane 1 enumerated with a size column.
      const list = await cli(['list'])
      const listOk = list.code === 0 && /^1\s+\d+x\d+/m.test(list.stdout)

      // 2) send — typed text reaches the pty and echoes back.
      const send = await cli(['send', '1', 'echo CTRL_7788'])
      const sendOk = send.code === 0 && (await waitForText('CTRL_7788'))

      // 3) send-key c-c — interrupt a long runner; the shell must answer afterwards.
      const longCmd = process.platform === 'win32' ? 'ping -t 127.0.0.1' : 'sleep 999'
      await cli(['send', '1', longCmd])
      await sleep(1800)
      const key = await cli(['send-key', '1', 'c-c'])
      await sleep(1000)
      await cli(['send', '1', 'echo AFTER_INT_4242'])
      const interruptOk = key.code === 0 && (await waitForText('AFTER_INT_4242'))

      // 4) capture — the tail lands on the CLI's stdout (and nowhere else).
      const cap = await cli(['capture', '1', '--lines', '400'])
      const captureOk = cap.code === 0 && cap.stdout.includes('CTRL_7788')

      // 5) refusals: bogus key (exit 2), unknown pane (exit 1), wrong token (exit 4).
      const badKey = await cli(['send-key', '1', 'c-x-bogus'])
      const badPane = await cli(['send', '99', 'echo nope'])
      const base =
        process.platform === 'win32'
          ? process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
          : process.env.XDG_RUNTIME_DIR || join(app.getPath('home'), 'Library', 'Application Support')
      const realEp = JSON.parse(
        readFileSync(join(base, 'MoggingLabs', 'run', 'v' + DAEMON_PROTOCOL_VERSION, 'endpoint.json'), 'utf8')
      ) as Record<string, unknown>
      const fakeDir = mkdtempSync(join(tmpdir(), 'mogging-ctl-'))
      const fakeEp = join(fakeDir, 'endpoint.json')
      writeFileSync(fakeEp, JSON.stringify({ ...realEp, token: 'wrong-token' }))
      const badAuth = await cli(['list'], { MOGGING_DAEMON_ENDPOINT: fakeEp })
      const refusalsOk = badKey.code === 2 && badPane.code === 1 && badAuth.code === 4

      const pass = listOk && sendOk && interruptOk && captureOk && refusalsOk
      result = {
        pass,
        listOk,
        sendOk,
        interruptOk,
        captureOk,
        refusalsOk,
        codes: { badKey: badKey.code, badPane: badPane.code, badAuth: badAuth.code },
        listHead: list.stdout.split('\n').slice(0, 3),
        captureLen: cap.stdout.length
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'control-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
