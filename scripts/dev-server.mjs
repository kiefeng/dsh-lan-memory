/**
 * 开发用假宿主：不启动 DSH，直接在本机端口上跑插件 + 管理面板。
 *
 *   node scripts/dev-server.mjs            # 默认 http://127.0.0.1:17800/lan-memory/
 *   PORT=18000 node scripts/dev-server.mjs
 *
 * 数据目录默认 .tmp/dev-data（可删），不会碰真实的 $DSH_HOME。
 */
import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.DEV_DATA_DIR || join(ROOT, '.tmp', 'dev-data')
mkdirSync(dataDir, { recursive: true })

const routes = []
const tools = []
const sections = []
const contexts = []
const ctx = {
  tools: { register(def) { tools.push(def); return () => {} } },
  systemPrompt: {
    section(def) { sections.push(def); return () => {} },
    context(def) { contexts.push(def); return () => {} },
  },
  webServer: { register(route) { routes.push(route); return () => {} } },
  on() { return () => {} },
  logger: {
    log: (...a) => console.log('[dev]', ...a),
    warn: (...a) => console.warn('[dev]', ...a),
    error: (...a) => console.error('[dev]', ...a),
  },
}

const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = join(ROOT, '.tmp', 'dev-home')
mkdirSync(process.env.DSH_HOME, { recursive: true })

const dispose = apply(ctx, { dataDir })
if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome

const route = routes[0]
if (!route) throw new Error('插件没有注册 /lan-memory 路由')

const port = Number(process.env.PORT || 17800)
const server = http.createServer((req, res) => {
  const url = req.url || '/'
  if (url === '/' || url === '') {
    res.statusCode = 302
    res.setHeader('Location', '/lan-memory/api/state')
    res.end()
    return
  }
  if (url.startsWith(route.path)) {
    route.handler(req, res)
    return
  }
  res.statusCode = 404
  res.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[dev] 插件已加载：${tools.length} 工具 / ${sections.length} section / ${contexts.length} context`)
  console.log(`[dev] API：http://127.0.0.1:${port}/lan-memory/api/state`)
  console.log(`[dev] 数据目录：${dataDir}`)
})

function shutdown() {
  try { dispose() } catch { /* 忽略 */ }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
