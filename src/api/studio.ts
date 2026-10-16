import type { Attachment } from '@/types/studio'
import { useStudioStore } from '@/store/modules/studio'
import { setStudioMutationActorResolver } from './studio-mutation'

setStudioMutationActorResolver(() => useStudioStore().user?.id)

/** 工作室接口沿用当前站点的服务器会话，业务金额以分传输。 */
export async function studioRequest<T>(
  path: string,
  body?: unknown,
  method = 'GET',
  signal?: AbortSignal
): Promise<T> {
  const actorId =
    body &&
    typeof body === 'object' &&
    'expectedActorId' in body &&
    typeof body.expectedActorId === 'string'
      ? body.expectedActorId
      : useStudioStore().user?.id
  const response = await fetch(`/api/studio/${path.replace(/^\//, '')}`, {
    method,
    signal,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(actorId && method !== 'GET' && method !== 'HEAD' ? { 'X-Studio-Actor': actorId } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const result = await response.json().catch(() => ({ message: '后台连接失败，请稍后重试' }))
  if (!response.ok)
    throw Object.assign(new Error(result.message || '操作失败，请重试'), {
      status: response.status,
      code: result.code,
      details: result.details,
      retryAfter: response.headers.get('Retry-After')
    })
  return result as T
}

export async function uploadStudioImage(file: File): Promise<Attachment> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('请上传 JPG、PNG 或 WebP 图片')
  if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MB')
  const encoded = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
  return studioRequest<Attachment>(
    'uploads',
    { name: file.name, mime: file.type, data: encoded },
    'POST'
  )
}
