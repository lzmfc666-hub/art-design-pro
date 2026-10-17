import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useStudio } from '@/hooks/business/useStudio'
import { createStudioMutationIntent } from '@/api/studio-mutation'

export function useFinanceActions() {
  const { mutate, refresh, loading, error } = useStudio()
  const saving = ref(false)
  const lastFailure = ref<unknown>(null)
  const intent = createStudioMutationIntent()
  async function submit(path: string, body: Record<string, unknown>, message: string) {
    if (saving.value) return false
    if (loading.value || error.value) {
      ElMessage.warning(
        loading.value ? '数据正在更新，请稍后操作' : '请先刷新并核实当前记录，再进行财务操作'
      )
      return false
    }
    saving.value = true
    lastFailure.value = null
    try {
      await mutate(path, intent.prepare(path, body))
      intent.complete()
      ElMessage.success(message)
      return true
    } catch (cause) {
      lastFailure.value = cause
      intent.fail(cause)
      const status = (cause as { status?: number } | null)?.status
      if (!status || status >= 500) {
        ElMessage.error('操作结果尚未确认。再次提交原内容会安全重试；请勿另行登记相同业务')
      } else ElMessage.error(cause instanceof Error ? cause.message : '操作失败')
      return false
    } finally {
      saving.value = false
    }
  }
  async function reload() {
    try {
      await refresh()
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '刷新失败')
    }
  }
  return { saving, submit, reload, lastFailure }
}
