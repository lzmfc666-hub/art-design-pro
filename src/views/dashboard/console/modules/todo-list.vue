<template>
  <div class="art-card h-128 p-5 mb-5">
    <div class="art-card-header"
      ><div class="title"><h4>待办事项</h4><p>按当前权限汇总需要处理的事项</p></div
      ><ElTag v-if="count" type="warning">{{ count }}</ElTag></div
    >
    <ElEmpty v-if="!todos.length" description="当前暂无待办，业务进度已同步" :image-size="80" />
    <ElScrollbar v-else height="360px">
      <button
        v-for="item in todos"
        :key="item.key"
        class="todo-item"
        @click="$router.push({ path: item.path, query: item.query })"
      >
        <span class="todo-icon"><ArtSvgIcon :icon="item.icon" /></span
        ><span class="min-w-0 flex-1 text-left"
          ><span class="block text-sm font-medium">{{ item.title }}</span
          ><span class="text-xs text-g-500 mt-1 block">{{ item.description }}</span></span
        ><ElTag type="warning" size="small">{{ item.count }}</ElTag>
      </button>
    </ElScrollbar>
  </div>
</template>
<script setup lang="ts">
  import { useBusinessTodo } from '@/hooks/business/useBusinessTodo'
  const { todos, count } = useBusinessTodo()
</script>
<style lang="scss" scoped>
  .todo-item {
    display: flex;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 16px 0;
    color: var(--art-gray-800);
    cursor: pointer;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--art-card-border);
  }

  .todo-item:hover {
    color: var(--el-color-primary);
  }

  .todo-icon {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-radius: 8px;
  }
</style>
