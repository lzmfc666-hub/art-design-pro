<template>
  <ArtSearchBar v-model="form" :items="items" @search="$emit('search')" @reset="$emit('reset')" />
</template>

<script
  setup
  lang="ts"
  generic="T extends { name?: string; username?: string; role?: string; status?: string }"
>
  import { computed } from 'vue'
  import { roleLabels } from '@/hooks/business/useStudio'

  export interface UserSearch {
    name: string
    username: string
    role: string
    status: string
  }
  const form = defineModel<T>({ required: true })
  defineEmits<{ search: []; reset: [] }>()
  const exampleFields = computed(() => 'userName' in form.value && !('name' in form.value))
  const items = computed(() => [
    {
      key: exampleFields.value ? 'userName' : 'name',
      label: exampleFields.value ? '用户名称' : '人员名称',
      type: 'input',
      props: { placeholder: '按人员名称搜索', clearable: true }
    },
    ...(exampleFields.value
      ? [
          {
            key: 'userPhone',
            label: '联系电话',
            type: 'input',
            props: { clearable: true, placeholder: '按联系电话搜索' }
          },
          {
            key: 'userEmail',
            label: '邮箱',
            type: 'input',
            props: { clearable: true, placeholder: '按邮箱搜索' }
          }
        ]
      : [
          {
            key: 'username',
            label: '登录账号',
            type: 'input',
            props: { placeholder: '按登录账号搜索', clearable: true }
          }
        ]),
    ...(!exampleFields.value
      ? [
          {
            key: 'role',
            label: '角色',
            type: 'select',
            props: {
              clearable: true,
              options: Object.entries(roleLabels).map(([value, label]) => ({ value, label }))
            }
          }
        ]
      : []),
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
