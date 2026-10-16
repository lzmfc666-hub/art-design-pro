import { randomUUID } from 'node:crypto'
import { ApiError, permissionsFor, playerAccess } from './studio.mjs'

const fail = (message, status = 400) => {
  throw new ApiError(message, status)
}
const copy = (value) => JSON.parse(JSON.stringify(value))
const FIELDS = ['type', 'title', 'text', 'body', 'imageId', 'sortOrder', 'startAt', 'endAt']
const allowed = new Set(['id', 'revision', ...FIELDS])
const rows = (state) => state.playerContents || []
const manager = (user) => {
  if (
    user.status !== 'active' ||
    user.role === 'player' ||
    !permissionsFor(user).includes('settings.manage')
  )
    fail('没有管理打手端内容的权限', 403)
}
const worker = (user) => {
  if (user.status !== 'active' || user.role !== 'player' || !playerAccess(user).login)
    fail('此接口仅供启用中的打手账号使用', 403)
}
const revision = (value, row) => {
  if (!Number.isSafeInteger(value) || value !== row.revision)
    fail('内容已被其他人修改，请刷新后再操作', 409)
}
const plainText = (value, label, max) => {
  if (typeof value !== 'string') fail(`${label}必须为文本`)
  const result = value.trim()
  if (result.length > max) fail(`${label}不能超过 ${max} 字`)
  if (/<\s*\/?\s*[a-z!][^>]*>/i.test(result) || result.includes('\u0000'))
    fail(`${label}仅支持纯文本，不能包含 HTML`)
  return result
}
function isoTime(value, label) {
  if (value === null) return null
  if (typeof value !== 'string') fail(`${label}须为有效 ISO 时间或空值`)
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
  )
  if (!match) fail(`${label}须为带时区的有效 ISO 时间`)
  const [, year, month, day, hour, minute, second, , zone] = match
  const local = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`)
  if (
    !Number.isFinite(local.getTime()) ||
    local.toISOString().slice(0, 19) !== `${year}-${month}-${day}T${hour}:${minute}:${second}` ||
    (zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 14 ||
        Number(zone.slice(4)) > 59 ||
        (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0)))
  )
    fail(`${label}无效`)
  const time = new Date(value)
  if (!Number.isFinite(time.getTime())) fail(`${label}无效`)
  return time.toISOString()
}
const references = (value, attachmentId) => {
  if (!value || typeof value !== 'object') return false
  if (value.id === attachmentId) return true
  return Object.values(value).some((entry) => references(entry, attachmentId))
}
export const isPlayerContentAttachment = (state, attachmentId) =>
  rows(state).some(
    (row) => row.imageId === attachmentId || row.published?.image?.id === attachmentId
  )

function sensitiveImage({ db, state }, attachmentId) {
  if (db.prepare('SELECT 1 FROM player_private_uploads WHERE attachment_id=?').get(attachmentId))
    return true
  if (
    ['orders', 'refunds', 'withdrawals', 'expenses', 'users'].some((key) =>
      references(state[key], attachmentId)
    )
  )
    return true
  return Boolean(
    db
      .prepare("SELECT 1 FROM fund_transactions WHERE json_extract(receipt_json,'$.id')=? LIMIT 1")
      .get(attachmentId)
  )
}
function imageRecord(context, attachmentId, includeData = false) {
  // Feed polling only needs the signature and stored length, not the complete image BLOB.
  const record = context.db
    .prepare(
      includeData
        ? 'SELECT id,owner_id,name,mime,size,data FROM uploads WHERE id=?'
        : 'SELECT id,owner_id,name,mime,size,length(data) AS dataLength,substr(data,1,12) AS prefix FROM uploads WHERE id=?'
    )
    .get(attachmentId)
  if (!record) fail('板报图片不存在，请重新上传')
  if (sensitiveImage(context, attachmentId))
    fail('不能把私人收款码、头像或业务凭证用作板报图片', 403)
  const data = Buffer.from(includeData ? record.data.subarray(0, 12) : record.prefix)
  const dataLength = includeData ? record.data.length : record.dataLength
  const signature =
    record.mime === 'image/png'
      ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : record.mime === 'image/jpeg'
        ? dataLength > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255
        : record.mime === 'image/webp' &&
          data.length >= 12 &&
          data.toString('ascii', 0, 4) === 'RIFF' &&
          data.toString('ascii', 8, 12) === 'WEBP'
  if (!signature || record.size < 1 || record.size > 8 * 1024 * 1024 || record.size !== dataLength)
    fail('板报图片须为不超过 8MB 的真实 PNG、JPG 或 WebP 图片')
  return record
}
const imageMetadata = (record, audience) => ({
  id: record.id,
  name: record.name,
  mime: record.mime,
  size: record.size,
  url: `/api/studio/${audience === 'player' ? 'player/content-assets' : 'player-content/assets'}/${record.id}`
})
const publication = (value, audience) => ({
  id: value.id,
  type: value.type,
  title: value.title,
  text: value.text,
  body: value.body,
  image: value.image ? imageMetadata(value.image, audience) : null,
  sortOrder: value.sortOrder,
  startAt: value.startAt,
  endAt: value.endAt,
  publishedAt: value.publishedAt
})
const status = (row, now) => {
  if (!row.published) return 'draft'
  if (!row.enabled) return 'offline'
  if (row.published.endAt && row.published.endAt <= now) return 'expired'
  if (row.published.startAt && row.published.startAt > now) return 'scheduled'
  return 'active'
}
const comparable = (value) =>
  Object.fromEntries(
    FIELDS.map((field) => [
      field,
      field === 'imageId' ? (value.imageId ?? value.image?.id ?? null) : value[field]
    ])
  )
const adminItem = (row, now, db) => ({
  id: row.id,
  revision: row.revision,
  ...Object.fromEntries(FIELDS.map((field) => [field, row[field]])),
  image: row.imageId
    ? imageMetadata(
        db.prepare('SELECT id,name,mime,size FROM uploads WHERE id=?').get(row.imageId),
        'admin'
      )
    : null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
  status: status(row, now),
  hasUnpublishedChanges:
    !row.published || JSON.stringify(comparable(row)) !== JSON.stringify(comparable(row.published)),
  published: row.published ? publication(row.published, 'admin') : null
})
const sorted = (values) =>
  values.sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
  )

function normalizeDraft(context, body, existing) {
  if (Object.keys(body).some((key) => !allowed.has(key)))
    fail('内容字段无效，仅支持文字和已上传图片')
  if (!['announcement', 'banner'].includes(body.type)) fail('内容类型无效')
  const title = plainText(body.title, '标题', 80)
  if (!title) fail('标题不能为空')
  const text = plainText(body.text, '公告文字', 300)
  const detail = plainText(body.body, '详情', 20000)
  if (!Number.isSafeInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 9999)
    fail('排序须为 0 至 9999 的整数')
  if (
    body.imageId !== null &&
    (typeof body.imageId !== 'string' || !body.imageId || body.imageId.length > 100)
  )
    fail('图片编号无效')
  if (body.type === 'announcement' && body.imageId !== null) fail('滚动公告不能设置轮播图片')
  if (body.imageId) {
    const record = imageRecord(context, body.imageId)
    if (
      record.owner_id !== context.user.id &&
      existing?.imageId !== body.imageId &&
      existing?.published?.image?.id !== body.imageId
    )
      fail('板报图片必须由当前账号上传，或复用本条内容已有图片', 403)
  }
  const startAt = isoTime(body.startAt, '开始时间'),
    endAt = isoTime(body.endAt, '结束时间')
  if (startAt && endAt && endAt <= startAt) fail('结束时间必须晚于开始时间')
  return {
    type: body.type,
    title,
    text,
    body: detail,
    imageId: body.imageId,
    sortOrder: body.sortOrder,
    startAt,
    endAt
  }
}

export function mutatePlayerContent(context) {
  const { state, user, path, body, now, audit } = context
  const actionMatch = path.match(/^\/player-content\/([^/]+)\/(publish|offline|delete)$/)
  if (path !== '/player-content' && !actionMatch) return undefined
  manager(user)
  state.playerContents ||= []
  let row
  if (path === '/player-content') {
    if (body.id !== undefined && (typeof body.id !== 'string' || !body.id || body.id.length > 100))
      fail('内容编号无效')
    row = body.id ? rows(state).find((entry) => entry.id === body.id) : null
    if (body.id && !row) fail('内容不存在', 404)
    if (row) revision(body.revision, row)
    else if (body.revision !== undefined) fail('新内容不能指定版本')
    if (!row && rows(state).length >= 100)
      fail('最多保留 100 条内容，请删除不再使用的草稿或下架内容', 409)
    const draft = normalizeDraft(context, body, row)
    const before = row ? copy(row) : null
    if (row)
      Object.assign(row, draft, { revision: row.revision + 1, updatedAt: now, updatedBy: user.id })
    else {
      row = {
        id: randomUUID(),
        revision: 1,
        ...draft,
        createdAt: now,
        updatedAt: now,
        updatedBy: user.id,
        published: null,
        enabled: false
      }
      rows(state).push(row)
    }
    audit(
      before ? '修改打手端内容草稿' : '新增打手端内容草稿',
      'player-content',
      row.id,
      before,
      copy(row)
    )
    return adminItem(row, now, context.db)
  }
  if (Object.keys(body).some((key) => key !== 'revision')) fail('操作字段无效')
  row = rows(state).find((entry) => entry.id === actionMatch[1])
  if (!row) fail('内容不存在', 404)
  revision(body.revision, row)
  const before = copy(row),
    action = actionMatch[2]
  if (action === 'delete') {
    if (row.published && row.enabled) fail('请先下架内容再删除', 409)
    state.playerContents = rows(state).filter((entry) => entry.id !== row.id)
    audit('删除打手端内容', 'player-content', row.id, before, null)
    return { ok: true }
  }
  if (action === 'publish') {
    normalizeDraft(context, Object.fromEntries(FIELDS.map((field) => [field, row[field]])), row)
    if (row.endAt && row.endAt <= now) fail('内容已超过结束时间，请调整时间后发布', 409)
    if (row.type === 'announcement' && !row.text) fail('请填写滚动公告文字后发布')
    if (row.type === 'banner' && !row.imageId) fail('请上传轮播图片后发布')
    const image = row.imageId ? imageRecord(context, row.imageId) : null
    row.published = {
      id: row.id,
      ...Object.fromEntries(
        FIELDS.filter((field) => field !== 'imageId').map((field) => [field, row[field]])
      ),
      image: image ? { id: image.id, name: image.name, mime: image.mime, size: image.size } : null,
      publishedAt: now
    }
    row.enabled = true
  } else {
    if (!row.published || !row.enabled) fail('此内容尚未发布或已经下架', 409)
    row.enabled = false
  }
  row.revision += 1
  row.updatedAt = now
  row.updatedBy = user.id
  audit(
    action === 'publish' ? '发布打手端内容' : '下架打手端内容',
    'player-content',
    row.id,
    before,
    copy(row)
  )
  return adminItem(row, now, context.db)
}

export function adminPlayerContent({ state, user, now, db }) {
  manager(user)
  return { items: sorted([...rows(state)]).map((row) => adminItem(row, now, db)), serverTime: now }
}
export function playerContent(context, contentId) {
  worker(context.user)
  const active = rows(context.state)
    .filter((row) => status(row, context.now) === 'active')
    .sort(
      (a, b) =>
        a.published.sortOrder - b.published.sortOrder ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id)
    )
    .filter((row) => {
      if (!row.published.image) return true
      try {
        imageRecord(context, row.published.image.id)
        return true
      } catch {
        return false
      }
    })
    .map((row) => publication(row.published, 'player'))
  if (contentId !== undefined)
    return active.find((row) => row.id === contentId) || fail('内容不存在或已下架', 404)
  return {
    announcements: active.filter((row) => row.type === 'announcement'),
    banners: active.filter((row) => row.type === 'banner'),
    serverTime: context.now
  }
}
export function playerContentAsset(context, attachmentId, audience) {
  if (audience === 'player') {
    worker(context.user)
    if (
      !rows(context.state).some(
        (row) => status(row, context.now) === 'active' && row.published.image?.id === attachmentId
      )
    )
      fail('板报图片不存在或已下架', 404)
  } else {
    manager(context.user)
    if (!isPlayerContentAttachment(context.state, attachmentId)) fail('板报图片不存在', 404)
  }
  const record = imageRecord(context, attachmentId, true)
  return { ...imageMetadata(record, audience), data: Buffer.from(record.data) }
}
