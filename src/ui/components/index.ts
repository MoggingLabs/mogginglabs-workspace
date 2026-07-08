/**
 * Component library — vanilla factory functions, no framework. These are the
 * presentational primitives shared across screens; feature-coupled builders
 * (rail items, pane headers, the palette) live inside their feature slices and
 * compose these. Nothing here touches the hot terminal path.
 */
export { el, clear, mount, type ElProps, type ElChild } from './dom'
export { icon, ICON_NAMES, type IconName } from './icons'
export { Button, IconButton, type ButtonOpts, type IconButtonOpts } from './button'
export { Pill, CountBadge, type PillOpts, type PillTone } from './pill'
export {
  TextInput,
  createPathInput,
  type TextInputOpts,
  type PathInputHandle,
  type PathInputOpts,
  type PathStatus,
  type PathStatusKind
} from './input'
export { createStepper, type StepperHandle, type StepperOpts } from './stepper'
export { createCheckbox, type CheckboxHandle, type CheckboxOpts } from './checkbox'
export { createToggleRow, type ToggleRowHandle, type ToggleRowOpts } from './toggle-row'
export { createMeter, type MeterHandle } from './meter'
export {
  MiniGridPreview,
  createLayoutGridPicker,
  type GridPreviewOpts,
  type LayoutSpec,
  type LayoutGridPickerHandle
} from './grid-preview'
export { createModal, type ModalHandle, type ModalOpts } from './modal'
export { confirmDialog, resetConfirmSkipsForSmoke, type ConfirmOpts } from './confirm'
export { Spinner, loadingRow } from './spinner'
export { showToast, type ToastOpts, type ToastTone } from './toast'
export { EmptyState, type EmptyStateOpts } from './empty-state'
export { createFolderBrowser, type FolderBrowserHandle, type FolderBrowserOpts } from './folder-browser'
export { createSegmented, type SegmentedHandle, type SegmentedOption } from './segmented'
// Layout primitives (8.5/01) — THE structural vocabulary: every grouped surface
// is a Card, headed by a SectionHeader, filled with FieldGroups, split by TwoColumn.
export { Card, type CardOpts } from './card'
export { createCollapsibleCard, type CollapsibleCardHandle, type CollapsibleCardOpts } from './collapsible-card'
export { SectionHeader, type SectionHeaderOpts } from './section-header'
export { FieldGroup, type FieldGroupOpts } from './field-group'
export { TwoColumn, type TwoColumnOpts } from './two-column'
