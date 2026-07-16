// The layout MECHANISM: a reusable resizable split-tree of terminal slots. Since Phase-1/05
// the `workspace` feature composes one `GridLayout` per workspace (it owns pane placement),
// and the `terminal` feature fills slots via the ui-core slots port — so `layout` no longer
// registers a UiFeature of its own; it just exports the components.
export {
  GridLayout,
  paneLimit,
  parseTree,
  leafIds,
  type ExpandMode,
  type LayoutTreeNode,
  type SplitDir
} from './grid-layout'
export { TEMPLATES, TEMPLATE_COUNTS, type GridSpec } from './templates'
export { serializeTree, MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX } from './layout-tree'
export { paneCapacity, screenPaneCapacity, PANE_SEAM_PX, type PaneCapacity } from './pane-capacity'
export {
  expandToWholeRegions,
  mergeRegions,
  sortRegions,
  specForCount,
  treeForRegions,
  uniformSpec,
  unmergeRegion,
  validateSpec,
  type GridRegion,
  type GridSpecModel
} from './grid-regions'
