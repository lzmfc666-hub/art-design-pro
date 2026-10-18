import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
// Normalize before sorting: native Windows separators otherwise put routesAlias
// before routes/..., while POSIX separators put it after that directory.
// String comparison is a fixed UTF-16 order, independent of the host locale.
export function canonicalFileMap(entries) {
  const normalized = entries
    .map(([path, digest]) => [path.replaceAll('\\', '/'), digest])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  for (let index = 1; index < normalized.length; index++)
    if (normalized[index - 1][0] === normalized[index][0]) throw new Error('发布文件路径重复')
  return Object.fromEntries(normalized)
}
export function sourceFingerprint() {
  const files = []
  const visit = (path) => {
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.qa', '.data', '.git'].includes(entry.name)) continue
      const child = join(path, entry.name)
      // Ignored Vite declaration output is regenerated locally and does not
      // affect runtime bytes; do not make a release depend on an untracked file.
      if (relative(root, child).replaceAll('\\', '/') === 'src/types/import/components.d.ts')
        continue
      if (entry.isDirectory()) visit(child)
      else files.push(child)
    }
  }
  for (const dir of [
    'server',
    'src',
    'public',
    'scripts',
    'tests',
    'deploy',
    'player-client/src',
    'player-client/public',
    'player-client/tests'
  ])
    visit(join(root, dir))
  for (const name of [
    '.gitignore',
    'index.html',
    'tsconfig.json',
    'tsconfig.node.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'vite.config.ts',
    'player-client/index.html',
    'player-client/tsconfig.json',
    'player-client/package.json',
    'player-client/pnpm-lock.yaml',
    'player-client/vite.config.ts',
    'docs/STUDIO-CONTRACT.md',
    '.qa/final-joint-ui.mjs'
  ]) {
    if (existsSync(join(root, name))) files.push(join(root, name))
  }
  const entries = canonicalFileMap(
    [...new Set(files)].map((path) => [
      relative(root, path),
      createHash('sha256').update(readFileSync(path)).digest('hex')
    ])
  )
  return {
    algorithm: 'SHA256',
    files: entries,
    digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(sourceFingerprint(), null, 2))
