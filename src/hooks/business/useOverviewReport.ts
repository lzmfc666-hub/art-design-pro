import { computed, ref } from 'vue'
import { studioRequest } from '@/api/studio'
import { useStudio } from './useStudio'
import type { OverviewReport } from '@/types/overview'

export function dateInShanghai(value = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value)
}
export function shiftDate(date: string, offset: number) {
  const value = new Date(date + 'T00:00:00Z')
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

export function useOverviewReport() {
  const { clearSession } = useStudio()
  const today = dateInShanghai()
  const range = ref<[string, string]>([shiftDate(today, -6), today])
  const report = ref<OverviewReport | null>(null)
  const loading = ref(false)
  const error = ref('')
  let requestVersion = 0
  let activeRequest: AbortController | null = null
  const ready = computed(
    () =>
      !loading.value &&
      !error.value &&
      report.value?.range.start === range.value[0] &&
      report.value?.range.end === range.value[1]
  )
  async function refresh() {
    activeRequest?.abort()
    const version = ++requestVersion
    const [start, end] = range.value
    if (!start || !end) return
    loading.value = true
    error.value = ''
    const controller = new AbortController()
    activeRequest = controller
    try {
      const response = await studioRequest<OverviewReport>(
        `overview?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        undefined,
        'GET',
        controller.signal
      )
      if (version === requestVersion) report.value = response
    } catch (cause) {
      if (version !== requestVersion || controller.signal.aborted) return
      if ((cause as { status?: number }).status === 401) clearSession()
      error.value = cause instanceof Error ? cause.message : '概览加载失败，请重试'
      report.value = null
    } finally {
      if (version === requestVersion) loading.value = false
    }
  }
  function clear() {
    activeRequest?.abort()
    activeRequest = null
    requestVersion++
    report.value = null
    loading.value = false
    error.value = ''
  }
  return { range, report, loading, error, ready, refresh, clear }
}
