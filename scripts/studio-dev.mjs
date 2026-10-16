import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { runGuardian } from './studio-guardian.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The same OS locks and Windows Job boundary protect development's watcher grandchildren.
const directory = join(root, '.qa/dev-service')
const guardian = await runGuardian({ directory, mode: 'development' })
console.log(`开发服务日志：${directory}；与稳定运行共用独占管理锁，已有服务不会被接管`)
const stop = async () => {
  await guardian.stop()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
