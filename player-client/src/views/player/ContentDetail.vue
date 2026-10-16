<template>
  <section class="p-page p-content-detail">
    <div v-if="resource.loading.value && !publication" class="p-card p-content-state" role="status"
      >内容加载中…</div
    >
    <div v-else-if="!publication" class="p-card p-content-state">
      <PlayerIcon name="announcement" />
      <h2>{{ unavailable ? '这条内容已下架或到期' : '内容暂时无法查看' }}</h2>
      <p>{{
        unavailable
          ? '请返回大厅查看当前公告和板报。'
          : resource.error.value || '请连接网络后重试。'
      }}</p>
      <button v-if="!unavailable" class="p-btn p-secondary" @click="resource.refresh()"
        >重新加载</button
      >
      <RouterLink to="/player/lobby" class="p-btn">返回接单大厅</RouterLink>
    </div>
    <article v-else class="p-card p-content-article">
      <span class="p-content-kind">{{
        publication.type === 'banner' ? '工作室板报' : '工作室公告'
      }}</span>
      <h2>{{ publication.title }}</h2>
      <time :datetime="publication.publishedAt">发布于 {{ publishedTime }}</time>
      <img
        v-if="imageUrl && failedImage !== imageUrl"
        :src="imageUrl"
        :alt="publication.title"
        class="p-content-image"
        @error="failedImage = imageUrl"
      />
      <p v-else-if="imageUrl" class="p-content-image-error">图片暂时无法加载，正文可继续查看。</p>
      <p
        v-if="publication.text && publication.text !== publication.title"
        class="p-content-summary"
        >{{ publication.text }}</p
      >
      <div class="p-content-body"
        ><p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p></div
      >
      <RouterLink to="/player/lobby" class="p-btn p-secondary p-content-back"
        >返回接单大厅</RouterLink
      >
    </article>
  </section>
</template>
<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { useRoute } from 'vue-router'
  import { contentApi, contentImageUrl } from '@/api/content'
  import { usePlayerContent } from './usePlayerContent'
  import PlayerIcon from './PlayerIcon.vue'
  import './content.css'
  const route = useRoute(),
    failedImage = ref('')
  const resource = usePlayerContent(async (signal) => {
    const [feed, detail] = await Promise.all([
      contentApi.feed(signal),
      contentApi.detail(String(route.params.id), signal)
    ])
    return {
      serverTime: feed.serverTime,
      announcements: detail.type === 'announcement' ? [detail] : [],
      banners: detail.type === 'banner' ? [detail] : []
    }
  })
  watch(resource.loadedRevision, () => {
    failedImage.value = ''
  })
  const publication = computed(() =>
    [...resource.announcements.value, ...resource.banners.value].find(
      (item) => item.id === String(route.params.id)
    )
  )
  const unavailable = computed(
    () =>
      resource.errorStatus.value === 404 ||
      (!resource.loading.value && !resource.error.value && !publication.value)
  )
  const imageUrl = computed(() => contentImageUrl(publication.value))
  const paragraphs = computed(() =>
    (publication.value?.body || '').split(/\r?\n/).filter((part) => part.trim())
  )
  const publishedTime = computed(() =>
    publication.value
      ? new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(new Date(publication.value.publishedAt))
      : ''
  )
  watch(
    () => route.params.id,
    () => {
      failedImage.value = ''
      void resource.refresh()
    }
  )
</script>
