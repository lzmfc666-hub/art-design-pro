import type { Attachment } from '@/types/studio'
import { prepareImage, type ImageKind } from '@/utils/prepareImage'
import { onSessionInvalidated, sessionRevision } from './sessionBoundary'

let unauthorizedHandler: (() => void) | undefined
let principalVerifier: ((id: string) => boolean) | undefined
let requestActorProvider: (() => string | null | undefined) | undefined
export const setUnauthorizedHandler = (handler: () => void) => {
  unauthorizedHandler = handler
}
export const setPrincipalVerifier = (verify: (id: string) => boolean) => {
  principalVerifier = verify
}
export const setRequestActorProvider = (provider: () => string | null | undefined) => {
  requestActorProvider = provider
}

export type RequestOutcome = 'rejected' | 'unknown'
export class StudioApiError extends Error {
  status: number
  code: string
  /** Retry delay in milliseconds, parsed from the server's Retry-After header. */
  retryAfter: number
  outcome: RequestOutcome
  requestId?: string
  constructor(message: string, options: {
    status?: number; code?: string; retryAfter?: number; outcome?: RequestOutcome; requestId?: string
  } = {}) {
    super(message)
    this.name = 'StudioApiError'
    this.status = options.status || 0
    this.code = options.code || ''
    this.retryAfter = options.retryAfter || 0
    this.outcome = options.outcome || 'rejected'
    this.requestId = options.requestId
  }
}
export const isAbortError = (cause: unknown) =>
  cause instanceof Error && (cause.name === 'AbortError' ||
    (cause instanceof StudioApiError && cause.code === 'SESSION_CHANGED'))

/** Keep business explanations while suppressing accidental server stack/SQL/path details. */
export function safeApiMessage(cause: unknown, fallback = '加载失败，请重试') {
  const message = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : ''
  if (!message || message.length > 300 || /(?:\bstack\b|\bsqlite\b|\bselect\s+.+\bfrom\b|\binsert\s+into\b|\bat\s+\S+\s*\(|[A-Z]:\\|\/node_modules\/|\bECONN\w+|TypeError:|SyntaxError:)/i.test(message))
    return fallback
  return message
}

export type RequestOptions = {
  timeoutMs?: number
  onUploadProgress?: (percent: number) => void
  actorId?: string | null
  expectedActorId?: string | null
}
function captureRequestActor(path: string, method: string, options: Pick<RequestOptions, 'actorId' | 'expectedActorId'>) {
  if (path === 'login' || method === 'GET' || method === 'HEAD') return undefined
  // Explicit operation metadata may never silently fall back to a different current account.
  if (Object.hasOwn(options, 'expectedActorId')) return options.expectedActorId
  if (Object.hasOwn(options, 'actorId')) return options.actorId
  return requestActorProvider?.()
}
type SharedRead = { promise: Promise<unknown>; controller: AbortController; users: number; settled: boolean }
const reads = new Map<string, SharedRead>()
const sessionControllers = new Set<AbortController>()
onSessionInvalidated(() => {
  reads.clear()
  for (const controller of sessionControllers) controller.abort('session-changed')
  sessionControllers.clear()
})
const abortError = () => new DOMException('读取已取消', 'AbortError')
const sessionError = (write = false, requestId?: string) => new StudioApiError('账号或权限已变化，请重新确认', {
  status: 409, code: 'SESSION_CHANGED', outcome: write ? 'unknown' : 'rejected', requestId
})
function retryDelay(value: string | null) {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

function fetchResponse(path: string, body: unknown, method: string, controller: AbortController,
  progress?: (percent: number) => void, actorId?: string | null): Promise<Response> {
  const headers = {
    'X-Studio-Client': 'player',
    ...(actorId ? { 'X-Studio-Actor': actorId } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
  }
  if (!progress || method === 'GET') return fetch(`/api/studio/${path}`, {
    method, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const cancel = () => xhr.abort()
    const clean = () => controller.signal.removeEventListener('abort', cancel)
    xhr.open(method, `/api/studio/${path}`)
    xhr.withCredentials = true
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.min(100, Math.round(event.loaded / event.total * 100)))
    }
    xhr.onload = () => {
      clean()
      if (!xhr.status) { reject(new Error('网络连接异常')); return }
      const received = new Headers()
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const split = line.indexOf(':')
        if (split > 0) received.append(line.slice(0, split), line.slice(split + 1).trim())
      }
      resolve(new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText, headers: received }))
    }
    xhr.onerror = () => { clean(); reject(new Error('网络连接异常')) }
    xhr.onabort = () => { clean(); reject(abortError()) }
    controller.signal.addEventListener('abort', cancel, { once: true })
    if (controller.signal.aborted) { clean(); reject(abortError()); return }
    xhr.send(body === undefined ? undefined : JSON.stringify(body))
  })
}
async function performRequest<T>(path: string, body: unknown, method: string,
  controller: AbortController, timeoutMs: number, progress?: (percent: number) => void, actorId?: string | null): Promise<T> {
  const revision = sessionRevision()
  const publicRead = path === 'appearance/public'
  const write = method !== 'GET' && method !== 'HEAD'
  const originalRequestId = body && typeof body === 'object' && 'requestId' in body
    ? String((body as { requestId: unknown }).requestId) : undefined
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort('timeout') }, timeoutMs)
  if (!publicRead) sessionControllers.add(controller)
  try {
    const response = await fetchResponse(path, body, method, controller, progress, actorId)
    if (!publicRead && revision !== sessionRevision()) throw sessionError(write, originalRequestId)
    const principal = response.headers.get('X-Studio-User')
    const principalChanged = () => path !== 'login' && principal && principalVerifier && !principalVerifier(principal)
    const rejectChangedPrincipal = () => {
      unauthorizedHandler?.()
      throw new StudioApiError('账号会话已变化，请重新登录', { status: 401, code: 'PRINCIPAL_CHANGED' })
    }
    let result: Record<string, unknown>
    try { result = await response.json() }
    catch {
      if (!publicRead && revision !== sessionRevision()) throw sessionError(write, originalRequestId)
      if (principalChanged()) rejectChangedPrincipal()
      if (response.status === 401 && path !== 'login') unauthorizedHandler?.()
      throw new StudioApiError(write ? '操作结果尚未确认，请先核对结果' : '后台连接异常，请重试', {
        status: response.status === 401 ? 401 : response.ok ? 0 : response.status,
        code: 'INVALID_RESPONSE', outcome: write ? 'unknown' : 'rejected', requestId: originalRequestId
      })
    }
    if (!publicRead && revision !== sessionRevision()) throw sessionError(write, originalRequestId)
    // These documented precondition responses are an atomic refusal, not a successful wrong-account reply.
    if (response.status === 409 && (result.code === 'PRINCIPAL_CHANGED' || result.code === 'PRECONDITION_REQUIRED')) {
      if (principalChanged()) unauthorizedHandler?.()
      throw new StudioApiError(safeApiMessage(result.message, '账号或操作信息已变化，请重新确认'), {
        status: 409, code: result.code, requestId: originalRequestId, outcome: 'rejected'
      })
    }
    if (principalChanged()) rejectChangedPrincipal()
    if (response.status === 401 && path !== 'login') unauthorizedHandler?.()
    if (!response.ok) {
      if (write && response.status >= 500 && response.status !== 503)
        throw new StudioApiError('操作结果尚未确认，请先核对结果，勿重复提交', {
          status: response.status, code: typeof result.code === 'string' ? result.code : 'SERVER_OUTCOME_UNKNOWN',
          outcome: 'unknown', requestId: originalRequestId
        })
      const fallback = response.status === 429 ? '操作太频繁，请稍后重试'
        : response.status === 503 ? '服务暂时无法处理，请稍后重试；已填写内容已保留'
        : response.status === 403 ? '当前账号没有此操作权限'
        : response.status === 401 ? '登录已失效，请重新登录' : '操作失败，请重试'
      throw new StudioApiError(response.status === 429 || response.status === 503 ? fallback : safeApiMessage(result.message, fallback), {
        status: response.status, code: typeof result.code === 'string' ? result.code.slice(0, 80) : '',
        retryAfter: retryDelay(response.headers.get('Retry-After')), requestId: originalRequestId
      })
    }
    return result as T
  } catch (cause) {
    if (cause instanceof StudioApiError) throw cause
    if (!publicRead && revision !== sessionRevision()) throw sessionError(write, originalRequestId)
    if (write) throw new StudioApiError('操作结果尚未确认，请先核对结果，勿重复提交', {
      code: timedOut ? 'TIMEOUT' : 'NETWORK_UNKNOWN', outcome: 'unknown', requestId: originalRequestId
    })
    if (controller.signal.aborted && !timedOut) throw abortError()
    throw new StudioApiError(timedOut ? '读取超时，请重试' : '网络连接异常，请检查网络后重试', {
      code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR'
    })
  } finally {
    clearTimeout(timer)
    sessionControllers.delete(controller)
  }
}

/** 同账号同查询并发读取合并；写入只发送一次，结果未知时由业务页核对原编号。 */
export function studioRequest<T>(path: string, body?: unknown, method = 'GET',
  signal?: AbortSignal, options: RequestOptions = {}): Promise<T> {
  path = path.replace(/^\//, '')
  method = method.toUpperCase()
  const actorId = captureRequestActor(path, method, options)
  if (signal?.aborted) return Promise.reject(abortError())
  if (method !== 'GET' || body !== undefined) {
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    return performRequest<T>(path, body, method, controller, options.timeoutMs || 20000, options.onUploadProgress, actorId)
      .finally(() => signal?.removeEventListener('abort', cancel))
  }
  const key = `${path === 'appearance/public' ? 'public' : sessionRevision()}:${path}`
  let shared = reads.get(key)
  if (shared?.controller.signal.aborted) { reads.delete(key); shared = undefined }
  if (!shared) {
    const controller = new AbortController()
    shared = { controller, users: 0, settled: false, promise: Promise.resolve() }
    const entry = shared
    entry.promise = performRequest<T>(path, undefined, method, controller, options.timeoutMs || 12000)
      .finally(() => { entry.settled = true; if (reads.get(key) === entry) reads.delete(key) })
    reads.set(key, entry)
  }
  const entry = shared
  entry.users++
  return new Promise<T>((resolve, reject) => {
    let released = false
    const release = () => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', cancel)
      entry.users--
      if (!entry.users && !entry.settled) entry.controller.abort('no-active-reader')
    }
    const cancel = () => { release(); reject(abortError()) }
    signal?.addEventListener('abort', cancel, { once: true })
    entry.promise.then((result) => {
      if (!released) { release(); resolve(result as T) }
    }, (cause) => {
      if (!released) { release(); reject(cause) }
    })
  })
}

export interface ImageUploadOptions {
  signal?: AbortSignal
  kind?: ImageKind
  onProgress?: (value: { phase: 'preparing' | 'uploading'; percent: number }) => void
  actorId?: string | null
  expectedActorId?: string | null
}
export async function uploadStudioImage(file: File, options: ImageUploadOptions = {}): Promise<Attachment> {
  const actorId = captureRequestActor('uploads', 'POST', options)
  const controller = new AbortController()
  const revision = sessionRevision()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  const unsubscribe = onSessionInvalidated(cancel)
  try {
    const prepared = await prepareImage(file, { signal: controller.signal, kind: options.kind,
      onProgress: percent => options.onProgress?.({ phase: 'preparing', percent }) })
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      const abort = () => { reader.abort(); cleanup(); reject(new DOMException('图片处理已取消', 'AbortError')) }
      const cleanup = () => controller.signal.removeEventListener('abort', abort)
      if (controller.signal.aborted) return abort()
      controller.signal.addEventListener('abort', abort, { once: true })
      reader.onload = () => { cleanup(); resolve(String(reader.result).split(',')[1] || '') }
      reader.onerror = () => { cleanup(); reject(new Error('图片读取失败，请重新选择')) }
      reader.readAsDataURL(prepared)
    })
    if (revision !== sessionRevision()) throw new DOMException('账号已变化', 'AbortError')
    options.onProgress?.({ phase: 'uploading', percent: 0 })
    const result = await studioRequest<Attachment>('uploads', { name: prepared.name, mime: prepared.type, data: encoded }, 'POST', controller.signal,
      { timeoutMs: 60000, expectedActorId: actorId, onUploadProgress: percent => options.onProgress?.({ phase: 'uploading', percent }) })
    options.onProgress?.({ phase: 'uploading', percent: 100 })
    return result
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    unsubscribe()
  }
}
