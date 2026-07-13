import { splitBom } from './common'
import { jsoncCodec } from './jsonc'
import type { ConfigCodec } from './types'

function validateStrictJson(text: string): void {
  const { body } = splitBom(text)
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error('Invalid JSON configuration. Comments and trailing commas are not supported by this provider.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON configuration root must be an object.')
  jsoncCodec.validate(text)
}

export const strictJsonCodec: ConfigCodec = {
  kind: 'json',
  read(text, path) {
    if (text !== null) validateStrictJson(text)
    return jsoncCodec.read(text, path)
  },
  set(text, path, value) {
    if (text !== null) validateStrictJson(text)
    const result = jsoncCodec.set(text, path, value)
    validateStrictJson(result)
    return result
  },
  remove(text, path) {
    validateStrictJson(text)
    const result = jsoncCodec.remove(text, path)
    validateStrictJson(result)
    return result
  },
  validate: validateStrictJson
}
