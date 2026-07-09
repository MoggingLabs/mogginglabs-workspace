/**
 * Tiny imperative-DOM helper for the component factories. No framework, no vdom,
 * no hidden re-render — just `document.createElement` with terse prop handling:
 *
 *   el('button', { class: 'btn', onClick }, [icon('plus'), 'New workspace'])
 */

export interface ElProps {
  class?: string
  text?: string
  title?: string
  type?: string
  value?: string
  placeholder?: string
  disabled?: boolean
  hidden?: boolean
  role?: string
  tabIndex?: number
  ariaLabel?: string
  dataset?: Record<string, string>
  attrs?: Record<string, string>
  style?: Partial<CSSStyleDeclaration>
  onClick?: (e: MouseEvent) => void
  onMousedown?: (e: MouseEvent) => void
  onDblclick?: (e: MouseEvent) => void
  onInput?: (e: Event) => void
  onChange?: (e: Event) => void
  onKeydown?: (e: KeyboardEvent) => void
  onBlur?: (e: FocusEvent) => void
}

export type ElChild = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: ElChild[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.class) node.className = props.class
  if (props.text != null) node.textContent = props.text
  if (props.title != null) node.title = props.title
  if (props.role) node.setAttribute('role', props.role)
  if (props.tabIndex != null) node.tabIndex = props.tabIndex
  if (props.ariaLabel != null) node.setAttribute('aria-label', props.ariaLabel)
  if (props.hidden) node.hidden = true
  if (props.type != null && 'type' in node) (node as { type?: string }).type = props.type
  if (props.value != null && 'value' in node) (node as { value?: string }).value = props.value
  if (props.placeholder != null && 'placeholder' in node)
    (node as { placeholder?: string }).placeholder = props.placeholder
  if (props.disabled != null && 'disabled' in node)
    (node as { disabled?: boolean }).disabled = props.disabled
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v)
  if (props.style) Object.assign(node.style, props.style)
  if (props.onClick) node.addEventListener('click', props.onClick as EventListener)
  if (props.onMousedown) node.addEventListener('mousedown', props.onMousedown as EventListener)
  if (props.onDblclick) node.addEventListener('dblclick', props.onDblclick as EventListener)
  if (props.onInput) node.addEventListener('input', props.onInput)
  if (props.onChange) node.addEventListener('change', props.onChange)
  if (props.onKeydown) node.addEventListener('keydown', props.onKeydown as EventListener)
  if (props.onBlur) node.addEventListener('blur', props.onBlur as EventListener)
  for (const child of children) {
    if (child == null || child === false) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

/** Remove every child of a node. */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}
