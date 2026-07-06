// Usage-meter contracts (Phase-7/01, ADR 0007). Pure data shapes shared by the
// backend seam and the UI. NOTHING here may carry a credential: adapters read
// tokens in memory for one request and return ONLY these normalized shapes.

/** Snapshot freshness. `stale` = last good data re-served after an error;
 *  `unconfigured` = the CLI/store isn't there (labeled state, not an error). */
export type UsageHealth = 'fresh' | 'stale' | 'error' | 'unconfigured'

/** One metered window (e.g. the 5h session window, the weekly window). */
export interface UsageWindow {
  label: string
  /** 0–100. Clamped by the seam; adapters normalize provider units to this. */
  usedPct: number
  /** ISO timestamp of the window reset, when the provider exposes it. */
  resetsAt?: string
  /** Window length in ms, when the adapter knows it (Codex reports it exactly).
   *  The pace engine uses this directly; absent -> the seam infers from label. */
  windowMs?: number
  /** Provider's own wording for this window, when it helps ("resets Tue 14:00"). */
  raw?: string
  /** VIEW-attached (7/10): the reset line pre-formatted by the ONE backend
   *  reset formatter in the user's chosen style. Adapters never set this. */
  resetText?: string
}

/** Usage for one plan on one (provider, profile) pair — the tile unit. */
export interface PlanUsage {
  providerId: string
  /** Phase-4 profile id, or 'default' when no profile targets the provider. */
  profileId: string
  planLabel: string
  windows: UsageWindow[]
  /** Credit-style balance where a provider has one (label + remaining units). */
  credits?: { label: string; remaining: number }
  /** Current-window spend where the provider exposes one (Phase-7/07 — the
   *  api-key admin/spend rows). A display value, never a bill. */
  spend?: { amount: number; currency: string }
  /** Epoch ms of the fetch that produced this data (stale keeps the OLD stamp). */
  fetchedAt: number
  health: UsageHealth
  /** Human reason for error/unconfigured/stale — UI renders it verbatim. */
  reason?: string
}

/** A provider usage adapter. `home` is the RESOLVED config home for the profile
 *  being read (pointer env or the per-OS default) — adapters never resolve
 *  profiles themselves and never look outside `home` + their known endpoint. */
export interface UsageAdapter {
  id: string
  /** 7/09 fan-out: read EVERY profile lane (real adapters — one home per
   *  call). Unset = the active lane only; the FAKE adapter models its own
   *  multi-profile fan-out inside its fixture set. */
  perProfile?: boolean
  /** Is this provider readable at `home`? false + reason -> `unconfigured`. */
  detect(home: string): Promise<{ ok: boolean; reason?: string }>
  /** Fetch + normalize. May return several plans. Throws only Error(reason) —
   *  the seam maps it to health 'error'/'stale'; a token NEVER rides an error. */
  fetch(home: string, profileId: string, signal: AbortSignal): Promise<PlanUsage[]>
}

// ── Display options (Phase-7/10): with ~57 providers possible, ONE gauge
//    can't show them all — the mode decides WHICH plan the titlebar mirrors,
//    content toggles decide WHAT the icon shows, and the reset style feeds
//    the ONE reset formatter. All paint-only; persisted in the KV.

/** Which plan the single titlebar gauge mirrors. */
export type GaugeMode = 'merged' | 'pinned' | 'auto'
/** How a reset moment renders, everywhere one renders. */
export type ResetStyle = 'countdown' | 'absolute' | 'relative'
export type PopoverDensity = 'roomy' | 'compact'
export type PopoverOrder = 'severity' | 'manual'

export interface UsageDisplayConfig {
  /** merged = highest severity · pinned = the chosen provider · auto =
   *  highest usage (CodexBar's auto-select). */
  mode: GaugeMode
  /** Provider id the gauge pins to when mode === 'pinned'. */
  pin?: string
  showBars: boolean
  showPct: boolean
  showGlyph: boolean
  showLabel: boolean
  resetStyle: ResetStyle
  density: PopoverDensity
  /** severity (09's rule) or the manual pinOrder; the highest-severity plan
   *  surfaces in the popover header regardless. */
  order: PopoverOrder
  pinOrder: string[]
}

/** The glance must survive a user who never opens Settings: two bars + the
 *  dot badge, severity-merged, countdown resets, roomy. */
export const USAGE_DISPLAY_DEFAULTS: UsageDisplayConfig = {
  mode: 'merged',
  showBars: true,
  showPct: false,
  showGlyph: false,
  showLabel: false,
  resetStyle: 'countdown',
  density: 'roomy',
  order: 'severity',
  pinOrder: []
}

// ── Pace baseline (Phase-7/12, feeds the 7/02 engine): which days/hours count
//    as ACTIVE time. Null = no baseline — wall-clock pacing (the default).
export interface UsagePaceConfig {
  /** Days 0(Sun)–6(Sat) that count as work days; null = every day. */
  workDays: number[] | null
  /** Active hours [startHour, endHour) in 0–24; null = all day. */
  workHours: [number, number] | null
}

// ── Threshold alerts (Phase-7/09): the meter taps you on the shoulder through
//    the HOUSE toast system — no OS spam. Copy is composed in ONE place (main,
//    with the 7/02 formatter's verdict line as the body) and rendered VERBATIM.
//    Each threshold fires once per (provider, profile, window-epoch); state is
//    persisted app-side so a restart never re-fires a spent threshold.

export interface UsageAlertConfig {
  /** First shoulder-tap, a quiet toast (default 80). */
  quiet: number
  /** The warning toast that carries the verdict line (default 95). */
  warn: number
  /** Optional reset flourish — default OFF (quiet is the house default). */
  confetti: boolean
}
export const USAGE_ALERT_DEFAULTS: UsageAlertConfig = { quiet: 80, warn: 95, confetti: false }

export interface UsageAlert {
  kind: 'threshold' | 'reset'
  /** threshold alerts only: which shoulder-tap this is. */
  level?: 'quiet' | 'warn'
  providerId: string
  profileId: string
  planLabel: string
  windowLabel: string
  usedPct: number
  /** Composed main-side — the toast renders title/body VERBATIM. */
  title: string
  /** The 7/02 formatter's verdict line when the plan paces; else a plain state line. */
  body: string
  /** 7/09 failover feed: present ONLY when the ACTIVE plan crossed `warn` and
   *  a sibling profile sits under 50% — a suggestion, never an auto-switch. */
  failover?: { profileId: string; profileName: string }
  /** Reset alerts only: the user opted into the flourish. */
  confetti?: boolean
}

// ── Provider status feed (Phase-7/08): PUBLIC status endpoints only — no
//    auth, no cookies, no keys. "They're down" is a different fact from
//    "you're out"; the feed exists so a red gauge can say which. Only the
//    enum state + booleans may enter telemetry (ADR 0005) — never note text.

export type ProviderStatusState = 'operational' | 'degraded' | 'outage' | 'unknown'

export interface ProviderStatus {
  providerId: string
  state: ProviderStatusState
  /** The status page's own short wording when non-operational — UI verbatim. */
  note?: string
  /** Epoch ms of the check that produced this state. */
  checkedAt: number
}

// ── Local cost scan (Phase-7/07, ADR 0007): parse the JSONL session logs the
//    CLIs ALREADY write, at their KNOWN locations, on demand, read-only —
//    zero network, never a watch. Closed shapes; the UI renders them verbatim.

/** One LOCAL calendar day of scanned spend/tokens. */
export interface CostDay {
  /** Local date, `YYYY-MM-DD` (a user's "per day" is their day, not UTC's). */
  date: string
  /** Estimated spend in `CostScan.currency` — a price-table estimate, not a bill. */
  spend: number
  /** Total tokens processed that day (input + output + cache, all lanes). */
  tokens: number
}

/** Result of one on-demand local log scan. A missing/absent log dir yields an
 *  EMPTY scan with a human `reason` — never a throw (ADR 0007 rule 5). */
export interface CostScan {
  providerId: string
  days: CostDay[]
  currency: string
  /** Present when the scan is empty, capped, or partially unpriced. */
  reason?: string
}

/** The three pace verdicts (Phase-7/02). Wording lives in ONE formatter
 *  (backend pace module); severity inks: runs-out = warning, on-pace =
 *  neutral, surplus = info-quiet. */
export type PaceVerdict = 'runs-out' | 'on-pace' | 'surplus'

/** Output of the pure pace engine for one window. Absent report (null from
 *  the engine) = not enough data to pace — surfaces render snapshot age
 *  instead of a forecast (never speculate past the data). */
export interface PaceReport {
  verdict: PaceVerdict
  /** Signed points: usedPct − elapsedPct (+12 = hotter than the budget line). */
  paceDelta: number
  /** 0–100: share of the window consumed (active-time when a baseline is set). */
  elapsedPct: number
  /** Blended burn in pct-points per (active) hour. */
  burnRatePctPerHour: number
  /** Epoch ms of projected exhaustion — present only when it lands BEFORE reset. */
  runOutAt?: number
  /** Projected unused points at reset — present only when it lands after. */
  surplusPct?: number
}

// ── Key slots (Phase-7/05, ADR 0007.a): paste-once OS-vault ciphertext,
//    WRITE-ONLY — the IPC surface is set / clear / presence; NO getter exists.
export type KeySlot = { kind: 'keychain' } | { kind: 'env-ref'; envRef: string } | { kind: 'none' }

// ── The provider catalog (Phase-7/04): a provider is a DATA ROW, a mechanism
//    is an adapter CLASS. ~57 CodexBar providers reduce to five classes; adding
//    a provider on an existing class is one row here + one fixture. ────────────

/** The mechanism class — dispatch keys on this, never on provider id. */
export type UsageClass = 'cli-store' | 'api-key' | 'cloud-cli' | 'web-session' | 'local'

/** A lane a provider HAS. `windowMs = 0` = a rolling/credit balance with no
 *  fixed reset window (shown as a balance, not paced). */
export type WindowKind = 'session' | 'weekly' | 'monthly' | 'daily' | 'hourly' | 'rolling'
export interface WindowSpec {
  kind: WindowKind
  label: string
  windowMs: number
}

/** Canonical window lengths (ms) so a row declares `windowMs` without arithmetic. */
export const WINDOW_MS = {
  session: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
  daily: 86_400_000,
  hourly: 3_600_000,
  rolling: 0
} as const

/** One catalog row. `windows` declares which lanes exist — never invent a lane
 *  a provider lacks. `verifiedAt` = ISO date the endpoint/shape was dev-checked
 *  on a real login (the 7/01 discipline); absent = FAKE-covered, unverified. */
export interface UsageProviderDef {
  id: string
  label: string
  klass: UsageClass
  /** Env var (a profile pointer) that relocates this provider's config home. */
  homePointerEnv?: string
  /** Usage endpoint, when the class calls one (documented, one bounded request). */
  endpoint?: string
  windows: WindowSpec[]
  /** True when the provider is credit/balance-based (a `credits` block, no lane). */
  credits?: boolean
  /** web-session class: the cookie/token name to read for this provider. */
  cookieName?: string
  /** web-session class: the site origin the cookie belongs to (store-read scope
   *  + sensitive-origin check). */
  origin?: string
  /** PUBLIC status endpoint (7/08) — a plain statuspage/health JSON, no auth,
   *  no cookies, https only. Rows carry one only after dev-verification. */
  statusUrl?: string
  verifiedAt?: string
}

// Sensitive-origin blocklist: moved to its real home, `@contracts/integrations`
// (the phase-8/01 blocklist this always was — grant.ts). A web-session row
// whose origin matches `isSensitiveOrigin` is still refused store-read even
// if it named one — usage is never worth a bank/mail/gov cookie.

const w = (kind: WindowKind, label: string): WindowSpec => ({ kind, label, windowMs: WINDOW_MS[kind] })

/** THE catalog. cli-store rows ship in 7/04 (Codex + Claude verified real;
 *  the rest catalog+fixture, honestly `unconfigured` until dev-verified).
 *  api-key / cloud-cli / web-session rows arrive in 7/05–06. */
export const USAGE_PROVIDERS: readonly UsageProviderDef[] = [
  // statusUrl rows are dev-verified statuspage.io JSON (2026-07-06, books §08);
  // providers without a PLAIN public JSON endpoint honestly carry none.
  { id: 'claude', label: 'Claude', klass: 'cli-store', homePointerEnv: 'CLAUDE_CONFIG_DIR', windows: [w('session', 'Session (5h)'), w('weekly', 'Weekly')], statusUrl: 'https://status.claude.com/api/v2/status.json', verifiedAt: '2026-07-06' },
  { id: 'codex', label: 'Codex', klass: 'cli-store', homePointerEnv: 'CODEX_HOME', windows: [w('session', 'Session (5h)'), w('weekly', 'Weekly')], statusUrl: 'https://status.openai.com/api/v2/status.json', verifiedAt: '2026-07-06' },
  { id: 'gemini', label: 'Gemini', klass: 'cli-store', homePointerEnv: 'GEMINI_CONFIG_DIR', windows: [w('daily', 'Daily')] },
  { id: 'copilot', label: 'GitHub Copilot', klass: 'cli-store', windows: [w('monthly', 'Monthly')] },
  { id: 'zed', label: 'Zed', klass: 'cli-store', windows: [w('monthly', 'Monthly')] },
  { id: 'kiro', label: 'Kiro', klass: 'cli-store', windows: [w('monthly', 'Monthly')] },
  { id: 'kilo', label: 'Kilo', klass: 'cli-store', windows: [w('rolling', 'Credits')], credits: true },
  { id: 'augment', label: 'Augment', klass: 'cli-store', windows: [w('monthly', 'Monthly')] },
  { id: 'jetbrains', label: 'JetBrains AI', klass: 'cli-store', windows: [w('monthly', 'Quota')] },
  { id: 'codebuff', label: 'Codebuff', klass: 'cli-store', windows: [w('rolling', 'Credits')], credits: true },
  { id: 'opencode', label: 'OpenCode', klass: 'cli-store', windows: [w('monthly', 'Monthly')] },
  { id: 'windsurf', label: 'Windsurf', klass: 'cli-store', windows: [w('rolling', 'Credits')], credits: true },
  // ── api-key class (7/05, ADR 0007.a): paste-once keychain or env-ref ──
  { id: 'openrouter', label: 'OpenRouter', klass: 'api-key', endpoint: 'https://openrouter.ai/api/v1/credits', windows: [w('rolling', 'Credits')], credits: true },
  { id: 'deepseek', label: 'DeepSeek', klass: 'api-key', endpoint: 'https://api.deepseek.com/user/balance', windows: [w('rolling', 'Balance')], credits: true },
  { id: 'moonshot', label: 'Moonshot / Kimi API', klass: 'api-key', endpoint: 'https://api.moonshot.ai/v1/users/me/balance', windows: [w('rolling', 'Balance')], credits: true },
  { id: 'elevenlabs', label: 'ElevenLabs', klass: 'api-key', endpoint: 'https://api.elevenlabs.io/v1/user/subscription', windows: [w('monthly', 'Characters')], statusUrl: 'https://status.elevenlabs.io/api/v2/status.json' },
  { id: 'deepgram', label: 'Deepgram', klass: 'api-key', endpoint: 'https://api.deepgram.com/v1/projects', windows: [w('rolling', 'Balance')], credits: true, statusUrl: 'https://status.deepgram.com/api/v2/status.json' },
  { id: 'litellm', label: 'LiteLLM', klass: 'api-key', windows: [w('rolling', 'Budget')], credits: true },
  { id: 'minimax', label: 'MiniMax', klass: 'api-key', windows: [w('rolling', 'Balance')], credits: true },
  { id: 'zai', label: 'z.ai', klass: 'api-key', windows: [w('rolling', 'Quota')], credits: true },
  { id: 'venice', label: 'Venice', klass: 'api-key', windows: [w('rolling', 'Balance')], credits: true },
  { id: 'poe', label: 'Poe', klass: 'api-key', windows: [w('rolling', 'Points')], credits: true },
  { id: 'chutes', label: 'Chutes', klass: 'api-key', windows: [w('rolling', 'Quota')], credits: true },
  { id: 'groqcloud', label: 'GroqCloud', klass: 'api-key', windows: [w('rolling', 'Metrics')], credits: true },
  { id: 'llmproxy', label: 'LLM Proxy', klass: 'api-key', windows: [w('rolling', 'Quota')], credits: true },
  { id: 'clawrouter', label: 'ClawRouter', klass: 'api-key', windows: [w('monthly', 'Budget')] },
  { id: 'crof', label: 'Crof', klass: 'api-key', windows: [w('rolling', 'Credits')], credits: true },
  { id: 'doubao', label: 'Doubao', klass: 'api-key', windows: [w('rolling', 'Requests')], credits: true },
  { id: 'warp', label: 'Warp', klass: 'api-key', windows: [w('monthly', 'Requests')] },
  { id: 'alibaba', label: 'Alibaba (key)', klass: 'api-key', windows: [w('rolling', 'Quota')], credits: true },
  { id: 'openai-admin', label: 'OpenAI (admin spend)', klass: 'api-key', endpoint: 'https://api.openai.com/v1/organization/costs', windows: [w('monthly', 'Spend')], statusUrl: 'https://status.openai.com/api/v2/status.json' },
  { id: 'claude-admin', label: 'Claude (admin spend)', klass: 'api-key', windows: [w('monthly', 'Spend')] },
  // ── cloud-cli class (7/05): ambient credentials via the vendor CLI ──
  { id: 'vertex', label: 'Vertex AI', klass: 'cloud-cli', windows: [w('rolling', 'Session')] },
  { id: 'bedrock', label: 'AWS Bedrock', klass: 'cloud-cli', windows: [w('monthly', 'Spend')] },
  // ── web-session class (7/06, ADR 0007.b): paste-first; store-read opt-in ──
  { id: 'cursor', label: 'Cursor', klass: 'web-session', origin: 'cursor.com', cookieName: 'WorkosCursorSessionToken', endpoint: 'https://cursor.com/api/usage', windows: [w('monthly', 'Requests')], statusUrl: 'https://status.cursor.com/api/v2/status.json' },
  { id: 'devin', label: 'Devin', klass: 'web-session', origin: 'app.devin.ai', cookieName: 'session', windows: [w('rolling', 'ACUs')], credits: true },
  { id: 'manus', label: 'Manus', klass: 'web-session', origin: 'manus.im', cookieName: 'session_id', windows: [w('rolling', 'Credits')], credits: true },
  { id: 't3chat', label: 'T3 Chat', klass: 'web-session', origin: 't3.chat', cookieName: 'session', windows: [w('monthly', 'Messages')] },
  { id: 'kimi', label: 'Kimi', klass: 'web-session', origin: 'kimi.com', cookieName: 'kimi-auth', windows: [w('rolling', 'Quota')], credits: true },
  { id: 'perplexity', label: 'Perplexity', klass: 'web-session', origin: 'www.perplexity.ai', cookieName: '__Secure-next-auth.session-token', windows: [w('daily', 'Queries')] },
  { id: 'mimo', label: 'Xiaomi MiMo', klass: 'web-session', origin: 'mimo.xiaomi.com', cookieName: 'session', windows: [w('rolling', 'Balance')], credits: true },
  { id: 'sakana', label: 'Sakana AI', klass: 'web-session', origin: 'sakana.ai', cookieName: 'session', windows: [w('rolling', 'Quota')], credits: true },
  { id: 'abacus', label: 'Abacus AI', klass: 'web-session', origin: 'abacus.ai', cookieName: 'session', windows: [w('monthly', 'Usage')] },
  { id: 'mistral-web', label: 'Mistral (spend)', klass: 'web-session', origin: 'console.mistral.ai', cookieName: 'session', windows: [w('monthly', 'Spend')] },
  { id: 'amp', label: 'Amp', klass: 'web-session', origin: 'ampcode.com', cookieName: 'session', windows: [w('rolling', 'Credits')], credits: true },
  { id: 'commandcode', label: 'Command Code', klass: 'web-session', origin: 'commandcode.ai', cookieName: 'session', windows: [w('rolling', 'Credits')], credits: true },
  { id: 'opencode-web', label: 'OpenCode (workspace)', klass: 'web-session', origin: 'opencode.ai', cookieName: 'session', windows: [w('monthly', 'Usage')] },
  { id: 'alibaba-web', label: 'Alibaba (cookie)', klass: 'web-session', origin: 'bailian.console.aliyun.com', cookieName: 'login_aliyunid_ticket', windows: [w('rolling', 'Quota')], credits: true },
  { id: 'grok-web', label: 'Grok (browser)', klass: 'web-session', origin: 'grok.com', cookieName: 'sso', windows: [w('rolling', 'Quota')], credits: true },
  // ── local class (7/13): no auth at all — loopback probes and the machine's
  //    own logs (the 7/07 cost scan is this class's dev-verified citizen).
  { id: 'ollama', label: 'Ollama', klass: 'local', endpoint: 'http://127.0.0.1:11434/api/tags', windows: [w('rolling', 'Local models')] }
]

export const findProvider = (id: string): UsageProviderDef | undefined => USAGE_PROVIDERS.find((p) => p.id === id)

export const USAGE_CADENCES = ['manual', '1m', '2m', '5m', '15m'] as const
export type UsageCadence = (typeof USAGE_CADENCES)[number]

export const USAGE_CADENCE_MS: Record<Exclude<UsageCadence, 'manual'>, number> = {
  '1m': 60_000,
  '2m': 120_000,
  '5m': 300_000,
  '15m': 900_000
}
