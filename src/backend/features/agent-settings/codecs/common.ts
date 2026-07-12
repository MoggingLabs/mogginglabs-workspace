import type { ConfigRead, JsonValue } from './types'

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface TextEnvelope {
  readonly bom: string
  readonly body: string
}

export function splitBom(text: string): TextEnvelope {
  return text.startsWith('\uFEFF')
    ? { bom: '\uFEFF', body: text.slice(1) }
    : { bom: '', body: text }
}

export function detectEol(text: string): '\r\n' | '\n' {
  const newline = text.indexOf('\n')
  return newline > 0 && text.charCodeAt(newline - 1) === 13 ? '\r\n' : '\n'
}

export function assertPath(path: readonly string[]): void {
  if (path.length === 0) throw new Error('Configuration paths must contain at least one segment')
  for (const segment of path) assertSafeKey(segment, 'Configuration path')
}

export function assertSafeKey(key: string, context: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.trim().length === 0) {
    throw new Error(`${context} contains an empty key`)
  }
  if (UNSAFE_KEYS.has(key)) throw new Error(`${context} contains unsafe prototype key ${JSON.stringify(key)}`)
  assertUnicodeScalarString(key, `${context} key`)
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(`${context} contains a control character in key ${JSON.stringify(key)}`)
    }
  }
}

export function assertUnicodeScalarString(value: string, context: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${context} contains an unpaired UTF-16 surrogate`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${context} contains an unpaired UTF-16 surrogate`)
    }
  }
}

export function assertJsonValue(value: unknown, context = 'Configuration value'): asserts value is JsonValue {
  validateJsonValue(value, context, new Set<object>())
}

function validateJsonValue(value: unknown, context: string, active: Set<object>): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, context)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${context} contains a non-finite number`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${context} is not JSON-compatible`)
  if (active.has(value)) throw new Error(`${context} contains a cycle`)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value)
      for (const key of ownKeys) {
        if (key === 'length') continue
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new Error(`${context} contains a non-JSON array property`)
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error(`${context} contains a sparse or accessor array element`)
        }
        validateJsonValue(descriptor.value, `${context}[${index}]`, active)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${context} must be a plain JSON object`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(`${context} contains a symbol key`)
      assertSafeKey(key, context)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`${context}.${key} must be an enumerable data property`)
      }
      validateJsonValue(descriptor.value, `${context}.${key}`, active)
    }
  } finally {
    active.delete(value)
  }
}

export function assertObjectRoot(value: JsonValue, kind: string): asserts value is { [key: string]: JsonValue } {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${kind} configuration root must be a mapping/object`)
  }
}

export function readJsonPath(root: JsonValue, path: readonly string[]): ConfigRead {
  let current: JsonValue = root
  for (const segment of path) {
    if (current === null || Array.isArray(current) || typeof current !== 'object') return { present: false }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { present: false }
    current = current[segment]
  }
  return { present: true, value: current }
}

export function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

export function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index])
}

export function pathKey(path: readonly string[]): string {
  return JSON.stringify(path)
}
