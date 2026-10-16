export type ImageKind = 'evidence' | 'qr' | 'avatar'
export interface PrepareImageOptions {
  signal?: AbortSignal
  kind?: ImageKind
  onProgress?: (percent: number) => void
}

const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const uploadLimit = 8 * 1024 * 1024
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('图片处理已取消', 'AbortError')
}

/** Keep screenshots and QR codes readable; only replace the original when the result is smaller. */
export async function prepareImage(file: File, options: PrepareImageOptions = {}): Promise<File> {
  const { signal, onProgress, kind = 'evidence' } = options
  check(signal)
  if (!acceptedTypes.has(file.type)) throw new Error('请上传 JPG、PNG 或 WebP 图片')
  if (!file.size) throw new Error('图片为空，请重新选择')
  if (file.size > 40 * 1024 * 1024) throw new Error('图片过大，请先在相册中缩小后再上传')
  onProgress?.(0)
  const url = URL.createObjectURL(file)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { image.src = ''; reject(new DOMException('图片处理已取消', 'AbortError')) }
      const done = (error?: Error) => {
        signal?.removeEventListener('abort', abort)
        image.onload = null
        image.onerror = null
        error ? reject(error) : resolve()
      }
      image.onload = () => done()
      image.onerror = () => done(new Error('图片无法读取，请选择清晰完整的图片'))
      signal?.addEventListener('abort', abort, { once: true })
      image.src = url
    })
    check(signal)
    onProgress?.(30)
    const width = image.naturalWidth, height = image.naturalHeight
    if (!width || !height || width * height > 64_000_000 || Math.max(width, height) > 16000)
      throw new Error('图片尺寸过大，请在相册中缩小后再上传')
    const limit = kind === 'avatar' ? 1024 : kind === 'qr' ? 4096 : 3200
    const scale = Math.min(1, limit / Math.max(width, height))
    // Small lossless images and QR codes remain unchanged. Resizing very large images
    // is useful, but repeatedly re-encoding small screenshots damages text clarity.
    if (scale === 1 && (file.type !== 'image/jpeg' || file.size < 700 * 1024 || kind === 'qr')) {
      if (file.size > uploadLimit) throw new Error('图片仍超过 8 MB，请缩小图片并检查文字清晰度')
      onProgress?.(100)
      return file
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器无法处理图片，请换用较小图片')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    onProgress?.(65)
    // PNG/WebP screenshots stay lossless. QR JPEGs use a higher quality setting.
    const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('图片处理失败，请重试')), mime,
        kind === 'avatar' ? 0.9 : kind === 'qr' ? 0.97 : 0.94)
    })
    canvas.width = canvas.height = 1
    check(signal)
    const result = blob.size < file.size
      ? new File([blob], file.name.replace(/\.[^.]*$/, '') + (mime === 'image/jpeg' ? '.jpg' : '.png'), { type: mime })
      : file
    if (result.size > uploadLimit) throw new Error('图片仍超过 8 MB，请缩小图片并检查文字清晰度')
    onProgress?.(100)
    return result
  } finally {
    image.onload = null
    image.onerror = null
    image.src = ''
    URL.revokeObjectURL(url)
  }
}
