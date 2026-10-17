import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export function sourceFingerprint() {
  const files = []
  const visit = (path) => {
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.qa', '.data', '.git'].includes(entry.name)) continue
      const child = join(path, entry.name)
      // Ignored Vite declaration output is regenerated locally and does not
      // affect runtime bytes; do not make a release depend on an untracked file.
      if (relative(root, child).replaceAll('\\', '/') === 'src/types/import/components.d.ts') continue
      if (entry.isDirectory()) visit(child)
      else files.push(child)
    }
  }
  for (const dir of ['server', 'src', 'public', 'scripts', 'tests', 'deploy', 'player-client/src', 'player-client/public', 'player-client/tests']) visit(join(root, dir))
  for (const name of ['.gitignore', 'index.html', 'tsconfig.json', 'tsconfig.node.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts', 'player-client/index.html', 'player-client/tsconfig.json', 'player-client/package.json', 'player-client/pnpm-lock.yaml', 'player-client/vite.config.ts', 'docs/STUDIO-CONTRACT.md', '.qa/final-joint-ui.mjs']) {
    if (existsSync(join(root, name))) files.push(join(root, name))
  }
  const entries = Object.fromEntries([...new Set(files)].sort().map(path => [relative(root, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')]))
  return { algorithm: 'SHA256', files: entries, digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(sourceFingerprint(), null, 2))
