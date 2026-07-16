import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCliRuntime } from '../cli-runtime'
import { runtimeDir } from '../daemon-client'
import { helperRuntime } from '../node-helper'
import { houseServerEntry } from '../mcp-manager'
import { processImagePath, samePath, sleep, waitUntil, writeResult } from './kit'

// Env-gated RUNTIME-SPLIT smoke (MOGGING_RUNTIMESPLIT, ADR 0017): the release-blocking
// proof that the Node runtime split actually happened — everything that used to ride
// Electron-as-Node now rides the standalone helper, and the fuse flip is DECLARED. Five
// claims, each read off the running system, never off intent:
//
//   helper       the standalone binary exists where the three call sites resolve it
//   daemon       the live daemon pid is EXECUTING the helper (OS process image, not the
//                endpoint's say-so) — the same proof SURVIVE makes across a relaunch
//   mcp          the house MCP server answers a real JSON-RPC initialize when the helper
//                hosts runtime.mcpEntry — the exact command+args every CLI config names
//   cli          `mogging list` works through the helper against the live daemon, and the
//                on-disk shims name the helper with NO ELECTRON_RUN_AS_NODE anywhere
//   fuse         electron-builder.yml declares runAsNode: false and the house entry
//                carries no env — the sweep-side pin of the flip; the FUSES gate reads
//                the same wall off the packaged artifact itself
//
// The sweep runs dev (fuses exist only in a package), so `fuse` here is the DECLARATION
// check; scripts/check-fuses.mjs owns the artifact truth. Release blocks unless SURVIVE +
// CONTROL + RUNTIMESPLIT are all green (release.yml runs exactly these three).
export function runRuntimeSplitSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 180000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>

  interface CliResult {
    code: number
    stdout: string
    stderr: string
  }
  const runHelper = (args: string[], input?: string): Promise<CliResult> =>
    new Promise((resolve) => {
      const child = execFile(
        helperRuntime().executable,
        args,
        { env: { ...process.env }, timeout: 20000, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? ((err as unknown as { code?: number }).code ?? 1) : 0
          resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) })
        }
      )
      if (input !== undefined) {
        child.stdin?.write(input)
        child.stdin?.end()
      }
    })

  const run = async (): Promise<void> => {
    let result: { pass: boolean } & Record<string, unknown> = { pass: false }
    try {
      const helper = helperRuntime()
      const runtime = getCliRuntime()
      const house = houseServerEntry()

      // ── 1. The helper binary itself ─────────────────────────────────────────────
      const helperOk = existsSync(helper.executable) && /mogging-node(\.exe)?$/.test(helper.executable)

      // ── 2. The live daemon's HOST: what binary is that pid executing? ───────────
      const epPath = join(runtimeDir(), 'endpoint.json')
      await waitUntil(() => existsSync(epPath), 20000, 200)
      const ep = JSON.parse(readFileSync(epPath, 'utf8')) as { pid: number }
      const daemonImage = processImagePath(ep.pid)
      const daemonOnHelper = samePath(daemonImage, helper.executable)

      // ── 3. The house MCP server answers under the helper ────────────────────────
      // The exact command+args every CLI config names (houseServerEntry), driven with a
      // real initialize; the reply must carry the protocol and THIS app's version.
      const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n'
      const mcp = await runHelper([runtime.mcpEntry], init)
      const mcpAnswers =
        /"id":1/.test(mcp.stdout) &&
        /"protocolVersion"/.test(mcp.stdout) &&
        mcp.stdout.includes(`"version":"${app.getVersion()}"`)
      const houseClean =
        house.command === helper.executable && house.env === undefined && house.args?.[0] === runtime.mcpEntry

      // ── 4. `mogging` verbs through the helper, against the live daemon ──────────
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()'
      )
      await sleep(3500)
      const list = await runHelper([runtime.cliEntry, 'list'])
      const cliWorks = list.code === 0 && /^1\s+\d+x\d+/m.test(list.stdout)

      // The on-disk shims — what a pane actually invokes — name the helper, no env games.
      const shimBodies = [runtime.shim, runtime.connectionShim].map((f) => readFileSync(f, 'utf8'))
      const shimsClean =
        shimBodies.every((s) => !s.includes('ELECTRON_RUN_AS_NODE')) &&
        shimBodies.every((s) => s.includes(helper.executable))

      // ── 5. The fuse flip is DECLARED (the FUSES gate proves it on the artifact) ─
      const builderYml = readFileSync(join(app.getAppPath(), 'electron-builder.yml'), 'utf8')
      const fuseDeclared = /runAsNode:\s*false/.test(builderYml) && !/runAsNode:\s*true/.test(builderYml)

      const pass = helperOk && daemonOnHelper && mcpAnswers && houseClean && cliWorks && shimsClean && fuseDeclared
      result = {
        pass,
        helperOk,
        daemonOnHelper,
        mcpAnswers,
        houseClean,
        cliWorks,
        shimsClean,
        fuseDeclared,
        helper: helper.executable,
        daemonPid: ep.pid,
        daemonImage,
        listHead: list.stdout.split('\n').slice(0, 3),
        mcpHead: mcp.stdout.slice(0, 200)
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    writeResult('runtimesplit', result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}
