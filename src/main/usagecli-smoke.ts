import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getUsageService, handleUsageCall } from './usage'
import { mcpEndpointDebug } from './mcp-endpoint'
import { keySlot, resolveKey, isKeyVaultAvailable } from './usage-keys'

// Env-gated usage-CLI smoke (MOGGING_USAGECLI, Phase-7/11). FAKE-adapter world
// (the env starts with MOGGING_USAGE, so the registry is fixture-only — zero
// network structurally). Runs the REAL `bin/mogging.mjs` as a child process
// (Electron-as-Node) against the REAL authed app endpoint:
//   1. `usage --json` returns the same enriched PlanUsage[] the popover
//      renders — 11 fixture plans, verdict text VERBATIM from the formatter
//      (compared against the endpoint's own enrich, bracketing the CLI call
//      so a minute boundary can't flake it)
//   2. `usage providers --json` lists the fake row (enabled, key:none)
//   3. `usage cost --provider codex --json` scans the SEEDED fixture dir
//      through the FULL pipe (CLI -> authed endpoint -> 07's scanner) and
//      sums exactly; `--provider all` covers both known log providers
//   4. `usage refresh` pokes and prints the next snapshot, exit 0
//   5. set-key/clear-key: the key travels stdin -> one authed frame -> the
//      0007.a vault (presence flips; refusal path on vault-less machines);
//      the piped value appears in NO CLI output and NOT in this verdict JSON
//   6. there is NO get-key verb — it exits 2 (usage error), by design
export function runUsageCliSmoke(_win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'usagecli-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')
  const cli = (args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((res) => {
      const child = execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 25000, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0
          res({ code, stdout: String(stdout), stderr: String(stderr) })
        }
      )
      child.stdin?.write(stdin ?? '')
      child.stdin?.end()
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      // Seed the cost fixture dir BEFORE any call (07's fixture-world rule:
      // the scanner reads ONLY this dir under a usage smoke).
      const croot = mkdtempSync(join(tmpdir(), 'mog-usagecli-'))
      const midday = (daysAgo: number): string => {
        const d = new Date(Date.now() - daysAgo * 86_400_000)
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).toISOString()
      }
      writeFileSync(
        join(croot, 'rollout-fixture.jsonl'),
        [
          JSON.stringify({ timestamp: midday(2), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 500, total_tokens: 1500 } } } }),
          JSON.stringify({ timestamp: midday(1), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 100, output_tokens: 1000, total_tokens: 3000 } } } })
        ].join('\n')
      )
      process.env.MOGGING_USAGE_COSTDIR = croot

      // Wait for the first snapshot + the live endpoint.
      const svc = getUsageService()
      let tries = 0
      while ((svc?.list().length ?? 0) === 0 && tries++ < 50) await sleep(200)
      tries = 0
      while (!mcpEndpointDebug().live && tries++ < 50) await sleep(200)

      // 1 ── `usage --json`: the popover's exact views. Bracket the CLI call
      //      with two endpoint reads so a minute boundary can't flake the
      //      verbatim-wording assert.
      const before = (await handleUsageCall('usage.list', {})) as { plans?: { profileId: string; pace?: { text: string } }[] }
      const snap = await cli(['usage', '--json'])
      const after = (await handleUsageCall('usage.list', {})) as { plans?: { profileId: string; pace?: { text: string } }[] }
      let plans: { profileId: string; health: string; pace?: { text: string }; windows: { usedPct: number; resetText?: string }[] }[] = []
      try {
        plans = JSON.parse(snap.stdout) as typeof plans
      } catch {
        /* shapeOk fails below */
      }
      const exCli = plans.find((p) => p.profileId === 'exhausted')
      const exTexts = [before.plans, after.plans].map((l) => l?.find((p) => p.profileId === 'exhausted')?.pace?.text)
      const verdictVerbatim = !!exCli?.pace?.text && exTexts.includes(exCli.pace.text)
      const snapshotOk =
        snap.code === 0 &&
        plans.length === 11 &&
        verdictVerbatim &&
        plans.every((p) => p.windows.every((w) => w.usedPct >= 0 && w.usedPct <= 100))
      // the human rendering carries windows + reset (the ONE reset formatter)
      const human = await cli(['usage'])
      const humanOk = human.code === 0 && /Session \(5h\)/.test(human.stdout) && /resets in /.test(human.stdout) && /\[fresh\]/.test(human.stdout)

      // 2 ── providers: the fake adapter row, read-only
      const prov = await cli(['usage', 'providers', '--json'])
      let provRows: { id: string; enabled: boolean; key: string; klass: string }[] = []
      try {
        provRows = JSON.parse(prov.stdout) as typeof provRows
      } catch {
        /* fails below */
      }
      const providersOk = prov.code === 0 && provRows.some((r) => r.id === 'fake' && r.enabled === true && r.key === 'none')

      // 3 ── cost through the FULL pipe: exact sums off the seeded fixture
      const cost = await cli(['usage', 'cost', '--provider', 'codex', '--json'])
      let scans: { providerId: string; days: { tokens: number; spend: number }[] }[] = []
      try {
        scans = JSON.parse(cost.stdout) as typeof scans
      } catch {
        /* fails below */
      }
      const costOk =
        cost.code === 0 &&
        scans.length === 1 &&
        scans[0].providerId === 'codex' &&
        scans[0].days.length === 2 &&
        scans[0].days[0].tokens === 1500 &&
        scans[0].days[1].tokens === 3000 &&
        scans[0].days.every((d) => d.spend === 0)
      const costAll = await cli(['usage', 'cost', '--json'])
      let allScans: { providerId: string }[] = []
      try {
        allScans = JSON.parse(costAll.stdout) as typeof allScans
      } catch {
        /* fails below */
      }
      const costAllOk = costAll.code === 0 && allScans.length === 2 && allScans.some((s) => s.providerId === 'claude')

      // 4 ── refresh pokes + prints the NEXT snapshot
      const rf = await cli(['usage', 'refresh'])
      const refreshOk = rf.code === 0 && /Session \(5h\)/.test(rf.stdout)

      // 5 ── set-key/clear-key round trip (stdin only; vault-conditioned like
      //      the USAGE gate — the CLAIM never weakens: no vault -> refusal)
      const SECRET = 'sk-or-v1-CLISMOKE-0123456789abcdef0123456789abcdef'
      const vaultAvailable = isKeyVaultAvailable()
      const setRes = await cli(['usage', 'set-key', '--provider', 'openrouter', '--stdin'], SECRET + '\n')
      let keyOk: boolean
      let clearRes = { code: 0, stdout: '', stderr: '' }
      if (vaultAvailable) {
        keyOk = setRes.code === 0 && keySlot('openrouter').kind === 'keychain' && resolveKey('openrouter') === SECRET
        clearRes = await cli(['usage', 'clear-key', '--provider', 'openrouter'])
        keyOk = keyOk && clearRes.code === 0 && keySlot('openrouter').kind === 'none' && resolveKey('openrouter') === null
      } else {
        keyOk = setRes.code === 1 && /env-ref/i.test(setRes.stderr) && keySlot('openrouter').kind === 'none'
      }
      // the piped value appears in NO cli output, ever
      const grepClean = ![snap, human, prov, cost, costAll, rf, setRes, clearRes].some((r) => (r.stdout + r.stderr).includes(SECRET))

      // 6 ── no get-key verb exists — a usage error, by design
      const getKey = await cli(['usage', 'get-key', '--provider', 'openrouter'])
      const noGetVerbOk = getKey.code === 2

      const pass = snapshotOk && humanOk && providersOk && costOk && costAllOk && refreshOk && keyOk && grepClean && noGetVerbOk
      result = { pass, snapshotOk, verdictVerbatim, humanOk, providersOk, costOk, costAllOk, refreshOk, vaultAvailable, keyOk, grepClean, noGetVerbOk, planCount: plans.length, exits: { snap: snap.code, human: human.code, prov: prov.code, cost: cost.code, rf: rf.code, set: setRes.code, getKey: getKey.code } }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 1000)
}
