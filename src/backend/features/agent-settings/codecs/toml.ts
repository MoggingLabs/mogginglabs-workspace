import { parseTOML, type AST } from 'toml-eslint-parser'
import {
  assertJsonValue,
  assertPath,
  assertSafeKey,
  assertUnicodeScalarString,
  detectEol,
  isPathPrefix,
  pathKey,
  readJsonPath,
  splitBom
} from './common'
import type { ConfigCodec, JsonValue } from './types'

type JsonObject = { [key: string]: JsonValue }

interface TomlEntry {
  readonly path: readonly string[]
  readonly node: AST.TOMLKeyValue
}

interface TomlTable {
  readonly path: readonly string[]
  readonly node: AST.TOMLTable
}

interface ParsedToml {
  readonly ast: AST.TOMLProgram
  readonly body: string
  readonly bom: string
  readonly entries: ReadonlyMap<string, TomlEntry>
  readonly root: JsonObject
  readonly tables: readonly TomlTable[]
}

function object(): JsonObject {
  return Object.create(null) as JsonObject
}

function parseToml(text: string): ParsedToml {
  const { body, bom } = splitBom(text)
  let ast: AST.TOMLProgram
  try {
    ast = parseTOML(body, { tomlVersion: '1.0' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid TOML configuration: ${message}`, { cause: error })
  }

  const root = object()
  const entries = new Map<string, TomlEntry>()
  const tables: TomlTable[] = []
  const top = ast.body[0]

  for (const item of top.body) {
    if (item.type === 'TOMLKeyValue') {
      const key = tomlKey(item.key, 'TOML configuration')
      assignDotted(root, key, tomlValue(item.value, 'TOML configuration'), 'TOML configuration')
      collectEntries(item, [], entries)
      continue
    }

    const resolved = item.resolvedKey
    for (const segment of resolved) {
      if (typeof segment === 'string') assertSafeKey(segment, 'TOML table path')
    }
    const container = ensureResolvedTable(root, resolved)
    for (const keyValue of item.body) {
      const key = tomlKey(keyValue.key, 'TOML configuration')
      assignDotted(container, key, tomlValue(keyValue.value, 'TOML configuration'), 'TOML configuration')
      collectEntries(keyValue, resolved, entries)
    }
    if (item.kind === 'standard' && resolved.every((segment): segment is string => typeof segment === 'string')) {
      tables.push({ path: resolved, node: item })
    }
  }

  assertJsonValue(root, 'TOML configuration')
  return { ast, body, bom, entries, root, tables }
}

function tomlKey(key: AST.TOMLKey, context: string): string[] {
  return key.keys.map((part) => {
    const value = part.type === 'TOMLBare' ? part.name : part.value
    assertSafeKey(value, context)
    return value
  })
}

function tomlValue(node: AST.TOMLContentNode, context: string): JsonValue {
  if (node.type === 'TOMLArray') {
    return node.elements.map((element, index) => tomlValue(element, `${context}[${index}]`))
  }
  if (node.type === 'TOMLInlineTable') {
    const result = object()
    for (const item of node.body) {
      const key = tomlKey(item.key, context)
      assignDotted(result, key, tomlValue(item.value, context), context)
    }
    return result
  }
  if (node.kind === 'offset-date-time' || node.kind === 'local-date-time' || node.kind === 'local-date' || node.kind === 'local-time') {
    // Keep valid foreign TOML representable in the read model without ever
    // serializing it back. Surgical edits splice only the requested node.
    return String(node.value)
  }
  if (node.kind === 'integer') {
    return Number.isSafeInteger(node.value) && BigInt(node.value) === node.bigint
      ? node.value
      : node.bigint.toString()
  }
  if (node.kind === 'float') {
    return Number.isFinite(node.value) ? node.value : String(node.value)
  }
  if (node.kind === 'string') {
    assertUnicodeScalarString(node.value, context)
    return node.value
  }
  if (node.kind === 'boolean') return node.value
  throw new Error(`${context} contains an unsupported TOML value`)
}

function assignDotted(target: JsonObject, key: readonly string[], value: JsonValue, context: string): void {
  let current = target
  for (let index = 0; index < key.length - 1; index += 1) {
    const segment = key[index]
    const existing = current[segment]
    if (existing === undefined && !Object.prototype.hasOwnProperty.call(current, segment)) {
      const created = object()
      current[segment] = created
      current = created
    } else if (existing !== null && !Array.isArray(existing) && typeof existing === 'object') {
      current = existing
    } else {
      throw new Error(`${context} has a scalar/table conflict at ${JSON.stringify(key.slice(0, index + 1))}`)
    }
  }
  const leaf = key[key.length - 1]
  if (Object.prototype.hasOwnProperty.call(current, leaf)) {
    throw new Error(`${context} contains duplicate key ${JSON.stringify(key)}`)
  }
  current[leaf] = value
}

function ensureResolvedTable(root: JsonObject, path: readonly (string | number)[]): JsonObject {
  let current: JsonValue = root
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]
    const nextIsArray = typeof path[index + 1] === 'number'
    const created: JsonValue = nextIsArray ? [] : object()
    if (typeof segment === 'string') {
      if (current === null || Array.isArray(current) || typeof current !== 'object') {
        throw new Error(`TOML table path conflicts at ${JSON.stringify(path.slice(0, index))}`)
      }
      if (!Object.prototype.hasOwnProperty.call(current, segment)) current[segment] = created
      current = current[segment]
    } else {
      if (!Array.isArray(current)) throw new Error(`TOML array-table path conflicts at index ${segment}`)
      if (current[segment] === undefined) current[segment] = created
      current = current[segment]
    }
  }
  if (current === null || Array.isArray(current) || typeof current !== 'object') {
    throw new Error(`TOML table path does not resolve to an object`)
  }
  return current
}

function collectEntries(
  node: AST.TOMLKeyValue,
  base: readonly (string | number)[],
  entries: Map<string, TomlEntry>
): void {
  const absolute = [...base, ...tomlKey(node.key, 'TOML configuration')]
  if (absolute.every((segment): segment is string => typeof segment === 'string')) {
    const key = pathKey(absolute)
    if (entries.has(key)) throw new Error(`TOML configuration contains duplicate key ${JSON.stringify(absolute)}`)
    entries.set(key, { path: absolute, node })
  }
  if (node.value.type === 'TOMLInlineTable') {
    for (const child of node.value.body) collectEntries(child, absolute, entries)
  }
}

function encodeTomlKey(path: readonly string[]): string {
  return path.map((segment) => (/^[A-Za-z0-9_-]+$/.test(segment) ? segment : encodeTomlString(segment))).join('.')
}

function encodeTomlString(value: string): string {
  assertUnicodeScalarString(value, 'TOML string')
  let result = '"'
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    switch (code) {
      case 0x08:
        result += '\\b'
        break
      case 0x09:
        result += '\\t'
        break
      case 0x0a:
        result += '\\n'
        break
      case 0x0c:
        result += '\\f'
        break
      case 0x0d:
        result += '\\r'
        break
      case 0x22:
        result += '\\"'
        break
      case 0x5c:
        result += '\\\\'
        break
      default:
        if (code < 0x20 || code === 0x7f) result += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
        else result += value[index]
    }
  }
  return result + '"'
}

function encodeTomlValue(value: JsonValue): string {
  if (value === null) throw new Error('TOML cannot represent JSON null')
  if (typeof value === 'string') return encodeTomlString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('TOML cannot represent a non-finite JSON number')
    if (Object.is(value, -0)) return '-0.0'
    if (Number.isSafeInteger(value)) return String(value)
    if (Number.isInteger(value)) return value.toExponential()
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(encodeTomlValue).join(', ')}]`
  const fields = Object.keys(value).map((key) => `${encodeTomlKey([key])} = ${encodeTomlValue(value[key])}`)
  return fields.length === 0 ? '{}' : `{ ${fields.join(', ')} }`
}

function spliceAndValidate(parsed: ParsedToml, start: number, end: number, replacement: string): string {
  const body = parsed.body.slice(0, start) + replacement + parsed.body.slice(end)
  const result = parsed.bom + body
  parseToml(result)
  return result
}

function lineStart(text: string, offset: number): number {
  const newline = text.lastIndexOf('\n', Math.max(0, offset - 1))
  return newline < 0 ? 0 : newline + 1
}

function lineEndWithBreak(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset)
  return newline < 0 ? text.length : newline + 1
}

function insertStatement(
  parsed: ParsedToml,
  table: TomlTable | undefined,
  relativePath: readonly string[],
  encodedValue: string
): string {
  const statement = `${encodeTomlKey(relativePath)} = ${encodedValue}`
  const eol = detectEol(parsed.body)
  if (table) {
    const body = table.node.body
    const lastEnd = body.length > 0 ? body[body.length - 1].range[1] : table.node.range[1]
    const offset = lineEndWithBreak(parsed.body, lastEnd)
    const endedLine = offset > lastEnd && parsed.body.slice(lastEnd, offset).includes('\n')
    return spliceAndValidate(parsed, offset, offset, endedLine ? `${statement}${eol}` : `${eol}${statement}`)
  }

  const firstTable = parsed.ast.body[0].body.find((node): node is AST.TOMLTable => node.type === 'TOMLTable')
  if (firstTable) {
    const offset = lineStart(parsed.body, firstTable.range[0])
    return spliceAndValidate(parsed, offset, offset, `${statement}${eol}`)
  }
  if (parsed.body.length === 0) return spliceAndValidate(parsed, 0, 0, `${statement}${eol}`)
  if (parsed.body.endsWith('\n')) {
    return spliceAndValidate(parsed, parsed.body.length, parsed.body.length, `${statement}${eol}`)
  }
  return spliceAndValidate(parsed, parsed.body.length, parsed.body.length, `${eol}${statement}`)
}

function insertInline(
  parsed: ParsedToml,
  inline: AST.TOMLInlineTable,
  relativePath: readonly string[],
  encodedValue: string
): string {
  const statement = `${encodeTomlKey(relativePath)} = ${encodedValue}`
  if (inline.body.length > 0) {
    const last = inline.body[inline.body.length - 1]
    return spliceAndValidate(parsed, last.range[1], last.range[1], `, ${statement}`)
  }
  const close = inline.range[1] - 1
  if (parsed.body[close] !== '}') throw new Error('Invalid TOML inline-table range')
  const inner = parsed.body.slice(inline.range[0] + 1, close)
  const insertion = inner.length === 0 ? ` ${statement} ` : `${/\s$/.test(inner) ? '' : ' '}${statement}`
  return spliceAndValidate(parsed, close, close, insertion)
}

function findInlineContainer(parsed: ParsedToml, parent: readonly string[]): TomlEntry | undefined {
  for (let length = parent.length; length > 0; length -= 1) {
    const entry = parsed.entries.get(pathKey(parent.slice(0, length)))
    if (entry?.node.value.type === 'TOMLInlineTable') return entry
  }
  return undefined
}

function findTableContainer(parsed: ParsedToml, parent: readonly string[]): TomlTable | undefined {
  let best: TomlTable | undefined
  for (const table of parsed.tables) {
    if (isPathPrefix(table.path, parent) && (!best || table.path.length > best.path.length)) best = table
  }
  return best
}

function assertWritableParent(root: JsonObject, parent: readonly string[]): void {
  for (let length = 1; length <= parent.length; length += 1) {
    const prefix = parent.slice(0, length)
    const read = readJsonPath(root, prefix)
    if (!read.present) return
    const value = read.value
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error(`TOML path crosses a non-table value at ${JSON.stringify(prefix)}`)
    }
  }
}

function removeInlineEntry(parsed: ParsedToml, entry: TomlEntry): string {
  const inline = entry.node.parent
  if (inline.type !== 'TOMLInlineTable') throw new Error('TOML entry is not inside an inline table')
  const index = inline.body.indexOf(entry.node)
  if (index < 0) throw new Error('TOML inline-table entry range is inconsistent')
  if (inline.body.length === 1) {
    return spliceAndValidate(parsed, entry.node.range[0], entry.node.range[1], '')
  }
  if (index < inline.body.length - 1) {
    return spliceAndValidate(parsed, entry.node.range[0], inline.body[index + 1].range[0], '')
  }
  return spliceAndValidate(parsed, inline.body[index - 1].range[1], entry.node.range[1], '')
}

export const tomlCodec: ConfigCodec = {
  kind: 'toml',

  read(text, path) {
    assertPath(path)
    if (text === null) return { present: false }
    return readJsonPath(parseToml(text).root, path)
  },

  set(text, path, value) {
    assertPath(path)
    assertJsonValue(value)
    const encoded = encodeTomlValue(value)
    const parsed = parseToml(text ?? '')
    const existing = parsed.entries.get(pathKey(path))
    if (existing) {
      return spliceAndValidate(parsed, existing.node.value.range[0], existing.node.value.range[1], encoded)
    }
    if (readJsonPath(parsed.root, path).present) {
      throw new Error(`TOML path ${JSON.stringify(path)} denotes a table or aggregate, not a key/value statement`)
    }

    const parent = path.slice(0, -1)
    assertWritableParent(parsed.root, parent)
    const inline = findInlineContainer(parsed, parent)
    if (inline && inline.node.value.type === 'TOMLInlineTable') {
      return insertInline(parsed, inline.node.value, path.slice(inline.path.length), encoded)
    }
    const table = findTableContainer(parsed, parent)
    return insertStatement(parsed, table, table ? path.slice(table.path.length) : path, encoded)
  },

  remove(text, path) {
    assertPath(path)
    const parsed = parseToml(text)
    const existing = parsed.entries.get(pathKey(path))
    if (existing) {
      if (existing.node.parent.type === 'TOMLInlineTable') return removeInlineEntry(parsed, existing)
      const start = lineStart(parsed.body, existing.node.range[0])
      const end = lineEndWithBreak(parsed.body, existing.node.range[1])
      return spliceAndValidate(parsed, start, end, '')
    }
    if (readJsonPath(parsed.root, path).present) {
      throw new Error(`TOML path ${JSON.stringify(path)} denotes a table or aggregate, not a removable key/value statement`)
    }
    return text
  },

  validate(text) {
    parseToml(text)
  }
}
