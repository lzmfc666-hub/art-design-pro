import { computed, reactive, watch, type Ref } from 'vue'

/** 为当前服务器快照分页，复用 ArtTable 的分页事件和参数。 */
export function useBusinessTable<T>(rows: Readonly<Ref<T[]>>, size = 20) {
  const pagination = reactive({ current: 1, size, total: 0 })
  watch(
    () => rows.value.length,
    (total) => {
      pagination.total = total
      pagination.current = Math.max(
        1,
        Math.min(pagination.current, Math.ceil(total / pagination.size))
      )
    },
    { immediate: true }
  )
  const tableData = computed(() =>
    rows.value.slice(
      (pagination.current - 1) * pagination.size,
      pagination.current * pagination.size
    )
  )
  const handleSizeChange = (size: number) => {
    pagination.size = size
    pagination.current = 1
  }
  const handleCurrentChange = (current: number) => {
    pagination.current = current
  }
  const resetPage = () => {
    pagination.current = 1
  }
  return { tableData, pagination, handleSizeChange, handleCurrentChange, resetPage }
}
