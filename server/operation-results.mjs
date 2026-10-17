import { ApiError } from './studio.mjs'

const operationPaths = {
  claim: /^\/player\/orders\/[^/]+\/claim$/,
  reject: /^\/player\/orders\/[^/]+\/reject$/,
  return: /^\/player\/orders\/[^/]+\/return-request$/,
  submit: /^\/player\/orders\/[^/]+\/submit$/,
  'problem-feedback': /^\/player\/orders\/[^/]+\/problem-feedback$/,
  withdraw: /^\/player\/withdrawals$/,
  'cancel-withdrawal': /^\/player\/withdrawals\/[^/]+\/cancel$/
}

const fail = (message, status, code) => {
  throw Object.assign(new ApiError(message, status), { code, publicBusinessError: true })
}

/**
 * A personal acknowledgement of a committed operation, never an old resource snapshot.
 * The caller must provide the current authenticated user from the authoritative state.
 * Missing success receipts cannot exclude a request that has not acquired its write lock yet.
 */
export function readPlayerOperationResult(db, user, requestId, family, now) {
  // Time alone cannot establish failure, expiry, or the absence of a late business commit.
  void now
  if (!user || typeof user.id !== 'string' || !user.id) fail('请先登录', 401, 'AUTH_REQUIRED')
  if (user.role !== 'player') fail('此接口仅供打手账号使用', 403, 'PLAYER_REQUIRED')
  if (user.status !== 'active' || user.playerAccess?.login === false)
    fail('账号已停用或关闭登录', 403, 'PLAYER_DISABLED')
  if (!Object.hasOwn(operationPaths, family))
    fail('不支持的操作种类', 400, 'INVALID_OPERATION_FAMILY')
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128)
    fail('请提供有效的原 requestId', 400, 'INVALID_REQUEST_ID')

  const response = {
    requestId,
    family,
    status: 'not-recorded',
    createdAt: null,
    operationConfirmed: false,
    result: 'confirmation-only',
    lateCommitPossible: true,
    canCreateNew: false,
    canRetryWithOriginal:
      (family !== 'claim' || user.playerAccess?.claim !== false) &&
      (family !== 'withdraw' || user.playerAccess?.withdraw !== false)
  }
  // Select no payload or result column. Even malformed private snapshots remain unread.
  const current = db
    .prepare('SELECT operation,created_at FROM business_requests WHERE request_id=? AND actor_id=?')
    .get(requestId, user.id)
  if (current && operationPaths[family].test(current.operation))
    return {
      ...response,
      status: 'succeeded',
      operationConfirmed: true,
      createdAt: current.created_at,
      lateCommitPossible: false,
      canRetryWithOriginal: false
    }

  const legacy = db
    .prepare('SELECT operation FROM financial_requests WHERE request_id=? AND actor_id=?')
    .get(requestId, user.id)
  if (legacy && operationPaths[family].test(legacy.operation))
    return {
      ...response,
      status: 'succeeded',
      operationConfirmed: true,
      createdAt: null,
      legacy: true,
      lateCommitPossible: false,
      canRetryWithOriginal: false
    }
  return response
}
