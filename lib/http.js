/**
 * 管理面板与 REST API。
 *
 * 安全边界（webServer 本身不做认证，见 dsh-host-webserver README）：
 *  - 只接受 loopback 来源（socket.remoteAddress 判定，fail-closed）；
 *  - 所有写请求要求 `x-lan-ui: 1` 自定义头 + `Content-Type: application/json`
 *    → 跨站"简单请求"无法伪造，浏览器会先发预检而本站不返回 CORS 头；
 *  - 若带 Origin，必须与本次请求 Host 同源；
 *  - 写请求可带 ifMatch，与当前 etag 不一致返回 409（多窗口/并发保护）。
 * 不引入 token 分发，个人自用场景下本机进程视为可信。
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL_FILE = join(HERE, '..', 'ui', 'panel.html')
const MAX_BODY = 1024 * 1024

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const KNOWN_API = new Set([
  '/lan-memory/api/state',
  '/lan-memory/api/health',
  '/lan-memory/api/backups',
  '/lan-memory/api/export',
  '/lan-memory/api/memory',
  '/lan-memory/api/persona',
  '/lan-memory/api/organize',
  '/lan-memory/api/journal',
  '/lan-memory/api/backup',
  '/lan-memory/api/restore',
  '/lan-memory/api/settings',
  '/lan-memory/api/migrate',
])

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.end(body)
}

function sendHtml(res, html) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.end(html)
}

function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** Host 头必须是本机名，挡住 DNS rebinding（域名解析到 127.0.0.1 的情况）。 */
function isLocalHostHeader(req) {
  const raw = String((req.headers && req.headers.host) || '').toLowerCase()
  if (!raw) return false
  const host = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin
  if (!origin) return true // 本机 curl / 脚本
  const host = req.headers.host || ''
  if (!host) return false
  try {
    const u = new URL(origin)
    const reqHost = host.toLowerCase()
    const originHost = u.host.toLowerCase()
    if (originHost === reqHost) return true
    // 127.0.0.1 与 localhost 视为同源（同一台机器同一端口）
    const strip = (h) => h.replace(/^(localhost|127\.0\.0\.1)/, 'local')
    return strip(originHost) === strip(reqHost)
  } catch { return false }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(Object.assign(new Error('body 不是合法 JSON'), { status: 400 })) }
    })
    req.on('error', () => reject(Object.assign(new Error('读取请求体失败'), { status: 400 })))
  })
}

function requireUiWrite(req) {
  if (req.headers['x-lan-ui'] !== '1') return '缺少 x-lan-ui 头'
  const ct = String(req.headers['content-type'] || '')
  if (!ct.includes('application/json')) return 'Content-Type 必须是 application/json'
  return ''
}

const DEFAULT_PANEL = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>澜 · 记忆面板</title>
<style>body{font:14px/1.6 system-ui,sans-serif;background:#141418;color:#e8e8ec;padding:32px}code{background:#232329;padding:2px 6px;border-radius:4px}</style>
</head><body><h1>澜 · 记忆面板</h1><p>面板文件缺失：<code>ui/panel.html</code> 没有随插件一起安装。</p>
<p>REST API 仍然可用：<code>GET /lan-memory/api/state</code></p>
<p>数据目录与工具记忆功能不受影响。</p></body></html>`

function loadPanel(logger) {
  try {
    const stat = statSync(PANEL_FILE)
    const text = readFileSync(PANEL_FILE, 'utf8')
    return { text, mtimeMs: stat.mtimeMs }
  } catch (e) {
    logger.warn?.(`[lan] panel.html 读取失败: ${e.message}`)
    return { text: DEFAULT_PANEL, mtimeMs: 0 }
  }
}

/**
 * @param {{store:any, organizer:any, capture:any, getHealth:()=>object, logger?:any}} deps
 */
export function createHttpHandler(deps) {
  const { store, organizer, capture, getHealth, logger = console } = deps
  let panelCache = loadPanel(logger)

  function readPanel() {
    try {
      const stat = statSync(PANEL_FILE)
      if (stat.mtimeMs !== panelCache.mtimeMs) panelCache = loadPanel(logger)
    } catch { /* 用缓存 */ }
    return panelCache.text
  }

  function statePayload() {
    const pendingIds = new Set(store.pendingJournal().map((r) => r.id))
    const journalItems = store.allJournal().slice(0, 50).map((rec) => ({
      id: rec.id,
      ts: rec.ts,
      session: rec.session,
      turn: rec.turn,
      user: rec.user,
      assistant: rec.assistant,
      tools: rec.tools || [],
      pending: pendingIds.has(rec.id),
    }))
    const stats = store.stats()
    return {
      ok: true,
      etag: store.etag(),
      dataDir: store.dataDir,
      meta: {
        schemaVersion: store.meta.schemaVersion,
        createdAt: store.meta.createdAt,
        lastOrganize: store.meta.lastOrganize || null,
        lastMigrate: store.meta.lastMigrate || null,
        settings: { ...store.meta.settings },
      },
      counts: stats.counts,
      health: getHealth(),
      persona: { soul: store.persona.soul, moodContract: store.persona.moodContract },
      pinned: store.pinned.map((p, i) => ({ id: `p${i}`, index: i, tag: p.tag, content: p.content, updatedAt: p.updatedAt || 0 })),
      memory: store.memory,
      experience: store.experience,
      moods: store.moods.slice(-20),
      journal: { pending: stats.counts.journalPending, items: journalItems },
    }
  }

  function checkEtag(body, res) {
    if (body && typeof body.ifMatch === 'string' && body.ifMatch && body.ifMatch !== store.etag()) {
      sendJson(res, 409, { ok: false, error: '数据已被其他窗口修改', etag: store.etag() })
      return false
    }
    return true
  }

  function done(res, extra = {}) {
    store.writeDerivedViews()
    sendJson(res, 200, { ok: true, etag: store.etag(), ...extra })
  }

  async function handleApi(req, res, pathname, url) {
    const method = req.method || 'GET'
    const body = MUTATING.has(method) ? await readBody(req) : null
    if (MUTATING.has(method)) {
      const msg = requireUiWrite(req)
      if (msg) return sendJson(res, 403, { ok: false, error: msg })
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
    }

    // ---------- 只读 ----------
    if (pathname === '/lan-memory/api/state' && method === 'GET') {
      return sendJson(res, 200, statePayload())
    }
    if (pathname === '/lan-memory/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...getHealth(), dataDir: store.dataDir, counts: store.stats().counts })
    }
    if (pathname === '/lan-memory/api/backups' && method === 'GET') {
      return sendJson(res, 200, { ok: true, items: store.listBackups() })
    }
    if (pathname === '/lan-memory/api/export' && method === 'GET') {
      const payload = {
        exportedAt: new Date().toISOString(),
        schemaVersion: store.meta.schemaVersion,
        persona: store.persona,
        pinned: store.pinned,
        memory: store.memory,
        experience: store.experience,
        moods: store.moods,
        settings: store.meta.settings,
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="lan-memory-${new Date().toISOString().slice(0, 10)}.json"`)
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(payload, null, 2))
      return
    }

    if (!MUTATING.has(method)) return sendJson(res, KNOWN_API.has(pathname) ? 405 : 404, { ok: false, error: 'method not allowed' })

    // ---------- 写 ----------
    if (!checkEtag(body, res)) return

    if (pathname === '/lan-memory/api/memory' && method === 'POST') {
      const layer = body.layer || 'memory'
      const action = body.action || 'add'
      const entry = body.entry || {}
      if (layer === 'pinned') {
        const items = store.pinned.slice()
        if (action === 'add') {
          const content = String(entry.content || '').trim()
          if (!content) return sendJson(res, 400, { ok: false, error: 'content 不能为空' })
          items.push({ tag: String(entry.tag || '通用').trim() || '通用', content, updatedAt: Date.now() })
        } else if (action === 'update') {
          const i = Number(body.index)
          if (!(i >= 0 && i < items.length)) return sendJson(res, 400, { ok: false, error: 'index 无效' })
          items[i] = { ...items[i], tag: String(entry.tag || items[i].tag).trim() || items[i].tag, content: String(entry.content || items[i].content).trim(), updatedAt: Date.now() }
        } else if (action === 'delete') {
          const i = Number(body.index)
          if (!(i >= 0 && i < items.length)) return sendJson(res, 400, { ok: false, error: 'index 无效' })
          items.splice(i, 1)
        } else {
          return sendJson(res, 400, { ok: false, error: 'unknown action' })
        }
        store.savePinned(items)
        return done(res)
      }
      if (layer === 'memory') {
        if (action === 'add') {
          const item = store.addMemory({ content: entry.content, tags: entry.tags, source: entry.source || 'user' })
          return done(res, { item })
        }
        if (action === 'update') {
          const item = store.updateMemory(String(body.id || ''), { content: entry.content, tags: entry.tags })
          return done(res, { item })
        }
        if (action === 'delete') {
          store.deleteMemory(String(body.id || ''))
          return done(res)
        }
        return sendJson(res, 400, { ok: false, error: 'unknown action' })
      }
      if (layer === 'experience') {
        if (action === 'add') {
          const item = store.addExperience({ category: entry.category, content: entry.content })
          return done(res, { item })
        }
        if (action === 'update') {
          const item = store.updateExperience(String(body.id || ''), { category: entry.category, content: entry.content })
          return done(res, { item })
        }
        if (action === 'delete') {
          store.deleteExperience(String(body.id || ''))
          return done(res)
        }
        return sendJson(res, 400, { ok: false, error: 'unknown action' })
      }
      return sendJson(res, 400, { ok: false, error: 'unknown layer' })
    }

    if (pathname === '/lan-memory/api/persona' && method === 'PUT') {
      store.savePersona({ soul: body.soul, moodContract: body.moodContract })
      return done(res)
    }

    if (pathname === '/lan-memory/api/organize' && method === 'POST') {
      const mode = body.mode || 'preview'
      if (mode === 'preview') {
        return done(res, { report: { ...organizer.preview(), pack: null } })
      }
      if (mode === 'apply-local') {
        const report = organizer.applyLocal()
        return done(res, { report })
      }
      if (mode === 'review-pack') {
        return done(res, { report: { pack: organizer.reviewPack(), actions: [], undoId: null } })
      }
      if (mode === 'undo') {
        const result = organizer.undo()
        return done(res, { report: { ...result, actions: [], undoId: null } })
      }
      return sendJson(res, 400, { ok: false, error: 'unknown mode' })
    }

    if (pathname === '/lan-memory/api/journal' && method === 'POST') {
      const action = body.action
      if (action === 'promote') {
        const id = String(body.id || '')
        const all = store.readJournal(30)
        const rec = all.find((r) => r.id === id)
        if (!rec) return sendJson(res, 404, { ok: false, error: 'journal 条目不存在' })
        const layer = body.layer === 'pinned' ? 'pinned' : 'memory'
        const content = String(body.content || '').trim() || [rec.user, rec.assistant].filter(Boolean).join(' → ').slice(0, 2000)
        if (layer === 'pinned') {
          store.savePinned([...store.pinned, { tag: String(body.tag || '对话').trim() || '对话', content, updatedAt: Date.now() }])
        } else {
          store.addMemory({ content, tags: body.tags, source: 'organize' })
        }
        store.setJournalStatus(id, 'promoted', { layer })
        return done(res)
      }
      if (action === 'dismiss') {
        store.setJournalStatus(String(body.id || ''), 'dismissed')
        return done(res)
      }
      if (action === 'dismissAll') {
        let n = 0
        for (const rec of store.pendingJournal()) {
          store.setJournalStatus(rec.id, 'dismissed')
          n++
        }
        return done(res, { dismissed: n })
      }
      return sendJson(res, 400, { ok: false, error: 'unknown action' })
    }

    if (pathname === '/lan-memory/api/backup' && method === 'POST') {
      const dir = store.snapshot('manual')
      return done(res, { dir })
    }

    if (pathname === '/lan-memory/api/restore' && method === 'POST') {
      store.restoreBackup(String(body.backup || ''))
      return done(res)
    }

    if (pathname === '/lan-memory/api/settings' && method === 'POST') {
      const settings = body.settings || {}
      const allowed = ['captureEnabled', 'autoOrganize', 'maxPinnedBytes', 'maxRecallBytes', 'maxIndexBytes', 'maxMoodBytes', 'maxMemory', 'maxExperience', 'journalRetentionDays', 'journalMaxPerDay', 'organizeThreshold']
      const patch = {}
      for (const key of allowed) {
        if (settings[key] === undefined) continue
        patch[key] = typeof settings[key] === 'boolean' ? settings[key] : Number(settings[key])
      }
      store.saveMeta({ settings: patch })
      if (patch.captureEnabled !== undefined) capture.setEnabled(!!patch.captureEnabled)
      return done(res)
    }

    if (pathname === '/lan-memory/api/migrate' && method === 'POST') {
      const report = store.migrateFromV1()
      store.loadAll()
      return done(res, { report })
    }

    return sendJson(res, KNOWN_API.has(pathname) ? 405 : 404, { ok: false, error: 'not found' })
  }

  async function handle(req, res) {
    try {
      if (!isLoopback(req)) {
        res.statusCode = 403
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        return res.end('forbidden: loopback only')
      }
      if (!isLocalHostHeader(req)) {
        res.statusCode = 403
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        return res.end('forbidden: local host only')
      }
      const url = new URL(req.url || '/', 'http://localhost')
      const pathname = decodeURIComponent(url.pathname)
      if (pathname === '/lan-memory' || pathname === '/lan-memory/' || pathname === '/lan-memory/panel.html') {
        if ((req.method || 'GET') !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        }
        return sendHtml(res, readPanel())
      }
      if (pathname.startsWith('/lan-memory/api/')) {
        return await handleApi(req, res, pathname, url)
      }
      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      const status = e && e.status ? e.status : 500
      logger.warn?.('[lan] http error:', e && e.message ? e.message : e)
      if (!res.headersSent) sendJson(res, status, { ok: false, error: String(e && e.message ? e.message : e) })
      else try { res.end() } catch { /* 忽略 */ }
    }
  }

  return { handle, PANEL_FILE }
}
