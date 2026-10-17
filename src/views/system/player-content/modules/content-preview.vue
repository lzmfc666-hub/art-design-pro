<template>
  <div class="content-preview" data-testid="player-content-preview">
    <div class="preview-top">接单大厅</div>
    <div class="preview-screen">
      <div v-if="content.type === 'announcement'" class="preview-notice">
        <ArtSvgIcon icon="ri:notification-3-line" />
        <span>{{ content.text || '填写滚动文字后，这里将显示公告' }}</span>
      </div>
      <div v-else class="preview-banner">
        <img
          v-if="content.image?.url"
          :src="studioImageUrl(content.image.url)"
          loading="lazy"
          :alt="content.title || '轮播图片'"
        />
        <div v-else class="preview-placeholder">上传轮播图片后显示</div>
        <span>{{ content.title || '轮播标题' }}</span>
      </div>
      <article class="preview-detail">
        <span class="preview-label">点击后查看详情</span>
        <h3>{{ content.title || '填写标题' }}</h3>
        <img
          v-if="content.type === 'banner' && content.image?.url"
          :src="studioImageUrl(content.image.url, 'display')"
          loading="lazy"
          :alt="content.title"
        />
        <p>{{ content.body || '这里展示详情正文，支持换行和分段。' }}</p>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
  import type { PlayerContentFields } from '@/types/player-content'
  import { studioImageUrl } from '@/utils/studio-image'
  defineProps<{ content: PlayerContentFields }>()
</script>

<style scoped lang="scss">
  .content-preview {
    width: 100%;
    max-width: 390px;
    margin: 0 auto;
    overflow: hidden;
    border: 1px solid var(--el-border-color);
    border-radius: 18px;
  }
  .preview-top {
    padding: 16px;
    font-weight: 600;
    text-align: center;
    color: #252438;
    background: #fff;
  }
  .preview-screen {
    padding: 14px;
    background: #edf6ff;
  }
  .preview-notice {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 14px;
    color: #705039;
    background: linear-gradient(100deg, #fff6de, #fff0f7);
    border-radius: 12px;
  }
  .preview-notice span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .preview-notice :deep(svg) {
    flex-shrink: 0;
    color: #ddaa39;
  }
  .preview-banner {
    position: relative;
    overflow: hidden;
    border-radius: 12px;
  }
  .preview-banner > img {
    display: block;
    width: 100%;
    height: 146px;
    object-fit: cover;
  }
  .preview-banner > span {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    padding: 24px 12px 10px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    overflow-wrap: anywhere;
    background: linear-gradient(transparent, rgb(20 14 48 / 75%));
  }
  .preview-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 146px;
    color: #7d71a0;
    background: #e7ddff;
  }
  .preview-detail {
    padding: 18px;
    margin-top: 16px;
    color: #302945;
    background: #fff;
    border-radius: 12px;
  }
  .preview-label {
    font-size: 12px;
    color: #89749c;
  }
  .preview-detail h3 {
    margin: 10px 0 14px;
    font-size: 18px;
    overflow-wrap: anywhere;
  }
  .preview-detail img {
    display: block;
    width: 100%;
    max-height: 280px;
    margin: 0 0 14px;
    object-fit: contain;
  }
  .preview-detail p {
    margin: 0;
    font-size: 14px;
    line-height: 1.8;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
</style>
