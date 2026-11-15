<!-- 服务器管理页面 -->
<template>
  <div class="page-content mb-5">
    <ElCard v-if="canReadMetrics" shadow="never" class="mb-5 business-detail-page">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <strong>实际运行指标</strong>
          <ElButton type="primary" plain :loading="metricsLoading" @click="loadMetrics"
            >刷新实际数据</ElButton
          >
        </div>
      </template>
      <ElAlert
        v-if="metricsError"
        :title="metricsError"
        type="error"
        :closable="false"
        class="mb-4"
      />
      <template v-if="metrics">
        <p class="text-xs text-g-500 mb-4"
          >采集时间 {{ formatTime(metrics.generatedAt) }}；请求统计自当前服务进程启动累计，P95
          取最近 {{ metrics.http.sampleCount }} 个实际请求。</p
        >
        <BusinessDetailHeader
          title="当前服务运行情况"
          description="读取当前 API 服务进程的真实统计，用于核对请求、存储、推送队列和计划备份。"
          icon="ri:server-line"
          badge="实际运行数据"
        />
        <BusinessDetailSummary
          :items="[
            { label: '累计实际请求', value: metrics.http.requests },
            {
              label: '请求 P95',
              value: metrics.http.p95Ms.toFixed(1) + ' ms',
              hint: '最近 ' + metrics.http.sampleCount + ' 个请求'
            },
            { label: '服务进程驻留内存', value: bytes(metrics.process.memory.rss) },
            {
              label: '所在磁盘可用空间',
              value: bytes(metrics.storage.freeBytes),
              tone: metrics.storage.warnings?.length ? 'warning' : undefined
            }
          ]"
        />
        <BusinessDetailSection
          title="运行与存储摘要"
          description="请求统计自当前服务进程启动累计；暂不可用的指标不按 0 展示。"
        >
          <ElDescriptions :column="2" border>
            <ElDescriptionsItem label="请求总数">{{ metrics.http.requests }}</ElDescriptionsItem>
            <ElDescriptionsItem label="服务端错误"
              >{{ metrics.http.errors }} ·
              {{ (metrics.http.serverErrorRate * 100).toFixed(2) }}%</ElDescriptionsItem
            >
            <ElDescriptionsItem label="请求 P95"
              >{{ metrics.http.p95Ms.toFixed(1) }} ms</ElDescriptionsItem
            >
            <ElDescriptionsItem label="服务进程驻留内存">{{
              bytes(metrics.process.memory.rss)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="数据库文件">{{
              bytes(metrics.storage.databaseBytes)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="数据库 WAL">{{
              bytes(metrics.storage.walBytes)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="所在磁盘可用空间">{{
              bytes(metrics.storage.freeBytes)
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="日志正文容量">{{
              bytes(metrics.logs.reduce((sum, row) => sum + row.bytes, 0))
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="推送等待 / 发送中"
              >{{ metrics.push.pending || 0 }} /
              {{ metrics.push.processing || 0 }}</ElDescriptionsItem
            >
            <ElDescriptionsItem label="最久待发等待"
              >{{ Math.round((metrics.push.oldestDueWaitMs || 0) / 1000) }} 秒</ElDescriptionsItem
            >
            <ElDescriptionsItem label="计划备份"
              >{{ metrics.backups.enabled ? '已配置' : '未配置' }} · 成功
              {{ metrics.backups.completed }} / 失败
              {{ metrics.backups.failed }}</ElDescriptionsItem
            >
            <ElDescriptionsItem label="最近成功备份">{{
              formatTime(metrics.backups.lastCompletedAt || '')
            }}</ElDescriptionsItem>
          </ElDescriptions>
          <ElButton class="mt-4" type="primary" plain @click="metricsDetailOpen = true"
            >查看运行详情</ElButton
          >
        </BusinessDetailSection>
        <ElAlert
          v-if="metrics.storage.warnings?.length"
          :title="'存储告警：' + metrics.storage.warnings.map(storageWarning).join('、')"
          type="warning"
          :closable="false"
          class="mt-4"
        />
        <p class="text-xs text-g-500 mt-4"
          >推送发送成功表示服务接收，不代表手机实际收到。此处内存为本服务进程指标，不作为整机内存占用。</p
        >
      </template>
    </ElCard>
    <BusinessDetailPanel
      page-key="runtime-details"
      @restore="restoreMetricsDetails"
      :restore-error="restoreError"
      v-model="metricsDetailOpen"
      title="实际运行监测详情"
    >
      <template v-if="metrics && canReadMetrics">
        <BusinessDetailHeader
          description="以下使用实际运行接口的同一份采集结果，刷新后重新读取。推送服务接受与手机收到分开判断。"
          icon="ri:server-line"
          badge="只读监测"
          :context="'采集时间 ' + formatTime(metrics.generatedAt)"
          ><template #actions
            ><ElButton :loading="metricsLoading" @click="loadMetrics"
              >刷新实际数据</ElButton
            ></template
          ></BusinessDetailHeader
        >
        <BusinessDetailSummary
          :items="[
            { label: '累计请求', value: metrics.http.requests },
            {
              label: '服务端错误',
              value:
                metrics.http.errors + ' · ' + (metrics.http.serverErrorRate * 100).toFixed(2) + '%',
              tone: metrics.http.errors ? 'warning' : 'success'
            },
            { label: '计划备份', value: metrics.backups.enabled ? '已配置' : '未配置' },
            {
              label: '待发 / 处理中',
              value: (metrics.push.pending || 0) + ' / ' + (metrics.push.processing || 0)
            }
          ]"
        />
        <ElTabs v-model="metricsTab"
          ><ElTabPane name="requests" label="请求与进程"
            ><BusinessDetailSection
              title="实际请求与服务进程"
              description="延迟为当前服务接口处理耗时；进程内存不代表整机内存。"
              ><ElDescriptions :column="1" border
                ><ElDescriptionsItem label="请求 P95"
                  >{{ metrics.http.p95Ms.toFixed(1) }} ms（最近
                  {{ metrics.http.sampleCount }} 个请求）</ElDescriptionsItem
                ><ElDescriptionsItem label="平均 / 最大耗时"
                  >{{
                    metrics.http.averageMs == null ? '—' : metrics.http.averageMs.toFixed(1) + ' ms'
                  }}
                  /
                  {{
                    metrics.http.maxMs == null ? '—' : metrics.http.maxMs.toFixed(1) + ' ms'
                  }}</ElDescriptionsItem
                ><ElDescriptionsItem label="客户端错误 / 中断请求"
                  >{{ metrics.http.clientErrors ?? '—' }} /
                  {{ metrics.http.aborted ?? '—' }}</ElDescriptionsItem
                ><ElDescriptionsItem label="处理中请求">{{
                  metrics.http.inflight ?? '—'
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="服务进程驻留内存">{{
                  bytes(metrics.process.memory.rss)
                }}</ElDescriptionsItem></ElDescriptions
              ></BusinessDetailSection
            ></ElTabPane
          >
          <ElTabPane name="storage" label="磁盘与审计"
            ><BusinessDetailSection
              title="当前真实文件容量"
              description="数据库主文件与 WAL 分别展示；磁盘容量读取失败时显示暂不可用。"
              ><ElDescriptions :column="1" border
                ><ElDescriptionsItem label="数据库主文件">{{
                  bytes(metrics.storage.databaseBytes)
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="数据库 WAL">{{
                  bytes(metrics.storage.walBytes)
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="磁盘剩余容量">{{
                  bytes(metrics.storage.freeBytes)
                }}</ElDescriptionsItem></ElDescriptions
              ><ElTable :data="metrics.logs" border
                ><ElTableColumn label="审计存储"
                  ><template #default="{ row }">{{
                    row.table_name === 'audit_logs'
                      ? '实时审计'
                      : row.table_name === 'audit_logs_archive'
                        ? '归档审计'
                        : '审计存储'
                  }}</template></ElTableColumn
                ><ElTableColumn prop="rows" label="记录数" /><ElTableColumn label="正文容量"
                  ><template #default="{ row }">{{ bytes(row.bytes) }}</template></ElTableColumn
                ></ElTable
              ><ElAlert
                v-if="metrics.storage.warnings?.length"
                :title="metrics.storage.warnings.map(storageWarning).join('、')"
                type="warning"
                :closable="false"
                class="mt-4" /></BusinessDetailSection
          ></ElTabPane>
          <ElTabPane name="push" label="推送队列"
            ><BusinessDetailSection
              title="等待与发送中队列"
              description="队列状态只描述后台处理。发送成功表示发送服务接受，不证明手机、锁屏或关闭网页后的实际到达。"
              ><ElDescriptions :column="1" border
                ><ElDescriptionsItem label="等待发送">{{
                  metrics.push.pending || 0
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="发送处理中">{{
                  metrics.push.processing || 0
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="最久到期待发等待"
                  >{{
                    Math.round((metrics.push.oldestDueWaitMs || 0) / 1000)
                  }}
                  秒（按当前到期发送时间计算）</ElDescriptionsItem
                ></ElDescriptions
              ></BusinessDetailSection
            ></ElTabPane
          >
          <ElTabPane name="backups" label="计划备份"
            ><BusinessDetailSection
              title="实际备份结果"
              description="仅展示备份服务已记录的结果，完整恢复验证需要使用隔离副本。"
              ><ElDescriptions :column="1" border
                ><ElDescriptionsItem label="计划配置">{{
                  metrics.backups.enabled ? '已配置' : '未配置'
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="成功 / 失败次数"
                  >{{ metrics.backups.completed }} /
                  {{ metrics.backups.failed }}</ElDescriptionsItem
                ><ElDescriptionsItem label="最近成功时间">{{
                  metrics.backups.lastCompletedAt
                    ? formatTime(metrics.backups.lastCompletedAt)
                    : '尚无成功记录'
                }}</ElDescriptionsItem></ElDescriptions
              ></BusinessDetailSection
            ></ElTabPane
          ></ElTabs
        > </template
      ><ElEmpty v-else description="当前账号没有可读取的实际运行数据" />
    </BusinessDetailPanel>
    <ElAlert
      title="以下为原框架的服务器界面演示"
      description="服务器名称、地址及 CPU、RAM、SWAP、DISK 数值均为示例，随机变化不代表真实主机监控；开关机按钮为演示占位。"
      type="info"
      :closable="false"
      show-icon
      class="mb-5"
    />
    <div class="w-full">
      <div class="flex flex-wrap w-[calc(100%+20px)]">
        <div
          class="box-border w-[calc(50%-20px)] mr-5 mb-5 border border-g-300 rounded max-lg:w-full max-md:w-full"
          v-for="item in serverList"
          :key="item.name"
        >
          <div
            class="flex-cb p-5 border-b border-g-300/80 max-lg:p-2.5 max-lg:px-5 max-md:p-2.5 max-md:px-5"
          >
            <span class="text-sm font-medium">{{ item.name }}</span>
            <span class="text-sm text-g-600">{{ item.ip }}</span>
          </div>
          <div class="flex-c p-9 scale-[0.8] max-lg:p-5 max-md:block max-md:p-5 max-sm:!block">
            <div class="mx-10 max-lg:m-0 max-lg:mr-5 max-md:m-0">
              <img
                src="@imgs/safeguard/server.png"
                alt="服务器"
                class="block w-47 max-md:w-37 max-md:mx-auto"
              />
              <div class="flex justify-center -mt-2.5 max-md:mt-2.5">
                <ElButtonGroup>
                  <ElButton type="primary" size="default" disabled>开机（演示）</ElButton>
                  <ElButton type="danger" size="default" disabled>关机（演示）</ElButton>
                  <ElButton type="warning" size="default" disabled>重启（演示）</ElButton>
                </ElButtonGroup>
              </div>
            </div>
            <div class="flex-1 mt-1 max-lg:mt-0 max-md:mt-7.5">
              <div class="my-3.5">
                <p class="mb-1 text-sm">CPU</p>
                <ElProgress :percentage="item.cup" :text-inside="true" :stroke-width="17" />
              </div>
              <div class="my-3.5">
                <p class="mb-1 text-sm">RAM</p>
                <ElProgress
                  :percentage="item.memory"
                  status="success"
                  :text-inside="true"
                  :stroke-width="17"
                />
              </div>
              <div class="my-3.5">
                <p class="mb-1 text-sm">SWAP</p>
                <ElProgress
                  :percentage="item.swap"
                  status="warning"
                  :text-inside="true"
                  :stroke-width="17"
                />
              </div>
              <div class="my-3.5">
                <p class="mb-1 text-sm">DISK</p>
                <ElProgress
                  :percentage="item.disk"
                  status="success"
                  :text-inside="true"
                  :stroke-width="17"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { studioRequest } from '@/api/studio'
  import { formatTime, useStudio } from '@/hooks/business/useStudio'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  defineOptions({ name: 'SafeguardServer' })
  const { user, can, clearSession, data } = useStudio()
  const canReadMetrics = computed(
    () =>
      ['owner', 'super_admin'].includes(user.value?.role || '') &&
      can('logs.view') &&
      can('settings.manage')
  )
  interface RuntimeMetrics {
    generatedAt: string
    source: 'actual-runtime'
    http: {
      requests: number
      errors: number
      serverErrorRate: number
      p95Ms: number
      sampleCount: number
      averageMs?: number
      maxMs?: number
      clientErrors?: number
      aborted?: number
      inflight?: number
    }
    process: { memory: { rss: number } }
    storage: {
      databaseBytes?: number | null
      walBytes?: number | null
      freeBytes?: number | null
      warnings?: string[]
    }
    logs: { bytes: number; rows?: number; table_name?: string }[]
    push: { pending?: number; processing?: number; oldestDueWaitMs?: number }
    backups: { enabled: boolean; completed: number; failed: number; lastCompletedAt: string | null }
  }
  const metrics = ref<RuntimeMetrics | null>(null)
  const metricsDetailOpen = ref(false)
  const metricsTab = ref('requests')
  const restoreError = ref('')
  const restoreMetricsPending = ref<{ recordId?: string; isCurrent?: () => boolean } | null>(null)
  function restoreMetricsDetails(payload: { recordId?: string; isCurrent?: () => boolean }) {
    restoreError.value = ''
    restoreMetricsPending.value = payload
    resumeMetricsRestore()
  }
  function resumeMetricsRestore() {
    if (restoreMetricsPending.value?.isCurrent?.() === false) {
      restoreMetricsPending.value = null
      return
    }
    if (!restoreMetricsPending.value || !data.value || metricsLoading.value) return
    if (!canReadMetrics.value) {
      restoreMetricsPending.value = null
      restoreError.value = '当前账号没有实际运行指标权限，请返回业务页面。'
      return
    }
    if (metrics.value) {
      restoreMetricsPending.value = null
      metricsDetailOpen.value = true
    } else if (metricsError.value) {
      restoreMetricsPending.value = null
      restoreError.value = '当前实际运行数据读取失败，请返回监测页重新读取。'
    } else void loadMetrics()
  }
  const metricsLoading = ref(false)
  const metricsError = ref('')
  watch([data, metrics, metricsLoading, metricsError, canReadMetrics], resumeMetricsRestore)
  let metricsVersion = 0
  const bytes = (value?: number | null) =>
    value == null ? '暂不可用' : `${(value / 1024 / 1024).toFixed(2)} MiB`
  const storageWarnings: Record<string, string> = {
    DISK_FREE_LOW: '磁盘可用空间偏低',
    WAL_LARGE: '数据库写入日志偏大',
    DISK_PROBE_UNAVAILABLE: '暂时无法读取磁盘容量'
  }
  const storageWarning = (code: string) => storageWarnings[code] || code
  async function loadMetrics() {
    if (!canReadMetrics.value) return
    const version = ++metricsVersion
    const accountId = user.value?.id
    metricsLoading.value = true
    metricsError.value = ''
    try {
      const result = await studioRequest<RuntimeMetrics>('runtime/metrics')
      if (version !== metricsVersion || accountId !== user.value?.id || !canReadMetrics.value)
        return
      if (result.source !== 'actual-runtime') throw new Error('接口未返回实际运行指标，已停止展示')
      metrics.value = result
    } catch (cause) {
      if (version !== metricsVersion) return
      metricsError.value = cause instanceof Error ? cause.message : '运行指标读取失败'
      if ((cause as { status?: number }).status === 401) clearSession()
    } finally {
      if (version === metricsVersion) metricsLoading.value = false
    }
  }
  watch(
    [() => user.value?.id, () => data.value?.permissions.join('|')],
    () => {
      metricsVersion++
      metrics.value = null
      metricsLoading.value = false
      metricsError.value = ''
      void loadMetrics()
    },
    { immediate: true }
  )

  interface ServerInfo {
    name: string
    ip: string
    cup: number
    memory: number
    swap: number
    disk: number
  }

  const UPDATE_INTERVAL = 3000 // 更新间隔时间（毫秒）

  /**
   * 服务器列表数据
   * 包含各服务器的基本信息和资源使用情况
   */
  const serverList = reactive<ServerInfo[]>([
    {
      name: '开发服务器',
      ip: '192.168.1.100',
      cup: 85,
      memory: 65,
      swap: 45,
      disk: 92
    },
    {
      name: '测试服务器',
      ip: '192.168.1.101',
      cup: 32,
      memory: 78,
      swap: 90,
      disk: 45
    },
    {
      name: '预发布服务器',
      ip: '192.168.1.102',
      cup: 95,
      memory: 42,
      swap: 67,
      disk: 88
    },
    {
      name: '线上服务器',
      ip: '192.168.1.103',
      cup: 58,
      memory: 93,
      swap: 25,
      disk: 73
    }
  ])

  /**
   * 生成指定范围内的随机整数
   * @param min 最小值（默认 0）
   * @param max 最大值（默认 100）
   * @returns 随机整数
   */
  const generateRandomValue = (min = 0, max = 100): number => {
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  /**
   * 更新所有服务器的资源使用数据
   * 模拟服务器资源使用情况的实时变化
   */
  const updateServerData = (): void => {
    serverList.forEach((server) => {
      server.cup = generateRandomValue()
      server.memory = generateRandomValue()
      server.swap = generateRandomValue()
      server.disk = generateRandomValue()
    })
  }

  let timer: number | null = null

  /**
   * 组件挂载时启动定时器
   * 每隔指定时间自动更新服务器数据
   */
  onMounted(() => {
    timer = window.setInterval(updateServerData, UPDATE_INTERVAL)
  })

  /**
   * 组件卸载时清理定时器
   * 防止内存泄漏
   */
  onUnmounted(() => {
    metricsVersion++
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  })
</script>
