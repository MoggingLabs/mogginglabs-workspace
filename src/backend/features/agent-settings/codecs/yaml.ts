import {
  Document,
  YAMLMap,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node
} from 'yaml'
import {
  assertJsonValue,
  assertPath,
  assertSafeKey,
  detectEol,
  readJsonPath,
  splitBom
} from './common'
import type { ConfigCodec, JsonValue } from './types'

interface ParsedYaml {
  readonly body: string
  readonly bom: string
  readonly document: Document<Node, true>
  readonly root: { [key: string]: JsonValue }
}

function parseYaml(text: string): ParsedYaml {
  const { body, bom } = splitBom(text)
  const document = parseDocument<Node>(body, {
    keepSourceTokens: true,
    prettyErrors: true,
    schema: 'core',
    strict: true,
    uniqueKeys: true,
    version: '1.2'
  })
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML configuration: ${document.errors[0].message}`)
  }
  if (document.warnings.length > 0) {
    throw new Error(`Unsupported YAML configuration: ${document.warnings[0].message}`)
  }

  let root: { [key: string]: JsonValue }
  if (document.contents === null) {
    root = Object.create(null) as { [key: string]: JsonValue }
  } else {
    if (!isMap(document.contents)) throw new Error('YAML configuration root must be a mapping')
    root = yamlMapToJson(document.contents, 'YAML configuration')
  }
  assertJsonValue(root, 'YAML configuration')
  return { body, bom, document, root }
}

function yamlNodeToJson(node: unknown, context: string): JsonValue {
  if (node === null) return null
  // Aliases remain in the round-trip document. The renderer sees an inert
  // marker; writes crossing an alias are refused below instead of rejecting an
  // otherwise valid file because an unrelated foreign key uses anchors.
  if (isAlias(node)) return '<YAML alias>'
  if (isScalar(node)) {
    const value = node.value as unknown
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
    if (typeof value === 'bigint') return value.toString()
    assertJsonValue(value, context)
    return value
  }
  if (isSeq(node)) {
    return node.items.map((item, index) => yamlNodeToJson(item, `${context}[${index}]`))
  }
  if (isMap(node)) return yamlMapToJson(node, context)
  throw new Error(`${context} contains a non-JSON YAML node`)
}

function assertWritablePath(document: Document<Node, true>, path: readonly string[]): void {
  for (let length = 1; length < path.length; length += 1) {
    const node = document.getIn(path.slice(0, length), true)
    if (isAlias(node)) throw new Error(`YAML path ${JSON.stringify(path)} crosses an alias`)
    if (node !== undefined && node !== null && !isMap(node)) {
      throw new Error(`YAML path ${JSON.stringify(path)} crosses a non-mapping value`)
    }
  }
}

function yamlMapToJson(map: YAMLMap, context: string): { [key: string]: JsonValue } {
  const result = Object.create(null) as { [key: string]: JsonValue }
  const seen = new Set<string>()
  for (const pair of map.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      throw new Error(`${context} contains a non-string mapping key`)
    }
    const key = pair.key.value
    assertSafeKey(key, context)
    if (seen.has(key)) throw new Error(`${context} contains duplicate key ${JSON.stringify(key)}`)
    seen.add(key)
    result[key] = yamlNodeToJson(pair.value, `${context}.${key}`)
  }
  return result
}

function renderYaml(parsed: ParsedYaml, originalWasAbsent: boolean): string {
  let rendered = parsed.document.toString({ lineWidth: 0 })
  const hadFinalNewline = /(?:\r\n|\n)$/.test(parsed.body)
  if (!originalWasAbsent && !hadFinalNewline) rendered = rendered.replace(/\n$/, '')
  if (detectEol(parsed.body) === '\r\n') rendered = rendered.replace(/\n/g, '\r\n')
  const result = parsed.bom + rendered
  parseYaml(result)
  return result
}

export const yamlCodec: ConfigCodec = {
  kind: 'yaml',

  read(text, path) {
    assertPath(path)
    if (text === null) return { present: false }
    return readJsonPath(parseYaml(text).root, path)
  },

  set(text, path, value) {
    assertPath(path)
    assertJsonValue(value)
    const parsed = parseYaml(text ?? '')
    if (parsed.document.contents === null) parsed.document.contents = new YAMLMap(parsed.document.schema)
    assertWritablePath(parsed.document, path)
    parsed.document.setIn([...path], parsed.document.createNode(value))
    return renderYaml(parsed, text === null)
  },

  remove(text, path) {
    assertPath(path)
    const parsed = parseYaml(text)
    if (!readJsonPath(parsed.root, path).present) return text
    if (!parsed.document.deleteIn([...path])) {
      throw new Error(`YAML path ${JSON.stringify(path)} could not be removed`)
    }
    return renderYaml(parsed, false)
  },

  validate(text) {
    parseYaml(text)
  }
}
