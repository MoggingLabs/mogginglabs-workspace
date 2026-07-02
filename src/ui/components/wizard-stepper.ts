import { el } from './dom'
import { icon } from './icons'

export interface WizardStep {
  id: string
  label: string
}

export interface WizardStepperHandle {
  el: HTMLElement
  setCurrent(id: string): void
}

/**
 * The Start · Layout · Agents progress header: done steps show a check, the current
 * step fills brand-orange with a soft halo, future steps stay quiet.
 */
export function createWizardStepper(steps: WizardStep[], current: string): WizardStepperHandle {
  const nodes = steps.map((step, i) =>
    el('div', { class: 'wizard-step', dataset: { step: step.id } }, [
      el('span', { class: 'wizard-step-dot' }, [
        el('span', { class: 'wizard-step-num', text: String(i + 1) }),
        icon('check', 13)
      ]),
      el('span', { class: 'wizard-step-label', text: step.label })
    ])
  )

  const children: Node[] = []
  nodes.forEach((node, i) => {
    if (i > 0) children.push(el('span', { class: 'wizard-step-line' }))
    children.push(node)
  })
  const root = el('div', { class: 'wizard-stepper' }, children)

  function setCurrent(id: string): void {
    const at = steps.findIndex((s) => s.id === id)
    nodes.forEach((node, i) => {
      node.classList.toggle('is-done', i < at)
      node.classList.toggle('is-current', i === at)
      if (i === at) node.setAttribute('aria-current', 'step')
      else node.removeAttribute('aria-current')
    })
  }

  setCurrent(current)
  return { el: root, setCurrent }
}
