<script setup lang="ts">
  import { ElInputNumber } from 'element-plus'

  withDefaults(
    defineProps<{ modelValue: number | null; placeholder?: string; disabled?: boolean }>(),
    {
      placeholder: '待配置',
      disabled: false
    }
  )
  const emit = defineEmits<{ 'update:modelValue': [value: number | null] }>()
  function update(value: number | undefined) {
    emit('update:modelValue', value == null ? null : Math.round(value * 100))
  }
</script>

<template>
  <ElInputNumber
    :model-value="modelValue == null ? undefined : modelValue / 100"
    :min="0"
    :precision="2"
    :step="0.01"
    :disabled="disabled"
    :placeholder="placeholder"
    controls-position="right"
    style="width: 100%"
    @update:model-value="update"
  />
</template>
