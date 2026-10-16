/** Only fingerprints enter the read URL; subscription keys remain in the browser. */
export async function pushFingerprint(subscription: PushSubscriptionJSON) {
  const { p256dh, auth } = subscription.keys || {}
  if (!subscription.endpoint || !p256dh || !auth || !globalThis.crypto?.subtle) return null
  try {
    const endpoint = new URL(subscription.endpoint).href
    const digest = async (value: string) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
      return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
    }
    const [endpointHash, subscriptionHash] = await Promise.all([
      digest(endpoint), digest(JSON.stringify({ endpoint, keys: { p256dh, auth } }))
    ])
    return { endpointHash, subscriptionHash }
  } catch { return null }
}
