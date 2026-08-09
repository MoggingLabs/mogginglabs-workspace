/**
 * A DOM small enough to RUN a renderer module in the unit tier.
 *
 * tests/unit is Electron-free and has no browser (vitest `environment: 'node'`, and the repo
 * deliberately ships no jsdom). Most renderer defects are therefore pinned as source
 * properties — wizard-controls.test.ts says so in its own header. But two of them are about
 * the ORDER several listeners run in, and about which one of them a `stopPropagation` can
 * silence; a source grep cannot see either. This is the smallest DOM that lets those rules be
 * executed rather than described.
 *
 * It models what the modules under test touch, and ONE thing beyond that on purpose:
 * `stopPropagation()` does NOT stop sibling listeners registered on the same node. That is the
 * whole substance of F021 (every open modal registers its own capture-phase Escape listener on
 * `window`), so a shim where stopPropagation silenced siblings would report a fix the real
 * browser does not have.
 *
 * Not a browser. Unknown selectors match nothing, layout is whatever a test says it is, and
 * nothing paints. Anything needing more than this belongs in a live gate.
 */

export type FakeListener = (e: FakeEvent) => void

export interface FakeEvent {
  type: string
  target: unknown
  key?: string
  propertyName?: string
  clientX?: number
  clientY?: number
  defaultPrevented?: boolean
  preventDefault(): void
  stopPropagation(): void
}

/** One compound selector: an optional tag, some classes, and `:not(.class)` exclusions. */
interface Compound {
  tag?: string
  classes: string[]
  not: string[]
  /** An attribute or pseudo this shim does not model — such a compound matches nothing. */
  opaque: boolean
}

function parseSelector(selector: string): Compound[] {
  return selector.split(',').map((part) => {
    const c: Compound = { classes: [], not: [], opaque: false }
    // `:not(...)` first, so its contents never leak into the outer parse.
    let rest = part.trim().replace(/:not\(([^)]*)\)/g, (_m, inner: string) => {
      if (inner.startsWith('.')) c.not.push(inner.slice(1))
      else c.opaque = true // :not([disabled]) and friends — not modelled
      return ''
    })
    if (/[[\]:>~+]/.test(rest)) c.opaque = true
    const tag = /^[a-zA-Z][\w-]*/.exec(rest)
    if (tag) {
      c.tag = tag[0].toUpperCase()
      rest = rest.slice(tag[0].length)
    }
    for (const m of rest.matchAll(/\.([\w-]+)/g)) c.classes.push(m[1])
    return c
  })
}

export class FakeNode {
  readonly childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  textContent = ''
  constructor(readonly nodeName: string) {}

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }
  get isConnected(): boolean {
    return rootOf(this).nodeName === '#document'
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const raw of nodes) {
      const node = typeof raw === 'string' ? textNode(raw) : raw
      node.parentNode?.removeChild(node)
      node.parentNode = this
      this.childNodes.push(node)
    }
  }
  removeChild(node: FakeNode): void {
    const i = this.childNodes.indexOf(node)
    if (i >= 0) this.childNodes.splice(i, 1)
    node.parentNode = null
  }
  remove(): void {
    this.parentNode?.removeChild(this)
  }
  contains(other: unknown): boolean {
    let n = other as FakeNode | null
    while (n) {
      if (n === this) return true
      n = n.parentNode
    }
    return false
  }
  /** Depth-first, document order — the order querySelectorAll must answer in. */
  descendants(): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (n: FakeNode): void => {
      for (const child of n.childNodes) {
        if (child instanceof FakeElement) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  querySelectorAll<T = FakeElement>(selector: string): T[] {
    return this.descendants().filter((e) => e.matches(selector)) as unknown as T[]
  }
  querySelector<T = FakeElement>(selector: string): T | null {
    return (this.querySelectorAll<T>(selector)[0] ?? null) as T | null
  }
}

/** Walk to the top of the tree. Free functions, not methods, so neither has to alias `this`. */
function rootOf(node: FakeNode): FakeNode {
  let n = node
  while (n.parentNode) n = n.parentNode
  return n
}

function closestFrom(start: FakeElement, selector: string): FakeElement | null {
  let n: FakeElement | null = start
  while (n) {
    if (n.matches(selector)) return n
    n = n.parentElement
  }
  return null
}

function textNode(text: string): FakeNode {
  const n = new FakeNode('#text')
  n.textContent = text
  return n
}

export class FakeElement extends FakeNode {
  readonly tagName: string
  readonly attrs = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string> = {}
  private readonly classes = new Set<string>()
  private readonly listeners = new Map<string, { fn: FakeListener; once: boolean }[]>()
  hidden = false
  inert = false
  disabled = false
  tabIndex = 0
  title = ''
  type = ''
  value = ''
  placeholder = ''
  innerHTML = ''
  offsetParent: FakeElement | null = null
  /** Geometry a test hands the element; the defaults never scroll and never hit a lane. */
  scrollHeight = 0
  clientHeight = 0
  scrollWidth = 0
  clientWidth = 0
  rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  focusCount = 0

  constructor(tag: string) {
    super(tag.toUpperCase())
    this.tagName = tag.toUpperCase()
  }

  get className(): string {
    return [...this.classes].join(' ')
  }
  set className(v: string) {
    this.classes.clear()
    for (const c of v.split(/\s+/).filter(Boolean)) this.classes.add(c)
  }

  readonly classList = {
    add: (...c: string[]): void => {
      for (const x of c) this.classes.add(x)
    },
    remove: (...c: string[]): void => {
      for (const x of c) this.classes.delete(x)
    },
    contains: (c: string): boolean => this.classes.has(c),
    toggle: (c: string, force?: boolean): boolean => {
      const on = force ?? !this.classes.has(c)
      if (on) this.classes.add(c)
      else this.classes.delete(c)
      return on
    }
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v)
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null
  }
  getBoundingClientRect(): typeof this.rect {
    return this.rect
  }

  matches(selector: string): boolean {
    return parseSelector(selector).some(
      (c) =>
        !c.opaque &&
        (!c.tag || c.tag === this.tagName) &&
        c.classes.every((x) => this.classes.has(x)) &&
        c.not.every((x) => !this.classes.has(x))
    )
  }
  closest(selector: string): FakeElement | null {
    return closestFrom(this, selector)
  }

  focus(): void {
    this.focusCount++
    currentFakeDocument().activeElement = this
  }

  addEventListener(type: string, fn: FakeListener, opts?: boolean | { once?: boolean }): void {
    const once = typeof opts === 'object' && !!opts.once
    const list = this.listeners.get(type) ?? []
    list.push({ fn, once })
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, fn: FakeListener): void {
    const list = this.listeners.get(type)
    if (!list) return
    const i = list.findIndex((l) => l.fn === fn)
    if (i >= 0) list.splice(i, 1)
  }
  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length
  }

  /**
   * Every listener on this node runs, in REGISTRATION order, even after one of them has called
   * `stopPropagation()`. Not a shortcut — the browser's actual rule, and the reason a modal
   * stack needs a topmost check rather than a stopPropagation.
   */
  dispatchEvent(e: FakeEvent): boolean {
    if (e.target == null) e.target = this
    for (const l of [...(this.listeners.get(e.type) ?? [])]) {
      if (l.once) this.removeEventListener(e.type, l.fn)
      l.fn(e)
    }
    return !e.defaultPrevented
  }
}

export function makeEvent(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
  const e = {
    type,
    target: null as unknown,
    defaultPrevented: false,
    ...init,
    preventDefault(): void {
      e.defaultPrevented = true
    },
    stopPropagation(): void {
      /* deliberately inert — see FakeElement.dispatchEvent */
    }
  }
  return e
}

export class FakeDocument extends FakeElement {
  readonly documentElement: FakeElement
  readonly body: FakeElement
  activeElement: FakeElement | null = null
  constructor() {
    super('#document')
    Object.defineProperty(this, 'nodeName', { value: '#document' })
    this.documentElement = new FakeElement('html')
    this.body = new FakeElement('body')
    this.append(this.documentElement)
    this.documentElement.append(this.body)
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag)
  }
  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(tag)
  }
  createTextNode(text: string): FakeNode {
    return textNode(text)
  }
  getElementById(id: string): FakeElement | null {
    return this.descendants().find((e) => e.getAttribute('id') === id) ?? null
  }
}

let doc = new FakeDocument()

const GLOBALS = ['document', 'window', 'HTMLElement', 'getComputedStyle'] as const
let saved: Record<string, unknown> | null = null

/** A fresh document + window on the globals the renderer reads. Call in `beforeEach`. */
export function installFakeDom(): { document: FakeDocument; window: FakeElement } {
  const g = globalThis as unknown as Record<string, unknown>
  if (!saved) saved = Object.fromEntries(GLOBALS.map((k) => [k, g[k]]))
  doc = new FakeDocument()
  const win = new FakeElement('window')
  g.document = doc
  g.window = win
  g.HTMLElement = FakeElement
  g.getComputedStyle = (el: FakeElement): Record<string, string> => ({
    overflowY: el.style.overflowY ?? 'visible',
    overflowX: el.style.overflowX ?? 'visible'
  })
  return { document: doc, window: win }
}

/** Put the real (usually absent) globals back. Call in `afterEach` — vitest isolates test
 *  FILES, not the tests inside one, and a leaked `document` is the kind of cross-test coupling
 *  that turns a suite flaky in a way nobody can reproduce alone. */
export function uninstallFakeDom(): void {
  if (!saved) return
  const g = globalThis as unknown as Record<string, unknown>
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k]
    else g[k] = saved[k]
  }
  saved = null
}

export function currentFakeDocument(): FakeDocument {
  return doc
}
