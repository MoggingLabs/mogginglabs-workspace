import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capturePaneTokenForSmoke } from './smoke-shell'

// Env-gated ownership-ledger smoke (MOGGING_LEDGER, Phase-4/02):
//   granted -> overlapping DENIED (owner named, exit 5) -> disjoint granted ->
//   owners lists both -> release frees territory -> pane exit auto-releases ->
//   the .pane-claims chip renders live -> human claims are refused (exit 2) ->
//   traversal/absolute patterns are refused (exit 2).
export function runLedgerSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')

  const cli = (
    args: string[],
    extraEnv: Record<string, string> = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout, stderr) =>
          resolveCli({
            code: err ? ((err as unknown as { code?: number }).code ?? 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr)
          })
      )
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`window.__mogging.templates.open([{provider:'shell',count:2}])`)
      await sleep(3000)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      // claim/release are pane-bound (protocol v10): the CLI must present the pane's own
      // daemon-minted MOGGING_PANE_TOKEN, exactly as a command launched inside the pane
      // inherits it. Capture the real token for each pane — a fabricated PANE_ID alone is
      // the forgeable claim the binding now refuses.
      const paneTokens: Record<number, string> = {}
      for (const n of [1, 2]) {
        paneTokens[n] = await capturePaneTokenForSmoke({
          write: async (command) => {
            const sent = await cli(['send', String(base + n), command])
            if (sent.code !== 0) throw new Error(`could not probe pane ${base + n}`)
          },
          sleep
        })
      }
      const p1 = { MOGGING_PANE_ID: String(base + 1), MOGGING_PANE_TOKEN: paneTokens[1] }
      const p2 = { MOGGING_PANE_ID: String(base + 2), MOGGING_PANE_TOKEN: paneTokens[2] }

      // grant -> deny (owner named) -> disjoint grant
      const g1 = await cli(['claim', 'src/a/**'], p1)
      const d2 = await cli(['claim', 'src/a/x.ts'], p2)
      const g2 = await cli(['claim', 'src/b/**'], p2)
      const grantOk = g1.code === 0 && g2.code === 0
      const denyOk = d2.code === 5 && d2.stderr.includes(String(base + 1))

      // owners lists both claims
      type Claim = { paneId: string; pattern: string }
      const owners1 = JSON.parse((await cli(['owners', '--json'])).stdout) as Claim[]
      const ownersOk =
        owners1.some((c) => c.paneId === String(base + 1) && c.pattern === 'src/a/**') &&
        owners1.some((c) => c.paneId === String(base + 2) && c.pattern === 'src/b/**') &&
        owners1.length === 2

      // the chip renders on pane 1 (push-fed)
      await sleep(800)
      const chip = (await ES(
        `(()=>{const el=document.querySelector('.layout-slot[data-pane-id="${base + 1}"] .pane-claims');return el&&!el.hidden?el.textContent:'';})()`
      )) as string
      const chipOk = String(chip).includes('1')

      // release -> the very claim that was denied now grants
      const rel = await cli(['release', 'src/a/**'], p1)
      const g3 = await cli(['claim', 'src/a/x.ts'], p2)
      const releaseOk = rel.code === 0 && g3.code === 0

      // pane exit auto-releases (close pane 2 -> its two claims vanish)
      await ES(`window.__mogging.layout.close(${base + 2})`)
      let autoOk = false
      for (let i = 0; i < 20 && !autoOk; i++) {
        await sleep(500)
        const now = JSON.parse((await cli(['owners', '--json'])).stdout) as Claim[]
        autoOk = now.every((c) => c.paneId !== String(base + 2))
      }

      // humans don't claim (exit 2); hostile patterns are refused (exit 2)
      const humanRefused = (await cli(['claim', 'src/z/**'])).code === 2
      const traversalRefused = (await cli(['claim', '../../etc/passwd'], p1)).code === 2
      const absoluteRefused = (await cli(['claim', 'C:/Windows/**'], p1)).code === 2

      const pass =
        grantOk && denyOk && ownersOk && chipOk && releaseOk && autoOk && humanRefused && traversalRefused && absoluteRefused
      result = {
        pass,
        grantOk,
        denyOk,
        denyStderr: d2.stderr.trim(),
        ownersOk,
        chipOk,
        chip,
        releaseOk,
        autoOk,
        humanRefused,
        traversalRefused,
        absoluteRefused
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'ledger-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
