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
export { createMeter, type MeterHandle } from './meter'
export {
  MiniGridPreview,
  createLayoutGridPicker,
  type GridPreviewOpts,
  type LayoutSpec,
  type LayoutGridPickerHandle
} from './grid-preview'
export { createWizardStepper, type WizardStep, type WizardStepperHandle } from './wizard-stepper'
export { createModal, type ModalHandle, type ModalOpts } from './modal'
export { confirmDialog, resetConfirmSkipsForSmoke, type ConfirmOpts } from './confirm'
export { Spinner, loadingRow } from './spinner'
export { showToast, type ToastOpts, type ToastTone } from './toast'
export { EmptyState, type EmptyStateOpts } from './empty-state'
export { createSegmented, type SegmentedHandle, type SegmentedOption } from './segmented'
