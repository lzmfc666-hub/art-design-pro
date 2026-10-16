/** Old bookmarks leave the desktop application and open the separately built player frontend. */
export function playerClientUrl(path = '/player/login'): string {
  const configured = import.meta.env.VITE_PLAYER_CLIENT_URL
  const target = new URL(configured || window.location.origin, window.location.origin)
  if (!configured) {
    target.port = '3008'
    target.pathname = '/'
    target.search = ''
  }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('打手端地址配置无效')
  target.hash = path.startsWith('/player/') ? path : '/player/login'
  return target.href
}
