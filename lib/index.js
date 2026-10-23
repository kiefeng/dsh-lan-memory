/**
 * dsh-lan-memory v2 — 澜 · 轻量本地记忆与人格系统（Host 半区）
 *
 * 六个工具：lan_remember / lan_recall / lan_list / lan_forget / lan_organize / lan_status
 * 三层记忆：pinned.md（常驻）/ memory.jsonl（检索）/ experience.jsonl（经验）
 * 双通道注入：persona 常量走 systemPrompt.section；pinned/索引/mood 走 systemPrompt.context
 * 零 LLM 捕获：session/event → journal/YYYY-MM-DD.jsonl（不调模型、不联网）
 * 管理：DSH 设置页「澜记忆」；/lan-memory 仅保留 API，不再有独立面板。
 *
 * 不 import 任何 DSH 包（工具用裸 ToolDefinition 注册），因此不存在 v1
 * "漏声明 dsh-llm 导致装不上"的问题；兼容性由 engines.dsh 声明。
 */
import { Store, resolveDefaultDataDir, shortHash } from './store.js'
import { buildIndex, searchIndex, byteLength, truncateByBytes } from './search.js'
import { createCapture } from './capture.js'
import { createOrganizer } from './organize.js'
import { createCompiler } from './compile.js'
import { createHttpHandler } from './http.js'
import { MEMORY_RULES, organizeRule } from './defaults.js'

export const name = 'dsh-lan-memory'
// 依赖三个宿主服务。webServer 提供 /lan-memory API；管理界面在 DSH 设置页。
// 当前 Cordis 版本的 inject 只接受数组（对象式 {required,optional} 会被当成服务名），所以保持必选。
export const inject = ['tools', 'systemPrompt', 'webServer', 'llm']

const VERSION = '2.9.0'

const textBlock = (s) => [{ type: 'text', text: String(s || '') }]

function bad(message) {
  throw new Error(message)
}

function argString(args, key, { required = false, max = 8000 } = {}) {
  const v = args && args[key]
  if (v === undefined || v === null || v === '') {
    if (required) bad(`缺少参数 ${key}`)
    return ''
  }
  return String(v).trim().slice(0, max)
}

function argNumber(args, key, fallback) {
  const n = Number(args && args[key])
  return Number.isFinite(n) ? n : fallback
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger || console
  const info = (msg) => { try { (logger.info || logger.log || console.log)(msg) } catch { /* 忽略 */ } }
  const settings = { ...(config || {}) }
  const dataDir = settings.dataDir
    || (process.env.DSH_LAN_DATA_DIR || '').trim()
    || resolveDefaultDataDir()

  const store = new Store({ dataDir, logger })
  let migration = { found: false, copied: [] }
  try {
    migration = store.init()
  } catch (e) {
    logger.error?.('[lan] store init failed:', e && e.message ? e.message : e)
    throw e
  }

  const capture = createCapture({
    store,
    logger,
    enabled: store.meta.settings.captureEnabled !== false,
  })
  const organizer = createOrganizer(store, logger)
  const compiler = createCompiler({
    store,
    llm: ctx.llm,
    logger,
    getSettings: () => ({}),
    getDefaultModel: () => {
      try { return ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === 'function' ? ctx.agentDefaultModel.currentSelection() : null } catch { return null }
    },
  })

  const health = {
    version: VERSION,
    dataDir,
    startedAt: new Date().toISOString(),
    tools: 0,
    sections: 0,
    contexts: 0,
    routes: 0,
    events: 0,
    migration,
    errors: [],
  }

  function noteError(where, e) {
    const msg = `${where}: ${e && e.message ? e.message : e}`
    health.errors.push(msg)
    if (health.errors.length > 20) health.errors.shift()
    logger.warn?.(`[lan] ${msg}`)
    store.lastError = msg
  }

  function getHealth() {
    return {
      version: health.version,
      dataDir: health.dataDir,
      startedAt: health.startedAt,
      tools: health.tools,
      sections: health.sections,
      contexts: health.contexts,
      routes: health.routes,
      events: health.events,
      panel: false,
      api: health.routes > 0,
      migration: health.migration,
      errors: health.errors,
      capture: capture.getStats(),
      lastError: store.lastError,
      readOnly: store.readOnly,
      counts: store.stats().counts,
    }
  }

  // ---------- 检索索引 ----------
  let indexCache = null
  let indexTag = ''
  let factIndexCache = null
  let factIndexTag = ''
  function memoryIndex() {
    const tag = store.etag()
    if (indexCache && indexTag === tag) return indexCache
    indexCache = buildIndex(store.memory.map((m) => ({ id: m.id, text: m.content, tags: m.tags })))
    indexTag = tag
    return indexCache
  }
  function factIndex() {
    const tag = store.etag()
    if (factIndexCache && factIndexTag === tag) return factIndexCache
    factIndexCache = buildIndex(store.facts.map((f) => ({ id: f.id, text: f.fact, tags: f.tags })))
    factIndexTag = tag
    return factIndexCache
  }
  let expIndexCache = null
  let expIndexTag = ''
  function experienceIndex() {
    const tag = store.etag()
    if (expIndexCache && expIndexTag === tag) return expIndexCache
    expIndexCache = buildIndex(store.experience.map((e) => ({ id: e.id, text: e.content, tags: [e.category] })))
    expIndexTag = tag
    return expIndexCache
  }

  function recall(query, topK = 5, layer = 'memory') {
    const budget = Number(store.meta.settings.maxRecallBytes) || 2048
    const idx = layer === 'experience' ? experienceIndex() : layer === 'fact' ? factIndex() : memoryIndex()
    const hits = searchIndex(idx, query, { topK })
    const pool = layer === 'experience'
      ? store.experience
      : layer === 'fact'
        ? store.facts.map((f) => ({ id: f.id, content: f.fact, tags: f.tags, layer: 'fact' }))
        : store.memory.map((m) => ({ id: m.id, content: m.content, tags: m.tags, layer: 'memory' }))
    const byId = new Map(pool.map((x) => [x.id, x]))
    const results = []
    const seenContent = new Set()
    let used = 0
    for (const hit of hits) {
      const item = byId.get(hit.id)
      if (!item) continue
      const key = String(item.content || '').trim()
      if (seenContent.has(key)) continue
      seenContent.add(key)
      const line = layer === 'experience'
        ? `[${item.category}] ${item.content}`
        : `${(item.tags || []).length ? `[${item.tags.join(',')}] ` : ''}${item.content}`
      const bytes = byteLength(line)
      if (used + bytes > budget) {
        if (!results.length) results.push({ id: item.id, layer, content: truncateByBytes(item.content, Math.max(80, budget - 40)), tags: item.tags || [], category: item.category })
        break
      }
      used += bytes
      results.push({ id: item.id, layer: item.layer || layer, content: item.content, tags: item.tags || [], category: item.category })
    }
    return results
  }

  // ---------- 注入文本 ----------
  function buildPinnedText() {
    const max = Number(store.meta.settings.maxPinnedBytes) || 4096
    if (!store.pinned.length) return ''
    let text = '## 常驻记忆（始终保留，除非与当前任务冲突）\n'
    for (const item of store.pinned) {
      const line = `- [${item.tag || '通用'}] ${item.content}\n`
      if (byteLength(text) + byteLength(line) > max) break
      text += line
    }
    return byteLength(text) > max ? truncateByBytes(text, max) : text
  }

  function buildIndexHint() {
    const max = Math.max(520, Number(store.meta.settings.maxIndexBytes) || 520)
    const pending = store.pendingJournal().length
    const parts = [
      `## 记忆索引`,
      `常驻 ${store.pinned.length} 条｜手动记忆 ${store.memory.length} 条｜自动事实 ${store.facts.length} 条｜经验 ${store.experience.length} 条` + (pending ? `｜待编译 ${pending} 条` : ''),
      '分层：常驻=始终注入；手动记忆=用户明确要求记住；自动事实=编译抽取并参与画像；经验=方法/踩坑，不参与画像。',
      '查记忆用 lan_recall（layer=memory/fact/experience）；用户说"整理记忆"时用 lan_organize（action 选 compile）。',
    ]
    let text = parts.join('\n')
    if (byteLength(text) > max) text = truncateByBytes(text, max)
    return text
  }

  function buildManualText() {
    const max = Number(store.meta.settings.maxManualBytes) || 2000
    if (!store.memory.length) return ''
    let text = '## 手动记忆（用户明确要求记住；不要把自动事实混进来）\n'
    for (const item of store.memory.slice(-20)) {
      const line = `- ${(item.tags || []).length ? `[${item.tags.join(',')}] ` : ''}${item.content}\n`
      if (byteLength(text) + byteLength(line) > max) break
      text += line
    }
    return byteLength(text) > max ? truncateByBytes(text, max) : text
  }

  function buildMemoryProfile() {
    const max = Number(store.meta.settings.maxMemoryBytes) || 8000
    let text = store.readMemoryProfile().trim()
    if (!text) return ''
    if (!/^##\s*重要事实/m.test(text)) text = '## 重要事实\n\n' + text
    text = '## 澜的长期记忆（自动编译，可在设置页编辑）\n\n' + text
    if (byteLength(text) > max) text = truncateByBytes(text, max)
    return text
  }

  function buildMoodContract() {
    return String(store.persona.moodContract || '').slice(0, 12000)
  }

  function buildLastMood() {
    const max = Number(store.meta.settings.maxMoodBytes) || 1024
    const last = store.moods.length ? store.moods[store.moods.length - 1] : null
    if (!last || !last.text) return ''
    let text = '最近状态池（上一轮参考，本轮重新生成，可在此基础上演变）：\n<mood>\n' + String(last.text).slice(0, 1500) + '\n</mood>'
    if (byteLength(text) > max) text = truncateByBytes(text, max)
    return text
  }

  // ---------- 工具 ----------
  const tools = []
  const disposers = []

  function registerTool(def) {
    try {
      disposers.push(ctx.tools.register(def))
      health.tools++
    } catch (e) {
      noteError(`tool ${def.name}`, e)
    }
  }

  function afterWrite() {
    try { store.writeDerivedViews() } catch (e) { noteError('views', e) }
    indexCache = null
    expIndexCache = null
  }

  tools.push({
    name: 'lan_remember',
    description: '写入一条本地长期记忆/常驻记忆/经验。写入纪律：仅当用户显式要求记住、同一事实被强调≥2次、或用户纠正了你的错误判断时调用；必须是提炼后的 1-3 句、一条一事，memory/experience 单条 ≤300 字、pinned ≤800 字；禁止把整段对话或代码原样写入；不记密钥/口令/证件号等敏感信息。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆内容，1-3 句，一条一事' },
        layer: { type: 'string', enum: ['memory', 'pinned', 'experience'], description: '默认 memory=用户明确记住；pinned=始终注入；experience=方法/经验库' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签；pinned 层的第一个 tag 作为条目标签' },
        category: { type: 'string', description: 'experience 层的分类，2-4 个词' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => textBlock(v && v.ok ? `已记住（${v.layer}）${v.id ? ` id=${v.id}` : ''}` : `写入失败：${(v && v.error) || '未知错误'}`),
    },
    execute(args) {
      try {
        if (store.readOnly) return { ok: false, error: '数据目录被另一个进程占用（只读模式）' }
        const content = argString(args, 'content', { required: true, max: 4000 })
        const layer = argString(args, 'layer') || 'memory'
        const tags = Array.isArray(args && args.tags) ? args.tags : []
        const limits = store.meta.settings
        const maxChars = layer === 'pinned'
          ? (Number(limits.maxPinnedEntryChars) || 800)
          : (Number(limits.maxEntryChars) || 300)
        if (content.length > maxChars) {
          return { ok: false, error: `内容 ${content.length} 字，超过单条上限 ${maxChars} 字。请先提炼成 1-3 句、一条一事再写入，不要整段复制对话或代码。` }
        }
        const lineCount = content.split('\n').filter((x) => x.trim()).length
        const fenceCount = (content.match(/```/g) || []).length
        if (lineCount > 4 || fenceCount >= 2) {
          return { ok: false, error: '内容看起来是整段对话/代码；请提炼成 1-3 句事实、偏好或结论再写入。' }
        }
        let item
        if (layer === 'pinned') {
          const tag = String(tags[0] || '通用').slice(0, 20) || '通用'
          const next = store.pinned.slice()
          const existing = next.findIndex((p) => p.tag === tag)
          if (existing >= 0) next[existing] = { ...next[existing], content, updatedAt: Date.now() }
          else next.push({ tag, content, updatedAt: Date.now() })
          store.savePinned(next)
          item = { tag, content }
        } else if (layer === 'experience') {
          item = store.addExperience({ category: argString(args, 'category') || tags[0] || '未分类', content })
        } else {
          item = store.addMemory({ content, tags, source: 'lan' })
        }
        afterWrite()
        return { ok: true, layer, id: item && item.id ? item.id : '', content }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    },
  })

  tools.push({
    name: 'lan_recall',
    description: '按关键词检索本地记忆（手动记忆 / 自动事实 / 经验库），返回 top_k 条（默认 5，最多 10）。回答涉及用户过往偏好、历史决定、长期事实时主动调用；命中低于阈值返回空。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或问题描述' },
        top_k: { type: 'integer', description: '返回条数，默认 5，最大 10' },
        layer: { type: 'string', enum: ['memory', 'fact', 'experience'], description: '默认 memory=手动记忆；fact=自动事实；experience=经验库' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        const list = (v && v.results) || []
        if (!list.length) return textBlock('（无命中）')
        return textBlock(list.map((r) => `• ${r.layer === 'experience' ? `[${r.category || '经验'}] ` : (r.tags && r.tags.length ? `[${r.tags.join(',')}] ` : '')}${r.content}`).join('\n'))
      },
    },
    execute(args) {
      try {
        const query = argString(args, 'query', { required: true, max: 2000 })
        const topK = Math.max(1, Math.min(10, argNumber(args, 'top_k', 5)))
        const requested = argString(args, 'layer')
        const layer = requested === 'experience' ? 'experience' : requested === 'fact' ? 'fact' : 'memory'
        return { results: recall(query, topK, layer), count: store.pendingJournal().length }
      } catch (e) {
        return { results: [], error: String(e && e.message ? e.message : e) }
      }
    },
  })

  tools.push({
    name: 'lan_list',
    description: '浏览本地记忆/自动事实（分页）。layer=pinned/memory/fact/experience，默认 memory；可传 tag/category 过滤；limit 默认 50，最大 200。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['pinned', 'memory', 'fact', 'experience'] },
        tag: { type: 'string', description: '可选：按标签/分类过滤' },
        offset: { type: 'integer', description: '默认 0' },
        limit: { type: 'integer', description: '默认 50，最大 200' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        if (!v || !v.items) return textBlock('（读取失败）')
        if (!v.items.length) return textBlock('（该层暂无条目）')
        return textBlock(`共 ${v.total} 条，显示第 ${v.offset + 1}-${v.offset + v.items.length} 条\n` + v.items.map((r) => `${r.id} ${r.tags && r.tags.length ? `[${r.tags.join(',')}] ` : ''}${r.content}`).join('\n'))
      },
    },
    execute(args) {
      try {
        const layer = argString(args, 'layer') || 'memory'
        const tag = argString(args, 'tag')
        const offset = Math.max(0, argNumber(args, 'offset', 0))
        const limit = Math.max(1, Math.min(200, argNumber(args, 'limit', 50)))
        let pool
        if (layer === 'pinned') pool = store.pinned.map((p) => ({ id: p.id, tags: [p.tag], content: p.content }))
        else if (layer === 'experience') pool = store.experience.map((e) => ({ id: e.id, tags: [e.category], content: e.content, category: e.category }))
        else if (layer === 'fact') pool = store.facts.map((f) => ({ id: f.id, tags: f.tags || [], content: f.fact, time: f.time }))
        else pool = store.memory.map((m) => ({ id: m.id, tags: m.tags || [], content: m.content }))
        if (tag) pool = pool.filter((x) => (x.tags || []).some((t) => String(t).includes(tag)) || String(x.content).includes(tag))
        return { layer, total: pool.length, offset, items: pool.slice(offset, offset + limit) }
      } catch (e) {
        return { items: [], error: String(e && e.message ? e.message : e) }
      }
    },
  })

  tools.push({
    name: 'lan_forget',
    description: '删除本地记忆。传 id 精确删除；传 keyword 先干跑返回命中清单，dry_run:false 才真正删除。删除前自动备份，可撤销。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['pinned', 'memory', 'fact', 'experience'], description: '默认 memory；fact=自动事实' },
        id: { type: 'string', description: '精确删除的条目 id' },
        keyword: { type: 'string', description: '按关键词模糊匹配' },
        dry_run: { type: 'boolean', description: '默认 true；只有显式 false 才真正删除' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        if (v && v.dryRun) return textBlock(`干跑：命中 ${v.matches.length} 条（确认后 dry_run:false 删除）\n` + v.matches.map((m) => `${m.id} ${m.content}`).join('\n'))
        return textBlock(v && v.removed ? `已删除 ${v.removed} 条` : '未删除任何条目')
      },
    },
    execute(args) {
      try {
        if (store.readOnly) return { removed: 0, error: '只读模式' }
        const layer = argString(args, 'layer') || 'memory'
        const id = argString(args, 'id')
        const keyword = argString(args, 'keyword')
        const dryRun = args && args.dry_run !== undefined ? !!args.dry_run : !id
        const pool = layer === 'pinned' ? store.pinned.map((p, i) => ({ id: `p${i}`, index: i, content: p.content, tag: p.tag }))
          : layer === 'experience' ? store.experience.map((e) => ({ id: e.id, content: e.content, category: e.category }))
            : layer === 'fact' ? store.facts.map((f) => ({ id: f.id, content: f.fact, tags: f.tags }))
              : store.memory.map((m) => ({ id: m.id, content: m.content, tags: m.tags }))
        let matches = []
        if (id) matches = pool.filter((x) => x.id === id)
        else if (keyword) matches = pool.filter((x) => String(x.content).includes(keyword) || (x.tags || []).some((t) => String(t).includes(keyword)) || String(x.category || '').includes(keyword) || String(x.tag || '').includes(keyword))
        else return { removed: 0, error: '需要 id 或 keyword' }
        if (!matches.length) return { removed: 0, matches: [], dryRun }
        if (dryRun) return { dryRun: true, matches: matches.slice(0, 20), total: matches.length }
        store.undoSnapshot('forget')
        if (layer === 'pinned') {
          const idx = new Set(matches.map((m) => m.index))
          store.savePinned(store.pinned.filter((_, i) => !idx.has(i)))
        } else if (layer === 'experience') {
          const ids = new Set(matches.map((m) => m.id))
          store.saveExperience(store.experience.filter((e) => !ids.has(e.id)))
        } else if (layer === 'fact') {
          for (const m of matches) store.deleteFact(m.id)
        } else {
          const ids = new Set(matches.map((m) => m.id))
          for (const id of ids) store.deleteMemory(id)
        }
        afterWrite()
        return { removed: matches.length, matches: [], dryRun: false }
      } catch (e) {
        return { removed: 0, error: String(e && e.message ? e.message : e) }
      }
    },
  })

  tools.push({
    name: 'lan_organize',
    description: '整理本地记忆：action=compile 立即自动编译（抽取事实→更新 memory.md，可编辑、可撤销）；preview 干跑清单；apply-local 对 memory.jsonl 做确定性去重；undo 撤销最近一次本地整理。自动整理默认开启，日常不需要手动调用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['preview', 'apply-local', 'compile', 'review-pack', 'undo'], description: '默认 compile；review-pack 兼容旧名，等同 compile' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        if (!v) return textBlock('（整理失败）')
        if (v.pack) return textBlock(v.pack)
        if (v.error) return textBlock(`整理失败：${v.error}`)
        if (v.compile) {
          const c = v.compile
          if (c.error) return textBlock(`自动编译失败：${c.error}（线索已保留，稍后重试）`)
          return textBlock(`自动编译完成：${c.compiled || 0} 条线索 → ${c.factsAdded || 0} 条事实；画像 ${c.factsTotal || 0} 条事实${c.model ? `；模型 ${c.model}` : ''}`)
        }
        const r = v.report || {}
        const lines = []
        if (r.countsBefore) lines.push(`整理：${r.countsBefore.memory}→${r.countsAfter.memory} 条记忆，${r.countsBefore.experience}→${r.countsAfter.experience} 条经验`)
        else if (v.undoId) lines.push('已撤销最近一次整理')
        for (const a of r.actions || []) lines.push(`- ${a.kind} ${a.layer}: ${a.preview}`)
        if (r.undoId) lines.push(`可撤销 id：${r.undoId}`)
        return textBlock(lines.join('\n') || '无需整理')
      },
    },
    execute(args) {
      try {
        const action = argString(args, 'action') || 'compile'
        if (action === 'preview') return { report: organizer.preview() }
        if (action === 'apply-local') {
          if (store.readOnly) return { error: '只读模式' }
          const report = organizer.applyLocal()
          afterWrite()
          return { report }
        }
        if (action === 'compile' || action === 'review-pack') {
          if (store.readOnly) return { error: '只读模式' }
          return compiler.run({ force: true, reason: 'manual' }).then((compile) => ({ compile }))
        }
        if (action === 'undo') {
          if (store.readOnly) return { error: '只读模式' }
          const res = organizer.undo()
          afterWrite()
          return { undoId: res.undoId, report: { actions: [] } }
        }
        return { error: `unknown action: ${action}` }
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) }
      }
    },
  })

  tools.push({
    name: 'lan_status',
    description: '查看澜记忆系统状态：数据目录、记忆/事实/经验条数、待编译数、自动编译状态、捕获健康、是否只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => textBlock(`数据目录：${v.dataDir}\n常驻 ${v.counts.pinned} 条｜手动记忆 ${v.counts.memory} 条｜自动事实 ${v.counts.facts || 0} 条｜经验 ${v.counts.experience} 条｜待编译 ${v.counts.journalPending} 条` + (v.compile ? `\n自动编译：${v.compile.state}${v.compile.model ? `（${v.compile.model}）` : ''}${v.compile.lastError ? `｜最近错误：${v.compile.lastError}` : ''}` : '') + (v.meta && v.meta.lastOrganize ? `\n最近本地整理：${v.meta.lastOrganize.at}（${v.meta.lastOrganize.summary}）` : '') + (v.readOnly ? '\n⚠️ 只读模式' : '')),
    },
    execute() {
      try {
        const stats = store.stats()
        return { ...stats, compile: compiler.status(), health: getHealth() }
      } catch (e) {
        return { dataDir: store.dataDir, counts: { pinned: 0, memory: 0, experience: 0, facts: 0, journalPending: 0 }, error: String(e && e.message ? e.message : e) }
      }
    },
  })

  for (const tool of tools) registerTool(tool)

  // ---------- 提示词注入 ----------
  function addSection(def) {
    try {
      disposers.push(ctx.systemPrompt.section(def))
      health.sections++
    } catch (e) { noteError(`section ${def.name}`, e) }
  }
  function addContext(def) {
    try {
      const fn = ctx.systemPrompt.context || ctx.systemPrompt.section
      disposers.push(fn.call(ctx.systemPrompt, def))
      health.contexts++
    } catch (e) { noteError(`context ${def.name}`, e) }
  }

  addSection({
    name: 'lan:persona',
    order: -90,
    interpolate: false,
    text: () => String(store.persona.soul || '').slice(0, 12000),
  })
  addSection({
    name: 'lan:mood-contract',
    order: -88,
    interpolate: false,
    text: () => buildMoodContract(),
  })
  addSection({
    name: 'lan:rules',
    order: -85,
    interpolate: false,
    text: () => store.meta.settings.autoCompile === false
      ? MEMORY_RULES
      : `${MEMORY_RULES}\n${organizeRule(Number(store.meta.settings.autoCompileThreshold) || 6)}`,
  })
  addContext({ name: 'lan:pinned', order: -80, interpolate: false, text: () => buildPinnedText() })
  addContext({ name: 'lan:manual', order: -74, interpolate: false, text: () => buildManualText() })
  addContext({ name: 'lan:memory', order: -73, interpolate: false, text: () => buildMemoryProfile() })
  addContext({ name: 'lan:index', order: -75, interpolate: false, text: () => buildIndexHint() })
  addContext({ name: 'lan:mood-last', order: -70, interpolate: false, text: () => buildLastMood() })

  // ---------- 事件 ----------
  function addEvent(name, fn) {
    try {
      const off = ctx.on(name, fn)
      if (typeof off === 'function') disposers.push(off)
      health.events++
    } catch (e) { noteError(`event ${name}`, e) }
  }

  addEvent('session/event', (session, event) => {
    try { capture.handleSessionEvent(session, event) } catch (e) { noteError('capture', e) }
  })

  // 兜底：实机验证发现 session/event 不一定把 turn/end 送到插件
  // （events 在涨、flushed 一直是 0），所以用官方 turn-stopping / idle / disposed
  // 三个时机按 session 主动落盘；buffer 落盘后即删除，重复触发不会重复写。
  function flushAgentSession(agent, reason) {
    try {
      const id = agent && agent.session && agent.session.id
      if (id) capture.flushSession(id, Date.now())
    } catch (e) { noteError(`flush ${reason}`, e) }
  }

  addEvent('agent/turn-stopping', (payload) => {
    flushAgentSession(payload && payload.agent, 'turn-stopping')
    compiler.schedule()
  })
  addEvent('agent/status', (payload) => {
    if (payload && payload.status === 'idle') {
      flushAgentSession(payload.agent, 'idle')
      compiler.schedule()
    }
  })
  addEvent('agent/disposed', (payload) => {
    flushAgentSession(payload && payload.agent, 'disposed')
    compiler.schedule()
  })

  // ---------- HTTP ----------
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    try {
      const http = createHttpHandler({ store, organizer, capture, compiler, getHealth, logger })
      disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/lan-memory', handler: http.handle }))
      health.routes++
    } catch (e) { noteError('webServer route', e) }
  } else {
    health.panel = false
    info('[lan] webServer unavailable in this composition; management panel disabled')
  }

  try { store.writeDerivedViews() } catch (e) { noteError('views', e) }
  // 启动后也尝试一次自动编译：用户重启后不必先发一句话才会触发。
  try { compiler.schedule(8000) } catch (e) { noteError('compile schedule', e) }

  info(`[lan] v${VERSION} ready: pinned=${store.pinned.length} memory=${store.memory.length} experience=${store.experience.length} pending=${store.pendingJournal().length} dataDir=${dataDir}`)
  if (migration.found) info(`[lan] migrated from v1: ${migration.copied.join(', ')}`)
  return () => {
    try { capture.flushAll() } catch { /* 忽略 */ }
    for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* 忽略 */ } }
    try { store.writeDerivedViews() } catch { /* 忽略 */ }
    try { store.releaseLock() } catch { /* 忽略 */ }
  }
}

export { shortHash }
