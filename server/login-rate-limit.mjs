const WINDOW_MS = 15 * 60 * 1000

// Keep the management and player clients independent, including behind the
// local proxies. The broader address limit still prevents cycling usernames.
export function createLoginRateLimit({ clock = Date.now, maxBuckets = 10000 } = {}) {
  const channels = new Map([
    ['admin', new Map()],
    ['player', new Map()]
  ])
  const sweepAt = new Map()
  const context = ({ channel, address, username }) => {
    const name = channel === 'player' ? 'player' : 'admin'
    const ip = String(address || 'local')
    const normalized =
      typeof username === 'string' ? username.trim().toLowerCase().slice(0, 65) : ''
    return {
      name,
      buckets: channels.get(name),
      accountKey: JSON.stringify([ip, normalized]),
      addressKey: JSON.stringify([ip])
    }
  }
  const prune = (buckets, now) => {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key)
  }
  const get = (buckets, key, now) => {
    const bucket = buckets.get(key)
    if (bucket && bucket.resetAt <= now) {
      buckets.delete(key)
      return undefined
    }
    return bucket
  }

  return {
    // A positive value is the actual remaining delay, in whole seconds.
    check(input) {
      const { name, buckets, accountKey, addressKey } = context(input)
      const now = Number(clock())
      if (!sweepAt.has(name) || now >= sweepAt.get(name)) {
        prune(buckets, now)
        sweepAt.set(name, now + 60000)
      }
      const account = get(buckets, accountKey, now)
      const address = get(buckets, addressKey, now)
      const blockedUntil = Math.max(
        account?.count >= 15 ? account.resetAt : 0,
        address?.count >= 150 ? address.resetAt : 0
      )
      if (blockedUntil > now) return Math.ceil((blockedUntil - now) / 1000)

      const required = Number(!account) + Number(!address)
      if (buckets.size + required > maxBuckets) {
        prune(buckets, now)
        if (buckets.size + required > maxBuckets) {
          // Do not evict active locks when the bound is reached.
          let earliest = now + WINDOW_MS
          for (const bucket of buckets.values()) earliest = Math.min(earliest, bucket.resetAt)
          return Math.max(1, Math.ceil((earliest - now) / 1000))
        }
      }
      return 0
    },
    failure(input) {
      const { buckets, accountKey, addressKey } = context(input)
      const now = Number(clock())
      for (const key of [addressKey, accountKey]) {
        let bucket = get(buckets, key, now)
        if (!bucket) {
          // check() reserves room logically; login and failure() are synchronous.
          if (buckets.size >= maxBuckets) continue
          bucket = { count: 0, resetAt: now + WINDOW_MS }
          buckets.set(key, bucket)
        }
        bucket.count++
      }
    },
    success(input) {
      const { buckets, accountKey } = context(input)
      buckets.delete(accountKey)
      // Successful logins do not erase failed attempts against other usernames.
    }
  }
}
