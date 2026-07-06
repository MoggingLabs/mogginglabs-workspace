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
  /** Is this provider readable at `home`? false + reason -> `unconfigured`. */
  detect(home: string): Promise<{ ok: boolean; reason?: string }>
  /** Fetch + normalize. May return several plans. Throws only Error(reason) —
   *  the seam maps it to health 'error'/'stale'; a token NEVER rides an error. */
  fetch(home: string, profileId: string, signal: AbortSignal): Promise<PlanUsage[]>
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
  verifiedAt?: string
}

/** Sensitive-origin blocklist (ADR 0007.b clause d; the phase-8/01 blocklist
 *  concept, needed here first). A web-session row whose origin matches is
 *  refused store-read even if it named one — usage is never worth a bank/mail/
 *  gov cookie. Host suffixes, matched case-insensitively. */
export const SENSITIVE_ORIGIN_PATTERNS: readonly string[] = [
  'bank', 'chase.com', 'wellsfargo', 'paypal', 'venmo', 'coinbase', 'stripe.com',
  'mail.google', 'gmail', 'outlook', 'mail.', 'proton.me',
  '.gov', 'irs.gov', 'ssa.gov',
  'icloud.com', 'apple.com/account'
]
export function isSensitiveOrigin(origin: string): boolean {
  const h = origin.toLowerCase()
  return SENSITIVE_ORIGIN_PATTERNS.some((p) => h.includes(p))
}

const w = (kind: WindowKind, label: string): WindowSpec => ({ kind, label, windowMs: WINDOW_MS[kind] })

/** THE catalog. cli-store rows ship in 7/04 (Codex + Claude verified real;
 *  the rest catalog+fixture, honestly `unconfigured` until dev-verified).
 *  api-key / cloud-cli / web-session rows arrive in 7/05–06. */
export const USAGE_PROVIDERS: readonly UsageProviderDef[] = [
  { id: 'claude', label: 'Claude', klass: 'cli-store', homePointerEnv: 'CLAUDE_CONFIG_DIR', windows: [w('session', 'Session (5h)'), w('weekly', 'Weekly')], verifiedAt: '2026-07-06' },
  { id: 'codex', label: 'Codex', klass: 'cli-store', homePointerEnv: 'CODEX_HOME', windows: [w('session', 'Session (5h)'), w('weekly', 'Weekly')], verifiedAt: '2026-07-06' },
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
  { id: 'elevenlabs', label: 'ElevenLabs', klass: 'api-key', endpoint: 'https://api.elevenlabs.io/v1/user/subscription', windows: [w('monthly', 'Characters')] },
  { id: 'deepgram', label: 'Deepgram', klass: 'api-key', endpoint: 'https://api.deepgram.com/v1/projects', windows: [w('rolling', 'Balance')], credits: true },
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
  { id: 'openai-admin', label: 'OpenAI (admin spend)', klass: 'api-key', endpoint: 'https://api.openai.com/v1/organization/costs', windows: [w('monthly', 'Spend')] },
  { id: 'claude-admin', label: 'Claude (admin spend)', klass: 'api-key', windows: [w('monthly', 'Spend')] },
  // ── cloud-cli class (7/05): ambient credentials via the vendor CLI ──
  { id: 'vertex', label: 'Vertex AI', klass: 'cloud-cli', windows: [w('rolling', 'Session')] },
  { id: 'bedrock', label: 'AWS Bedrock', klass: 'cloud-cli', windows: [w('monthly', 'Spend')] },
  // ── web-session class (7/06, ADR 0007.b): paste-first; store-read opt-in ──
  { id: 'cursor', label: 'Cursor', klass: 'web-session', origin: 'cursor.com', cookieName: 'WorkosCursorSessionToken', endpoint: 'https://cursor.com/api/usage', windows: [w('monthly', 'Requests')] },
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
  { id: 'grok-web', label: 'Grok (browser)', klass: 'web-session', origin: 'grok.com', cookieName: 'sso', windows: [w('rolling', 'Quota')], credits: true }
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
