<template>
  <div class="appearance-page">
    <BusinessPageHeader
      title="界面外观"
      description="设置品牌、业务与登录背景、文案及毛玻璃效果。"
      icon="ri:palette-line"
      badge="工作室共享配置"
    >
      <template #actions>
        <ElButton :loading="store.loading" :disabled="busy || !canEdit" @click="reloadSaved"
          ><ArtSvgIcon icon="ri:refresh-line" class="mr-1" />读取已保存设置</ElButton
        >
        <ElButton
          v-if="canEdit"
          type="primary"
          :loading="store.saving"
          :disabled="locked || !dirty"
          @click="saveAppearance"
          ><ArtSvgIcon icon="ri:save-3-line" class="mr-1" />{{
            conflict ? '确认并保存草稿' : '保存到工作室'
          }}</ElButton
        >
      </template>
    </BusinessPageHeader>

    <ElAlert
      v-if="!canEdit"
      title="当前账号没有界面外观管理权限，无法编辑或保存工作室设置。"
      type="warning"
      :closable="false"
      show-icon
      class="mb-5"
    />
    <ElAlert
      v-else-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
      class="mb-5"
    />
    <div v-if="conflict" class="conflict-notice"
      ><ArtSvgIcon icon="ri:alert-line" /><div
        ><strong>其他管理员已更新外观，当前草稿已保留</strong
        ><p>{{
          latestRevision === null
            ? '请先读取最新已保存设置，再核对并确认是否使用当前草稿。'
            : `最新已保存名称：${store.saved.studioName}。继续保存需要再次确认替换共享配置。`
        }}</p></div
      ><ElButton :disabled="busy || !canEdit" @click="readLatestKeepingDraft"
        >读取最新设置</ElButton
      ></div
    >

    <div class="appearance-layout" v-loading="store.loading && !loaded">
      <ElCard shadow="never" class="appearance-editor">
        <ElTabs v-model="tab" :before-leave="() => !busy">
          <ElTabPane name="brand" label="品牌与页面背景" :disabled="busy" />
          <ElTabPane name="hero" label="主页横幅" :disabled="busy" />
          <ElTabPane name="login" label="登录外观" :disabled="busy" />
          <ElTabPane name="icons" label="菜单与快捷图标" :disabled="busy" />
        </ElTabs>
        <ElForm
          :model="form"
          label-position="top"
          :disabled="locked"
          @submit.prevent="saveAppearance"
        >
          <template v-if="tab === 'brand'">
            <section class="settings-section"
              ><div class="section-title"
                ><ArtSvgIcon icon="ri:building-4-line" /><div
                  ><h3>工作室品牌</h3
                  ><p>名称与 Logo 用于后台品牌区，浏览器标签图标沿用 Logo。</p></div
                ></div
              >
              <ElFormItem label="工作室名称" required
                ><ElInput
                  v-model="form.studioName"
                  maxlength="40"
                  show-word-limit
                  placeholder="输入工作室名称"
              /></ElFormItem>
              <ElFormItem label="全站毛玻璃效果">
                <div class="switch-control">
                  <ElSwitch v-model="form.glass.enabled" />
                  <span>{{
                    form.glass.enabled ? '卡片、顶栏与弹窗使用柔和透明表面' : '使用原不透明表面'
                  }}</span>
                </div>
                <p class="field-tip"
                  >支持浅色和深色；浏览器不支持模糊或偏好减少透明时，自动使用清晰表面。</p
                >
              </ElFormItem>
              <ElFormItem label="工作室 Logo"
                ><AppearanceImageUpload
                  label="Logo"
                  variant="square"
                  :image-url="form.logo?.url"
                  :filename="form.logo?.name"
                  recommended="建议正方形图像，透明 PNG 效果更好"
                  :disabled="locked"
                  @uploaded="setImage('logo', $event)"
                  @remove="removeImage('logo')"
                  @busy="uploading = $event"
              /></ElFormItem>
            </section>
            <section class="settings-section"
              ><div class="section-title"
                ><ArtSvgIcon icon="ri:landscape-line" /><div
                  ><h3>页面背景</h3><p>设置业务页面内容区的背景，表格与表单仍保持清晰可读。</p></div
                ></div
              >
              <ElFormItem label="背景类型"
                ><ElRadioGroup v-model="form.page.mode"
                  ><ElRadioButton value="default">原默认背景</ElRadioButton
                  ><ElRadioButton value="color">纯色</ElRadioButton
                  ><ElRadioButton value="image">图片</ElRadioButton></ElRadioGroup
                ></ElFormItem
              >
              <ElFormItem v-if="form.page.mode === 'color'" label="背景颜色（HEX）"
                ><div class="color-control"
                  ><ElColorPicker
                    :model-value="form.page.color"
                    color-format="hex"
                    :predefine="pageColors"
                    @update:model-value="updateColor('page', $event)" /><ElInput
                    v-model="form.page.color"
                    maxlength="7"
                    placeholder="#F5F8FC" /></div
              ></ElFormItem>
              <template v-if="form.page.mode === 'image'"
                ><ElFormItem label="页面背景图片"
                  ><AppearanceImageUpload
                    label="页面背景"
                    :image-url="form.page.image?.url"
                    :filename="form.page.image?.name"
                    recommended="建议横向图片，宽度 1920 像素以上"
                    :disabled="locked"
                    @uploaded="setImage('page', $event)"
                    @remove="removeImage('page')"
                    @busy="uploading = $event" /></ElFormItem
                ><ElFormItem label="图片遮罩强度"
                  ><div class="overlay-control"
                    ><ElSlider v-model="form.page.overlay" :min="0" :max="90" :step="1" /><span
                      >{{ form.page.overlay }}%</span
                    ></div
                  ><p class="field-tip">遮罩越强，图片越淡；深色模式使用深色遮罩。</p></ElFormItem
                ></template
              >
              <p v-if="form.page.mode === 'default'" class="default-hint"
                ><ArtSvgIcon icon="ri:check-double-line" />使用原浅色 /
                深色模式对应的默认页面背景。</p
              >
            </section>
          </template>

          <template v-else-if="tab === 'hero'">
            <section class="settings-section"
              ><div class="section-title"
                ><ArtSvgIcon icon="ri:dashboard-line" /><div
                  ><h3>主页欢迎横幅</h3><p>更换主页欢迎区背景，保留工作入口和原有业务内容。</p></div
                ></div
              >
              <ElFormItem label="背景类型"
                ><ElRadioGroup v-model="form.hero.mode"
                  ><ElRadioButton value="default">原蓝色渐变</ElRadioButton
                  ><ElRadioButton value="color">纯色</ElRadioButton
                  ><ElRadioButton value="image">图片</ElRadioButton></ElRadioGroup
                ></ElFormItem
              >
              <ElFormItem v-if="form.hero.mode === 'color'" label="横幅颜色（HEX）"
                ><div class="color-control"
                  ><ElColorPicker
                    :model-value="form.hero.color"
                    color-format="hex"
                    :predefine="heroColors"
                    @update:model-value="updateColor('hero', $event)" /><ElInput
                    v-model="form.hero.color"
                    maxlength="7"
                    placeholder="#80B7FF" /></div
              ></ElFormItem>
              <template v-if="form.hero.mode === 'image'"
                ><ElFormItem label="横幅背景图片"
                  ><AppearanceImageUpload
                    label="横幅背景"
                    :image-url="form.hero.image?.url"
                    :filename="form.hero.image?.name"
                    recommended="建议宽幅图片，主体避开左侧欢迎文字"
                    :disabled="locked"
                    @uploaded="setImage('hero', $event)"
                    @remove="removeImage('hero')"
                    @busy="uploading = $event" /></ElFormItem
                ><ElFormItem label="图片遮罩强度"
                  ><div class="overlay-control"
                    ><ElSlider v-model="form.hero.overlay" :min="0" :max="70" :step="1" /><span
                      >{{ form.hero.overlay }}%</span
                    ></div
                  ><p class="field-tip"
                    >调整背景图的遮罩，让欢迎文字与快捷入口更清晰。</p
                  ></ElFormItem
                ></template
              >
              <ElFormItem label="原玻璃装饰图"
                ><div class="switch-control"
                  ><ElSwitch v-model="form.hero.showDecoration" /><span>{{
                    form.hero.showDecoration ? '展示主页玻璃装饰图' : '隐藏装饰，突出自定义背景'
                  }}</span></div
                ></ElFormItem
              >
            </section>
          </template>

          <template v-else-if="tab === 'login'">
            <section class="settings-section">
              <div class="section-title"
                ><ArtSvgIcon icon="ri:login-box-line" /><div>
                  <h3>登录页面</h3><p>这里的品牌、背景和文字会在登录前公开展示。</p>
                </div></div
              >
              <ElFormItem label="登录标题" required
                ><ElInput v-model="form.login.title" maxlength="80" show-word-limit
              /></ElFormItem>
              <ElFormItem label="登录副标题"
                ><ElInput
                  v-model="form.login.subtitle"
                  type="textarea"
                  :rows="2"
                  maxlength="200"
                  show-word-limit
              /></ElFormItem>
              <ElFormItem label="登录说明"
                ><ElInput
                  v-model="form.login.description"
                  type="textarea"
                  :rows="3"
                  maxlength="800"
                  show-word-limit
              /></ElFormItem>
              <ElFormItem label="左侧大图"
                ><ElRadioGroup v-model="form.login.illustration.mode">
                  <ElRadioButton value="default">原默认大图</ElRadioButton>
                  <ElRadioButton value="image">自定义图片</ElRadioButton>
                </ElRadioGroup></ElFormItem
              >
              <ElFormItem v-if="form.login.illustration.mode === 'image'" label="左侧大图图片"
                ><AppearanceImageUpload
                  label="登录左侧大图"
                  :image-url="form.login.illustration.image?.url"
                  :filename="form.login.illustration.image?.name"
                  recommended="建议使用清晰的横向插图，图片会完整显示；保存后可在登录前查看"
                  :disabled="locked"
                  @uploaded="setImage('illustration', $event)"
                  @remove="removeImage('illustration')"
                  @busy="uploading = $event"
              /></ElFormItem>
              <p class="field-tip mb-5"
                >左侧大图与整页背景分别设置；窄屏登录页会自动收起左侧展示区。</p
              >
              <ElFormItem label="整页背景类型"
                ><ElRadioGroup v-model="form.login.background.mode">
                  <ElRadioButton value="default">原默认背景</ElRadioButton
                  ><ElRadioButton value="color">纯色</ElRadioButton
                  ><ElRadioButton value="image">图片</ElRadioButton>
                </ElRadioGroup></ElFormItem
              >
              <ElFormItem v-if="form.login.background.mode === 'color'" label="登录背景颜色（HEX）">
                <div class="color-control"
                  ><ElColorPicker
                    :model-value="form.login.background.color"
                    color-format="hex"
                    :predefine="pageColors"
                    @update:model-value="updateColor('login', $event)" /><ElInput
                    v-model="form.login.background.color"
                    maxlength="7"
                    placeholder="#EEF4FF"
                /></div>
              </ElFormItem>
              <template v-if="form.login.background.mode === 'image'">
                <ElFormItem label="登录背景图片"
                  ><AppearanceImageUpload
                    label="登录背景"
                    :image-url="form.login.background.image?.url"
                    :filename="form.login.background.image?.name"
                    recommended="此图片保存后可在登录前查看，请使用适合公开展示的图片"
                    :disabled="locked"
                    @uploaded="setImage('login', $event)"
                    @remove="removeImage('login')"
                    @busy="uploading = $event"
                /></ElFormItem>
                <ElFormItem label="图片遮罩强度"
                  ><div class="overlay-control"
                    ><ElSlider v-model="form.login.background.overlay" :min="0" :max="90" /><span
                      >{{ form.login.background.overlay }}%</span
                    ></div
                  ><p class="field-tip"
                    >浅色与深色模式使用对应遮罩，建议让登录文字保持清晰。</p
                  ></ElFormItem
                >
              </template>
              <p class="field-tip"
                >文案以纯文本显示。保存后刷新登录页即可查看；业务页面背景和菜单配置不会公开读取。</p
              >
            </section>
          </template>

          <template v-else>
            <section class="settings-section"
              ><div class="section-title"
                ><ArtSvgIcon icon="ri:apps-2-line" /><div
                  ><h3>菜单与快捷入口图标</h3
                  ><p>从预设图标中选择，菜单和主页快捷入口会使用同一套设置。</p></div
                ></div
              >
              <div class="icon-settings-grid"
                ><div
                  v-for="target in APPEARANCE_ICON_TARGETS"
                  :key="target.key"
                  class="icon-setting"
                  ><div class="icon-setting-label"
                    ><span class="icon-chip"><ArtSvgIcon :icon="iconFor(target.key)" /></span
                    ><strong>{{ target.label }}</strong
                    ><ElButton
                      link
                      :disabled="locked || !form.icons[target.key]"
                      @click="restoreIcon(target.key)"
                      >恢复原图标</ElButton
                    ></div
                  ><ElSelect
                    :model-value="iconFor(target.key)"
                    class="w-full"
                    filterable
                    @update:model-value="setIcon(target.key, $event)"
                    ><template #prefix><ArtSvgIcon :icon="iconFor(target.key)" /></template
                    ><ElOption
                      v-for="icon in APPEARANCE_ICON_OPTIONS"
                      :key="icon"
                      :label="iconLabel(icon)"
                      :value="icon"
                      ><div class="icon-option"
                        ><ArtSvgIcon :icon="icon" /><span>{{ iconLabel(icon) }}</span></div
                      ></ElOption
                    ></ElSelect
                  ></div
                ></div
              >
              <ElButton
                class="mt-5"
                :disabled="locked || !Object.keys(form.icons).length"
                @click="form.icons = {}"
                >恢复全部原图标</ElButton
              >
            </section>
          </template>
        </ElForm>
        <div class="editor-footer"
          ><div
            ><ElTag :type="!loaded ? 'info' : dirty ? 'warning' : 'success'" effect="plain">{{
              !loaded ? '等待读取已保存设置' : dirty ? '当前有未保存更改' : '与已保存设置一致'
            }}</ElTag
            ><span v-if="store.saved.updatedAt"
              >上次保存 {{ formatTime(store.saved.updatedAt) }}</span
            ></div
          ><ElButton type="danger" plain :disabled="locked" @click="restoreDefaults"
            >恢复工作室默认外观</ElButton
          ></div
        >
      </ElCard>

      <aside class="appearance-aside"
        ><ElCard shadow="never" class="preview-card"
          ><template #header
            ><div class="preview-heading"
              ><h3>草稿预览</h3
              ><ElTag :type="previewing ? 'primary' : 'info'" effect="plain" size="small">{{
                previewing ? '本窗口预览已应用' : '小预览随编辑更新'
              }}</ElTag></div
            ></template
          >
          <div
            v-if="tab === 'login'"
            class="mini-login"
            :class="{ 'mini-login-glass': form.glass.enabled }"
            :style="loginPreviewStyle"
          >
            <div class="mini-login-brand" :style="loginTextStyle"
              ><img v-if="form.logo" :src="form.logo.url" alt="Logo 草稿" /><strong>{{
                form.studioName
              }}</strong></div
            >
            <div class="mini-login-illustration">
              <img
                v-if="form.login.illustration.mode === 'image' && form.login.illustration.image"
                :src="form.login.illustration.image.url"
                alt="登录左侧大图草稿"
              />
              <ThemeSvg v-else :src="loginIcon" size="100%" />
            </div>
            <div class="mini-login-form"
              ><h3>{{ form.login.title }}</h3
              ><p>{{ form.login.subtitle }}</p
              ><div class="mini-login-field">工作室账号</div><div class="mini-login-field">密码</div
              ><small>{{ form.login.description }}</small
              ><div class="mini-login-button">登录</div></div
            >
          </div>
          <div
            v-else
            class="mini-layout"
            :class="{ 'mini-layout-glass': form.glass.enabled }"
            :style="pagePreviewStyle"
            ><div
              v-if="form.page.mode === 'image'"
              class="mini-page-veil"
              :style="{ opacity: form.page.overlay / 100 }" /><div class="mini-sidebar"
              ><div class="mini-brand"
                ><img v-if="form.logo" :src="form.logo.url" alt="Logo 草稿" /><ArtSvgIcon
                  v-else
                  icon="ri:gamepad-line"
                /><strong>{{ form.studioName || '工作室名称' }}</strong></div
              ><div
                v-for="item in previewMenus"
                :key="item.key"
                class="mini-menu"
                :class="{ 'is-current': item.key === 'dashboard' }"
                ><ArtSvgIcon :icon="iconFor(item.key)" /><span>{{ item.label }}</span></div
              ></div
            ><div class="mini-main"
              ><div class="mini-topbar"><span>业务后台</span><ArtSvgIcon icon="ri:user-line" /></div
              ><div class="mini-hero" :style="heroPreviewStyle"
                ><div
                  v-if="form.hero.mode === 'image'"
                  class="mini-hero-veil"
                  :style="{ opacity: form.hero.overlay / 100 }" /><img
                  v-if="form.hero.showDecoration"
                  :src="glassArt"
                  class="mini-glass"
                  alt="" /><div class="mini-hero-content"
                  ><strong>欢迎回来</strong><span>{{ form.studioName || '工作室名称' }}</span
                  ><div class="mini-shortcuts"
                    ><ArtSvgIcon :icon="iconFor('createOrder')" /><ArtSvgIcon
                      :icon="iconFor('finance')" /><ArtSvgIcon
                      :icon="iconFor('export')" /></div></div></div
              ><div class="mini-data-cards"
                ><div v-for="index in 4" :key="index"><i /><span /><span /></div></div></div
          ></div>
          <p class="preview-description"
            >小预览随编辑更新。点击“预览应用”可在当前窗口查看实际外观，登录页可在此预览。</p
          >
          <div class="preview-actions"
            ><ElButton type="primary" plain :disabled="locked" @click="applyPreview"
              ><ArtSvgIcon icon="ri:eye-line" class="mr-1" />预览应用</ElButton
            ><ElButton :disabled="busy || !previewing" @click="store.stopPreview"
              >停止预览</ElButton
            ></div
          > </ElCard
        ><ElCard shadow="never" class="scope-card"
          ><div class="scope-heading"
            ><ArtSvgIcon icon="ri:team-line" /><h3>保存后全工作室共享</h3></div
          ><p>预览只影响当前窗口，保存后其他成员刷新页面即可使用新的工作室外观。</p
          ><p>员工原有浅色 / 深色、主题色和布局偏好继续由个人设置管理。</p
          ><p>恢复默认会保存原外观配置，历史上传图片继续保留。</p></ElCard
        ></aside
      >
    </div>
  </div>
</template>

<script setup lang="ts">
  import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
  import { onBeforeRouteLeave, useRoute } from 'vue-router'
  import { ElMessage, ElMessageBox } from 'element-plus'
  import BusinessPageHeader from '@/components/business/BusinessPageHeader.vue'
  import AppearanceImageUpload from './modules/appearance-image-upload.vue'
  import { useAppearanceStore } from '@/store/modules/appearance'
  import { useStudio, formatTime } from '@/hooks/business/useStudio'
  import {
    appearanceBackgroundStyle,
    appearanceBackgroundTextStyle
  } from '@/hooks/business/useAppearance'
  import {
    APPEARANCE_ICON_OPTIONS,
    APPEARANCE_ICON_TARGETS,
    DEFAULT_APPEARANCE,
    type AppearanceConfig
  } from '@/types/appearance'
  import type { Attachment } from '@/types/studio'
  import glassArt from '@imgs/dashboard/overview-glass.svg'
  import loginIcon from '@imgs/svg/login_icon.svg'

  defineOptions({ name: 'Appearance' })
  const store = useAppearanceStore()
  const { can, user } = useStudio()
  const route = useRoute()
  const clone = (value: AppearanceConfig): AppearanceConfig => JSON.parse(JSON.stringify(value))
  const form = ref<AppearanceConfig>(clone(DEFAULT_APPEARANCE))
  const baseline = ref<AppearanceConfig>(clone(DEFAULT_APPEARANCE))
  const loaded = ref(false)
  const loadError = ref('')
  const uploading = ref(false)
  const confirming = ref(false)
  const conflict = ref(false)
  const latestRevision = ref<number | null>(null)
  const tab = ref('brand')
  const canEdit = computed(() => can('settings.manage'))
  const busy = computed(() => store.loading || store.saving || uploading.value || confirming.value)
  const locked = computed(
    () => busy.value || !canEdit.value || !loaded.value || Boolean(loadError.value)
  )
  const previewing = computed(() => store.draft !== null)
  const bodySignature = (value: AppearanceConfig) =>
    JSON.stringify({
      studioName: value.studioName,
      logo: value.logo,
      page: value.page,
      hero: value.hero,
      login: value.login,
      glass: value.glass,
      icons: value.icons
    })
  const dirty = computed(
    () => loaded.value && bodySignature(form.value) !== bodySignature(baseline.value)
  )
  const pageColors = ['#f5f8fc', '#eef4ff', '#f0fdf4', '#fffbeb', '#faf5ff', '#111827']
  const heroColors = ['#80b7ff', '#3478f6', '#8b5cf6', '#f59e0b', '#10b981', '#0f172a']
  const previewMenus = [
    { key: 'dashboard', label: '工作台' },
    { key: 'orderList', label: '订单管理' },
    { key: 'finance', label: '财务结算' },
    { key: 'appearance', label: '界面外观' }
  ]
  const iconLabels: Record<string, string> = {
    'ri:pie-chart-line': '环形统计',
    'ri:dashboard-line': '仪表盘',
    'ri:home-smile-2-line': '工作主页',
    'ri:file-list-3-line': '业务单据',
    'ri:list-check-2': '任务清单',
    'ri:add-box-line': '新增项目',
    'ri:wallet-3-line': '钱包',
    'ri:money-cny-circle-line': '人民币',
    'ri:funds-line': '经营趋势',
    'ri:calendar-check-line': '日历考勤',
    'ri:team-line': '团队',
    'ri:group-line': '人员组',
    'ri:user-settings-line': '人员权限',
    'ri:contacts-book-line': '客户档案',
    'ri:settings-3-line': '设置',
    'ri:palette-line': '配色外观',
    'ri:gamepad-line': '游戏项目',
    'ri:history-line': '历史记录',
    'ri:file-excel-2-line': 'Excel 表格',
    'ri:download-2-line': '下载',
    'ri:user-line': '个人资料',
    'ri:shield-check-line': '安全授权',
    'ri:star-line': '星标',
    'ri:customer-service-2-line': '客户服务'
  }
  const iconLabel = (icon: string) => iconLabels[icon] || '预设图标'
  const iconFor = (key: string) =>
    form.value.icons[key] ||
    APPEARANCE_ICON_TARGETS.find((target) => target.key === key)?.icon ||
    'ri:settings-3-line'
  const pagePreviewStyle = computed(() =>
    form.value.page.mode === 'color'
      ? { backgroundColor: form.value.page.color }
      : form.value.page.mode === 'image' && form.value.page.image
        ? {
            backgroundImage: `url(${JSON.stringify(form.value.page.image.url)})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }
        : {}
  )
  const heroPreviewStyle = computed(() =>
    form.value.hero.mode === 'color'
      ? { background: form.value.hero.color }
      : form.value.hero.mode === 'image' && form.value.hero.image
        ? {
            backgroundImage: `url(${JSON.stringify(form.value.hero.image.url)})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }
        : {}
  )
  const loginPreviewStyle = computed(() => appearanceBackgroundStyle(form.value.login.background))
  const loginTextStyle = computed(() => appearanceBackgroundTextStyle(form.value.login.background))
  const backgroundFor = (target: 'page' | 'hero' | 'login') =>
    target === 'login' ? form.value.login.background : form.value[target]

  function setImage(
    target: 'logo' | 'page' | 'hero' | 'login' | 'illustration',
    attachment: Attachment
  ) {
    if (!canEdit.value) return
    if (target === 'logo') form.value.logo = attachment
    else if (target === 'illustration') form.value.login.illustration.image = attachment
    else backgroundFor(target).image = attachment
  }
  function removeImage(target: 'logo' | 'page' | 'hero' | 'login' | 'illustration') {
    if (locked.value) return
    if (target === 'logo') form.value.logo = null
    else if (target === 'illustration')
      form.value.login.illustration = { mode: 'default', image: null }
    else {
      const background = backgroundFor(target)
      background.image = null
      if (background.mode === 'image') background.mode = 'default'
    }
  }
  function updateColor(target: 'page' | 'hero' | 'login', value: string | null | undefined) {
    if (!locked.value && value) backgroundFor(target).color = value
  }
  function setIcon(key: string, value: string) {
    if (
      locked.value ||
      !APPEARANCE_ICON_TARGETS.some((target) => target.key === key) ||
      !APPEARANCE_ICON_OPTIONS.some((icon) => icon === value)
    )
      return
    const original = APPEARANCE_ICON_TARGETS.find((target) => target.key === key)?.icon
    if (value === original) delete form.value.icons[key]
    else form.value.icons[key] = value
  }
  function restoreIcon(key: string) {
    if (!locked.value) delete form.value.icons[key]
  }
  function validationMessage(value: AppearanceConfig): string {
    const name = value.studioName.trim()
    if (
      !name ||
      name.length > 40 ||
      [...name].some(
        (character) =>
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127 ||
          '<>'.includes(character)
      )
    )
      return '工作室名称需为 1 至 40 个字符，不含 HTML 符号'
    for (const [text, label, max] of [
      [value.login.title, '登录标题', 80],
      [value.login.subtitle, '登录副标题', 200],
      [value.login.description, '登录说明', 800]
    ] as const) {
      if (
        text.trim().length > max ||
        /[<>]/.test(text) ||
        [...text].some((character) => {
          const code = character.charCodeAt(0)
          return (code < 32 && ![9, 10, 13].includes(code)) || code === 127
        })
      )
        return `${label}需为纯文本，最多 ${max} 个字符`
    }
    if (!value.login.title.trim()) return '请填写登录标题'
    if (value.login.illustration.mode === 'image' && !value.login.illustration.image)
      return '请先上传登录左侧大图'
    if (typeof value.glass.enabled !== 'boolean') return '请选择是否启用毛玻璃'
    const loginBackground = value.login.background
    if (!/^#[0-9a-fA-F]{6}$/.test(loginBackground.color)) return '登录背景颜色需为 #RRGGBB 格式'
    if (
      !Number.isInteger(loginBackground.overlay) ||
      loginBackground.overlay < 0 ||
      loginBackground.overlay > 90
    )
      return '登录背景遮罩应为0至90%'
    if (loginBackground.mode === 'image' && !loginBackground.image) return '请先上传登录背景图片'
    for (const [key, label, max] of [
      ['page', '页面', 90],
      ['hero', '横幅', 70]
    ] as const) {
      const background = value[key]
      if (!/^#[0-9a-fA-F]{6}$/.test(background.color)) return `${label}背景颜色需为 #RRGGBB 格式`
      if (
        !Number.isInteger(background.overlay) ||
        background.overlay < 0 ||
        background.overlay > max
      )
        return `${label}图片遮罩强度应为 0 至 ${max}%`
      if (background.mode === 'image' && !background.image) return `请先上传${label}背景图片`
    }
    if (
      Object.entries(value.icons).some(
        ([key, icon]) =>
          !APPEARANCE_ICON_TARGETS.some((target) => target.key === key) ||
          !APPEARANCE_ICON_OPTIONS.some((option) => option === icon)
      )
    )
      return '请从预设图标中选择菜单图标'
    return ''
  }
  function applyPreview() {
    if (locked.value) return
    const message = validationMessage(form.value)
    if (message) return void ElMessage.warning(message)
    store.beginPreview(clone(form.value))
    ElMessage.success('已在当前窗口应用草稿预览')
  }
  function acceptSaved(value: AppearanceConfig) {
    form.value = clone(value)
    baseline.value = clone(value)
    loaded.value = true
    loadError.value = ''
    conflict.value = false
    latestRevision.value = null
  }
  const errorText = (cause: unknown) =>
    cause instanceof Error ? cause.message : '操作失败，请稍后重试'
  async function initialize() {
    if (!user.value || !canEdit.value || store.saving || uploading.value || confirming.value) return
    loadError.value = ''
    try {
      acceptSaved(await store.load())
    } catch (cause) {
      loadError.value = errorText(cause)
      ElMessage.error(loadError.value)
    }
  }
  async function confirmDiscard(message: string) {
    confirming.value = true
    try {
      await ElMessageBox.confirm(message, '尚有未保存更改', {
        confirmButtonText: '放弃更改',
        cancelButtonText: '继续编辑',
        type: 'warning',
        closeOnClickModal: false
      })
      return true
    } catch {
      return false
    } finally {
      confirming.value = false
    }
  }
  async function reloadSaved() {
    if (busy.value || !canEdit.value) return
    if (
      dirty.value &&
      !(await confirmDiscard('重新读取会放弃当前未保存草稿，并停止本窗口的临时预览。'))
    )
      return
    store.stopPreview()
    if (loaded.value) acceptSaved(store.saved)
    await initialize()
  }
  async function readLatestKeepingDraft() {
    if (busy.value || !canEdit.value) return
    try {
      const latest = await store.load()
      latestRevision.value = latest.revision
      baseline.value = clone(latest)
      loadError.value = ''
      ElMessage.success('最新设置已读取，当前编辑草稿保持不变')
    } catch (cause) {
      ElMessage.error(errorText(cause))
    }
  }
  async function saveAppearance() {
    if (locked.value || !dirty.value) return
    const message = validationMessage(form.value)
    if (message) return void ElMessage.warning(message)
    const candidate = clone(form.value)
    candidate.studioName = candidate.studioName.trim()
    if (conflict.value) {
      if (latestRevision.value === null)
        return void ElMessage.warning('请先读取最新已保存设置，再确认保存当前草稿')
      confirming.value = true
      try {
        await ElMessageBox.confirm(
          `最新共享名称为“${store.saved.studioName}”。确认使用当前页面草稿替换最新外观设置？`,
          '核对并保存当前草稿',
          {
            confirmButtonText: '确认替换并保存',
            cancelButtonText: '继续核对',
            type: 'warning',
            closeOnClickModal: false
          }
        )
      } catch {
        return
      } finally {
        confirming.value = false
      }
      if (!canEdit.value) return
      candidate.revision = latestRevision.value
    }
    try {
      acceptSaved(await store.save(candidate))
      ElMessage.success('工作室外观已保存，其他成员刷新后生效')
    } catch (cause) {
      if ((cause as { status?: number })?.status === 409) {
        conflict.value = true
        latestRevision.value = null
        ElMessage.warning('外观设置已被其他管理员更新。草稿已保留，请读取最新设置后重新确认。')
      } else ElMessage.error(errorText(cause))
    }
  }
  async function restoreDefaults() {
    if (locked.value) return
    if (conflict.value && latestRevision.value === null)
      return void ElMessage.warning('请先读取最新已保存设置，再确认恢复默认')
    const revision = conflict.value ? latestRevision.value! : form.value.revision
    confirming.value = true
    try {
      await ElMessageBox.confirm(
        '将品牌、页面背景、主页横幅、登录背景与文案、毛玻璃和菜单图标恢复为默认外观并保存。历史上传图片继续保留。',
        '恢复工作室默认外观',
        {
          confirmButtonText: '确认恢复并保存',
          cancelButtonText: '取消',
          type: 'warning',
          closeOnClickModal: false
        }
      )
    } catch {
      return
    } finally {
      confirming.value = false
    }
    if (!canEdit.value) return
    try {
      acceptSaved(await store.reset(revision))
      ElMessage.success('工作室默认外观已恢复')
    } catch (cause) {
      if ((cause as { status?: number })?.status === 409) {
        conflict.value = true
        latestRevision.value = null
        ElMessage.warning('共享设置已更新，请先读取并核对最新设置')
      } else ElMessage.error(errorText(cause))
    }
  }
  watch(
    form,
    () => {
      if (previewing.value && canEdit.value && !validationMessage(form.value))
        store.beginPreview(clone(form.value))
    },
    { deep: true }
  )
  watch(
    canEdit,
    (allowed) => {
      if (!allowed) store.stopPreview()
      else if (!loaded.value && route.path === '/system/appearance') void initialize()
    },
    { flush: 'sync' }
  )
  watch(
    () => store.saved,
    (value) => {
      if (loaded.value && !dirty.value && !conflict.value) acceptSaved(value)
    }
  )
  function beforeUnload(event: BeforeUnloadEvent) {
    if (route.path === '/system/appearance' && (dirty.value || busy.value)) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  onBeforeRouteLeave(async () => {
    if (!user.value) {
      store.stopPreview()
      return true
    }
    if (busy.value) {
      ElMessage.warning('正在上传、保存或确认，请稍后离开')
      return false
    }
    if (
      dirty.value &&
      !(await confirmDiscard(
        '离开页面会放弃尚未保存的外观草稿。已上传的图片保留，本窗口临时预览会停止。'
      ))
    )
      return false
    store.stopPreview()
    acceptSaved(store.saved)
    return true
  })
  let activatedOnce = false
  onActivated(() => {
    if (!activatedOnce) {
      activatedOnce = true
      return
    }
    if (!dirty.value && !busy.value) void initialize()
  })
  onDeactivated(() => store.stopPreview())
  onMounted(() => {
    window.addEventListener('beforeunload', beforeUnload)
    void initialize()
  })
  onUnmounted(() => {
    window.removeEventListener('beforeunload', beforeUnload)
    store.stopPreview()
  })
  watch(
    () => user.value?.id,
    (value, previous) => {
      if (value !== previous && previous !== undefined) {
        store.stopPreview()
        loaded.value = false
        form.value = clone(DEFAULT_APPEARANCE)
        baseline.value = clone(DEFAULT_APPEARANCE)
        if (value && route.path === '/system/appearance') void initialize()
      }
    },
    { flush: 'sync' }
  )
</script>

<style scoped lang="scss">
  .mini-login {
    min-height: 340px;
    padding: 18px;
    background: var(--el-color-primary-light-9);
    border-radius: 12px;
  }

  .mini-login-brand {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 18px;
    font-size: 12px;
    color: var(--appearance-background-text, var(--art-gray-900));

    img {
      width: 24px;
      height: 24px;
      object-fit: contain;
    }
  }

  .mini-login-form {
    padding: 18px;
    overflow-wrap: anywhere;
    background: var(--default-box-color);
    border: 1px solid var(--default-border);
    border-radius: 12px;

    h3 {
      font-size: 16px;
      font-weight: 600;
    }

    p,
    small {
      display: block;
      margin-top: 10px;
      font-size: 10px;
      color: var(--art-gray-600);
      white-space: pre-line;
    }
  }

  .mini-login-illustration {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 140px;
    margin-bottom: 18px;

    img,
    :deep(svg) {
      width: 100%;
      max-height: 140px;
      object-fit: contain;
    }
  }

  .mini-login-field {
    padding: 8px;
    margin-top: 12px;
    font-size: 10px;
    color: var(--art-gray-500);
    border: 1px solid var(--default-border);
    border-radius: 6px;
  }

  .mini-login-button {
    padding: 8px;
    margin-top: 14px;
    font-size: 11px;
    color: white;
    text-align: center;
    background: var(--theme-color);
    border-radius: 6px;
  }

  @supports ((backdrop-filter: blur(10px)) or (-webkit-backdrop-filter: blur(10px))) {
    .mini-login-glass .mini-login-form,
    .mini-layout-glass .mini-sidebar,
    .mini-layout-glass .mini-topbar,
    .mini-layout-glass .mini-data-cards > div {
      background: color-mix(in srgb, var(--default-box-color) 88%, transparent);
      -webkit-backdrop-filter: blur(10px);
      backdrop-filter: blur(10px);
    }
  }

  .appearance-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 20px;
    align-items: start;
  }

  .appearance-editor {
    min-width: 0;
  }

  .appearance-aside {
    position: sticky;
    top: 90px;
    display: grid;
    gap: 16px;
    min-width: 0;
  }

  .settings-section {
    padding: 18px 0 10px;

    & + & {
      padding-top: 24px;
      margin-top: 6px;
      border-top: 1px solid var(--el-border-color-light);
    }
  }

  .section-title {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-bottom: 22px;

    > :deep(.art-svg-icon) {
      width: 22px;
      height: 22px;
      color: var(--el-color-primary);
    }

    h3 {
      font-size: 15px;
      font-weight: 600;
    }

    p {
      margin-top: 5px;
      font-size: 12px;
      line-height: 1.8;
      color: var(--el-text-color-secondary);
    }
  }

  .color-control {
    display: flex;
    gap: 12px;
    align-items: center;
    width: 240px;
    max-width: 100%;
  }

  .overlay-control {
    display: flex;
    gap: 18px;
    align-items: center;
    width: 100%;
    max-width: 420px;

    .el-slider {
      flex: 1;
      min-width: 0;
    }

    span {
      flex: 0 0 38px;
      font-size: 13px;
      color: var(--el-text-color-secondary);
    }
  }

  .field-tip {
    width: 100%;
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
  }

  .switch-control {
    display: flex;
    gap: 12px;
    align-items: center;

    span {
      font-size: 13px;
      color: var(--el-text-color-secondary);
    }
  }

  .default-hint {
    display: flex;
    gap: 7px;
    align-items: center;
    padding: 12px 14px;
    font-size: 13px;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-extra-light);
    border-radius: 10px;
  }

  .icon-settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }

  .icon-setting {
    padding: 14px;
    background: var(--el-fill-color-extra-light);
    border: 1px solid var(--el-border-color-light);
    border-radius: 12px;
  }

  .icon-setting-label {
    display: flex;
    gap: 9px;
    align-items: center;
    margin-bottom: 12px;

    strong {
      font-size: 13px;
      font-weight: 500;
    }

    .el-button {
      margin-left: auto;
      font-size: 11px;
    }
  }

  .icon-chip {
    display: grid;
    flex: 0 0 30px;
    place-items: center;
    height: 30px;
    font-size: 17px;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-radius: 8px;
  }

  .icon-option {
    display: flex;
    gap: 10px;
    align-items: center;

    :deep(.art-svg-icon) {
      width: 18px;
      height: 18px;
      font-size: 18px;
    }
  }

  .editor-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
    justify-content: space-between;
    padding-top: 20px;
    margin-top: 16px;
    border-top: 1px solid var(--el-border-color-light);

    > div {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    span {
      font-size: 12px;
      color: var(--el-text-color-secondary);
    }
  }

  .preview-heading {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    h3 {
      font-size: 15px;
      font-weight: 600;
    }
  }

  .mini-layout {
    position: relative;
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    min-height: 235px;
    overflow: hidden;
    background: var(--el-fill-color-light);
    border: 1px solid var(--el-border-color-light);
    border-radius: 12px;
  }

  .mini-page-veil {
    position: absolute;
    inset: 0;
    background: #fff;
  }

  .mini-sidebar {
    position: relative;
    z-index: 1;
    padding: 12px 8px;
    background: var(--el-bg-color);
    border-right: 1px solid var(--el-border-color-extra-light);
  }

  .mini-brand {
    display: flex;
    gap: 5px;
    align-items: center;
    margin-bottom: 15px;
    color: var(--el-color-primary);

    img {
      width: 17px;
      height: 17px;
      object-fit: contain;
    }

    strong {
      min-width: 0;
      font-size: 8px;
      overflow-wrap: anywhere;
    }

    > :deep(.art-svg-icon) {
      width: 17px;
      height: 17px;
    }
  }

  .mini-menu {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 7px 3px;
    margin-bottom: 7px;
    font-size: 8px;
    color: var(--el-text-color-secondary);
    border-radius: 5px;

    &.is-current {
      color: var(--el-color-primary);
      background: var(--el-color-primary-light-9);
    }

    :deep(.art-svg-icon) {
      width: 11px;
      height: 11px;
    }
  }

  .mini-main {
    position: relative;
    z-index: 1;
    min-width: 0;
    padding: 0 10px 12px;
  }

  .mini-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 31px;
    font-size: 8px;
    color: var(--el-text-color-secondary);
  }

  .mini-hero {
    position: relative;
    min-height: 108px;
    padding: 15px 12px;
    overflow: hidden;
    background: linear-gradient(120deg, #70b2ff, #bedcff);
    border-radius: 9px;
  }

  .mini-hero-veil {
    position: absolute;
    inset: 0;
    background: #fff;
  }

  .mini-glass {
    position: absolute;
    right: -10px;
    bottom: -5px;
    width: 110px;
    opacity: 0.85;
  }

  .mini-hero-content {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;

    strong {
      font-size: 11px;
      color: #173d74;
    }

    > span {
      font-size: 8px;
      color: #365d94;
    }
  }

  .mini-shortcuts {
    display: flex;
    gap: 6px;
    margin-top: 4px;

    :deep(.art-svg-icon) {
      width: 22px;
      height: 22px;
      padding: 4px;
      color: #25589c;
      background: rgb(255 255 255 / 55%);
      border-radius: 5px;
    }
  }

  .mini-data-cards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin-top: 12px;

    > div {
      padding: 9px;
      background: var(--el-bg-color);
      border: 1px solid var(--el-border-color-extra-light);
      border-radius: 6px;
    }

    i,
    span {
      display: block;
      height: 4px;
      margin-bottom: 5px;
      background: var(--el-fill-color-darker);
      border-radius: 2px;
    }

    i {
      width: 24px;
      background: var(--el-color-primary-light-8);
    }

    span:last-child {
      width: 60%;
      margin-bottom: 0;
    }
  }

  .preview-description {
    margin-top: 16px;
    font-size: 12px;
    line-height: 1.8;
    color: var(--el-text-color-secondary);
  }

  .preview-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 16px;

    .el-button {
      margin-left: 0;
    }
  }

  .scope-heading {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--el-color-primary);

    h3 {
      font-size: 14px;
      font-weight: 600;
      color: var(--el-text-color-primary);
    }
  }

  .scope-card p {
    margin-top: 12px;
    font-size: 12px;
    line-height: 1.8;
    color: var(--el-text-color-secondary);
  }

  .conflict-notice {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
    padding: 16px 20px;
    margin-bottom: 20px;
    background: var(--el-color-warning-light-9);
    border: 1px solid var(--el-color-warning-light-5);
    border-radius: 12px;

    > :deep(.art-svg-icon) {
      width: 20px;
      height: 20px;
      color: var(--el-color-warning);
    }

    > div {
      flex: 1;
      min-width: 200px;
    }

    strong {
      font-size: 14px;
    }

    p {
      margin-top: 6px;
      font-size: 13px;
      line-height: 1.7;
      color: var(--el-text-color-secondary);
    }
  }

  :global(.dark .appearance-page .mini-page-veil),
  :global(.dark .appearance-page .mini-hero-veil) {
    background: #0f172a;
  }

  @media (width < 1200px) {
    .appearance-layout {
      grid-template-columns: minmax(0, 1fr) 310px;
    }

    .icon-settings-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (width < 900px) {
    .appearance-layout {
      grid-template-columns: 1fr;
      gap: 16px;
    }

    .appearance-aside {
      position: static;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (width < 640px) {
    .appearance-aside {
      grid-template-columns: 1fr;
    }

    .icon-settings-grid {
      gap: 12px;
    }

    .editor-footer {
      flex-direction: column;
      align-items: flex-start;
    }

    .mini-layout {
      min-height: 240px;
    }
  }
</style>
