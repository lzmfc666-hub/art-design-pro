import { h, type VNode } from 'vue'

export interface BusinessConfirmFact {
  label: string
  value: string | number | null | undefined
}

/** Readonly context for an existing confirmation; callers keep their original action and buttons. */
export function businessConfirmMessage(
  message: string,
  facts: BusinessConfirmFact[],
  note?: string
): VNode {
  return h('div', { class: 'business-confirm-content' }, [
    h('p', { class: 'business-confirm-impact' }, message),
    h(
      'dl',
      { class: 'business-confirm-facts' },
      facts.map((fact) => h('div', [h('dt', fact.label), h('dd', String(fact.value ?? '—'))]))
    ),
    note ? h('p', { class: 'business-confirm-note' }, note) : null
  ])
}
