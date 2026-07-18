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

export type McpToolFamily = 'browser' | 'control' | 'brain'
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

/** The browser tools — the 14 SHIPPED in 6/05b, plus the 3 TAB tools (F4). Names
 *  verbatim from the server; the validator holds the catalog to this exact sequence. */
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
  'browser_wait_for',
  'browser_tab_list',
  'browser_tab_new',
  'browser_tab_select'
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

/** Control-plane reads (02) — snapshots of what the daemon/app already knows.
 *  Board v2 adds `get_card` (one card + its activity, same scope as list). */
export const MCP_CONTROL_READ_TOOL_NAMES = [
  'list_panes',
  'capture_pane',
  'mail_read',
  'list_owners',
  'list_board',
  'get_card'
] as const

/** Self-scoped control declarations. They are always served because the daemon
 *  authenticates the calling pane with its per-session capability; they can never
 *  target another pane and therefore do not belong behind the general write grant. */
export const MCP_CONTROL_SELF_TOOL_NAMES = ['report_working_directory'] as const

/** Control-plane writes (03) — behind the workspace grant, default OFF. The
 *  fleet writes map 1:1 onto verbs `mogging` already speaks; the Board-v2
 *  writes (create/claim/release/comment/archive + the widened update) all
 *  funnel through main's ONE board writer (CAS + claim rule + activity), so an
 *  agent can drive the board fully and never silently clobber anyone. There is
 *  deliberately no delete: agents archive; humans delete. */
export const MCP_CONTROL_WRITE_TOOL_NAMES = [
  'send_to_pane',
  'send_key',
  'mail_send',
  'claim_files',
  'release_files',
  'update_card',
  'create_card',
  'claim_card',
  'release_card',
  'comment_card',
  'archive_card'
] as const

/** The brain's read family (ADR 0018, steps 05–08) — graph reads, the ranked
 *  repomap, and the library lens (version truth + docs custody), free to every
 *  pane (ADR 0008's reads-free stance), scoped app-side to the caller's own
 *  checkout. Reads are never gated; the validator holds every name here to
 *  `access: 'read'` structurally. (get_library_docs' opt-in `fetch` path is
 *  consent-gated app-side — per-workspace, default OFF — not grant-gated.) */
export const MCP_BRAIN_READ_TOOL_NAMES = [
  'brain_status',
  'query_graph',
  'get_node',
  'get_neighbors',
  'shortest_path',
  'find_symbol',
  'find_references',
  'get_repo_map',
  'list_libraries',
  'get_library_docs'
] as const

/** The brain's write family (ADR 0018 step 07) — symbol-level edits in the
 *  caller's OWN checkout, behind the SAME per-workspace grant as every other
 *  write (ADR 0018.e: no second path around the write wall). THE SET IS CLOSED:
 *  a brain write verb not in this list is a review rejection, and growing it
 *  needs an ADR revision — rename_symbol stays deferred there (cross-file blast
 *  radius over a syntactic graph is a find-and-pray). */
export const MCP_BRAIN_WRITE_TOOL_NAMES = [
  'replace_symbol_body',
  'insert_after_symbol',
  'insert_before_symbol'
] as const

/** The memory lens's read family (ADR 0018 step 09, Phase 2.5) — the team's
 *  `.memory/` wikilink graph, read project-wide (freshest copy across roots
 *  wins, root-labeled), searched and suggested DETERMINISTICALLY (FTS5 bm25;
 *  fixed-weight overlap scoring with the breakdown served back). Reads are
 *  never gated, like every brain read. */
export const MCP_MEMORY_READ_TOOL_NAMES = [
  'search_memories',
  'get_memory',
  'find_backlinks',
  'suggest_connections'
] as const

/** The memory lens's write family (ADR 0018 step 09) — create/update files in
 *  the caller's OWN checkout's `.memory/`, behind the SAME per-workspace grant
 *  as every other write. THE SET IS CLOSED: growing it needs an ADR revision —
 *  delete stays a human verb (`git rm` is the delete). */
export const MCP_MEMORY_WRITE_TOOL_NAMES = ['create_memory', 'update_memory'] as const

/** EVERY grant-gated write, one list: the fleet/board writes plus the brain's
 *  symbol writes plus the memory writes. The grant store resolves 'all'/list
 *  against exactly this — one toggle, one boundary, no write outside it. */
export const MCP_WRITE_TOOL_NAMES = [
  ...MCP_CONTROL_WRITE_TOOL_NAMES,
  ...MCP_BRAIN_WRITE_TOOL_NAMES,
  ...MCP_MEMORY_WRITE_TOOL_NAMES
] as const

export const MCP_TOOL_NAMES = [
  ...MCP_BROWSER_TOOL_NAMES,
  ...MCP_CONTROL_READ_TOOL_NAMES,
  ...MCP_CONTROL_SELF_TOOL_NAMES,
  ...MCP_CONTROL_WRITE_TOOL_NAMES,
  ...MCP_BRAIN_READ_TOOL_NAMES,
  ...MCP_BRAIN_WRITE_TOOL_NAMES,
  ...MCP_MEMORY_READ_TOOL_NAMES,
  ...MCP_MEMORY_WRITE_TOOL_NAMES
] as const

export type McpBrowserToolName = (typeof MCP_BROWSER_TOOL_NAMES)[number]
export type McpControlReadToolName = (typeof MCP_CONTROL_READ_TOOL_NAMES)[number]
export type McpControlSelfToolName = (typeof MCP_CONTROL_SELF_TOOL_NAMES)[number]
export type McpWriteToolName = (typeof MCP_WRITE_TOOL_NAMES)[number]
export type McpBrainReadToolName = (typeof MCP_BRAIN_READ_TOOL_NAMES)[number]
export type McpBrainWriteToolName = (typeof MCP_BRAIN_WRITE_TOOL_NAMES)[number]
export type McpMemoryReadToolName = (typeof MCP_MEMORY_READ_TOOL_NAMES)[number]
export type McpMemoryWriteToolName = (typeof MCP_MEMORY_WRITE_TOOL_NAMES)[number]
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
    if (family !== 'browser' && family !== 'control' && family !== 'brain') {
      fail(name + '.family must be browser|control|brain')
    }
    const access = entry.access
    if (access !== 'read' && access !== 'self' && access !== 'write' && access !== 'act') {
      fail(name + '.access must be read|self|write|act')
    }
    const upstream = entry.upstream
    if (upstream !== 'app' && upstream !== 'daemon') fail(name + '.upstream must be app|daemon')
    const isBrowser = (MCP_BROWSER_TOOL_NAMES as readonly string[]).includes(name)
    if (isBrowser !== (family === 'browser')) fail(name + '.family disagrees with the name lists')
    const isBrainRead =
      (MCP_BRAIN_READ_TOOL_NAMES as readonly string[]).includes(name) ||
      (MCP_MEMORY_READ_TOOL_NAMES as readonly string[]).includes(name)
    const isBrainWrite =
      (MCP_BRAIN_WRITE_TOOL_NAMES as readonly string[]).includes(name) ||
      (MCP_MEMORY_WRITE_TOOL_NAMES as readonly string[]).includes(name)
    if ((isBrainRead || isBrainWrite) !== (family === 'brain')) fail(name + '.family disagrees with the brain name lists')
    if (family === 'browser' && upstream !== 'app') fail(name + ': browser tools ride the app endpoint')
    if (family === 'browser' && (access === 'write' || access === 'self')) {
      fail(name + ': browser tools are read or act, never self/write')
    }
    if (family === 'control' && access === 'act') {
      fail(name + ': act is a browser tier; control tools are read, self, or write')
    }
    // ADR 0018 steps 05/07/09: the brain family is the CLOSED read sets (graph
    // + memory) plus the CLOSED write sets (symbol + memory), on the app
    // endpoint, every verb wearing the brain.* prefix. A brain verb outside
    // the lists — or a read that claims write access, or vice versa — is a
    // review rejection; growing a write set needs an ADR revision. This is
    // where the rejection becomes structural.
    if (family === 'brain' && isBrainRead && access !== 'read') fail(name + ': brain reads are reads, forever')
    if (family === 'brain' && isBrainWrite && access !== 'write') {
      fail(name + ': brain writes sit behind the grant — access must be write')
    }
    if (family === 'brain' && upstream !== 'app') fail(name + ': brain tools ride the app endpoint')
    if (family === 'brain' && !String(entry.verb ?? '').startsWith('brain.')) {
      fail(name + ': brain verbs wear the brain.* prefix')
    }
    const isAct = (MCP_BROWSER_ACT_TOOL_NAMES as readonly string[]).includes(name)
    if (isAct !== (access === 'act')) fail(name + '.access disagrees with the §04 act list')
    const isSelf = (MCP_CONTROL_SELF_TOOL_NAMES as readonly string[]).includes(name)
    if (isSelf !== (access === 'self')) fail(name + '.access disagrees with the self-tool list')
    const isWrite = (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(name)
    if (isWrite !== (access === 'write')) fail(name + '.access disagrees with the write-tool lists')
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

/** THE catalog: the 14 shipped browser tools (names/schemas verbatim) + 6
 *  control reads + 1 self-scoped declaration + 11 control writes + 10 brain
 *  reads (ADR 0018 steps 05–08: the graph seven, the repomap, the library
 *  lens) + 3 brain writes (step 07: the closed symbol-write set) + 4 memory
 *  reads and 2 memory writes (step 09: the `.memory/` wikilink lens).
 *  Validated at load. */
export const MCP_TOOLS: readonly McpToolDef[] = validateMcpCatalog(catalogJson)

export const findMcpTool = (name: string): McpToolDef | undefined => MCP_TOOLS.find((t) => t.name === name)

/** The house server's ALWAYS-SERVED groups, by family, derived from the one
 *  catalog — the tool-plan matrix lists these so its "always" cell is an
 *  enumerated truth, not a vibe (step-05 registration honesty). Read/self/act
 *  tiers are listed (act still gates per origin downstream); writes are the
 *  grant's story and deliberately absent here. */
export const MCP_HOUSE_TOOL_GROUPS: readonly { family: McpToolFamily; label: string; count: number }[] = (
  [
    ['browser', 'browser'],
    ['control', 'fleet & board reads'],
    ['brain', 'brain reads (code graph & memory)']
  ] as const
).map(([family, label]) => ({
  family,
  label,
  count: MCP_TOOLS.filter((t) => t.family === family && t.access !== 'write').length
}))
