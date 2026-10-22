/**
 * 文件存储层。
 *
 * 设计原则（对应 research/04-v2-plan.md）：
 *  - 文件是唯一真源：persona.md / pinned.md / memory.jsonl / experience.jsonl / mood.jsonl
 *  - 写盘五步护栏：读指纹 → 备份上一版(.bak) → tmp+rename 原子写 → 回读校验 → 失败可见
 *  - 任何"整理/删除/迁移"前做整份快照（backups/<ts>/ + manifest.sha256），可恢复、可撤销
 *  - IO 错误绝不静默当空串（v1 的致命缺陷）
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync,
  readdirSync, statSync, unlinkSync, appendFileSync, rmdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_SETTINGS, defaultPersonaMarkdown } from './defaults.js'

export const SCHEMA_VERSION = 2
const BACKUP_KEEP = 20
const UNDO_KEEP = 10
const MOOD_KEEP = 200
const V1_DIR_NAME = 'hanako'

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const shortHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16)

export function resolveDefaultDataDir(env = process.env) {
  const home = (env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  return join(home, 'lan-memory')
}

export function localDate(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function readTextStrict(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw new Error(`读取失败 ${file}: ${e && e.message ? e.message : e}`)
  }
}

function parseJsonl(text) {
  if (!text) return { items: [], badLines: 0 }
  const items = []
  let badLines = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try { items.push(JSON.parse(line)) } catch { badLines++ }
  }
  return { items, badLines }
}

function toJsonl(items) {
  return items.map((it) => JSON.stringify(it)).join('\n') + (items.length ? '\n' : '')
}

function genId(prefix = 'm') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 从 persona.md 解析 SOUL / MOOD 两段；解析失败时整篇当 SOUL。 */
export function parsePersonaMarkdown(md, fallback) {
  const text = String(md || '')
  const soulMatch = /^##\s*SOUL\s*$/im.exec(text)
  const moodMatch = /^##\s*MOOD\s*$/im.exec(text)
  if (soulMatch && moodMatch) {
    const soulStart = soulMatch.index + soulMatch[0].length
    const moodStart = moodMatch.index + moodMatch[0].length
    const soul = text.slice(soulStart, moodMatch.index).trim()
    const mood = text.slice(moodStart).trim()
    if (soul) return { soul, moodContract: mood || fallback.moodContract }
  }
  if (soulMatch) {
    const start = soulMatch.index + soulMatch[0].length
    const rest = text.slice(start).trim()
    if (rest) return { soul: rest, moodContract: fallback.moodContract }
  }
  const whole = text.trim()
  if (whole) return { soul: whole, moodContract: fallback.moodContract }
  return { soul: fallback.soul, moodContract: fallback.moodContract }
}

export function serializePersonaMarkdown(persona) {
  return [
    '# 澜 · 人格',
    '',
    '> 本文件是唯一真源，可整段手改。上半部分是 SOUL（稳定人格），下半部分是 MOOD 契约（每轮状态池格式 + 记忆纪律）。',
    '',
    '## SOUL',
    '',
    String(persona.soul || '').trim(),
    '',
    '## MOOD',
    '',
    String(persona.moodContract || '').trim(),
    '',
  ].join('\n')
}

/** 从 pinned.md 解析条目，兼容 v1 的 `[tag] content` 与 v2 的 `- [tag] content`。 */
export function parsePinnedMarkdown(md) {
  const out = []
  for (const raw of String(md || '').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('- ')) line = line.slice(2).trim()
    else if (line.startsWith('* ')) line = line.slice(2).trim()
    const m = /^\[([^\]]{1,40})\]\s*([\s\S]+)$/.exec(line)
    if (m) out.push({ tag: m[1].trim(), content: m[2].trim() })
    else out.push({ tag: '通用', content: line })
  }
  return out
}

export function serializePinnedMarkdown(items) {
  return items.map((p) => `- [${p.tag || '通用'}] ${p.content}`).join('\n') + (items.length ? '\n' : '')
}

function normalizePinned(items) {
  return items.map((p, i) => ({
    id: `p${i}`,
    tag: String(p.tag || '通用').trim() || '通用',
    content: String(p.content || '').trim(),
    updatedAt: Number(p.updatedAt) || 0,
  })).filter((p) => p.content)
}

export class Store {
  constructor(options = {}) {
    this.dataDir = options.dataDir || resolveDefaultDataDir()
    this.logger = options.logger || console
    this.readOnly = false
    this.lockInfo = null
    this.loadedAt = 0
    this.lastError = null
    this.persona = { soul: '', moodContract: '' }
    this.pinned = []
    this.memory = []
    this.experience = []
    this.facts = []
    this.compiled = { facts: '', today: '', week: '', longterm: '' }
    this.memoryProfile = ''
    this.moods = []
    this.meta = {}
    this._etag = ''
    this._journalReadCache = new Map()
    this._pendingCache = null
  }

  // ---------- 路径 ----------
  p(...parts) { return join(this.dataDir, ...parts) }
  get personaFile() { return this.p('persona.md') }
  get pinnedFile() { return this.p('pinned.md') }
  get memoryFile() { return this.p('memory.jsonl') }
  get factsFile() { return this.p('facts.jsonl') }
  get memoryMdFile() { return this.p('memory.md') }
  get factsMdFile() { return this.p('facts.md') }
  get todayMdFile() { return this.p('today.md') }
  get weekMdFile() { return this.p('week.md') }
  get longtermMdFile() { return this.p('longterm.md') }
  get experienceFile() { return this.p('experience.jsonl') }
  get moodFile() { return this.p('mood.jsonl') }
  get metaFile() { return this.p('meta.json') }
  get journalDir() { return this.p('journal') }
  get backupDir() { return this.p('backups') }
  get undoDir() { return this.p('undo') }
  get viewsDir() { return this.p('views') }
  get lockFile() { return this.p('.lock') }
  get journalStatusFile() { return this.p('journal-status.jsonl') }

  // ---------- 初始化 ----------
  init() {
    mkdirSync(this.dataDir, { recursive: true })
    mkdirSync(this.journalDir, { recursive: true })
    mkdirSync(this.backupDir, { recursive: true })
    mkdirSync(this.undoDir, { recursive: true })
    mkdirSync(this.viewsDir, { recursive: true })
    this._acquireLock()
    this.loadAll()
    this.recoverCorrupt()
    const migration = this.migrateFromV1()
    if (migration.found) {
      this.logger.log?.(`[lan] migrated v1 data: ${migration.copied.join(', ')}`)
      this.loadAll()
    }
    this.writeDerivedViews()
    return migration
  }

  _acquireLock() {
    try {
      const raw = readTextStrict(this.lockFile)
      if (raw) {
        const info = JSON.parse(raw)
        const alive = info && info.pid && info.pid !== process.pid && isAlive(info.pid)
        if (alive) {
          this.readOnly = true
          this.lockInfo = info
          this.logger.warn?.(`[lan] another process holds the data dir (pid ${info.pid}); running read-only`)
          return
        }
      }
    } catch { /* 锁损坏按无锁处理 */ }
    try { writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8') } catch { /* 忽略 */ }
  }

  releaseLock() {
    try {
      const raw = readTextStrict(this.lockFile)
      if (!raw) return
      const info = JSON.parse(raw)
      if (info && info.pid === process.pid) unlinkSync(this.lockFile)
    } catch { /* 忽略 */ }
  }

  // ---------- 读 ----------
  loadAll() {
    this.loadedAt = Date.now()
    const fallback = { soul: '', moodContract: '' }
    // persona
    const personaText = readTextStrict(this.personaFile)
    if (personaText === null) {
      const def = defaultPersonaMarkdown()
      this.persona = parsePersonaMarkdown(def, { soul: '', moodContract: '' })
      try { this._safeWrite(this.personaFile, def) } catch { /* 只读模式下保留内存默认值 */ }
    } else {
      this.persona = parsePersonaMarkdown(personaText, fallback)
      if (!this.persona.soul || !this.persona.moodContract) {
        const def = parsePersonaMarkdown(defaultPersonaMarkdown(), fallback)
        this.persona = {
          soul: this.persona.soul || def.soul,
          moodContract: this.persona.moodContract || def.moodContract,
        }
      }
    }
    // pinned
    const pinnedText = readTextStrict(this.pinnedFile)
    if (pinnedText === null) {
      this.pinned = []
      try { this._safeWrite(this.pinnedFile, '') } catch { /* 只读模式 */ }
    } else {
      this.pinned = normalizePinned(parsePinnedMarkdown(pinnedText))
    }
    // memory / experience
    const memoryText = readTextStrict(this.memoryFile)
    const mem = parseJsonl(memoryText)
    this.memory = normalizeMemory(mem.items)
    if (mem.badLines) this.lastError = `memory.jsonl 有 ${mem.badLines} 行无法解析（已跳过）`
    const expText = readTextStrict(this.experienceFile)
    const exp = parseJsonl(expText)
    this.experience = normalizeExperience(exp.items)
    if (exp.badLines) this.lastError = `experience.jsonl 有 ${exp.badLines} 行无法解析（已跳过）`
    // moods
    const moodText = readTextStrict(this.moodFile)
    this.moods = parseJsonl(moodText).items.slice(-MOOD_KEEP)
    // facts + compiled profile（自动整理产物）
    const factsText = readTextStrict(this.factsFile)
    this.facts = normalizeFacts(parseJsonl(factsText).items)
    const profileText = readTextStrict(this.memoryMdFile)
    this.memoryProfile = profileText || ''
    this.compiled = parseCompiledMarkdown(this.memoryProfile)
    // meta
    const metaText = readTextStrict(this.metaFile)
    try { this.meta = metaText ? JSON.parse(metaText) : {} } catch { this.meta = {} }
    this.meta.schemaVersion = SCHEMA_VERSION
    this.meta.settings = { ...DEFAULT_SETTINGS, ...(this.meta.settings || {}) }
    if (!this.meta.createdAt) this.meta.createdAt = new Date().toISOString()
    this._etag = ''
    this._journalReadCache.clear()
    this._pendingCache = null
  }

  /** 若存在 .bak 且主文件损坏/为空，提示可恢复（不自动覆盖）。 */
  recoverCorrupt() {
    for (const file of [this.memoryFile, this.experienceFile, this.pinnedFile]) {
      if (!existsSync(file + '.bak')) continue
      try {
        const cur = statSync(file)
        if (cur.size === 0) {
          this.lastError = `${basename(file)} 为空，上一版在 ${basename(file)}.bak`
        }
      } catch { /* 忽略 */ }
    }
  }

  // ---------- 写 ----------
  _safeWrite(file, content) {
    if (this.readOnly) throw new Error('数据目录被另一个进程占用（只读模式），拒绝写入')
    const dir = dirname(file)
    try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, content, 'utf8')
    // 保留上一版单槽 .bak
    if (existsSync(file)) {
      try { copyFileSync(file, file + '.bak') } catch { /* 忽略 */ }
    }
    renameSync(tmp, file)
    // 回读校验（长度 + 结尾完整性）
    const back = readTextStrict(file)
    if (back !== content) throw new Error(`写盘校验失败 ${basename(file)}`)
    this._etag = ''
    return true
  }

  etag() {
    if (this._etag) return this._etag
    const payload = JSON.stringify({
      persona: this.persona,
      pinned: this.pinned.map((p) => [p.tag, p.content]),
      memory: this.memory.map((m) => [m.id, m.content, m.tags, m.updated_at]),
      facts: this.facts.map((f) => [f.id, f.fact, f.tags, f.time]),
      profile: shortHash(this.memoryProfile || ''),
      experience: this.experience.map((e) => [e.id, e.category, e.content]),
      settings: this.meta.settings,
    })
    this._etag = shortHash(payload)
    return this._etag
  }

  savePersona(persona) {
    const next = {
      soul: String(persona?.soul ?? this.persona.soul).trim(),
      moodContract: String(persona?.moodContract ?? this.persona.moodContract).trim(),
    }
    if (!next.soul) throw new Error('SOUL 不能为空')
    this._safeWrite(this.personaFile, serializePersonaMarkdown(next))
    this.persona = next
    this._etag = ''
    return true
  }

  savePinned(items = this.pinned) {
    const next = normalizePinned(items)
    this._safeWrite(this.pinnedFile, serializePinnedMarkdown(next))
    this.pinned = next
    this._etag = ''
    return true
  }

  saveMemory(items = this.memory) {
    const next = normalizeMemory(items)
    this._safeWrite(this.memoryFile, toJsonl(next))
    this.memory = next
    return true
  }

  saveExperience(items = this.experience) {
    const next = normalizeExperience(items)
    this._safeWrite(this.experienceFile, toJsonl(next))
    this.experience = next
    return true
  }

  /** 追加原子事实；按规范化文本去重，返回真正新增的条目。 */
  appendFacts(items = []) {
    const seen = new Set(this.facts.map((f) => normalizeFactKey(f.fact)))
    const added = []
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue
      const fact = String(raw.fact || '').trim()
      if (!fact) continue
      const key = normalizeFactKey(fact)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const now = new Date().toISOString()
      added.push({
        id: genId('f'),
        fact: fact.slice(0, 200),
        tags: normalizeTags(raw.tags),
        time: raw.time ? String(raw.time).slice(0, 32) : null,
        session: raw.session ? String(raw.session) : null,
        source: String(raw.source || 'auto'),
        created_at: now,
      })
    }
    if (!added.length) return []
    this.facts.push(...added)
    const max = Number(this.meta?.settings?.maxFacts) || 2000
    if (this.facts.length > max) this.facts = this.facts.slice(-max)
    this._safeWrite(this.factsFile, toJsonl(this.facts))
    this._etag = ''
    return added
  }

  saveFacts(items = this.facts) {
    const next = normalizeFacts(items)
    this._safeWrite(this.factsFile, toJsonl(next))
    this.facts = next
    this._etag = ''
    return true
  }

  /** 写入四段编译画像；memory.md 是给人看的合并稿，其余是分段中间稿。 */
  writeCompiled(profile = {}) {
    const next = {
      facts: String(profile.facts || '').trim() || '（暂无）',
      today: String(profile.today || '').trim() || '（暂无）',
      week: String(profile.week || '').trim() || '（暂无）',
      longterm: String(profile.longterm || '').trim() || '（暂无）',
    }
    const md = serializeCompiledMarkdown(next)
    this._safeWrite(this.factsMdFile, next.facts + '\n')
    this._safeWrite(this.todayMdFile, next.today + '\n')
    this._safeWrite(this.weekMdFile, next.week + '\n')
    this._safeWrite(this.longtermMdFile, next.longterm + '\n')
    this._safeWrite(this.memoryMdFile, md)
    this.compiled = next
    this.memoryProfile = md
    this._etag = ''
    return next
  }

  /** 手动编辑合并稿；下一次编译会以它为“当前画像”输入。 */
  saveMemoryProfile(text) {
    const md = String(text || '').trim()
    if (!md) throw new Error('记忆画像不能为空')
    this._safeWrite(this.memoryMdFile, md + '\n')
    this.memoryProfile = md + '\n'
    this.compiled = parseCompiledMarkdown(md)
    this._etag = ''
    return true
  }

  readMemoryProfile() {
    try {
      const text = readTextStrict(this.memoryMdFile)
      if (text !== null) this.memoryProfile = text
    } catch { /* 保留内存副本 */ }
    return this.memoryProfile || ''
  }

  saveMeta(patch = {}) {
    this.meta = { ...this.meta, ...patch, settings: { ...this.meta.settings, ...(patch.settings || {}) } }
    this._safeWrite(this.metaFile, JSON.stringify(this.meta, null, 2))
    this._pendingCache = null
    this._journalReadCache.clear()
    return true
  }

  // ---------- 记忆 CRUD ----------
  addMemory({ content, tags = [], source = 'lan' }) {
    const text = String(content || '').trim()
    if (!text) throw new Error('content 不能为空')
    if (text.length > 4000) throw new Error('单条记忆不能超过 4000 字符')
    const now = new Date().toISOString()
    const item = { id: genId('m'), tags: normalizeTags(tags), content: text, created_at: now, updated_at: now, source: String(source || 'lan') }
    this.memory.push(item)
    this.trimMemory()
    this.saveMemory()
    return item
  }

  updateMemory(id, patch) {
    const item = this.memory.find((m) => m.id === id)
    if (!item) throw new Error('未找到该记忆')
    if (patch.content !== undefined) {
      const text = String(patch.content || '').trim()
      if (!text) throw new Error('content 不能为空')
      item.content = text
    }
    if (patch.tags !== undefined) item.tags = normalizeTags(patch.tags)
    item.updated_at = new Date().toISOString()
    this.saveMemory()
    return item
  }

  deleteMemory(id) {
    const before = this.memory.length
    this.memory = this.memory.filter((m) => m.id !== id)
    if (this.memory.length === before) throw new Error('未找到该记忆')
    this.saveMemory()
    return true
  }

  addExperience({ category, content }) {
    const c = String(category || '').trim()
    const text = String(content || '').trim()
    if (!c || !text) throw new Error('category 与 content 不能为空')
    const item = { id: genId('e'), category: c, content: text, created_at: new Date().toISOString() }
    this.experience.push(item)
    this.trimExperience()
    this.saveExperience()
    return item
  }

  updateExperience(id, patch) {
    const item = this.experience.find((e) => e.id === id)
    if (!item) throw new Error('未找到该经验')
    if (patch.category !== undefined) item.category = String(patch.category || '').trim() || item.category
    if (patch.content !== undefined) item.content = String(patch.content || '').trim() || item.content
    this.saveExperience()
    return item
  }

  deleteExperience(id) {
    const before = this.experience.length
    this.experience = this.experience.filter((e) => e.id !== id)
    if (this.experience.length === before) throw new Error('未找到该经验')
    this.saveExperience()
    return true
  }

  trimMemory() {
    const max = Number(this.meta?.settings?.maxMemory) || 1000
    if (this.memory.length > max) this.memory = this.memory.slice(-max)
  }

  trimExperience() {
    const max = Number(this.meta?.settings?.maxExperience) || 500
    if (this.experience.length > max) this.experience = this.experience.slice(-max)
  }

  // ---------- mood ----------
  recordMood(text, ts = Date.now(), meta = {}) {
    const t = String(text || '').trim().slice(0, 2000)
    if (!t) return null
    const item = { ts, text: t }
    if (meta && meta.session) item.session = String(meta.session)
    if (meta && Number.isFinite(Number(meta.turn))) item.turn = Number(meta.turn)
    if (meta && Number.isFinite(Number(meta.seq))) item.seq = Number(meta.seq)
    this.moods.push(item)
    if (this.moods.length > MOOD_KEEP) this.moods = this.moods.slice(-MOOD_KEEP)
    try { this._safeWrite(this.moodFile, toJsonl(this.moods)) } catch (e) { this.lastError = `mood 写入失败: ${e.message}` }
    return item
  }

  /** 按 session + turn 找最近一条状态池；找不到时回退到全局最近一条。 */
  findMood({ session, turn } = {}) {
    for (let i = this.moods.length - 1; i >= 0; i--) {
      const m = this.moods[i]
      if (!m || !m.text) continue
      if (session && m.session && m.session !== session) continue
      if (turn !== undefined && turn !== null && m.turn !== undefined && Number(m.turn) !== Number(turn)) continue
      if ((session && !m.session) || (turn !== undefined && m.turn === undefined)) continue
      return m
    }
    return null
  }

  // ---------- journal ----------
  appendJournal(rec) {
    const day = localDate(rec.ts || Date.now())
    const file = join(this.journalDir, `${day}.jsonl`)
    const line = JSON.stringify(rec) + '\n'
    if (this.readOnly) return false
    mkdirSync(this.journalDir, { recursive: true })
    appendFileSync(file, line, 'utf8')
    this._journalReadCache.clear()
    this._pendingCache = null
    this.trimJournalDay(file)
    return true
  }

  trimJournalDay(file) {
    try {
      const max = Number(this.meta?.settings?.journalMaxPerDay) || 300
      const text = readTextStrict(file)
      if (!text) return
      const lines = text.split('\n').filter(Boolean)
      if (lines.length <= max) return
      writeFileSync(file, lines.slice(-max).join('\n') + '\n', 'utf8')
    } catch { /* 忽略 */ }
  }

  _journalDays() {
    return Number(this.meta?.settings?.journalRetentionDays) || 30
  }

  readJournal(days = this._journalDays()) {
    const cacheKey = `${days}`
    const cached = this._journalReadCache.get(cacheKey)
    if (cached && Date.now() - cached.at < 2000) return cached.items
    const now = Date.now()
    const cutoff = now - days * 24 * 3600 * 1000
    const items = []
    let names = []
    try { names = readdirSync(this.journalDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort() } catch { names = [] }
    for (const name of names) {
      const dayTs = Date.parse(name.slice(0, 10) + 'T00:00:00')
      if (Number.isFinite(dayTs) && dayTs < cutoff - 24 * 3600 * 1000) continue
      const text = readTextStrict(join(this.journalDir, name))
      if (!text) continue
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
          const rec = JSON.parse(line)
          if (rec && rec.ts >= cutoff) items.push(rec)
        } catch { /* 跳过坏行 */ }
      }
    }
    items.sort((a, b) => b.ts - a.ts)
    this._journalReadCache.set(cacheKey, { at: Date.now(), items })
    return items
  }

  readJournalStatus() {
    const text = readTextStrict(this.journalStatusFile)
    const map = new Map()
    const parsed = parseJsonl(text)
    for (const rec of parsed.items) {
      if (rec && rec.id) map.set(rec.id, rec)
    }
    return map
  }

  setJournalStatus(id, action, extra = {}) {
    if (!id) throw new Error('缺少 journal id')
    if (this.readOnly) throw new Error('只读模式')
    const rec = { id, action, ts: Date.now(), ...extra }
    appendFileSync(this.journalStatusFile, JSON.stringify(rec) + '\n', 'utf8')
    this._journalReadCache.clear()
    this._pendingCache = null
    return rec
  }

  pendingJournal(days = undefined) {
    const effectiveDays = days === undefined ? this._journalDays() : days
    if (this._pendingCache && Date.now() - this._pendingCache.at < 2000) return this._pendingCache.items
    const status = this.readJournalStatus()
    const pendingDays = Math.min(effectiveDays, Number(this.meta?.settings?.journalPendingDays) || 14)
    const maxPending = Number(this.meta?.settings?.journalPendingMax) || 60
    const cutoff = Date.now() - pendingDays * 24 * 3600 * 1000
    // 只把最近 N 天、最多 M 条算作「待整理」；更老/更多的线索仍在 journal 文件里，
    // 但不计入徽标、不打扰用户，也不进注入。这样收件箱不会无限积压。
    const items = this.readJournal(effectiveDays)
      .filter((rec) => rec.ts >= cutoff)
      .filter((rec) => {
        // 任何处理过的状态（promoted / dismissed / reviewed）都不再计入待整理
        return !status.get(rec.id)
      })
      .slice(0, maxPending)
    this._pendingCache = { at: Date.now(), items }
    return items
  }

  allJournal(days = undefined) {
    const effectiveDays = days === undefined ? this._journalDays() : days
    const status = this.readJournalStatus()
    return this.readJournal(effectiveDays).map((rec) => {
      const st = status.get(rec.id)
      return { ...rec, state: st ? st.action : 'pending' }
    })
  }

  // ---------- 备份 / 撤销 ----------
  snapshot(reason = 'manual') {
    if (this.readOnly) throw new Error('只读模式')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(this.backupDir, `${stamp}_${reason}`)
    mkdirSync(dir, { recursive: true })
    const files = {}
    for (const [name, file] of [
      ['persona.md', this.personaFile],
      ['pinned.md', this.pinnedFile],
      ['memory.jsonl', this.memoryFile],
      ['experience.jsonl', this.experienceFile],
      ['facts.jsonl', this.factsFile],
      ['memory.md', this.memoryMdFile],
      ['facts.md', this.factsMdFile],
      ['today.md', this.todayMdFile],
      ['week.md', this.weekMdFile],
      ['longterm.md', this.longtermMdFile],
      ['mood.jsonl', this.moodFile],
      ['meta.json', this.metaFile],
    ]) {
      const text = readTextStrict(file)
      if (text === null) continue
      writeFileSync(join(dir, name), text, 'utf8')
      files[name] = { sha256: sha256(text), size: Buffer.byteLength(text) }
    }
    const manifest = { createdAt: new Date().toISOString(), reason, files }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    this._pruneBackups()
    return dir
  }

  _pruneBackups() {
    try {
      const dirs = readdirSync(this.backupDir).filter((n) => !n.startsWith('.')).sort()
      while (dirs.length > BACKUP_KEEP) {
        const old = dirs.shift()
        this._removeTree(join(this.backupDir, old))
      }
    } catch { /* 忽略 */ }
  }

  _removeTree(dir) {
    try {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) this._removeTree(p)
        else unlinkSync(p)
      }
      rmdirSync(dir)
    } catch { /* 忽略 */ }
  }

  listBackups() {
    try {
      const out = []
      for (const name of readdirSync(this.backupDir)) {
        const dir = join(this.backupDir, name)
        const manifestText = readTextStrict(join(dir, 'manifest.json'))
        if (!manifestText) continue
        let manifest
        try { manifest = JSON.parse(manifestText) } catch { continue }
        const size = Object.values(manifest.files || {}).reduce((a, f) => a + (Number(f.size) || 0), 0)
        out.push({ dir: name, createdAt: manifest.createdAt, reason: manifest.reason, files: Object.keys(manifest.files || {}), size })
      }
      return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    } catch { return [] }
  }

  restoreBackup(name) {
    if (this.readOnly) throw new Error('只读模式')
    const dir = join(this.backupDir, String(name || ''))
    if (!existsSync(dir)) throw new Error('备份不存在')
    const manifestText = readTextStrict(join(dir, 'manifest.json'))
    if (!manifestText) throw new Error('备份缺少 manifest')
    const manifest = JSON.parse(manifestText)
    // 校验完整性
    for (const [file, meta] of Object.entries(manifest.files || {})) {
      const text = readTextStrict(join(dir, file))
      if (text === null) throw new Error(`备份缺少 ${file}`)
      if (sha256(text) !== meta.sha256) throw new Error(`备份文件校验失败: ${file}`)
    }
    this.snapshot('pre-restore')
    for (const file of Object.keys(manifest.files || {})) {
      const text = readTextStrict(join(dir, file))
      if (text === null) continue
      const target = this.p(file)
      this._safeWrite(target, text)
    }
    this.loadAll()
    return true
  }

  undoSnapshot(label) {
    if (this.readOnly) throw new Error('只读模式')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(this.undoDir, stamp)
    mkdirSync(dir, { recursive: true })
    for (const [name, file] of [
      ['pinned.md', this.pinnedFile],
      ['memory.jsonl', this.memoryFile],
      ['experience.jsonl', this.experienceFile],
    ]) {
      const text = readTextStrict(file)
      if (text !== null) writeFileSync(join(dir, name), text, 'utf8')
    }
    writeFileSync(join(dir, 'label.json'), JSON.stringify({ label: label || '', at: new Date().toISOString() }), 'utf8')
    try {
      const dirs = readdirSync(this.undoDir).filter((n) => !n.startsWith('.')).sort()
      while (dirs.length > UNDO_KEEP) this._removeTree(join(this.undoDir, dirs.shift()))
    } catch { /* 忽略 */ }
    return stamp
  }

  undoLast() {
    if (this.readOnly) throw new Error('只读模式')
    let dirs = []
    try { dirs = readdirSync(this.undoDir).filter((n) => !n.startsWith('.')).sort() } catch { dirs = [] }
    if (!dirs.length) throw new Error('没有可撤销的整理')
    const latest = dirs[dirs.length - 1]
    const dir = join(this.undoDir, latest)
    for (const name of ['pinned.md', 'memory.jsonl', 'experience.jsonl']) {
      const text = readTextStrict(join(dir, name))
      if (text !== null) this._safeWrite(this.p(name), text)
    }
    this._removeTree(dir)
    this.loadAll()
    return { undoId: latest, restored: ['pinned.md', 'memory.jsonl', 'experience.jsonl'] }
  }

  // ---------- 派生视图 ----------
  writeDerivedViews() {
    if (this.readOnly) return
    try {
      const lines = ['# 澜 · 记忆视图', '', `> 派生文件，由插件自动生成；修改请用管理面板或 memory.jsonl。`, '']
      lines.push(`## 常驻（${this.pinned.length}）`, '')
      for (const p of this.pinned) lines.push(`- [${p.tag}] ${p.content}`)
      lines.push('', `## 检索记忆（${this.memory.length}）`, '')
      for (const m of this.memory.slice().reverse()) {
        lines.push(`- ${(m.tags || []).length ? `[${m.tags.join(', ')}] ` : ''}${m.content}  <sub>${String(m.updated_at || m.created_at || '').slice(0, 10)}</sub>`)
      }
      lines.push('', `## 经验（${this.experience.length}）`, '')
      for (const e of this.experience.slice().reverse()) lines.push(`- [${e.category}] ${e.content}`)
      lines.push('')
      this._safeWrite(join(this.viewsDir, 'memory.md'), lines.join('\n'))
    } catch (e) { this.lastError = `视图生成失败: ${e.message}` }
  }

  // ---------- v1 迁移 ----------
  migrateFromV1() {
    const report = { found: false, copied: [], skipped: [] }
    if (this.readOnly) return report
    const v1Dir = join((process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh'), V1_DIR_NAME)
    if (!existsSync(v1Dir)) return report
    // 已有 v2 数据则不重复迁移
    const hasV2 = (() => {
      try { return this.memory.length > 0 || this.pinned.length > 0 || this.experience.length > 0 || this.moods.length > 0 } catch { return false }
    })()
    if (hasV2) { report.skipped.push('v2 数据非空，跳过迁移'); return report }
    const map = [
      ['pinned.md', this.pinnedFile],
      ['memory.jsonl', this.memoryFile],
      ['experience.jsonl', this.experienceFile],
      ['mood.jsonl', this.moodFile],
    ]
    report.found = true
    this.snapshot('pre-migrate-v1')
    const v1Persona = readTextStrict(join(v1Dir, 'persona.json'))
    if (v1Persona) {
      try {
        const p = JSON.parse(v1Persona)
        const md = serializePersonaMarkdown({ soul: p.soul || '', moodContract: p.moodContract || '' })
        this._safeWrite(this.personaFile, md)
        report.copied.push('persona.json → persona.md')
      } catch { report.skipped.push('persona.json 解析失败') }
    }
    for (const [srcName, dst] of map) {
      const text = readTextStrict(join(v1Dir, srcName))
      if (text === null) continue
      // 目标为空才复制（保护首次启动时刚写入的默认文件）
      const existing = readTextStrict(dst)
      if (existing && existing.trim() && srcName !== 'mood.jsonl') { report.skipped.push(`${srcName} 目标非空，未覆盖`); continue }
      this._safeWrite(dst, text)
      report.copied.push(srcName)
    }
    this.saveMeta({ lastMigrate: { at: new Date().toISOString(), copied: report.copied, from: v1Dir } })
    return report
  }

  // ---------- 健康 ----------
  stats() {
    return {
      dataDir: this.dataDir,
      counts: {
        pinned: this.pinned.length,
        memory: this.memory.length,
        experience: this.experience.length,
        facts: this.facts.length,
        compiled: this.memoryProfile ? 1 : 0,
        memoryBytes: Buffer.byteLength(this.memoryProfile || ''),
        journalPending: this.pendingJournal().length,
        journalToday: this.readJournal(1).length,
        moods: this.moods.length,
      },
      meta: this.meta,
      lastError: this.lastError,
      readOnly: this.readOnly,
      lock: this.lockInfo,
    }
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/)
  const out = []
  for (const t of list) {
    const s = String(t || '').trim()
    if (s && !out.includes(s)) out.push(s.slice(0, 40))
    if (out.length >= 12) break
  }
  return out
}

export function normalizeMemory(items) {
  const out = []
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue
    const content = String(it.content || '').trim()
    if (!content) continue
    out.push({
      id: typeof it.id === 'string' && it.id ? it.id : genId('m'),
      tags: normalizeTags(it.tags),
      content,
      created_at: it.created_at || new Date().toISOString(),
      updated_at: it.updated_at || it.created_at || new Date().toISOString(),
      source: it.source || 'lan',
    })
    if (out.length >= 5000) break
  }
  return out
}

export function normalizeExperience(items) {
  const out = []
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue
    const content = String(it.content || '').trim()
    const category = String(it.category || '').trim()
    if (!content) continue
    out.push({
      id: typeof it.id === 'string' && it.id ? it.id : genId('e'),
      category: category || '未分类',
      content,
      created_at: it.created_at || new Date().toISOString(),
    })
    if (out.length >= 2000) break
  }
  return out
}

export function normalizeFacts(items) {
  const out = []
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue
    const fact = String(it.fact || '').trim()
    if (!fact) continue
    out.push({
      id: typeof it.id === 'string' && it.id ? it.id : genId('f'),
      fact: fact.slice(0, 200),
      tags: normalizeTags(it.tags),
      time: it.time ? String(it.time).slice(0, 32) : null,
      session: it.session ? String(it.session) : null,
      source: it.source || 'auto',
      created_at: it.created_at || new Date().toISOString(),
    })
    if (out.length >= 3000) break
  }
  return out
}

export function normalizeFactKey(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').trim()
}

const COMPILED_HEADINGS = [
  ['facts', '重要事实'],
  ['today', '今天'],
  ['week', '本周'],
  ['longterm', '长期'],
]

export function parseCompiledMarkdown(md) {
  const text = String(md || '')
  const out = { facts: '', today: '', week: '', longterm: '' }
  for (const [key, label] of COMPILED_HEADINGS) {
    const re = new RegExp(`^##\\s*${label}\\s*$`, 'im')
    const m = re.exec(text)
    if (!m) continue
    const start = m.index + m[0].length
    const rest = text.slice(start)
    const next = /^##\s+/m.exec(rest)
    out[key] = (next ? rest.slice(0, next.index) : rest).trim()
  }
  return out
}

export function serializeCompiledMarkdown(sections) {
  const s = sections || {}
  return COMPILED_HEADINGS.map(([key, label]) => `## ${label}\n\n${String(s[key] || '（暂无）').trim()}\n`).join('\n')
}

export { shortHash, sha256 }
