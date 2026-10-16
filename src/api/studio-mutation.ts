/** 公网 HTTP 下 randomUUID 可能不可用，仍使用浏览器强随机数生成 UUID v4。 */
export function createStudioRequestId(): string {
  const browserCrypto = globalThis.crypto
  if (typeof browserCrypto?.randomUUID === 'function') return browserCrypto.randomUUID()
  if (typeof browserCrypto?.getRandomValues !== 'function') {
    throw new Error('当前浏览器不支持安全随机数，请升级浏览器后重试')
  }
  const bytes = browserCrypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

/** 一次业务意图在网络重试时保留同一请求内容和编号。 */
let actorResolver: () => string | undefined = () => undefined
export function setStudioMutationActorResolver(resolve: () => string | undefined) {
  actorResolver = resolve
}
export function createStudioMutationIntent() {
  let pending: { path: string; signature: string; body: Record<string, unknown> } | null = null
  let uncertain = false
  return {
    prepare(path: string, body: Record<string, unknown>) {
      const signature = JSON.stringify(body)
      if (uncertain && pending && (pending.path !== path || pending.signature !== signature)) {
        throw Object.assign(
          new Error('上一次提交结果尚未确认，请先按原内容重试，或刷新并核对原操作结果'),
          {
            status: 409,
            code: 'LOCAL_PENDING_REQUEST'
          }
        )
      }
      if (!pending || pending.path !== path || pending.signature !== signature) {
        const expectedActorId = actorResolver()
        pending = {
          path,
          signature,
          body: JSON.parse(
            JSON.stringify({
              ...body,
              requestId: body.requestId || createStudioRequestId(),
              ...(expectedActorId ? { expectedActorId } : {})
            })
          )
        }
      }
      return pending.body
    },
    fail(cause: unknown) {
      if ((cause as { code?: string } | null)?.code === 'LOCAL_PENDING_REQUEST') return
      const status = (cause as { status?: number } | null)?.status
      uncertain = !status || status >= 500
    },
    complete() {
      pending = null
      uncertain = false
    },
    get uncertain() {
      return uncertain
    }
  }
}
