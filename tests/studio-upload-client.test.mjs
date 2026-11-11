import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function loadSource(path, imports, fetch) {
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true
  })
  assert.deepEqual(
    (compiled.diagnostics || []).filter((row) => row.category === ts.DiagnosticCategory.Error),
    []
  )
  const exports = {}
  new Function('exports', 'require', 'fetch', compiled.outputText)(
    exports,
    (name) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected source dependency: ${name}`)
      return imports[name]
    },
    fetch
  )
  return exports
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(fetch) {
  const store = { user: { id: 'staff-a' } }
  // Execute the real upload and mutation modules; only replace the Pinia boundary
  // and transport so account changes and late responses are deterministic.
  const mutation = loadSource('../src/api/studio-mutation.ts', {}, fetch)
  const api = loadSource(
    '../src/api/studio.ts',
    {
      '@/store/modules/studio': { useStudioStore: () => store },
      './studio-mutation': mutation
    },
    fetch
  )
  return { store, upload: api.uploadStudioImage }
}

const bytes = Uint8Array.from([0, 137, 80, 78, 71, 255])
const image = () => new File([bytes], '客服 截图#1.png', { type: 'image/png' })
const attachment = { id: 'upload-a', url: '/api/studio/uploads/upload-a' }

test('后台上传使用真实二进制、编码文件名和发起账号，正常响应交付附件', async () => {
  let request
  const f = fixture(async (url, options) => {
    request = { url, options }
    return Response.json(attachment)
  })
  const file = image()
  assert.deepEqual(await f.upload(file), attachment)
  assert.equal(request.url, '/api/studio/uploads')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.credentials, 'same-origin')
  assert.equal(request.options.body, file)
  assert.deepEqual(new Uint8Array(await request.options.body.arrayBuffer()), bytes)
  assert.deepEqual(request.options.headers, {
    'Content-Type': 'image/png',
    'X-Upload-Name': encodeURIComponent(file.name),
    'X-Studio-Actor': 'staff-a'
  })
})

for (const status of [200, 401]) {
  test(`上传旧账号的迟到${status}在解析期间换号后不交付附件或透传认证失效`, async () => {
    const entered = deferred(),
      body = deferred()
    let actor
    const f = fixture(async (_url, options) => {
      actor = options.headers['X-Studio-Actor']
      return {
        ok: status === 200,
        status,
        headers: new Headers(),
        json() {
          entered.resolve()
          return body.promise
        }
      }
    })
    const pending = f.upload(image())
    const checked = assert.rejects(pending, (error) => {
      assert.match(error.message, /账号已变化/)
      assert.equal(error.status, undefined)
      assert.equal(error.code, undefined)
      return true
    })
    await entered.promise
    f.store.user = { id: 'staff-b' }
    body.resolve(status === 200 ? attachment : { message: '旧会话已失效', code: 'SESSION_EXPIRED' })
    await checked
    assert.equal(actor, 'staff-a')
    assert.equal(f.store.user.id, 'staff-b')
  })
}

test('同账号上传401仍保留状态、错误码和重试信息供现有会话逻辑处理', async () => {
  const f = fixture(async () =>
    Response.json(
      {
        message: '会话已失效',
        code: 'SESSION_EXPIRED',
        details: { expired: true }
      },
      { status: 401, headers: { 'Retry-After': '3' } }
    )
  )
  await assert.rejects(f.upload(image()), (error) => {
    assert.equal(error.status, 401)
    assert.equal(error.code, 'SESSION_EXPIRED')
    assert.deepEqual(error.details, { expired: true })
    assert.equal(error.retryAfter, '3')
    return true
  })
})

test('上传期间退出也不交付旧附件，无登录账号时不发送请求', async () => {
  const entered = deferred(),
    response = deferred()
  let requests = 0
  const f = fixture(async () => {
    requests++
    entered.resolve()
    return response.promise
  })
  const pending = f.upload(image())
  const checked = assert.rejects(pending, /账号已变化/)
  await entered.promise
  f.store.user = null
  response.resolve(Response.json(attachment))
  await checked
  await assert.rejects(f.upload(image()), /请先登录/)
  assert.equal(requests, 1)
})
