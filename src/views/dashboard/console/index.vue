<template>
  <div v-loading="loading && !data">
    <div class="flex items-center justify-between flex-wrap gap-3 mb-5">
      <div
        ><h2 class="text-xl font-semibold">{{ user?.name }}，欢迎回来</h2
        ><p class="mt-1 text-sm text-g-500">工作室订单、待办与经营情况</p></div
      >
      <ElSpace wrap
        ><ElDatePicker
          v-model="month"
          type="month"
          value-format="YYYY-MM"
          :clearable="false"
          style="width: 150px"
          @change="changeMonth"
        /><ElButton :loading="loading" @click="reload"
          ><ArtSvgIcon icon="ri:refresh-line" class="mr-1" />刷新</ElButton
        ><ElButton
          v-if="can('orders.create')"
          type="primary"
          @click="$router.push('/orders/create')"
          >创建订单</ElButton
        ></ElSpace
      >
    </div>
    <ElResult
      v-if="user?.role === 'player'"
      icon="info"
      title="打手端将独立上线"
      sub-title="请使用分配给你的打手端入口。"
    />
    <template v-else>
      <CardList />
      <ElRow :gutter="20"
        ><ElCol :xs="24" :lg="10"><ActiveUser /></ElCol
        ><ElCol :xs="24" :lg="14"><SalesOverview /></ElCol
      ></ElRow>
      <ElRow :gutter="20"
        ><ElCol :xs="24" :lg="12"><NewUser /></ElCol
        ><ElCol :xs="24" :md="12" :lg="6"><Dynamic /></ElCol
        ><ElCol :xs="24" :md="12" :lg="6"><TodoList /></ElCol
      ></ElRow>
      <AboutProject />
    </template>
  </div>
</template>
<script setup lang="ts">
  import { useStudio } from '@/hooks/business/useStudio'
  import CardList from './modules/card-list.vue'
  import ActiveUser from './modules/active-user.vue'
  import SalesOverview from './modules/sales-overview.vue'
  import NewUser from './modules/new-user.vue'
  import Dynamic from './modules/dynamic-stats.vue'
  import TodoList from './modules/todo-list.vue'
  import AboutProject from './modules/about-project.vue'
  defineOptions({ name: 'Console' })
  const { data, user, can, loading, refresh, selectedMonth } = useStudio()
  const month = computed({
    get: () => selectedMonth.value,
    set: (value: string) => {
      if (value) selectedMonth.value = value
    }
  })
  const reload = () => refresh().catch(() => {})
  const changeMonth = (value: string | null) => {
    if (value) void refresh(value).catch(() => {})
  }
  onMounted(reload)
</script>
