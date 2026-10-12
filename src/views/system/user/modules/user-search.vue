<template>
  <ArtSearchBar v-model="form" :items="items" @search="$emit('search')" @reset="$emit('reset')" />
</template>

<script setup lang="ts" generic="T extends { keyword?: string; role?: string; status?: string }">
  import { computed } from 'vue'
  import { roleLabels } from '@/hooks/business/useStudio'

  export interface UserSearch {
    keyword: string
    role: string
    status: string
  }
  const form = defineModel<T>({ required: true })
  defineEmits<{ search: []; reset: [] }>()
  const items = computed(() => [
    {
      key: 'keyword',
      label: '姓名 / 账号',
      type: 'input',
      props: { placeholder: '搜索姓名或登录账号', clearable: true }
    },
    {
      key: 'role',
      label: '角色',
      type: 'select',
      props: {
        clearable: true,
        options: Object.entries(roleLabels).map(([value, label]) => ({ value, label }))
      }
    },
    {
      key: 'status',
      label: '账号状态',
      type: 'select',
      props: {
        clearable: true,
        options: [
          { value: 'active', label: '启用' },
          { value: 'disabled', label: '停用' }
        ]
      }
    }
  ])
</script>
