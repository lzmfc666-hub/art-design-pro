<template>
  <article class="overview-metric-card" :class="`metric-${color}`" :aria-busy="loading">
    <header class="metric-heading">
      <div class="metric-label">
        <span class="metric-icon"><ArtSvgIcon :icon="icon" /></span>
        <div
          ><h3>{{ title }}</h3
          ><p v-if="subtitle">{{ subtitle }}</p></div
        >
      </div>
      <ElButton
        v-if="sensitive && hasSensitiveData && !loading"
        class="privacy-toggle"
        text
        circle
        :aria-label="masked ? `显示${title}` : `隐藏${title}`"
        :title="masked ? '点击显示金额' : '点击隐藏金额'"
        @click="revealed = !revealed"
        ><ArtSvgIcon :icon="masked ? 'ri:eye-off-line' : 'ri:eye-line'"
      /></ElButton>
    </header>

    <div class="metric-main">
      <span v-if="loading" class="metric-value-skeleton" />
      <strong v-else class="metric-value" :class="{ 'is-masked': masked && value !== null }">{{
        displayValue
      }}</strong>
      <div v-if="!loading" class="metric-comparison">
        <template v-if="masked"
          ><ArtSvgIcon icon="ri:lock-2-line" /><span>金额已隐藏</span></template
        >
        <template v-else-if="hasTrend">
          <span :class="trend === 0 ? 'trend-flat' : trendPositive ? 'trend-up' : 'trend-down'">
            <ArtSvgIcon
              :icon="
                trend === 0
                  ? 'ri:subtract-line'
                  : trendPositive
                    ? 'ri:arrow-up-line'
                    : 'ri:arrow-down-line'
              "
            />{{ trendText }} </span
          ><span>较上一同长时段</span>
        </template>
        <span v-else>暂无可比数据</span>
      </div>
    </div>

    <div class="metric-chart">
      <div v-if="loading" class="chart-skeleton" />
      <div v-else-if="masked" class="chart-placeholder"
        ><ArtSvgIcon icon="ri:eye-off-line" />点击眼睛查看已有权限的金额</div
      >
      <svg
        v-else-if="chartPoints.length"
        viewBox="0 0 240 76"
        preserveAspectRatio="none"
        role="img"
        :aria-label="`${title}在所选时段的${chart === 'bar' ? '每日分布' : '变化趋势'}`"
      >
        <defs>
          <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--metric-accent)" stop-opacity="0.19" />
            <stop offset="100%" stop-color="var(--metric-accent)" stop-opacity="0.01" />
          </linearGradient>
        </defs>
        <path d="M 0 66 H 240" class="chart-baseline" />
        <template v-if="chart === 'bar'">
          <rect
            v-for="(bar, index) in bars"
            :key="index"
            :x="bar.x"
            :y="bar.y"
            :width="bar.width"
            :height="bar.height"
            rx="2.5"
            fill="var(--metric-accent)"
            :opacity="index === bars.length - 1 ? 0.95 : 0.55"
          />
        </template>
        <template v-else>
          <path :d="areaPath" :fill="`url(#${gradientId})`" />
          <path
            :d="linePath"
            fill="none"
            stroke="var(--metric-accent)"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <circle
            v-if="lastPoint"
            :cx="lastPoint.x"
            :cy="lastPoint.y"
            r="3"
            fill="var(--metric-accent)"
          />
        </template>
      </svg>
      <div v-else class="chart-placeholder"
        ><ArtSvgIcon icon="ri:line-chart-line" />{{
          value === null ? '暂无完整统计数据' : '该指标暂无每日趋势'
        }}</div
      >
    </div>

    <div v-if="details.length" class="metric-details">
      <div v-for="(item, index) in details" :key="index"
        ><span>{{ item.label }}</span
        ><strong>{{ loading ? '—' : masked ? '•••' : item.value }}</strong></div
      >
    </div>
    <footer v-if="href || $slots.default" class="metric-footer">
      <slot />
      <ElButton v-if="href" link :disabled="loading" class="details-button" @click="showDetails"
        ><span class="details-content">查看详情<ArtSvgIcon icon="ri:arrow-right-line" /></span
      ></ElButton>
    </footer>
  </article>
</template>

<script setup lang="ts">
  import { computed, getCurrentInstance, ref, useId, watch } from 'vue'
  import { useRouter } from 'vue-router'

  const props = withDefaults(
    defineProps<{
      title: string
      subtitle?: string
      value: string | number | null
      icon: string
      color?: 'blue' | 'purple' | 'orange' | 'green'
      trend?: number | null
      points?: number[]
      chart?: 'line' | 'bar'
      details?: { label: string; value: string | number }[]
      sensitive?: boolean
      loading?: boolean
      href?: string
    }>(),
    {
      subtitle: '',
      color: 'blue',
      trend: null,
      points: () => [],
      chart: 'line',
      details: () => [],
      sensitive: false,
      loading: false
    }
  )
  const emit = defineEmits<{ details: [] }>()
  const instance = getCurrentInstance()
  const router = useRouter()
  const revealed = ref(!props.sensitive)
  const gradientId = `overview-gradient-${useId().replace(/:/g, '')}`
  const masked = computed(() => props.sensitive && !revealed.value)
  const hasSensitiveData = computed(
    () => props.value !== null || props.details.length > 0 || props.points.length > 0
  )
  const displayValue = computed(() =>
    props.value === null ? '—' : masked.value ? '••••••' : props.value
  )
  const hasTrend = computed(() => typeof props.trend === 'number' && Number.isFinite(props.trend))
  const trendPositive = computed(() => props.trend != null && props.trend > 0)
  const trendText = computed(() =>
    hasTrend.value
      ? `${props.trend! > 0 ? '+' : ''}${props.trend!.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
      : ''
  )
  const chartPoints = computed(() => {
    if (masked.value) return []
    const points = props.points.filter((point) => Number.isFinite(point))
    // 保留真实数据首尾；长区间只采样绘图，避免多张卡片生成大量 SVG 元素。
    if (points.length <= 40) return points
    return Array.from(
      { length: 40 },
      (_, index) => points[Math.round((index * (points.length - 1)) / 39)]
    )
  })
  const positions = computed(() => {
    const points = chartPoints.value
    if (!points.length) return []
    const min = Math.min(...points)
    const max = Math.max(...points)
    return points.map((value, index) => ({
      x: points.length === 1 ? 120 : 4 + (index * 232) / (points.length - 1),
      y: min === max ? 37 : 8 + ((max - value) * 52) / (max - min)
    }))
  })
  const linePath = computed(() =>
    positions.value
      .map(
        (point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
      )
      .join(' ')
  )
  const areaPath = computed(() => {
    const points = positions.value
    return points.length
      ? `${linePath.value} L ${points[points.length - 1].x} 66 L ${points[0].x} 66 Z`
      : ''
  })
  const lastPoint = computed(() => positions.value[positions.value.length - 1])
  const bars = computed(() => {
    const points = chartPoints.value
    if (!points.length) return []
    const min = Math.min(0, ...points)
    const max = Math.max(0, ...points)
    const range = max - min || 1
    const baseline = 8 + (max * 58) / range
    const step = 240 / points.length
    return points.map((value, index) => {
      const y = 8 + ((max - value) * 58) / range
      return {
        x: index * step + step * 0.18,
        y: Math.min(y, baseline),
        width: step * 0.64,
        height: Math.abs(baseline - y)
      }
    })
  })
  watch(
    () => props.sensitive,
    (value) => {
      revealed.value = !value
    }
  )
  // 新一轮请求 / 权限切换时清除本地可见状态，不沿用上一账号的金额展示。
  watch(
    () => props.loading,
    (value) => {
      if (value && props.sensitive) revealed.value = false
    }
  )
  function showDetails() {
    emit('details')
    if (props.href && !instance?.vnode.props?.onDetails) void router.push(props.href)
  }
</script>

<style scoped lang="scss">
  .overview-metric-card {
    --metric-accent: #3478f6;
    --metric-tint: rgb(52 120 246 / 9%);

    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 20px 20px 0;
    background: var(--el-bg-color);
    border: 1px solid rgb(80 131 211 / 14%);
    border-radius: 16px;
    box-shadow: 0 4px 18px rgb(33 67 121 / 3.5%);
    transition:
      border-color 180ms ease,
      box-shadow 180ms ease;
  }

  .overview-metric-card:hover {
    border-color: rgb(80 131 211 / 30%);
    box-shadow: 0 8px 24px rgb(33 67 121 / 7%);
  }

  .metric-purple {
    --metric-accent: #8b5cf6;
    --metric-tint: rgb(139 92 246 / 9%);
  }

  .metric-orange {
    --metric-accent: #f59e0b;
    --metric-tint: rgb(245 158 11 / 10%);
  }

  .metric-green {
    --metric-accent: #10b981;
    --metric-tint: rgb(16 185 129 / 9%);
  }

  .metric-heading {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    justify-content: space-between;
  }

  .metric-label {
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;

    h3 {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.5;
      color: var(--el-text-color-primary);
    }

    p {
      margin-top: 3px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--el-text-color-secondary);
    }
  }

  .metric-icon {
    display: grid;
    flex: 0 0 38px;
    place-items: center;
    height: 38px;
    font-size: 20px;
    color: var(--metric-accent);
    background: var(--metric-tint);
    border-radius: 12px;
  }

  .privacy-toggle {
    margin-top: 2px;
    color: var(--el-text-color-secondary);
  }

  .metric-main {
    margin-top: 12px;
  }

  .metric-value {
    display: block;
    min-height: 36px;
    font-size: 29px;
    font-weight: 650;
    line-height: 1.3;
    color: var(--el-text-color-primary);
    letter-spacing: -0.7px;
    overflow-wrap: anywhere;
  }

  .metric-value.is-masked {
    letter-spacing: 4px;
  }

  .metric-comparison {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 7px;
    align-items: center;
    min-height: 18px;
    margin-top: 4px;
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }

  .trend-up,
  .trend-down,
  .trend-flat {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    font-weight: 500;
  }

  .trend-up {
    color: var(--el-color-success);
  }

  .trend-down {
    color: var(--el-color-danger);
  }

  .trend-flat {
    color: var(--el-text-color-secondary);
  }

  .metric-chart {
    display: flex;
    align-items: center;
    height: 56px;
    margin: 8px -4px 2px;

    > svg {
      display: block;
      width: 100%;
      height: 52px;
      overflow: visible;
    }
  }

  .chart-baseline {
    fill: none;
    stroke: var(--el-border-color-light);
    stroke-dasharray: 4 5;
    stroke-width: 0.7;
  }

  .chart-placeholder {
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 38px;
    padding: 8px;
    font-size: 11px;
    line-height: 1.6;
    color: var(--el-text-color-placeholder);
    text-align: center;
    background: var(--el-fill-color-extra-light);
    border-radius: 9px;

    :deep(.art-svg-icon) {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      font-size: 16px;
    }
  }

  .metric-details {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 9px;
    padding: 8px 0 10px;
    border-top: 1px solid var(--el-border-color-extra-light);

    div {
      min-width: 0;
    }

    span {
      display: block;
      font-size: 11px;
      line-height: 1.5;
      color: var(--el-text-color-secondary);
    }

    strong {
      display: block;
      margin-top: 5px;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.5;
      color: var(--el-text-color-primary);
      overflow-wrap: anywhere;
    }
  }

  .metric-footer {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: flex-end;
    min-height: 34px;
    margin-top: auto;
    border-top: 1px solid var(--el-border-color-extra-light);
  }

  .details-button {
    gap: 4px;
    width: 100%;
    font-size: 12px;
    color: var(--metric-accent);

    :deep(> span) {
      width: 100%;
    }
  }

  .details-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }

  .metric-value-skeleton,
  .chart-skeleton {
    display: block;
    background: var(--el-fill-color);
    border-radius: 7px;
  }

  .metric-value-skeleton {
    width: 70%;
    height: 36px;
    margin-bottom: 22px;
  }

  .chart-skeleton {
    width: 100%;
    height: 34px;
  }

  :global(.dark .overview-metric-card) {
    border-color: rgb(117 159 225 / 16%);
    box-shadow: 0 4px 18px rgb(0 0 0 / 10%);
  }

  @media (width <= 767px) {
    .overview-metric-card {
      padding: 18px 18px 0;
    }

    .metric-value {
      font-size: 28px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .overview-metric-card {
      transition: none;
    }
  }
</style>
