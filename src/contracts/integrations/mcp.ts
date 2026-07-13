// The unified MCP tool catalog (Phase-8/01, ADR 0008.b/c). ONE piece of data —
// `mcp-catalog.json` is the source of truth (the bin consumes the same file
// without a build step); dispatch, served tools/list, and docs all derive from
// it. Descriptions are for MODELS: the server serves them verbatim. Phase-2.5
// memory tools APPEND rows later — the catalog grows without touching dispatch.
//
// TS cannot pin a JSON import against closed unions (`satisfies` fails: JSON
// string literals widen to `string`), so the pin is the load-time validator
// below — it structurally narrows the JSON AND enforces the invariants the
// types can't: unique names, the shipped browser set verbatim, the act-verb
// set, and that `approve` is never a tool (docs/09: humans own the review gate).
import catalogJson from './mcp-catalog.json'

export type McpToolFamily = 'browser' | 'control'
/** `read` is never gated · `self` is bound to the calling pane's session capability
 *  · `write` is gated by the workspace grant's `writeTools` (03) · `act` is gated
 *  per signed-in ORIGIN (04). */
export type McpToolAccess = 'read' | 'self' | 'write' | 'act'
/** Which authed socket the server forwards this tool to (it owns neither):
 *  `app` = the browser-control endpoint · `daemon` = the versioned PTY daemon. */
export type McpToolUpstream = 'app' | 'daemon'

/** Plain JSON-Schema data (closed to what the catalog uses) — the contracts
 *  stay dependency-free; the server serves this shape verbatim. */
export interface McpPropertySchema {
  type: 'string' | 'number' | 'boolean'
  description?: string
  enum?: readonly string[]
}
export interface McpInputSchema {
  type: 'object'
  properties: Readonly<Record<string, McpPropertySchema>>
  required?: readonly string[]
}

/** The 14 browser tools SHIPPED in 6/05b — names verbatim from the server;
 *  the validator holds the catalog to this exact sequence. */
export const MCP_BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_select',
  'browser_eval',
  'browser_console',
  'browser_network_failures',
  'browser_wait_for'
] as const

/** Browser tools that ACT on a page (IMPLEMENTATION §04's gate list) — 04's
 *  per-origin gating derives from `access === 'act'`, which must equal this
 *  set. `browser_eval` is the sharpest tool: act-gated, no read-tier
 *  exception, ever. */
export const MCP_BROWSER_ACT_TOOL_NAMES = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_eval'
] as const

/** Control-plane reads (02) — snapshots of what the daemon/app already knows. */
export const MCP_CONTROL_READ_TOOL_NAMES = [
  'list_panes',
  'capture_pane',
  'mail_read',
  'list_owners',
  'list_board'
] as const

/** Self-scoped control declarations. They are always served because the daemon
 *  authenticates the calling pane with its per-session capability; they can never
 *  target another pane and therefore do not belong behind the general write grant. */
export const MCP_CONTROL_SELF_TOOL_NAMES = ['report_working_directory'] as const

/** Control-plane writes (03) — behind the workspace grant, default OFF. Each
 *  maps 1:1 onto a verb `mogging` already speaks; none adds capability. */
export const MCP_CONTROL_WRITE_TOOL_NAMES = [
  'send_to_pane',
  'send_key',
  'mail_send',
  'claim_files',
  'release_files',
  'update_card'
] as const

export const MCP_TOOL_NAMES = [
  ...MCP_BROWSER_TOOL_NAMES,
  ...MCP_CONTROL_READ_TOOL_NAMES,
  ...MCP_CONTROL_SELF_TOOL_NAMES,
  ...MCP_CONTROL_WRITE_TOOL_NAMES
] as const

export type McpBrowserToolName = (typeof MCP_BROWSER_TOOL_NAMES)[number]
export type McpControlReadToolName = (typeof MCP_CONTROL_READ_TOOL_NAMES)[number]
export type McpControlSelfToolName = (typeof MCP_CONTROL_SELF_TOOL_NAMES)[number]
export type McpWriteToolName = (typeof MCP_CONTROL_WRITE_TOOL_NAMES)[number]
export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

/** One catalog row. `verb` is the EXISTING upstream verb the server forwards
 *  to (a daemon ClientMessage `t`, or an app-endpoint call name) — the catalog
 *  never names capability that doesn't already exist daemon/app-side. */
export interface McpToolDef {
  name: McpToolName
  title: string
  description: string
  inputSchema: McpInputSchema
  family: McpToolFamily
  access: McpToolAccess
  upstream: McpToolUpstream
  verb: string
}

function fail(msg: string): never {
  throw new Error('mcp-catalog invalid: ' + msg)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function requireText(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v) fail(where + ' must be a non-empty string')
  return v
}

function validateInputSchema(raw: unknown, where: string): McpInputSchema {
  if (!isRecord(raw) || raw.type !== 'object' || !isRecord(raw.properties)) {
    fail(where + '.inputSchema must be { type: "object", properties: {...} }')
  }
  const properties: Record<string, McpPropertySchema> = {}
  for (const [key, p] of Object.entries(raw.properties)) {
    if (!isRecord(p)) fail(where + '.inputSchema.' + key + ' must be an object')
    const t = p.type
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      fail(where + '.inputSchema.' + key + '.type must be string|number|boolean')
    }
    const prop: McpPropertySchema = { type: t }
    if (p.description !== undefined) prop.description = requireText(p.description, where + '.inputSchema.' + key + '.description')
    if (p.enum !== undefined) {
      if (!Array.isArray(p.enum) || p.enum.length === 0) fail(where + '.inputSchema.' + key + '.enum must be a non-empty array')
      const en: string[] = []
      for (const e of p.enum) en.push(requireText(e, where + '.inputSchema.' + key + '.enum entry'))
      prop.enum = en
    }
    properties[key] = prop
  }
  let required: string[] | undefined
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required)) fail(where + '.inputSchema.required must be an array')
    required = []
    for (const r of raw.required) {
      const name = requireText(r, where + '.inputSchema.required entry')
      if (!(name in properties)) fail(where + '.inputSchema.required names unknown property "' + name + '"')
      required.push(name)
    }
  }
  return required ? { type: 'object', properties, required } : { type: 'object', properties }
}

/** THE assert (8/01 DoD): every entry valid, names exactly the declared closed
 *  unions in order (browser = the shipped server's 14, verbatim), act set =
 *  the §04 gate list, and no tool named anything like `approve`. Runs at
 *  module load — an invalid catalog fails every boot and every smoke. */
function validateMcpCatalog(raw: unknown): readonly McpToolDef[] {
  if (!Array.isArray(raw)) fail('catalog must be an array')
  const out: McpToolDef[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i]
    if (!isRecord(entry)) fail('entry ' + i + ' must be an object')
    const name = requireText(entry.name, 'entry ' + i + '.name')
    if (name.toLowerCase().includes('approve')) {
      fail('"' + name + '" — approve is a human verb, never a tool (ADR 0008.c, docs/09)')
    }
    if (!(MCP_TOOL_NAMES as readonly string[]).includes(name)) fail('"' + name + '" is not a declared tool name')
    const family = entry.family
    if (family !== 'browser' && family !== 'control') fail(name + '.family must be browser|control')
    const access = entry.access
    if (access !== 'read' && access !== 'self' && access !== 'write' && access !== 'act') {
      fail(name + '.access must be read|self|write|act')
    }
    const upstream = entry.upstream
    if (upstream !== 'app' && upstream !== 'daemon') fail(name + '.upstream must be app|daemon')
    const isBrowser = (MCP_BROWSER_TOOL_NAMES as readonly string[]).includes(name)
    if (isBrowser !== (family === 'browser')) fail(name + '.family disagrees with the name lists')
    if (family === 'browser' && upstream !== 'app') fail(name + ': browser tools ride the app endpoint')
    if (family === 'browser' && (access === 'write' || access === 'self')) {
      fail(name + ': browser tools are read or act, never self/write')
    }
    if (family === 'control' && access === 'act') {
      fail(name + ': act is a browser tier; control tools are read, self, or write')
    }
    const isAct = (MCP_BROWSER_ACT_TOOL_NAMES as readonly string[]).includes(name)
    if (isAct !== (access === 'act')) fail(name + '.access disagrees with the §04 act list')
    const isSelf = (MCP_CONTROL_SELF_TOOL_NAMES as readonly string[]).includes(name)
    if (isSelf !== (access === 'self')) fail(name + '.access disagrees with the self-tool list')
    const isWrite = (MCP_CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes(name)
    if (isWrite !== (access === 'write')) fail(name + '.access disagrees with the write-tool list')
    const verb = requireText(entry.verb, name + '.verb')
    if (family === 'browser' && verb !== name) fail(name + ': the app endpoint dispatches browser tools by name')
    if (isSelf && (upstream !== 'daemon' || verb !== 'cwd-report')) {
      fail(name + ': the self-scoped cwd declaration must ride daemon cwd-report')
    }
    out.push({
      name: name as McpToolName,
      title: requireText(entry.title, name + '.title'),
      description: requireText(entry.description, name + '.description'),
      inputSchema: validateInputSchema(entry.inputSchema, name),
      family,
      access,
      upstream,
      verb
    })
  }
  const names = out.map((d) => d.name)
  if (names.length !== MCP_TOOL_NAMES.length || names.some((n, i) => n !== MCP_TOOL_NAMES[i])) {
    fail('catalog names must be exactly MCP_TOOL_NAMES, in order (browser 14 first, verbatim)')
  }
  return out
}

/** THE catalog: the 14 shipped browser tools (names/schemas verbatim) + 5
 *  control reads + 1 self-scoped declaration + 6 control writes. Validated at load. */
export const MCP_TOOLS: readonly McpToolDef[] = validateMcpCatalog(catalogJson)

export const findMcpTool = (name: string): McpToolDef | undefined => MCP_TOOLS.find((t) => t.name === name)
