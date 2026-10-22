/**
 * 自动记忆编译管线。
 *
 * 设计参考 Hanako 的「摘要 → 元事实 → 分层画像」思路，但保持本插件的
 * 文件优先与零外部依赖：
 *   journal 原始记录  →  LLM 抽取原子事实  →  facts.jsonl
 *   facts + 旧画像    →  LLM 合并四段画像  →  facts.md / today.md / week.md / longterm.md / memory.md
 *
 * 模型走 DSH 原生 ctx.llm（复用当前已配置的 provider，不引入 API Key）。
 * 编译失败不推进 journal 状态，下一次自动重试；成功后才标记 compiled。
 */
import { createHash } from 'node:crypto'

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)

function normalizeFact(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim()
}

function clip(text, max) {
  const s = String(text || '').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

function stripMood(text) {
  return String(text || '').replace(/<mood\b[^>]*>[\s\S]*?<\/mood>/gi, '').trim()
}

function parseJson(text) {
  let s = String(text || '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()
  const start = s.search(/[\[{]/)
  if (start < 0) throw new Error('模型没有返回 JSON')
  const open = s[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return JSON.parse(s.slice(start, i + 1))
    }
  }
  throw new Error('模型返回的 JSON 不完整')
}

function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : []
  const out = []
  for (const t of list) {
    const s = String(t || '').trim().replace(/^#/, '')
    if (s && !out.includes(s)) out.push(s.slice(0, 30))
    if (out.length >= 5) break
  }
  return out
}

const EXTRACT_PROMPT = `你是长期记忆抽取器。输入是最近的对话记录（含用户与助手）。请只抽取值得长期保留的「用户事实」，输出严格 JSON 数组，不要 markdown、不要解释。

规则：
1. 一条一事，原子化；每条 1-2 句，最多 80 字。
2. 只保留稳定的用户画像：身份、性格、审美、兴趣、好恶、长期关系、长期关注方向、明确偏好、重要决定。
3. 排除：任务执行细节、工具/命令/文件名、代码、测试与发布流程、协作流程、助手产出内容、一次性的过程波动。
4. 不要抽取助手的内心想法；只抽取客观事实或用户明确表达。
5. 每条给 2-5 个检索标签；time 用记录里出现的时间（YYYY-MM-DDTHH:MM）或 null。
6. 没有值得保留的内容就返回 []。

输出格式：
[{"fact":"用户偏好直接给结论，不要先铺垫背景","tags":["偏好","沟通"],"time":null}]`

const COMPILE_PROMPT = `你是长期记忆编译器。输入是「当前四段画像」和「新增原子事实」。请把它们合并重写成新的四段画像，输出严格 JSON 对象，不要 markdown、不要解释。

结构：{"facts":"...","today":"...","week":"...","longterm":"..."}

规则：
1. facts（重要事实）：稳定用户画像，最多 200 字；旧的过长就压缩成更高层概括。
2. today（今天）：最近一天 3-5 条粗颗粒事件，每条 1-2 句，共最多 300 字；保留粗时间锚点，如上午/傍晚。
3. week（本周）：最近一周的粗颗粒概览，最多 600 字；同主题多次往返合并成一件事。
4. longterm（长期）：只留“一年后回看仍能理解这个人”的内容，最多 400 字。
5. 只做取舍、抽象、合并；不要追加，不要把旧内容和新内容分开复述。
6. 不保留执行步骤、文件名、工具、命令、测试、发布流程、协作偏好、助手产出细节。
7. 某段没有内容时写“（暂无）”；不要输出 Markdown 标题。`

export function createCompiler({ store, llm, logger = console, getSettings, getDefaultModel }) {
  const settings = () => ({ ...store.meta.settings, ...(getSettings ? getSettings() : {}) })
  let modelCache = null
  let running = null
  let timer = null
  let lastAttempt = 0

  function log(msg) { try { (logger.info || logger.log || console.log)(`[lan:compile] ${msg}`) } catch { /* 忽略 */ } }
  function warn(msg) { try { (logger.warn || console.warn)(`[lan:compile] ${msg}`) } catch { /* 忽略 */ } }

  function updateMeta(patch) {
    try { store.saveMeta({ compile: { ...(store.meta.compile || {}), ...patch, updatedAt: new Date().toISOString() } }) } catch { /* 忽略 */ }
  }

  async function resolveModel() {
    if (!llm) throw new Error('宿主没有 llm 服务')
    const s = settings()
    if (s.memoryProvider && s.memoryModel) return { provider: s.memoryProvider, model: s.memoryModel }
    if (getDefaultModel) {
      try {
        const d = getDefaultModel()
        if (d && d.provider && d.model) return { provider: String(d.provider), model: String(d.model) }
      } catch { /* 继续自动探测 */ }
    }
    if (modelCache && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.value
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    for (const p of providers) {
      const provider = String(p && (p.id || p.provider || p.name) || '')
      if (!provider) continue
      try {
        const models = await llm.listModels(provider)
        const model = (models || []).map((m) => String(m && (m.id || m.model) || '')).find(Boolean)
        if (model) {
          const value = { provider, model }
          modelCache = { at: Date.now(), value }
          return value
        }
      } catch { /* 换下一个 provider */ }
    }
    throw new Error('没有可用的模型；请在设置里指定 memoryProvider/memoryModel')
  }

  async function call(prompt, maxTokens) {
    const route = await resolveModel()
    let text = ''
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0.2,
      maxTokens: maxTokens || 1200,
    })) {
      if (chunk && chunk.type === 'text-delta') text += chunk.text || ''
      if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        throw new Error(`模型调用失败：${chunk.reason.failure && chunk.reason.failure.code ? chunk.reason.failure.code : 'unknown'}`)
      }
    }
    return text.trim()
  }

  function journalLines(records) {
    const lines = []
    for (const rec of records) {
      const user = stripMood(rec.user)
      const assistant = stripMood(rec.assistant)
      if (user) lines.push(`[${rec.session || 's'}#${rec.turn || '?'}] 用户：${clip(user, 700)}`)
      if (assistant) lines.push(`[${rec.session || 's'}#${rec.turn || '?'}] 助手：${clip(assistant, 450)}`)
      if (lines.length >= 60) break
    }
    return lines.join('\n').slice(0, 16000)
  }

  async function extractFacts(records) {
    const input = journalLines(records)
    if (!input) return []
    const raw = await call(EXTRACT_PROMPT + '\n\n### 对话记录\n' + input, 1400)
    let arr
    try { arr = parseJson(raw) } catch (e) { throw new Error(`事实抽取 JSON 解析失败：${e.message}`) }
    if (!Array.isArray(arr)) throw new Error('事实抽取返回值不是数组')
    const out = []
    const seen = new Set(store.facts.map((f) => normalizeFact(f.fact)))
    for (const item of arr) {
      if (!item || typeof item.fact !== 'string') continue
      const fact = clip(item.fact.replace(/\s+/g, ' ').trim(), 120)
      if (!fact) continue
      const key = normalizeFact(fact)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({ fact, tags: cleanTags(item.tags), time: typeof item.time === 'string' ? item.time.slice(0, 32) : null })
      if (out.length >= 20) break
    }
    return out
  }

  function currentSections() {
    return store.compiled || { facts: '', today: '', week: '', longterm: '' }
  }

  function fallbackProfile(newFacts) {
    const cur = currentSections()
    const merged = [cur.facts, ...newFacts.map((f) => `- ${f.fact}`)].filter(Boolean).join('\n').trim()
    return {
      facts: clip(merged, 200),
      today: cur.today || '（暂无）',
      week: cur.week || '（暂无）',
      longterm: cur.longterm || '（暂无）',
    }
  }

  async function compileProfile(newFacts) {
    const cur = currentSections()
    const all = store.facts.slice(-80).map((f) => `- ${f.fact}${(f.tags || []).length ? ` [${f.tags.join(',')}]` : ''}`).join('\n')
    const input = [
      '### 当前四段画像',
      `facts: ${cur.facts || '（暂无）'}`,
      `today: ${cur.today || '（暂无）'}`,
      `week: ${cur.week || '（暂无）'}`,
      `longterm: ${cur.longterm || '（暂无）'}`,
      '### 新增原子事实',
      newFacts.map((f) => `- ${f.fact}${(f.tags || []).length ? ` [${f.tags.join(',')}]` : ''}`).join('\n') || '（无）',
      '### 已有事实库（最近 80 条，供合并去重）',
      all || '（空）',
    ].join('\n')
    let raw
    try { raw = await call(COMPILE_PROMPT + '\n\n' + input, 1800) } catch (e) { throw new Error(`画像编译失败：${e.message}`) }
    let obj
    try { obj = parseJson(raw) } catch (e) { throw new Error(`画像 JSON 解析失败：${e.message}`) }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('画像返回值不是对象')
    const section = (v, max) => clip(typeof v === 'string' ? v.trim() : '', max) || '（暂无）'
    return {
      facts: section(obj.facts, 240),
      today: section(obj.today, 360),
      week: section(obj.week, 720),
      longterm: section(obj.longterm, 480),
    }
  }

  async function runOnce({ force = false, reason = 'auto' } = {}) {
    if (!store || store.readOnly) return { ok: false, error: '只读模式' }
    const s = settings()
    if (!force && s.autoCompile === false) return { ok: false, skipped: 'autoCompile off' }
    const pending = store.pendingJournal()
    if (!pending.length) {
      if (!force || !store.facts.length) return { ok: true, skipped: 'no pending', factsAdded: 0, compiled: 0 }
      if (running) return running
      running = (async () => {
        const started = Date.now()
        try {
          const route = await resolveModel()
          updateMeta({ state: 'running', model: `${route.provider}/${route.model}`, lastReason: reason })
          const profile = await compileProfile([])
          store.writeCompiled(profile)
          updateMeta({ state: 'ok', lastRunAt: new Date().toISOString(), pending: 0, factsTotal: store.facts.length, factsAdded: 0, model: `${route.provider}/${route.model}`, durationMs: Date.now() - started })
          return { ok: true, factsAdded: 0, factsTotal: store.facts.length, compiled: 0, model: `${route.provider}/${route.model}` }
        } catch (e) {
          const msg = String(e && e.message ? e.message : e)
          updateMeta({ state: 'error', lastError: msg, lastErrorAt: new Date().toISOString(), pending: 0 })
          warn(msg)
          return { ok: false, error: msg }
        } finally {
          running = null
        }
      })()
      return running
    }
    const threshold = Number(s.autoCompileThreshold) || 6
    const oldest = pending.reduce((min, r) => Math.min(min, Number(r.ts) || Date.now()), Date.now())
    const idleMs = (Number(s.compileIdleMinutes) || 30) * 60 * 1000
    if (!force && pending.length < threshold && Date.now() - oldest < idleMs) return { ok: true, skipped: 'below threshold', pending: pending.length }
    if (running) return running
    running = (async () => {
      const started = Date.now()
      updateMeta({ state: 'running', model: null, lastError: null, lastReason: reason, pending: pending.length })
      try {
        const route = await resolveModel()
        updateMeta({ state: 'running', model: `${route.provider}/${route.model}` })
        const batch = pending.slice(0, 40)
        const facts = await extractFacts(batch)
        if (!facts.length) {
          for (const rec of batch) store.setJournalStatus(rec.id, 'compiled', { by: 'auto', reason: 'no-facts' })
          updateMeta({ state: 'ok', lastRunAt: new Date().toISOString(), pending: store.pendingJournal().length, factsAdded: 0, model: `${route.provider}/${route.model}`, durationMs: Date.now() - started })
          return { ok: true, factsAdded: 0, compiled: batch.length, model: `${route.provider}/${route.model}` }
        }
        const profile = await compileProfile(facts)
        const added = store.appendFacts(facts.map((f) => ({ ...f, source: 'auto', session: batch[0] && batch[0].session })))
        store.writeCompiled(profile)
        for (const rec of batch) store.setJournalStatus(rec.id, 'compiled', { by: 'auto', facts: added.length })
        updateMeta({ state: 'ok', lastRunAt: new Date().toISOString(), pending: store.pendingJournal().length, factsTotal: store.facts.length, factsAdded: added.length, model: `${route.provider}/${route.model}`, durationMs: Date.now() - started })
        log(`compiled ${batch.length} journal records → ${added.length} facts`)
        return { ok: true, factsAdded: added.length, factsTotal: store.facts.length, compiled: batch.length, model: `${route.provider}/${route.model}` }
      } catch (e) {
        const msg = String(e && e.message ? e.message : e)
        updateMeta({ state: 'error', lastError: msg, lastErrorAt: new Date().toISOString(), pending: store.pendingJournal().length })
        warn(msg)
        return { ok: false, error: msg }
      } finally {
        running = null
      }
    })()
    return running
  }

  function schedule(delay = 15000, force = false) {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      lastAttempt = Date.now()
      runOnce({ force, reason: force ? 'remember' : 'scheduled' }).catch(() => {})
    }, Math.max(1000, delay))
    if (timer.unref) timer.unref()
  }

  function status() {
    const c = store.meta.compile || {}
    return {
      running: !!running,
      auto: settings().autoCompile !== false,
      threshold: Number(settings().autoCompileThreshold) || 6,
      pending: store.pendingJournal().length,
      facts: store.facts.length,
      model: c.model || null,
      state: c.state || 'idle',
      lastRunAt: c.lastRunAt || null,
      lastError: c.lastError || null,
      durationMs: c.durationMs || null,
      memoryBytes: Buffer.byteLength(store.memoryProfile || ''),
    }
  }

  return { run: runOnce, schedule, status, resolveModel, _parseJson: parseJson, _normalizeFact: normalizeFact }
}
