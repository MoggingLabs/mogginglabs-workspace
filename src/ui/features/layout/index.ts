// The layout MECHANISM: a reusable resizable grid of terminal slots. Since Phase-1/05 the
// `workspace` feature composes one `GridLayout` per workspace (it owns pane placement), and
// the `terminal` feature fills slots via the ui-core slots port — so `layout` no longer
// registers a UiFeature of its own; it just exports the components.
export { GridLayout } from './grid-layout'
export { TEMPLATE_COUNTS } from './templates'
