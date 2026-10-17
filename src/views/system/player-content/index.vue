<template>
  <div class="player-content-admin">
    <BusinessPageHeader
      title="打手端内容管理"
      description="维护接单大厅的滚动公告和图片轮播。草稿可反复修改，发布后打手端自动更新。"
      icon="ri:slideshow-3-line"
      badge="发布前可预览"
    >
      <template #actions>
        <ElButton :loading="loading" :disabled="busy || loading" @click="reload()"
          >刷新内容</ElButton
        >
        <ElButton
          v-if="canEdit"
          type="primary"
          :disabled="busy || loading || items.length >= 100"
          @click="openEditor()"
        >
          {{ tab === 'announcement' ? '新增公告' : '新增轮播图' }}
        </ElButton>
      </template>
    </BusinessPageHeader>

    <ElAlert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      class="mb-4"
    />
    <ElAlert
      title="保存草稿不会改变打手端当前展示的内容。确认内容后再发布；定时内容按北京时间自动开始和结束展示。"
      type="info"
      show-icon
      :closable="false"
      class="mb-4"
    />
    <ElCard shadow="never">
      <ElTabs v-model="tab">
        <ElTabPane name="announcement" :label="`滚动公告（${announcementCount}）`" />
        <ElTabPane name="banner" :label="`图片轮播（${items.length - announcementCount}）`" />
      </ElTabs>
      <div class="content-filters">
        <ElInput
          v-model="search"
          clearable
          placeholder="搜索标题或文字"
          aria-label="搜索标题或文字"
        />
        <ElSelect v-model="statusFilter" clearable placeholder="全部状态" aria-label="内容状态筛选">
          <ElOption v-for="(label, key) in statusLabels" :key="key" :label="label" :value="key" />
        </ElSelect>
        <span class="content-count">共 {{ items.length }} / 100 条，排序数字小的在前</span>
      </div>
      <ElTable
        v-if="filteredItems.length"
        :data="contentTable.tableData.value"
        v-loading="loading"
        row-key="id"
        stripe
      >
        <ElTableColumn label="内容" min-width="280">
          <template #default="{ row }">
            <div class="content-summary" :data-testid="`content-row-${row.id}`">
              <img
                v-if="row.type === 'banner' && row.image?.url"
                :src="studioImageUrl(row.image.url)"
                loading="lazy"
                :alt="row.title"
              />
              <div>
                <strong>{{ row.title }}</strong>
                <p v-if="row.type === 'announcement'">{{ row.text || '草稿尚未填写滚动文字' }}</p>
                <p v-else-if="!row.image">草稿尚未上传轮播图片</p>
                <ElTag
                  v-if="row.hasUnpublishedChanges"
                  size="small"
                  effect="plain"
                  type="warning"
                  >{{ row.published ? '有未发布修改' : '尚未发布' }}</ElTag
                >
              </div>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="状态" width="105">
          <template #default="{ row }"
            ><ElTag :type="statusTag(row.status)">{{
              statusLabels[row.status as PlayerContentStatus]
            }}</ElTag></template
          >
        </ElTableColumn>
        <ElTableColumn label="排序" prop="sortOrder" width="75" />
        <ElTableColumn label="展示时间（北京时间）" min-width="225">
          <template #default="{ row }">
            <div class="content-time"
              >开始：{{ row.startAt ? formatTime(row.startAt) : '发布后立即' }}</div
            >
            <div class="content-time"
              >结束：{{ row.endAt ? formatTime(row.endAt) : '长期展示' }}</div
            >
            <span v-if="row.hasUnpublishedChanges && row.published" class="content-hint"
              >上述为草稿时间；发布后生效</span
            >
          </template>
        </ElTableColumn>
        <ElTableColumn label="最近修改" min-width="185">
          <template #default="{ row }"
            ><div>{{ formatTime(row.updatedAt) }}</div
            ><span class="content-hint">{{ operatorName(row.updatedBy) }}</span></template
          >
        </ElTableColumn>
        <ElTableColumn label="操作" width="390" fixed="right">
          <template #default="{ row }">
            <ElButton link type="primary" :disabled="busy" @click="contentDetailId = row.id"
              >查看详情</ElButton
            >
            <ElButton link type="primary" :disabled="busy" @click="openEditor(row)">编辑</ElButton>
            <ElButton link type="primary" :disabled="busy" @click="openPreview(row)">预览</ElButton>
            <ElButton link type="success" :disabled="busy || !canEdit" @click="publishRow(row)"
              >发布</ElButton
            >
            <ElButton
              link
              type="warning"
              :disabled="busy || !canEdit || !row.published || row.status === 'offline'"
              @click="offlineRow(row)"
              >下架</ElButton
            >
            <ElButton
              link
              type="danger"
              :disabled="busy || !canEdit || !['draft', 'offline'].includes(row.status)"
              @click="deleteRow(row)"
              >删除</ElButton
            >
          </template>
        </ElTableColumn>
      </ElTable>
      <ElEmpty
        v-else
        :description="
          loading
            ? '正在读取内容…'
            : search || statusFilter
              ? '没有符合条件的内容'
              : tab === 'announcement'
                ? '还没有公告，新增第一条工作室通知吧'
                : '还没有轮播图，可上传活动图片或接单指引'
        "
      >
        <ElButton
          v-if="!search && !statusFilter && !loading && canEdit"
          type="primary"
          :disabled="busy || items.length >= 100"
          @click="openEditor()"
        >
          {{ tab === 'announcement' ? '新增公告' : '新增轮播图' }}
        </ElButton>
      </ElEmpty>
      <ElPagination
        v-if="filteredItems.length"
        class="mt-4"
        :current-page="contentTable.pagination.current"
        :page-size="contentTable.pagination.size"
        :total="contentTable.pagination.total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        @size-change="contentTable.handleSizeChange"
        @current-change="contentTable.handleCurrentChange"
      />
      <p class="content-footer"
        >打手端只显示已发布且在展示时间内的内容。下架后可继续编辑或删除；草稿和发布版分别保存。每次修改、发布、下架、删除均记录到操作日志。</p
      >
    </ElCard>

    <BusinessDetailPanel
      page-key="player-content-details"
      :record-id="contentDetailId || undefined"
      @restore="queueRestore('detail', $event)"
      :restore-error="restoreError"
      :model-value="!!contentDetailId"
      title="内容记录详情"
      @update:model-value="!$event && !busy && (contentDetailId = '')"
      @close="contentDetailId = ''"
    >
      <template v-if="contentDetail">
        <BusinessDetailHeader
          :title="contentDetail.title"
          description="分别查看已保存草稿与最近发布版。实际打手端展示由发布状态和展示时间共同决定。"
          icon="ri:slideshow-3-line"
          :badge="statusLabels[contentDetail.status]"
          :context="contentDetail.id"
        />
        <BusinessDetailSummary
          :items="[
            { label: '内容类型', value: contentDetail.type === 'banner' ? '图片轮播' : '滚动公告' },
            { label: '记录修订', value: 'v' + contentDetail.revision },
            {
              label: '发布情况',
              value: contentDetail.published
                ? contentDetail.hasUnpublishedChanges
                  ? '有未发布修改'
                  : '与已发布版一致'
                : '尚未发布'
            },
            {
              label: '最近修改',
              value: formatTime(contentDetail.updatedAt),
              hint: operatorName(contentDetail.updatedBy)
            }
          ]"
        />
        <BusinessDetailSection title="记录与发布信息">
          <ElDescriptions :column="1" border
            ><ElDescriptionsItem label="创建时间">{{
              formatTime(contentDetail.createdAt)
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="最近发布时间">{{
              contentDetail.published ? formatTime(contentDetail.published.publishedAt) : '尚未发布'
            }}</ElDescriptionsItem
            ><ElDescriptionsItem label="排序"
              >{{ contentDetail.sortOrder }}（数字小的在前）</ElDescriptionsItem
            ></ElDescriptions
          >
        </BusinessDetailSection>
        <ElTabs v-model="contentDetailTab"
          ><ElTabPane name="draft" label="已保存草稿"
            ><BusinessDetailSection
              title="草稿内容"
              description="修改草稿不改变当前打手端展示；重新发布后才替换发布版。"
              ><ElDescriptions :column="1" border
                ><ElDescriptionsItem label="开始展示（北京时间）">{{
                  contentDetail.startAt ? formatTime(contentDetail.startAt) : '发布后立即'
                }}</ElDescriptionsItem
                ><ElDescriptionsItem label="结束展示（北京时间）">{{
                  contentDetail.endAt ? formatTime(contentDetail.endAt) : '长期展示'
                }}</ElDescriptionsItem></ElDescriptions
              ><ContentPreview :content="contentDetail" /></BusinessDetailSection></ElTabPane
          ><ElTabPane name="published" label="最近发布版"
            ><BusinessDetailSection
              title="发布时内容"
              description="最近发布版留存用于核对，不代表当前时间仍在打手端展示。"
              ><template v-if="contentDetail.published"
                ><ElDescriptions :column="1" border
                  ><ElDescriptionsItem label="开始展示（北京时间）">{{
                    contentDetail.published.startAt
                      ? formatTime(contentDetail.published.startAt)
                      : '发布后立即'
                  }}</ElDescriptionsItem
                  ><ElDescriptionsItem label="结束展示（北京时间）">{{
                    contentDetail.published.endAt
                      ? formatTime(contentDetail.published.endAt)
                      : '长期展示'
                  }}</ElDescriptionsItem></ElDescriptions
                ><ContentPreview :content="contentDetail.published" /></template
              ><ElEmpty v-else description="这条内容尚未发布" /></BusinessDetailSection></ElTabPane
        ></ElTabs> </template
      ><ElEmpty v-else description="当前账号没有可读取的内容，请关闭后刷新" />
    </BusinessDetailPanel>

    <BusinessDetailPanel
      page-key="player-content-editor"
      :record-id="form.id || 'new:' + form.type"
      @restore="queueRestore('editor', $event)"
      :restore-error="restoreError"
      v-model="editorOpen"
      :title="form.id ? '编辑内容' : tab === 'announcement' ? '新增公告' : '新增轮播图'"
      :close-on-click-modal="false"
      :before-close="closeEditor"
      destroy-on-close
    >
      <ElAlert
        v-if="restoredContentNote"
        :title="restoredContentNote"
        type="info"
        :closable="false"
        class="mb-4"
      />
      <BusinessDetailHeader
        :title="form.title || (form.type === 'announcement' ? '滚动公告' : '图片轮播')"
        description="保存草稿仅保留当前编辑，保存并发布才会更新打手端的发布版本。"
        icon="ri:edit-box-line"
        :badge="form.id ? '编辑已有内容' : '新增草稿'"
        :context="form.id || undefined"
      />
      <BusinessDetailSummary
        :items="[
          { label: '内容类型', value: form.type === 'announcement' ? '滚动公告' : '图片轮播' },
          { label: '编辑状态', value: dirty ? '有未保存编辑' : '草稿已保存' },
          { label: '开始展示（北京时间）', value: form.startAt || '发布后立即' },
          { label: '结束展示（北京时间）', value: form.endAt || '长期展示' }
        ]"
      />
      <div class="content-editor" data-testid="player-content-editor">
        <ElAlert
          v-if="editorError"
          :title="editorError"
          type="error"
          show-icon
          :closable="false"
          class="mb-4"
        />
        <div v-if="externalChange" class="content-conflict">
          <strong>{{
            latestItem
              ? '其他管理员已更新这条内容，当前编辑已保留'
              : '这条内容已被其他管理员删除，当前编辑已保留'
          }}</strong>
          <p v-if="latestItem"
            >最新修改：{{ formatTime(latestItem.updatedAt) }} ·
            {{ operatorName(latestItem.updatedBy) }}。请核对后选择使用最新草稿，或保留当前编辑。</p
          >
          <p v-else>可将当前编辑另存为一条新草稿。</p>
          <div>
            <ElButton v-if="latestItem" :disabled="busy" @click="useLatest">使用最新草稿</ElButton>
            <ElButton v-if="latestItem" type="warning" :disabled="busy" @click="keepDraftOnLatest"
              >保留当前编辑</ElButton
            >
            <ElButton v-else type="primary" :disabled="busy" @click="saveAsNew"
              >另存为新草稿</ElButton
            >
            <ElButton :disabled="busy || loading" @click="reload()">重新读取</ElButton>
          </div>
        </div>
        <ElAlert
          v-else-if="conflictUnread"
          title="服务器上的内容已变化，当前编辑已保留。请重新读取最新内容后核对。"
          type="warning"
          show-icon
          :closable="false"
          class="mb-4"
        >
          <ElButton :disabled="busy || loading" @click="reload()">重新读取最新内容</ElButton>
        </ElAlert>
        <BusinessDetailSection
          title="编辑草稿与展示时间"
          description="右侧预览只用于核对当前编辑，所有现有发布和冲突检查继续保留。"
          ><div class="content-editor-layout">
            <ElForm
              :model="form"
              label-position="top"
              :disabled="busy || !canEdit"
              class="content-form"
              @submit.prevent="saveEditing"
            >
              <ElFormItem label="标题" required>
                <ElInput
                  v-model="form.title"
                  maxlength="80"
                  show-word-limit
                  placeholder="例如：今日接单提醒"
                />
              </ElFormItem>
              <ElFormItem v-if="form.type === 'announcement'" label="滚动文字" required>
                <ElInput
                  v-model="form.text"
                  maxlength="300"
                  show-word-limit
                  type="textarea"
                  :autosize="{ minRows: 2, maxRows: 4 }"
                  placeholder="大厅顶部滚动展示的简短通知"
                />
              </ElFormItem>
              <ElFormItem v-else label="轮播图片">
                <ElUpload
                  action="#"
                  :auto-upload="false"
                  :show-file-list="false"
                  accept="image/jpeg,image/png,image/webp"
                  :disabled="busy || !canEdit"
                  :on-change="selectImage"
                >
                  <div class="content-image-control" :class="{ 'is-disabled': busy }">
                    <img
                      v-if="form.image?.url"
                      :src="studioImageUrl(form.image.url)"
                      loading="lazy"
                      :alt="form.title || '轮播图片'"
                    />
                    <div v-else
                      ><ArtSvgIcon icon="ri:image-add-line" /><span>选择轮播图片</span></div
                    >
                    <span>{{
                      uploading
                        ? '正在上传…'
                        : form.image
                          ? '点击替换图片'
                          : '上传 JPG / PNG / WebP'
                    }}</span>
                  </div>
                </ElUpload>
                <div class="content-upload-note"
                  ><span>{{ form.image?.name || '建议横向图片，最大 8 MB；发布前必须上传。' }}</span
                  ><ElButton
                    v-if="form.image"
                    link
                    type="danger"
                    :disabled="busy"
                    @click="form.image = null"
                    >移除图片</ElButton
                  ></div
                >
              </ElFormItem>
              <ElFormItem label="详情正文">
                <ElInput
                  v-model="form.body"
                  type="textarea"
                  :rows="7"
                  maxlength="20000"
                  show-word-limit
                  placeholder="点击公告或轮播图后查看的详细说明，支持换行与分段"
                />
              </ElFormItem>
              <p class="content-hint content-text-tip"
                >标题、滚动文字和正文仅支持纯文本，请勿填写网页代码。</p
              >
              <div class="content-schedule">
                <ElFormItem label="展示排序"
                  ><ElInputNumber
                    v-model="form.sortOrder"
                    :min="0"
                    :max="9999"
                    :precision="0"
                    controls-position="right"
                /></ElFormItem>
                <ElFormItem label="开始展示时间（北京时间）"
                  ><ElDatePicker
                    v-model="form.startAt"
                    type="datetime"
                    value-format="YYYY-MM-DD HH:mm:ss"
                    format="YYYY-MM-DD HH:mm"
                    placeholder="留空，发布后立即展示"
                    clearable
                /></ElFormItem>
                <ElFormItem label="结束展示时间（北京时间）"
                  ><ElDatePicker
                    v-model="form.endAt"
                    type="datetime"
                    value-format="YYYY-MM-DD HH:mm:ss"
                    format="YYYY-MM-DD HH:mm"
                    placeholder="留空，长期展示"
                    clearable
                /></ElFormItem>
              </div>
              <p class="content-hint"
                >排序越小越靠前。编辑中的字段保存在草稿里，重新发布后才会替换打手端正在展示的版本。</p
              >
            </ElForm>
            <aside class="content-live-preview"
              ><h4>当前编辑预览</h4><ContentPreview :content="previewForm" /><p
                >手机上的文字滚动与图片轮播由打手端自动展示。</p
              ></aside
            >
          </div></BusinessDetailSection
        >
      </div>
      <template #footer>
        <div class="content-editor-footer">
          <span>{{ dirty ? '有尚未保存的编辑' : '草稿已保存' }}</span>
          <div
            ><ElButton :disabled="busy" @click="openEditingPreview">预览</ElButton
            ><ElButton
              :loading="saving && !publishing"
              :disabled="busy || !canEdit || externalChange || conflictUnread"
              @click="saveEditing"
              >保存草稿</ElButton
            ><ElButton
              type="primary"
              :loading="publishing"
              :disabled="busy || !canEdit || externalChange || conflictUnread"
              @click="publishEditing"
              >保存并发布</ElButton
            ></div
          >
        </div>
      </template>
    </BusinessDetailPanel>

    <BusinessDetailPanel
      page-key="player-content-preview"
      :record-id="previewRecordId"
      @restore="queueRestore('preview', $event)"
      :restore-error="restoreError"
      v-model="previewOpen"
      title="内容预览"
      append-to-body
    >
      <ElAlert
        v-if="restoredContentNote"
        :title="restoredContentNote"
        type="info"
        :closable="false"
        class="mb-4"
      />
      <BusinessDetailHeader
        :title="selectedPreview?.title || '内容预览'"
        description="预览所选内容版本，实际展示仍按发布状态和北京时间的展示区间判断。"
        icon="ri:smartphone-line"
        :badge="previewVersion === 'published' ? '最近发布版' : '草稿预览'"
      />
      <ElRadioGroup v-if="previewPublication" v-model="previewVersion" class="preview-version"
        ><ElRadioButton value="draft">{{
          previewFromEditor ? '当前编辑草稿' : '已保存草稿'
        }}</ElRadioButton
        ><ElRadioButton value="published">当前发布版</ElRadioButton></ElRadioGroup
      >
      <p class="preview-caption">{{
        previewVersion === 'published'
          ? '这是最近发布的内容版本，实际展示仍以展示时间为准。'
          : '这是草稿预览，保存草稿不会改变打手端当前内容。'
      }}</p>
      <ContentPreview v-if="selectedPreview" :content="selectedPreview" />
    </BusinessDetailPanel>
  </div>
</template>

<script setup lang="ts">
  import { studioImageUrl } from '@/utils/studio-image'
  import BusinessDetailPanel from '@/components/business/BusinessDetailPanel.vue'
  import { computed, onMounted, onUnmounted, ref, watch, type VNode } from 'vue'
  import { onBeforeRouteLeave } from 'vue-router'
  import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import ContentPreview from './modules/content-preview.vue'
  import { studioRequest, uploadStudioImage } from '@/api/studio'
  import { useBusinessTable } from '@/hooks/business/useBusinessTable'
  import BusinessDetailHeader from '@/components/business/BusinessDetailHeader.vue'
  import BusinessDetailSummary from '@/components/business/BusinessDetailSummary.vue'
  import BusinessDetailSection from '@/components/business/BusinessDetailSection.vue'
  import { businessConfirmMessage } from '@/utils/business/confirm-message'
  import { useStudio, formatTime } from '@/hooks/business/useStudio'
  import type { Attachment } from '@/types/studio'
  import type {
    PlayerContentFields,
    PlayerContentItem,
    PlayerContentList,
    PlayerContentPublication,
    PlayerContentStatus,
    PlayerContentType
  } from '@/types/player-content'

  interface EditorForm {
    id: string | null
    revision: number | null
    type: PlayerContentType
    title: string
    text: string
    body: string
    image: Attachment | null
    sortOrder: number
    startAt: string | null
    endAt: string | null
  }
  const { can, user, data, clearSession } = useStudio()
  const canEdit = computed(() => can('settings.manage'))
  const items = ref<PlayerContentItem[]>([])
  const serverTime = ref('')
  let serverReceivedAt = 0
  const loading = ref(false)
  const saving = ref(false)
  const publishing = ref(false)
  const uploading = ref(false)
  const confirming = ref(false)
  const busy = computed(
    () => saving.value || uploading.value || confirming.value || publishing.value
  )
  const tab = ref<PlayerContentType>('announcement')
  const search = ref('')
  const statusFilter = ref<PlayerContentStatus | ''>('')
  const loadError = ref('')
  const editorError = ref('')
  const editorOpen = ref(false)
  const baseline = ref('')
  const form = ref<EditorForm>(emptyForm('announcement'))
  const conflictUnread = ref(false)
  const previewOpen = ref(false)
  const previewDraft = ref<PlayerContentFields | null>(null)
  const previewPublication = ref<PlayerContentPublication | null>(null)
  const previewVersion = ref<'draft' | 'published'>('draft')
  const previewFromEditor = ref(false)
  const previewRecordId = ref<string | undefined>()
  const restoredContentNote = ref('')
  const restoreError = ref('')
  const contentReadComplete = ref(false)
  const pendingRestores = ref<
    { kind: 'detail' | 'editor' | 'preview'; recordId?: string; isCurrent?: () => boolean }[]
  >([])
  function queueRestore(
    kind: 'detail' | 'editor' | 'preview',
    payload: { recordId?: string; isCurrent?: () => boolean }
  ) {
    restoreError.value = ''
    pendingRestores.value = [
      ...pendingRestores.value.filter((entry) => entry.kind !== kind),
      { kind, ...payload }
    ]
    resumeRestores()
  }
  function resumeRestores() {
    pendingRestores.value = pendingRestores.value.filter((entry) => entry.isCurrent?.() !== false)
    if (!pendingRestores.value.length || !data.value || loading.value || busy.value) return
    if (!canEdit.value) {
      pendingRestores.value = []
      restoreError.value = '当前账号没有内容管理权限，请返回业务列表。'
      return
    }
    if (!contentReadComplete.value && !loadError.value) {
      void reload()
      return
    }
    if (loadError.value) {
      restoreError.value = '内容读取失败，请返回内容列表重新读取后打开。'
      pendingRestores.value = []
      return
    }
    for (const request of pendingRestores.value.splice(0)) {
      if (request.isCurrent?.() === false) continue
      if (request.kind === 'editor' && request.recordId?.startsWith('new:')) {
        const type = request.recordId.slice(4)
        if (!['announcement', 'banner'].includes(type)) {
          restoreError.value = '内容类型无效，请返回内容列表重新选择。'
          continue
        }
        tab.value = type as PlayerContentType
        openEditor()
        restoredContentNote.value =
          '刷新后重新初始化新草稿；未保存的文字和图片不会恢复，请重新核对。'
        continue
      }
      const editingPreview = request.kind === 'preview' && request.recordId?.startsWith('editing:')
      const id = editingPreview ? request.recordId?.slice(8) : request.recordId
      const row = items.value.find((item) => item.id === id)
      if (!row) {
        restoreError.value = '这条内容不存在、无权读取或未曾保存，请返回内容列表重新打开。'
        continue
      }
      tab.value = row.type
      if (request.kind === 'detail') contentDetailId.value = row.id
      else if (request.kind === 'editor') {
        openEditor(row)
        restoredContentNote.value =
          '刷新后重新读取了当前已保存草稿；未保存的编辑不会恢复，请核对后再保存或发布。'
      } else if (editingPreview && editorOpen.value && form.value.id === row.id) {
        openEditingPreview()
        restoredContentNote.value = '预览使用重新读取的当前草稿；刷新前未保存的编辑不会恢复。'
      } else {
        openPreview(row)
        if (editingPreview)
          restoredContentNote.value = '刷新前未保存的预览已失效；这里展示当前已保存草稿。'
      }
    }
  }
  watch([data, items, loading, busy, contentReadComplete], resumeRestores)
  const selectedPreview = computed(() =>
    previewVersion.value === 'published' ? previewPublication.value : previewDraft.value
  )
  const previewForm = computed<PlayerContentFields>(() => ({
    ...form.value,
    startAt: null,
    endAt: null
  }))
  const dirty = computed(() => signature(form.value) !== baseline.value)
  const latestItem = computed(() => items.value.find((item) => item.id === form.value.id) || null)
  const externalChange = computed(
    () =>
      editorOpen.value &&
      !!form.value.id &&
      !loading.value &&
      !loadError.value &&
      (!latestItem.value || latestItem.value.revision !== form.value.revision)
  )
  const announcementCount = computed(
    () => items.value.filter((item) => item.type === 'announcement').length
  )
  const statusLabels: Record<PlayerContentStatus, string> = {
    draft: '草稿',
    scheduled: '待展示',
    active: '展示中',
    expired: '已到期',
    offline: '已下架'
  }
  const filteredItems = computed(() => {
    const keyword = search.value.trim().toLowerCase()
    return items.value
      .filter(
        (item) =>
          item.type === tab.value &&
          (!statusFilter.value || item.status === statusFilter.value) &&
          (!keyword || `${item.title}\n${item.text}`.toLowerCase().includes(keyword))
      )
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id)
      )
  })
  const contentTable = useBusinessTable(filteredItems)
  const contentDetailId = ref('')
  const contentDetailTab = ref('draft')
  const contentDetail = computed(() =>
    canEdit.value ? items.value.find((item) => item.id === contentDetailId.value) : undefined
  )
  watch([tab, search, statusFilter], () => contentTable.resetPage())
  watch(contentDetailId, () => {
    contentDetailTab.value = 'draft'
  })
  let disposed = false
  let epoch = 0
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  function emptyForm(type: PlayerContentType): EditorForm {
    return {
      id: null,
      revision: null,
      type,
      title: '',
      text: '',
      body: '',
      image: null,
      sortOrder: 0,
      startAt: null,
      endAt: null
    }
  }
  function signature(value: EditorForm) {
    return JSON.stringify([
      value.type,
      value.title,
      value.text,
      value.body,
      value.image?.id || null,
      value.sortOrder,
      value.startAt,
      value.endAt
    ])
  }
  function toBeijing(value: string | null) {
    if (!value) return null
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(value))
  }
  function toIso(value: string | null) {
    if (!value) return null
    const date = new Date(`${value.replace(' ', 'T')}+08:00`)
    if (Number.isNaN(date.getTime())) throw new Error('展示时间无效，请重新选择')
    return date.toISOString()
  }
  function fillForm(item: PlayerContentItem) {
    form.value = {
      id: item.id,
      revision: item.revision,
      type: item.type,
      title: item.title,
      text: item.text,
      body: item.body,
      image: item.image ? { ...item.image } : null,
      sortOrder: item.sortOrder,
      startAt: toBeijing(item.startAt),
      endAt: toBeijing(item.endAt)
    }
    baseline.value = signature(form.value)
    conflictUnread.value = false
    editorError.value = ''
  }
  function statusTag(status: PlayerContentStatus): 'success' | 'warning' | 'info' {
    return status === 'active' ? 'success' : status === 'scheduled' ? 'warning' : 'info'
  }
  function operatorName(id: string) {
    if (!id) return '—'
    const operator = data.value?.users.find((entry) => entry.id === id)
    return operator?.name || (user.value?.id === id ? user.value.name : '管理员')
  }
  function errorText(cause: unknown) {
    return cause instanceof Error ? cause.message : '操作失败，请重试'
  }
  async function request<T>(path: string, body?: unknown, method = 'GET') {
    const version = epoch
    const actorId = user.value?.id
    try {
      const result = await studioRequest<T>(path, body, method)
      if (disposed || version !== epoch || actorId !== user.value?.id)
        throw new DOMException('账号已变化', 'AbortError')
      return result
    } catch (cause) {
      if (disposed || version !== epoch || actorId !== user.value?.id)
        throw new DOMException('账号已变化', 'AbortError')
      if (version === epoch && (cause as { status?: number }).status === 401) clearSession()
      throw cause
    }
  }
  async function reload(silent = false) {
    if (loading.value || disposed || !canEdit.value) return false
    const version = epoch
    loading.value = true
    try {
      const result = await request<PlayerContentList>('player-content')
      if (disposed || version !== epoch) return false
      items.value = result.items
      contentReadComplete.value = true
      serverTime.value = result.serverTime
      serverReceivedAt = Date.now()
      loadError.value = ''
      conflictUnread.value = false
      return true
    } catch (cause) {
      if (version === epoch && !disposed) {
        loadError.value = errorText(cause)
        if (!silent) ElMessage.error(loadError.value)
      }
      return false
    } finally {
      if (version === epoch) loading.value = false
    }
  }
  function replaceItem(item: PlayerContentItem) {
    const index = items.value.findIndex((entry) => entry.id === item.id)
    if (index < 0) items.value.push(item)
    else items.value[index] = item
  }
  function openEditor(item?: PlayerContentItem) {
    if (busy.value) return
    restoredContentNote.value = ''
    if (item) fillForm(item)
    else {
      form.value = emptyForm(tab.value)
      baseline.value = signature(form.value)
      conflictUnread.value = false
      editorError.value = ''
    }
    editorOpen.value = true
  }
  function openPreview(item: PlayerContentItem) {
    previewRecordId.value = item.id
    restoredContentNote.value = ''
    previewDraft.value = { ...item }
    previewPublication.value = item.published
    previewVersion.value = 'draft'
    previewFromEditor.value = false
    previewOpen.value = true
  }
  function openEditingPreview() {
    previewRecordId.value = 'editing:' + (form.value.id || 'new:' + form.value.type)
    previewDraft.value = { ...previewForm.value }
    previewPublication.value = latestItem.value?.published || null
    previewVersion.value = 'draft'
    previewFromEditor.value = true
    previewOpen.value = true
  }
  async function confirm(message: string | VNode, title: string, confirmButtonText: string) {
    if (confirming.value) return false
    const version = epoch
    const actorId = user.value?.id
    confirming.value = true
    try {
      await ElMessageBox.confirm(message, title, {
        confirmButtonText,
        cancelButtonText: '取消',
        type: 'warning',
        closeOnClickModal: false,
        closeOnHashChange: false
      })
      return !disposed && version === epoch && actorId === user.value?.id
    } catch {
      return false
    } finally {
      if (version === epoch) confirming.value = false
    }
  }
  async function closeEditor(done: () => void) {
    if (busy.value) return
    if (
      !dirty.value ||
      (await confirm('当前编辑尚未保存，关闭后将丢弃这些编辑。', '关闭编辑', '丢弃并关闭'))
    )
      done()
  }
  async function useLatest() {
    if (!latestItem.value || busy.value) return
    if (
      dirty.value &&
      !(await confirm(
        '使用服务器上的最新草稿，将替换当前尚未保存的编辑。',
        '使用最新草稿',
        '替换当前编辑'
      ))
    )
      return
    if (latestItem.value) fillForm(latestItem.value)
  }
  async function keepDraftOnLatest() {
    if (!latestItem.value || busy.value) return
    if (
      !(await confirm(
        '已保留当前输入。继续保存会将它写入最新草稿，请先在预览中核对；当前发布版不会因保存草稿而改变。',
        '保留当前编辑',
        '确认保留'
      ))
    )
      return
    const latest = latestItem.value
    if (!latest) return
    form.value.revision = latest.revision
    baseline.value = signature({
      ...form.value,
      title: latest.title,
      text: latest.text,
      body: latest.body,
      image: latest.image,
      sortOrder: latest.sortOrder,
      startAt: toBeijing(latest.startAt),
      endAt: toBeijing(latest.endAt)
    })
    conflictUnread.value = false
    editorError.value = ''
  }
  async function saveAsNew() {
    if (busy.value || items.value.length >= 100) return
    if (
      !(await confirm(
        '保留当前全部编辑，并将它另存为一条新草稿。新草稿需要单独发布。',
        '另存为新草稿',
        '确认另存'
      ))
    )
      return
    form.value.id = null
    form.value.revision = null
    conflictUnread.value = false
    editorError.value = ''
    baseline.value = ''
    await saveEditing()
  }
  function validate(forPublish: boolean) {
    if (!form.value.title.trim()) throw new Error('请填写标题')
    if (forPublish && form.value.type === 'announcement' && !form.value.text.trim())
      throw new Error('请填写滚动文字')
    if (forPublish && form.value.type === 'banner' && !form.value.image)
      throw new Error('请先上传轮播图片再发布')
    if (
      !Number.isInteger(form.value.sortOrder) ||
      form.value.sortOrder < 0 ||
      form.value.sortOrder > 9999
    )
      throw new Error('展示排序应为 0 到 9999 的整数')
    const start = toIso(form.value.startAt)
    const end = toIso(form.value.endAt)
    if (start && end && new Date(end) <= new Date(start))
      throw new Error('结束展示时间必须晚于开始展示时间')
    const now = serverTime.value
      ? new Date(serverTime.value).getTime() + Date.now() - serverReceivedAt
      : Date.now()
    if (forPublish && end && new Date(end).getTime() <= now)
      throw new Error('结束展示时间已过去，请调整后再发布')
    return { start, end }
  }
  async function saveDraftInternal(forPublish = false) {
    const { start, end } = validate(forPublish)
    const result = await request<PlayerContentItem>(
      'player-content',
      {
        ...(form.value.id ? { id: form.value.id, revision: form.value.revision } : {}),
        type: form.value.type,
        title: form.value.title.trim(),
        text: form.value.type === 'announcement' ? form.value.text.trim() : '',
        body: form.value.body,
        imageId: form.value.type === 'banner' ? form.value.image?.id || null : null,
        sortOrder: form.value.sortOrder,
        startAt: start,
        endAt: end
      },
      'POST'
    )
    replaceItem(result)
    fillForm(result)
    return result
  }
  async function handleError(cause: unknown, inEditor = false) {
    if (disposed || (cause instanceof DOMException && cause.name === 'AbortError')) return
    const message = errorText(cause)
    if (inEditor) editorError.value = message
    ElMessage.error(message)
    if ((cause as { status?: number }).status === 409) {
      conflictUnread.value = inEditor
      await reload(true)
    }
  }
  async function saveEditing() {
    if (busy.value || !canEdit.value || externalChange.value || conflictUnread.value) return
    const version = epoch
    saving.value = true
    editorError.value = ''
    try {
      await saveDraftInternal()
      ElMessage.success('草稿已保存，发布后才会更新打手端')
    } catch (cause) {
      await handleError(cause, true)
    } finally {
      if (version === epoch) saving.value = false
    }
  }
  async function publishEditing() {
    if (busy.value || !canEdit.value || externalChange.value || conflictUnread.value) return
    try {
      validate(true)
    } catch (cause) {
      editorError.value = errorText(cause)
      ElMessage.warning(editorError.value)
      return
    }
    if (
      !(await confirm(
        businessConfirmMessage(
          `确认将「${form.value.title.trim()}」保存并发布？${form.value.startAt ? '到设定的开始时间后显示。' : '发布后将更新打手端。'}`,
          [
            { label: '本次标题', value: form.value.title.trim() },
            {
              label: '内容类型',
              value: form.value.type === 'announcement' ? '滚动公告' : '图片轮播'
            },
            {
              label: '原记录状态',
              value: latestItem.value ? statusLabels[latestItem.value.status] : '新草稿，尚未保存'
            },
            {
              label: '原记录修订',
              value: form.value.revision == null ? '新草稿' : 'v' + form.value.revision
            },
            { label: '开始展示（北京时间）', value: form.value.startAt || '发布后立即' },
            { label: '结束展示（北京时间）', value: form.value.endAt || '长期展示' }
          ],
          '确认后先保存当前编辑，再发布该保存版本；草稿与发布版仍分别保留。'
        ),
        '保存并发布',
        '确认发布'
      ))
    )
      return
    publishing.value = true
    const version = epoch
    editorError.value = ''
    try {
      const saved = await saveDraftInternal(true)
      const published = await request<PlayerContentItem>(
        `player-content/${encodeURIComponent(saved.id)}/publish`,
        { revision: saved.revision },
        'POST'
      )
      replaceItem(published)
      fillForm(published)
      ElMessage.success(
        published.status === 'scheduled'
          ? '已发布，将在设定时间开始展示'
          : '已发布，打手端将自动更新'
      )
      editorOpen.value = false
    } catch (cause) {
      await handleError(cause, true)
    } finally {
      if (version === epoch) publishing.value = false
    }
  }
  async function publishRow(item: PlayerContentItem) {
    if (busy.value || !canEdit.value) return
    if (item.type === 'banner' && !item.image) {
      ElMessage.warning('请先编辑并上传轮播图片')
      return
    }
    if (
      !(await confirm(
        businessConfirmMessage(
          `确认发布「${item.title}」的已保存草稿？${item.published ? '它将替换当前发布版。' : '发布后打手端会按展示时间显示。'}`,
          [
            { label: '当前标题', value: item.title },
            { label: '内容类型', value: item.type === 'announcement' ? '滚动公告' : '图片轮播' },
            { label: '当前记录状态', value: statusLabels[item.status] },
            { label: '已保存修订', value: 'v' + item.revision },
            {
              label: '开始展示（北京时间）',
              value: item.startAt ? formatTime(item.startAt) : '发布后立即'
            },
            {
              label: '结束展示（北京时间）',
              value: item.endAt ? formatTime(item.endAt) : '长期展示'
            }
          ],
          '发布已保存的草稿版本；实际展示继续按原发布状态和展示时间核对。'
        ),
        '发布内容',
        '确认发布'
      ))
    )
      return
    saving.value = true
    const version = epoch
    try {
      const result = await request<PlayerContentItem>(
        `player-content/${encodeURIComponent(item.id)}/publish`,
        { revision: item.revision },
        'POST'
      )
      replaceItem(result)
      ElMessage.success(
        result.status === 'scheduled' ? '已发布，将在设定时间开始展示' : '内容已发布'
      )
    } catch (cause) {
      await handleError(cause)
    } finally {
      if (version === epoch) saving.value = false
    }
  }
  async function offlineRow(item: PlayerContentItem) {
    if (busy.value || !canEdit.value || !item.published || item.status === 'offline') return
    if (
      !(await confirm(
        businessConfirmMessage(
          `确认下架「${item.title}」？下架后打手端不再展示，草稿仍保留。`,
          [
            { label: '当前标题', value: item.title },
            { label: '内容类型', value: item.type === 'announcement' ? '滚动公告' : '图片轮播' },
            { label: '当前记录状态', value: statusLabels[item.status] },
            { label: '原记录修订', value: 'v' + item.revision },
            {
              label: '最近发布时间',
              value: item.published ? formatTime(item.published.publishedAt) : '尚未发布'
            }
          ],
          '下架只停止展示，保存草稿与最近发布版继续留存。'
        ),
        '下架内容',
        '确认下架'
      ))
    )
      return
    saving.value = true
    const version = epoch
    try {
      const result = await request<PlayerContentItem>(
        `player-content/${encodeURIComponent(item.id)}/offline`,
        { revision: item.revision },
        'POST'
      )
      replaceItem(result)
      ElMessage.success('内容已下架')
    } catch (cause) {
      await handleError(cause)
    } finally {
      if (version === epoch) saving.value = false
    }
  }
  async function deleteRow(item: PlayerContentItem) {
    if (busy.value || !canEdit.value || !['draft', 'offline'].includes(item.status)) return
    if (
      !(await confirm(
        businessConfirmMessage(
          `确认删除「${item.title}」？删除后无法从内容列表恢复，操作日志仍保留。`,
          [
            { label: '当前标题', value: item.title },
            { label: '内容类型', value: item.type === 'announcement' ? '滚动公告' : '图片轮播' },
            { label: '当前记录状态', value: statusLabels[item.status] },
            { label: '原记录修订', value: 'v' + item.revision },
            { label: '最近修改时间', value: formatTime(item.updatedAt) }
          ],
          '原删除资格和版本核验继续保留，删除不会清除操作日志。'
        ),
        '删除内容',
        '确认删除'
      ))
    )
      return
    saving.value = true
    const version = epoch
    try {
      await request<{ ok: true }>(
        `player-content/${encodeURIComponent(item.id)}/delete`,
        { revision: item.revision },
        'POST'
      )
      items.value = items.value.filter((entry) => entry.id !== item.id)
      ElMessage.success('内容已删除')
    } catch (cause) {
      await handleError(cause)
    } finally {
      if (version === epoch) saving.value = false
    }
  }
  async function selectImage(file: UploadFile) {
    if (!file.raw || busy.value || !canEdit.value) return
    if (!file.raw.size || file.raw.size > 8 * 1024 * 1024) {
      ElMessage.warning('图片大小应大于 0 且不超过 8 MB')
      return
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.raw.type)) {
      ElMessage.warning('请选择 JPG、PNG 或 WebP 图片')
      return
    }
    const version = epoch
    const actorId = user.value?.id
    uploading.value = true
    try {
      const image = await uploadStudioImage(file.raw)
      if (version === epoch && actorId === user.value?.id && !disposed) {
        form.value.image = image
        ElMessage.success('图片已上传，请保存草稿或发布')
      }
    } catch (cause) {
      if (version === epoch && actorId === user.value?.id && !disposed) {
        if ((cause as { status?: number }).status === 401) clearSession()
        await handleError(cause, true)
      }
    } finally {
      if (version === epoch) uploading.value = false
    }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (editorOpen.value && dirty.value) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  onBeforeRouteLeave(async (_to, from) => {
    if (busy.value) {
      ElMessage.warning('内容正在处理，请稍候再离开')
      return false
    }
    const secondary = Array.isArray(from.query.secondary)
      ? from.query.secondary
      : [from.query.secondary]
    // Routed editors retain the original closeEditor protection through Panel's stack guard.
    if (editorOpen.value && dirty.value && !secondary.includes('player-content-editor'))
      return confirm('当前编辑尚未保存，离开后将丢弃这些编辑。', '离开内容管理', '丢弃并离开')
    return true
  })
  watch(
    () => user.value?.id,
    () => {
      epoch++
      items.value = []
      contentReadComplete.value = false
      editorOpen.value = false
      previewOpen.value = false
      loadError.value = ''
      loading.value = false
      saving.value = false
      publishing.value = false
      uploading.value = false
      if (confirming.value) ElMessageBox.close()
      confirming.value = false
      if (user.value && canEdit.value) void reload(true)
    }
  )
  onMounted(() => {
    void reload()
    refreshTimer = setInterval(() => {
      if (!busy.value) void reload(true)
    }, 30000)
    window.addEventListener('beforeunload', beforeUnload)
  })
  onUnmounted(() => {
    disposed = true
    epoch++
    if (refreshTimer) clearInterval(refreshTimer)
    window.removeEventListener('beforeunload', beforeUnload)
  })
</script>

<style scoped lang="scss">
  .player-content-admin {
    min-width: 0;
  }
  .content-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin: 4px 0 20px;
  }
  .content-filters :deep(.el-input) {
    width: 260px;
  }
  .content-filters :deep(.el-select) {
    width: 140px;
  }
  .content-count,
  .content-hint,
  .content-footer {
    font-size: 12px;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
  }
  .content-count {
    margin-left: auto;
  }
  .content-summary {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .content-summary img {
    flex-shrink: 0;
    width: 84px;
    height: 52px;
    object-fit: cover;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 6px;
  }
  .content-summary > div {
    min-width: 0;
  }
  .content-summary strong {
    display: block;
    overflow-wrap: anywhere;
  }
  .content-summary p {
    display: -webkit-box;
    overflow: hidden;
    margin: 4px 0;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }
  .content-time {
    font-size: 12px;
    line-height: 1.8;
  }
  .content-footer {
    margin: 16px 0 0;
  }
  .content-editor-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 290px;
    gap: 24px;
  }
  .content-form {
    min-width: 0;
  }
  .content-live-preview h4 {
    margin: 0 0 12px;
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }
  .content-live-preview > p {
    margin-top: 12px;
    font-size: 12px;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
  }
  .content-schedule :deep(.el-date-editor),
  .content-schedule :deep(.el-input-number) {
    width: 100%;
  }
  .content-text-tip {
    margin: -8px 0 16px;
  }
  .content-image-control {
    position: relative;
    width: 100%;
    min-width: 220px;
    height: 155px;
    overflow: hidden;
    background: var(--el-fill-color-extra-light);
    border: 1px dashed var(--el-border-color);
    border-radius: 8px;
  }
  .content-image-control > img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .content-image-control > div {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;
    height: 120px;
    color: var(--el-text-color-secondary);
  }
  .content-image-control > span {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    padding: 6px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-light);
  }
  .content-image-control.is-disabled {
    opacity: 0.65;
  }
  .content-upload-note {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    width: 100%;
    margin-top: 7px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }
  .content-upload-note span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .content-editor-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
  }
  .content-editor-footer > span {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
  .content-editor-footer > div {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .content-editor-footer :deep(.el-button + .el-button) {
    margin-left: 0;
  }
  .content-conflict {
    padding: 16px;
    margin-bottom: 18px;
    background: var(--el-color-warning-light-9);
    border: 1px solid var(--el-color-warning-light-7);
    border-radius: 8px;
  }
  .content-conflict p {
    margin: 8px 0 12px;
    font-size: 12px;
    line-height: 1.7;
  }
  .content-conflict > div {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .content-conflict :deep(.el-button + .el-button) {
    margin-left: 0;
  }
  .preview-version {
    display: flex;
    justify-content: center;
    margin-bottom: 12px;
  }
  .preview-caption {
    margin: 0 0 14px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }
  @media (width <= 720px) {
    .content-editor-layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .content-live-preview {
      display: none;
    }
    .content-count {
      width: 100%;
      margin-left: 0;
    }
    .content-editor-footer {
      justify-content: flex-end;
    }
  }
</style>
