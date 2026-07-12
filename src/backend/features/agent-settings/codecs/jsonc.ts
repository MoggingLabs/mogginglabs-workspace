import {
  applyEdits,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type Node as JsonNode,
  type ParseError
} from 'jsonc-parser'
import {
  assertJsonValue,
  assertObjectRoot,
  assertPath,
  assertSafeKey,
  detectEol,
  readJsonPath,
  splitBom
} from './common'
import type { ConfigCodec, JsonValue } from './types'

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false }

interface ParsedJsonc {
  readonly value: { [key: string]: JsonValue }
}

function parseJsonc(text: string): ParsedJsonc {
  const { body } = splitBom(text)
  const errors: ParseError[] = []
  const tree = parseTree(body, errors, PARSE_OPTIONS)
  if (errors.length > 0 || !tree) {
    const first = errors[0]
    const detail = first ? `${printParseErrorCode(first.error)} at offset ${first.offset}` : 'empty document'
    throw new Error(`Invalid JSONC configuration: ${detail}`)
  }
  if (tree.type !== 'object') throw new Error('JSONC configuration root must be an object')
  assertJsonTreeKeys(tree)

  const value = parse(body, [], PARSE_OPTIONS) as unknown
  assertJsonValue(value, 'JSONC configuration')
  assertObjectRoot(value, 'JSONC')
  return { value }
}

function assertJsonTreeKeys(node: JsonNode): void {
  if (node.type === 'object') {
    const seen = new Set<string>()
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0]
      const valueNode = property.children?.[1]
      if (!keyNode || keyNode.type !== 'string' || typeof keyNode.value !== 'string' || !valueNode) {
        throw new Error('Invalid JSONC object property')
      }
      const key = keyNode.value
      assertSafeKey(key, 'JSONC configuration')
      if (seen.has(key)) throw new Error(`JSONC configuration contains duplicate key ${JSON.stringify(key)}`)
      seen.add(key)
      assertJsonTreeKeys(valueNode)
    }
  } else if (node.type === 'array') {
    for (const child of node.children ?? []) assertJsonTreeKeys(child)
  }
}

function formattingOptions(text: string): FormattingOptions {
  const body = splitBom(text).body
  let insertSpaces = true
  let tabSize = 2
  for (const line of body.split(/\r?\n/)) {
    const match = /^([ \t]+)["}\]]/.exec(line)
    if (!match) continue
    insertSpaces = !match[1].includes('\t')
    if (insertSpaces) tabSize = Math.max(1, match[1].length)
    break
  }
  return {
    eol: detectEol(body),
    insertSpaces,
    tabSize,
    insertFinalNewline: /(?:\r\n|\n)$/.test(body)
  }
}

function editJsonc(text: string, path: readonly string[], value: JsonValue | undefined): string {
  const envelope = splitBom(text)
  const edits = modify(envelope.body, [...path], value, { formattingOptions: formattingOptions(text) })
  const result = envelope.bom + applyEdits(envelope.body, edits)
  parseJsonc(result)
  return result
}

export const jsoncCodec: ConfigCodec = {
  kind: 'jsonc',

  read(text, path) {
    assertPath(path)
    if (text === null) return { present: false }
    return readJsonPath(parseJsonc(text).value, path)
  },

  set(text, path, value) {
    assertPath(path)
    assertJsonValue(value)
    const source = text === null ? '{}\n' : text
    if (text !== null) parseJsonc(text)
    return editJsonc(source, path, value)
  },

  remove(text, path) {
    assertPath(path)
    const parsed = parseJsonc(text)
    if (!readJsonPath(parsed.value, path).present) return text
    return editJsonc(text, path, undefined)
  },

  validate(text) {
    parseJsonc(text)
  }
}
