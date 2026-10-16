import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxy: Record<string, ProxyOptions> = {
    '/api/studio': {
      target: process.env.STUDIO_API_TARGET || env.STUDIO_API_TARGET || 'http://127.0.0.1:3007',
      changeOrigin: true,
      headers: { 'X-Studio-Client': 'player' },
      configure(proxy) {
        proxy.on('proxyReq', (request, original) => {
          for (const name of request.getHeaderNames()) {
            const lower = name.toLowerCase()
            if (
              lower === 'forwarded' ||
              lower === 'x-real-ip' ||
              lower.startsWith('x-forwarded-')
            )
              request.removeHeader(name)
          }
          const source = original.socket.remoteAddress
          if (source) request.setHeader('X-Forwarded-For', source)
          const playerCookie = original.headers.cookie
            ?.split(';')
            .map((value) => value.trim())
            .filter((value) => value.startsWith('studio_player_session='))
            .join('; ')
          if (playerCookie) request.setHeader('cookie', playerCookie)
          else request.removeHeader('cookie')
          request.setHeader('X-Studio-Client', 'player')
        })
      }
    }
  }
  return {
    plugins: [vue()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: '127.0.0.1',
      port: 3008,
      strictPort: true,
      proxy,
      fs: {
        allow: [
          fileURLToPath(new URL('.', import.meta.url)),
          fileURLToPath(new URL('../node_modules', import.meta.url))
        ],
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          '**/.data/**',
          '**/.qa/**',
          '**/output/**',
          '**/*.sqlite',
          '**/*.sqlite-wal',
          '**/*.sqlite-shm',
          '**/bootstrap-password.txt'
        ]
      }
    },
    preview: { host: '127.0.0.1', port: 3008, strictPort: true, proxy },
    build: { outDir: 'dist', emptyOutDir: true }
  }
})
