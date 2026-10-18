import { ref, shallowRef } from 'vue'

type RecoveryOptions = {
  resolveTarget: (target: string) => string | null
  href: () => string
  replaceHref: (href: string) => void
  reload: () => void
}

// eslint-disable-next-line no-control-regex -- Deliberately reject control characters and backslashes before URL normalization.
const unsafeTargetCharacters = /[\\\u0000-\u001f\u007f]/

/** Only browser/Vite resource failures qualify; business, syntax and generic network errors do not. */
export function isNavigationResourceError(error: unknown) {
  if (
    !error ||
    typeof error !== 'object' ||
    !('message' in error) ||
    typeof error.message !== 'string'
  )
    return false
  return /^(?:Failed to fetch dynamically imported module(?::|\s|$)|error loading dynamically imported module(?::|\s|$)|Importing a module script failed\.?$|Unable to preload CSS for\s)/i.test(
    error.message
  )
}

export function safeNavigationTarget(
  raw: unknown,
  href: string,
  resolveTarget: RecoveryOptions['resolveTarget']
) {
  if (
    typeof raw !== 'string' ||
    raw.length > 2048 ||
    !raw.startsWith('/player/') ||
    unsafeTargetCharacters.test(raw)
  )
    return null
  try {
    const base = new URL(href)
    if (!['http:', 'https:'].includes(base.protocol)) return null
    const candidate = new URL(raw, base.origin)
    if (
      candidate.origin !== base.origin ||
      candidate.username ||
      candidate.password ||
      unsafeTargetCharacters.test(decodeURIComponent(candidate.pathname))
    )
      return null
    const matched = resolveTarget(candidate.pathname + candidate.search + candidate.hash)
    if (!matched || !matched.startsWith('/player/') || unsafeTargetCharacters.test(matched))
      return null
    const resolved = new URL(matched, base.origin)
    if (resolved.origin !== base.origin || resolved.username || resolved.password) return null
    return resolved.pathname + resolved.search + resolved.hash
  } catch {
    return null
  }
}

/** Holds only one route target in memory. No storage, session cleanup, writes or automatic retries. */
export function createNavigationLoadRecovery(options: RecoveryOptions) {
  const failure = shallowRef<{ target: string } | null>(null)
  const refreshing = ref(false)
  function report(error: unknown, rawTarget: unknown) {
    if (!isNavigationResourceError(error)) return false
    const target = safeNavigationTarget(rawTarget, options.href(), options.resolveTarget)
    if (!target) return false
    failure.value = { target }
    refreshing.value = false
    return true
  }
  function clear() {
    failure.value = null
    refreshing.value = false
  }
  function refresh() {
    if (!failure.value || refreshing.value) return false
    // Revalidate on the explicit click; neither an error URL nor a catch-all route is a destination.
    const target = safeNavigationTarget(failure.value.target, options.href(), options.resolveTarget)
    if (!target) {
      clear()
      return false
    }
    const destination = new URL(options.href())
    destination.hash = target
    refreshing.value = true
    try {
      // replaceState updates the hash without asking the stale router to import the missing file again.
      options.replaceHref(destination.href)
      options.reload()
      return true
    } catch {
      refreshing.value = false
      return false
    }
  }
  return { failure, refreshing, report, clear, refresh }
}
