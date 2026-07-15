// Reviewer-gate smokes exercise the real credential path. Approval is executed inside
// the pane so the daemon-minted MOGGING_PANE_TOKEN reaches the CLI naturally.

export interface SmokeCliResult {
  code: number
  stdout: string
  stderr?: string
}

export type SmokeCli = (args: string[], extraEnv?: Record<string, string>) => Promise<SmokeCliResult>

const quote = (value: string): string =>
  process.platform === 'win32'
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'"'"'`)}'`

export async function sendApprovalFromPane(
  cli: SmokeCli,
  cliPath: string,
  paneId: number,
  branch: string,
  opts: { repo?: string; base?: string } = {}
): Promise<boolean> {
  const command = [
    `node ${quote(cliPath)} approve ${quote(branch)}`,
    opts.repo ? `--repo ${quote(opts.repo)}` : '',
    opts.base ? `--base ${quote(opts.base)}` : ''
  ].filter(Boolean).join(' ')
  return (await cli(['send', String(paneId), command])).code === 0
}

export async function approvalListed(
  cli: SmokeCli,
  branch: string,
  opts: { attempts?: number; sleepMs?: number; byPaneId?: number } = {}
): Promise<boolean> {
  const attempts = opts.attempts ?? 30
  const sleepMs = opts.sleepMs ?? 200
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await cli(['approvals', '--json'])
      if (res.code === 0) {
        const rows = JSON.parse(res.stdout) as { branch?: string; byPaneId?: string }[]
        if (rows.some((row) => row.branch === branch && (opts.byPaneId === undefined || row.byPaneId === String(opts.byPaneId)))) return true
      }
    } catch {
      /* daemon/CLI still settling */
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs))
  }
  return false
}
