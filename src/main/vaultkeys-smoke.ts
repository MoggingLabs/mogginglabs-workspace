import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingsStore } from './app-settings'
import { setVaultProbeForSmoke } from './vault'
import { resolveServiceKeyEnv, serviceKeyClear, serviceKeyNames, serviceKeySet } from './service-keys'
import { keyClear, keySetPlaintext, resolveKey } from './usage-keys'
import { setToolPlan } from './integrations'
import { saveServer, type GrantKv } from '@backend/features/integrations'

// Env-gated service-key vault smoke (MOGGING_VAULTKEYS, Phase-8/08). Proves the
// paste-once fleet vault end to end:
//   (a) a secret-shaped paste lands as vault CIPHERTEXT — the KV slot holds
//       ciphertext, the fixture CLI config carries ${NAME} not the literal;
//   (b) a fixture pane's ENV carries the value (spawn-path assert, in memory);
//   (c/at-rest) NO plaintext of the secret anywhere under userData (KV, trail,
//       telemetry, logs, renderer stores) — grepped exhaustively;
//   (d) delete -> absent from the store + the next launch's env;
//   (e) vault-less machine -> REFUSED, env-ref offered instead;
//   (f) covered by (c)'s exhaustive grep;
//   (g) usage keys (consumer one) still round-trip after the extraction.
// The secret never rides the pane's TYPED command (the pane checks its env LEN
// into a marker file), so this smoke never itself leaks it to scrollback.

const SECRET = 'mlw-vault-secret-9f3a2b7c1d4e5061' // secret-shaped, fixed for the run
const NAME = 'MOG_VAULT_TEST'
const CIPHER_KV = `integrations.vaultkey.${NAME}`

export function runVaultKeysSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000)
  const wc = win.webContents
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js, true)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const outDir = join(app.getAppPath(), 'out')
  const plainEnvFile = join(outDir, 'vaultkeys-env-plain.txt')
  const scopedEnvFile = join(outDir, 'vaultkeys-env-scoped.txt')
  const configFile = join(outDir, 'vaultkeys-config.json')

  const emit = (o: object): void => {
    try {
      writeFileSync(join(outDir, 'vaultkeys-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  // Exhaustive at-rest grep: walk userData for the literal secret. Skip only the
  // big binary caches (compiled shaders / HTTP cache — the app makes no external
  // request carrying the secret); KEEP renderer stores (Local/Session Storage,
  // IndexedDB) since a leak to the renderer would land there.
  const SKIP = new Set(['Cache', 'GPUCache', 'Code Cache', 'DawnCache', 'DawnGraphiteCache', 'ShaderCache', 'GrShaderCache', 'blob_storage'])
  const offenders: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (st.isFile() && st.size < 8_000_000) {
        try {
          if (readFileSync(full, 'latin1').includes(SECRET)) offenders.push(full)
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const store = getSettingsStore()
      try {
        rmSync(plainEnvFile)
        rmSync(scopedEnvFile)
      } catch {
        /* fresh */
      }

      // (e) vault-less REFUSAL first (nothing stored yet), env-ref offered.
      setVaultProbeForSmoke(() => false)
      const refuse = serviceKeySet(NAME, SECRET)
      const vaultlessRefused = !refuse.ok && /env var|\$\{/.test(refuse.reason ?? '')
      setVaultProbeForSmoke(null)

      // (a) paste -> vault ciphertext; KV holds ciphertext, not the literal.
      const set = serviceKeySet(NAME, SECRET)
      const cipher = store?.getSetting(CIPHER_KV) ?? ''
      const storedAsCipher = set.ok && serviceKeyNames().includes(NAME) && cipher.length > 0 && !cipher.includes(SECRET)

      // Main-side value correctness (the env map materialization resolves it).
      const kv: GrantKv | null = store
        ? { get: (key) => store.getSetting(key), set: (key, value) => store.setSetting(key, value) }
        : null
      const workspaceId = 'vaultkeys-scoped-workspace'
      const serverSaved =
        !!kv &&
        saveServer(kv, {
          id: 'vault-fixture',
          label: 'Vault fixture',
          transport: 'stdio',
          command: 'vault-fixture',
          env: { [NAME]: `\${${NAME}}` }
        }).ok
      setToolPlan({ workspaceId, entries: { 'vault-fixture': 'all-clis' }, inheritGlobal: false })
      const resolved = resolveServiceKeyEnv(workspaceId, 'codex')
      const resolveOk =
        serverSaved &&
        resolved[NAME] === SECRET &&
        resolveServiceKeyEnv(workspaceId, 'shell')[NAME] === undefined &&
        resolveServiceKeyEnv('another-workspace', 'codex')[NAME] === undefined

      // Fixture CLI config carries ${NAME}, never the literal.
      const cfg = JSON.stringify({ mcpServers: { posthog: { command: 'posthog-mcp', env: { POSTHOG_API_KEY: `\${${NAME}}` } } } }, null, 2)
      writeFileSync(configFile, cfg)
      const configOk = cfg.includes(`\${${NAME}}`) && !cfg.includes(SECRET)

      // (b) a fixture pane's ENV carries the value (spawn-path). Key is set
      // BEFORE the pane spawns, so main injects it into the spawn env.
      await ES(`window.__mogging.workspace.create({ id: ${JSON.stringify(workspaceId)}, name: 'Vault scope', assignments: ['shell'] })`)
      await sleep(3000)
      const commandFor = (file: string): string =>
        `node -e "require('fs').writeFileSync('${file.replace(/\\/g, '/')}', String((process.env.${NAME}||'').length))"\r`
      // The pane writes the LENGTH of its env var to a marker file — proves the
      // value arrived WITHOUT echoing the secret into scrollback.
      await ES(`window.bridge.send('terminal:write',{id:1,data:${JSON.stringify(commandFor(plainEnvFile))}})`)
      let plainLen = ''
      for (let i = 0; i < 12 && !plainLen; i++) {
        await sleep(500)
        try {
          plainLen = readFileSync(plainEnvFile, 'utf8').trim()
        } catch {
          /* not yet */
        }
      }
      const plainPaneNoKey = plainLen === '0'

      await ES(`window.bridge.invoke('terminal:spawn', {
        id: 99, cwd: ${JSON.stringify(outDir)}, cols: 80, rows: 24,
        workspaceId: ${JSON.stringify(workspaceId)}, agentId: 'codex'
      })`)
      await sleep(1200)
      await ES(`window.bridge.send('terminal:write',{id:99,data:${JSON.stringify(commandFor(scopedEnvFile))}})`)
      let scopedLen = ''
      for (let i = 0; i < 16 && !scopedLen; i++) {
        await sleep(500)
        try {
          scopedLen = readFileSync(scopedEnvFile, 'utf8').trim()
        } catch {
          /* not yet */
        }
      }
      await ES(`window.bridge.send('terminal:kill',{id:99})`)
      const paneEnvOk = scopedLen === String(SECRET.length)

      // (g) usage keys (consumer one) still round-trip.
      keySetPlaintext('vaulttest', 'usage-secret-xyz-778899')
      const usageOk = resolveKey('vaulttest') === 'usage-secret-xyz-778899'
      keyClear('vaulttest')

      // (c/f) exhaustive at-rest grep — the secret rests NOWHERE in plaintext.
      walk(app.getPath('userData'), 0)
      const noPlaintextAtRest = offenders.length === 0

      // (d) delete -> absent from store + next launch's env.
      serviceKeyClear(NAME)
      const deletedOk =
        !serviceKeyNames().includes(NAME) &&
        resolveServiceKeyEnv(workspaceId, 'codex')[NAME] === undefined &&
        !(store?.getSetting(CIPHER_KV) ?? '')

      // Cleanup the deliberate env-length marker + fixture config.
      try {
        rmSync(plainEnvFile)
        rmSync(scopedEnvFile)
        rmSync(configFile)
      } catch {
        /* best effort */
      }

      const pass =
        vaultlessRefused &&
        storedAsCipher &&
        resolveOk &&
        configOk &&
        plainPaneNoKey &&
        paneEnvOk &&
        usageOk &&
        noPlaintextAtRest &&
        deletedOk
      result = {
        pass,
        vaultlessRefused,
        storedAsCipher,
        resolveOk,
        configOk,
        plainPaneNoKey,
        plainLen,
        paneEnvOk,
        scopedLen,
        usageOk,
        noPlaintextAtRest,
        offenders: offenders.slice(0, 5),
        deletedOk
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
