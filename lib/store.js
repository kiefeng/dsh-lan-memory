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
import { similarity } from './search.js'

export const SCHEMA_VERSION = 2
const BACKUP_KEEP = 20
const UNDO_KEEP = 10
const MOOD_KEEP = 200
const V1_DIR_NAME = 'hanako'

// 单写者锁：心跳新鲜（默认 5 分钟内）的活进程才独占；心跳过期视为陈旧，可自动接管。
const LOCK_STALE_MS = 5 * 60 * 1000
const LOCK_HEARTBEAT_MS = 60 * 1000
// 新事实与已有事实的近似判据：同一件事的改写 → 原地更新旧条目，不再新增。
const NEAR_UPDATE_SIM = 0.82
const NEAR_UPDATE_TAG_SIM = 0.62

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

/** 数字占位化：只差编号/日期数字的两条（"批量事实 1" vs "批量事实 2"）不是同一事实。 */
function digitless(text) {
  return String(text || '').replace(/[0-9]+/g, '#')
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
    this.lockOwned = false
    this.lockTimer = null
    this.loadedAt = 0
    this.lastError = null
    this.persona = { soul: '', moodContract: '' }
    this.pinned = []
    this.memory = []
    this.experience = []
    this.facts = []
    this.archivedFacts = []
    this.archiveIndex = []
    this.factTombstones = []
    this.experienceCandidates = []
    this.summaries = {}
    this.summaryMonths = {}
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
  get factTombstonesFile() { return this.p('fact-tombstones.json') }
  get experienceCandidatesFile() { return this.p('experience-candidates.json') }
  get summariesFile() { return this.p('summaries.json') }
  get summaryMonthsFile() { return this.p('summary-months.json') }
  get factsArchiveFile() { return this.p('facts-archive.jsonl') }
  get archiveIndexFile() { return this.p('archive-index.jsonl') }
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

  /**
   * 单写者锁。
   *
   * 旧逻辑只在启动时判一次：锁里的 pid "看起来活着" 就永久只读。
   * 进程退出后 pid 被系统复用、或锁文件残留，插件就会静默停摆整个生命周期。
   * 现在锁带心跳：心跳新鲜的活进程才独占；心跳超时或进程已不存在的陈旧锁
   * 直接接管；只读状态下每次写前也会重试，不会因为一次误判卡死。
   */
  _acquireLock() {
    let info = null
    try {
      const raw = readTextStrict(this.lockFile)
      if (raw) info = JSON.parse(raw)
    } catch { info = null } // 锁损坏按无锁处理
    if (info && info.pid && info.pid !== process.pid) {
      const beat = Number(info.heartbeat || info.at || 0) || 0
      const age = Date.now() - beat
      const alive = isAlive(info.pid)
      if (alive && beat > 0 && age < LOCK_STALE_MS) {
        this.readOnly = true
        this.lockInfo = { pid: Number(info.pid), heartbeatAt: new Date(beat).toISOString(), ageMs: age }
        this.logger.warn?.(`[lan] another process holds the data dir (pid ${info.pid}, heartbeat ${Math.round(age / 1000)}s ago); running read-only`)
        return false
      }
      this.logger.warn?.(`[lan] taking over stale lock (pid ${info.pid}, alive=${alive}, heartbeat ${Math.round(age / 1000)}s ago)`)
    }
    try {
      writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), heartbeat: Date.now() }), 'utf8')
      this.lockOwned = true
      this.readOnly = false
      this.lockInfo = { pid: process.pid, heartbeatAt: new Date().toISOString(), ageMs: 0 }
      this._startHeartbeat()
      return true
    } catch (e) {
      this.lastError = `锁写入失败：${e && e.message ? e.message : e}`
      return false
    }
  }

  _startHeartbeat() {
    if (this.lockTimer) return
    this.lockTimer = setInterval(() => {
      if (!this.lockOwned || this.readOnly) return
      try {
        writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), heartbeat: Date.now() }), 'utf8')
      } catch { /* 忽略：真实写入失败会由 _safeWrite 暴露 */ }
    }, LOCK_HEARTBEAT_MS)
    if (this.lockTimer.unref) this.lockTimer.unref()
  }

  /** 只读状态下重新探测锁，陈旧则接管。写操作前调用。 */
  ensureWritable() {
    if (!this.readOnly) return true
    const ok = this._acquireLock()
    if (ok) this.logger.warn?.('[lan] lock reacquired, writes enabled')
    return ok
  }

  /** 强制接管：忽略存活检测（设置页/人工恢复用）。调用方应先做备份。 */
  takeoverLock() {
    try {
      writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), heartbeat: Date.now(), forced: true }), 'utf8')
    } catch (e) {
      throw new Error(`强制接管失败：${e && e.message ? e.message : e}`)
    }
    this.readOnly = false
    this.lockOwned = true
    this.lockInfo = { pid: process.pid, heartbeatAt: new Date().toISOString(), ageMs: 0 }
    this._startHeartbeat()
    return true
  }

  releaseLock() {
    if (this.lockTimer) { clearInterval(this.lockTimer); this.lockTimer = null }
    try {
      const raw = readTextStrict(this.lockFile)
      if (raw) {
        const info = JSON.parse(raw)
        if (info && info.pid === process.pid) unlinkSync(this.lockFile)
      }
    } catch { /* 忽略 */ }
    this.lockOwned = false
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
    try {
      const tombText = readTextStrict(this.factTombstonesFile)
      const parsed = tombText ? JSON.parse(tombText) : []
      this.factTombstones = Array.isArray(parsed) ? parsed.map((x) => String(x || '')).filter(Boolean).slice(-2000) : []
    } catch { this.factTombstones = [] }
    try {
      const candText = readTextStrict(this.experienceCandidatesFile)
      const parsed = candText ? JSON.parse(candText) : []
      this.experienceCandidates = normalizeExperienceCandidates(parsed)
    } catch { this.experienceCandidates = [] }
    try {
      const summariesText = readTextStrict(this.summariesFile)
      const parsed = summariesText ? JSON.parse(summariesText) : {}
      this.summaries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { this.summaries = {} }
    // 冷存储：已归档事实、归档索引、摘要月度大纲
    this.archivedFacts = normalizeFacts(parseJsonl(readTextStrict(this.factsArchiveFile)).items)
    this.archiveIndex = parseJsonl(readTextStrict(this.archiveIndexFile)).items
    try {
      const monthText = readTextStrict(this.summaryMonthsFile)
      const parsed = monthText ? JSON.parse(monthText) : {}
      this.summaryMonths = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { this.summaryMonths = {} }
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
    if (this.readOnly && !this.ensureWritable()) throw new Error('数据目录被另一个进程占用（只读模式），拒绝写入')
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
      archivedFacts: this.archivedFacts.length,
      summaryMonths: Object.keys(this.summaryMonths || {}).length,
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

  saveFactTombstones(items = this.factTombstones) {
    const next = [...new Set((items || []).map((x) => String(x || '')).filter(Boolean))].slice(-2000)
    this._safeWrite(this.factTombstonesFile, JSON.stringify(next, null, 2))
    this.factTombstones = next
    this._etag = ''
    return true
  }

  /**
   * 追加原子事实。
   *  - 规范化文本完全相同 → 跳过；
   *  - 命中删除墓碑 → 跳过；
   *  - 与已有事实是同一件事的近似改写 → 原地更新旧条目（旧文本进墓碑），不新增。
   * 这是事实库不再被同义句撑爆的关键：编译每批都会重抽，原来只认精确文本。
   */
  appendFacts(items = []) {
    const seen = new Set(this.facts.map((f) => normalizeFactKey(f.fact)))
    const tomb = new Set(this.factTombstones)
    const added = []
    const rewritten = []
    let tombChanged = false
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue
      const fact = String(raw.fact || '').trim()
      if (!fact) continue
      const key = normalizeFactKey(fact)
      if (!key || seen.has(key) || tomb.has(key)) continue
      seen.add(key)
      const tags = normalizeTags(raw.tags)
      const time = raw.time ? String(raw.time).slice(0, 32) : null
      const hit = this._findNearFact({ fact, tags })
      if (hit) {
        const oldKey = normalizeFactKey(hit.fact)
        const nextText = fact.slice(0, 200)
        if (hit.fact !== nextText) {
          hit.fact = nextText
          hit.tags = normalizeTags([...(hit.tags || []), ...tags])
          hit.time = time || hit.time
          hit.updated_at = new Date().toISOString()
          rewritten.push(hit)
          if (oldKey && oldKey !== key) { tomb.add(oldKey); tombChanged = true }
        }
        continue
      }
      const now = new Date().toISOString()
      added.push({
        id: genId('f'),
        fact: fact.slice(0, 200),
        tags,
        time: time || now.slice(0, 10),
        session: raw.session ? String(raw.session) : null,
        source: String(raw.source || 'auto'),
        created_at: now,
        updated_at: now,
      })
      if (added.length >= 200) break
    }
    if (added.length) this.facts.push(...added)
    if (tombChanged) this.saveFactTombstones([...tomb])
    if (added.length || rewritten.length) {
      const max = Number(this.meta?.settings?.maxFacts) || 2000
      if (this.facts.length > max) this.facts = this.facts.slice(-max)
      this._safeWrite(this.factsFile, toJsonl(this.facts))
      this._etag = ''
    }
    return added
  }

  /** 找最像的已有事实（同一件事的改写）；没有返回 null。 */
  _findNearFact(item) {
    let best = null
    let bestSim = 0
    const itemDigits = digitless(item.fact)
    for (const old of this.facts) {
      if (!old || !old.fact) continue
      // 只有数字不同（编号/日期/数量）说明是不同事实，不合并。
      if (itemDigits === digitless(old.fact) && item.fact !== old.fact) continue
      const sim = similarity(item.fact, old.fact)
      if (sim < NEAR_UPDATE_TAG_SIM) continue
      const oldTags = new Set(old.tags || [])
      let shared = 0
      for (const t of item.tags || []) if (oldTags.has(t)) shared++
      if (!(sim >= NEAR_UPDATE_SIM || (shared >= 2 && sim >= NEAR_UPDATE_TAG_SIM))) continue
      if (sim > bestSim) { best = old; bestSim = sim }
    }
    return best
  }

  /**
   * 给编译用的「事实代表」：按相似度聚类，每簇只出一条代表 + 簇大小。
   * 编译原来只喂最近 80 条，旧事实永远进不了合并上下文，重复清不掉；
   * 聚类后覆盖面是全库，提示词反而更短。
   */
  factDigest(limit = 150) {
    const items = (this.facts || []).filter((f) => f && f.fact && f.source !== 'fallback')
    const clusters = []
    for (const f of items) {
      let target = null
      const digits = digitless(f.fact)
      for (const c of clusters) {
        if (digits === digitless(c.rep.fact) && f.fact !== c.rep.fact) continue
        const sim = similarity(f.fact, c.rep.fact)
        if (sim >= 0.72) { target = c; break }
        const tags = new Set(f.tags || [])
        let shared = 0
        for (const t of c.rep.tags || []) if (tags.has(t)) shared++
        if (shared >= 2 && sim >= 0.55) { target = c; break }
      }
      if (target) {
        target.items.push(f)
        if (String(f.fact).length > String(target.rep.fact).length) target.rep = f
      } else {
        clusters.push({ rep: f, items: [f] })
      }
    }
    clusters.sort((a, b) => b.items.length - a.items.length)
    return clusters.slice(0, limit).map((c) => ({
      fact: c.rep.fact,
      tags: c.rep.tags,
      count: c.items.length,
      time: c.rep.time,
    }))
  }

  saveFacts(items = this.facts) {
    const next = normalizeFacts(items)
    this._safeWrite(this.factsFile, toJsonl(next))
    this.facts = next
    this._etag = ''
    return true
  }

  addFact({ fact, tags = [], time = null, source = 'manual' }) {
    const key = normalizeFactKey(fact)
    if (key && this.factTombstones.includes(key)) this.saveFactTombstones(this.factTombstones.filter((x) => x !== key))
    return this.appendFacts([{ fact, tags, time, source }])[0] || null
  }

  updateFact(id, patch = {}) {
    const item = this.facts.find((f) => f.id === id)
    if (!item) throw new Error('未找到该事实')
    if (patch.fact !== undefined) {
      const text = String(patch.fact || '').trim()
      if (!text) throw new Error('事实不能为空')
      const oldKey = normalizeFactKey(item.fact)
      const newKey = normalizeFactKey(text)
      if (oldKey && oldKey !== newKey) this.saveFactTombstones([...this.factTombstones, oldKey])
      if (newKey) this.saveFactTombstones(this.factTombstones.filter((x) => x !== newKey))
      item.fact = text.slice(0, 200)
    }
    if (patch.tags !== undefined) item.tags = normalizeTags(patch.tags)
    if (patch.time !== undefined) item.time = patch.time ? String(patch.time).slice(0, 32) : null
    this._safeWrite(this.factsFile, toJsonl(this.facts))
    this._etag = ''
    return item
  }

  deleteFact(id) {
    const item = this.facts.find((f) => f.id === id)
    if (!item) throw new Error('未找到该事实')
    const key = normalizeFactKey(item.fact)
    this.facts = this.facts.filter((f) => f.id !== id)
    if (key) this.saveFactTombstones([...this.factTombstones, key])
    this._safeWrite(this.factsFile, toJsonl(this.facts))
    this._etag = ''
    return true
  }

  mergeFacts({ ids = [], keepId = '' } = {}) {
    const wanted = new Set((ids || []).map(String))
    const items = this.facts.filter((f) => wanted.has(f.id))
    if (items.length < 2) throw new Error('至少需要两条事实才能合并')
    const keep = items.find((f) => f.id === keepId) || items.slice().sort((a, b) => {
      const len = String(b.fact || '').length - String(a.fact || '').length
      return len || String(b.created_at || '').localeCompare(String(a.created_at || ''))
    })[0]
    const tags = []
    for (const f of items) for (const t of f.tags || []) if (!tags.includes(t)) tags.push(t)
    keep.tags = normalizeTags(tags)
    this.saveFacts(this.facts)
    const removed = []
    for (const f of items) {
      if (f.id === keep.id) continue
      this.deleteFact(f.id)
      removed.push(f.id)
    }
    return { keepId: keep.id, fact: keep.fact, tags: keep.tags, merged: items.length, removed }
  }

  /** 每会话一份滚动摘要；fact 抽取优先读摘要，没有才退回 journal。 */
  saveSummary(session, summary, meta = {}) {
    const key = String(session || 'unknown')
    const text = String(summary || '').trim().slice(0, 4000)
    if (!text) return null
    this.summaries[key] = {
      session: key,
      summary: text,
      turn: Number(meta.turn) || 0,
      lastTs: Number(meta.lastTs) || Date.now(),
      updated_at: new Date().toISOString(),
    }
    try { this._safeWrite(this.summariesFile, JSON.stringify(this.summaries, null, 2)) } catch (e) { this.lastError = `摘要写入失败: ${e.message}` }
    return this.summaries[key]
  }

  recentSummaries(limit = 8) {
    return Object.values(this.summaries || {})
      .filter((s) => s && s.summary)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, limit)
  }

  // ---------- 冷存储：归档与月度大纲 ----------

  /**
   * 把超龄事实移到冷存储：facts.jsonl → facts-archive.jsonl。
   * 不删数据；归档后默认召回不查，需要时用 includeArchive 深挖。
   * 同时按月份生成一行索引（"2026-10：3 条，标签…，样例…"）。
   */
  archiveFacts({ beforeDays = 365, now = Date.now(), snapshot = true } = {}) {
    const cutoff = now - beforeDays * 86400000
    const keep = []
    const old = []
    for (const f of this.facts) {
      const ts = Date.parse(f.time || f.updated_at || f.created_at || '') || 0
      if (ts && ts < cutoff) old.push(f)
      else keep.push(f)
    }
    if (!old.length) return { archived: 0, months: 0 }
    if (snapshot) this.undoSnapshot('archive-facts')
    const byMonth = new Map()
    for (const f of old) {
      const month = String(f.time || f.updated_at || f.created_at || '').slice(0, 7) || 'unknown'
      if (!byMonth.has(month)) byMonth.set(month, [])
      byMonth.get(month).push(f)
    }
    for (const [month, list] of byMonth) {
      const tags = []
      for (const f of list) for (const t of f.tags || []) if (!tags.includes(t)) tags.push(t)
      this.archiveIndex = this.archiveIndex.filter((x) => x && x.month !== month)
      this.archiveIndex.push({
        month,
        count: list.length,
        tags: tags.slice(0, 5),
        sample: String((list[0] && list[0].fact) || '').slice(0, 80),
      })
    }
    this.archiveIndex.sort((a, b) => String(a.month).localeCompare(String(b.month)))
    this.archivedFacts = [...this.archivedFacts, ...old].slice(-5000)
    this.facts = keep
    this._safeWrite(this.factsFile, toJsonl(this.facts))
    this._safeWrite(this.factsArchiveFile, toJsonl(this.archivedFacts))
    this._safeWrite(this.archiveIndexFile, toJsonl(this.archiveIndex))
    this.saveMeta({ lastArchive: { at: new Date().toISOString(), archived: old.length, months: byMonth.size } })
    this._etag = ''
    return { archived: old.length, months: byMonth.size }
  }

  /**
   * 摘要月度大纲：保留最近 keep 份会话摘要，更早且超过 days 的按月压成一段。
   * 确定性压缩，不调模型；原文仍在备份/undo 快照里。
   */
  compactSummaries({ keep = 30, olderThanDays = 90, now = Date.now(), snapshot = true } = {}) {
    const entries = Object.values(this.summaries || {})
      .filter((s) => s && s.session && s.summary)
      .sort((a, b) => Number(b.lastTs || 0) - Number(a.lastTs || 0))
    if (entries.length <= keep) return { compacted: 0, months: 0 }
    const cutoff = now - olderThanDays * 86400000
    const old = entries.slice(keep).filter((s) => (Number(s.lastTs) || 0) < cutoff)
    if (!old.length) return { compacted: 0, months: 0 }
    if (snapshot) this.undoSnapshot('compact-summaries')
    const byMonth = new Map()
    for (const s of old) {
      const month = new Date(Number(s.lastTs) || now).toISOString().slice(0, 7)
      if (!byMonth.has(month)) byMonth.set(month, [])
      byMonth.get(month).push(s.summary)
    }
    for (const [month, list] of byMonth) {
      const text = list.join(' ').replace(/\s+/g, ' ').trim()
      this.summaryMonths[month] = String(this.summaryMonths[month] ? this.summaryMonths[month] + ' ' + text : text).slice(-400)
    }
    const oldSessions = new Set(old.map((s) => s.session))
    const next = {}
    for (const s of entries) if (!oldSessions.has(s.session)) next[s.session] = this.summaries[s.session]
    this.summaries = next
    this._safeWrite(this.summariesFile, JSON.stringify(this.summaries, null, 2))
    this._safeWrite(this.summaryMonthsFile, JSON.stringify(this.summaryMonths, null, 2))
    return { compacted: old.length, months: byMonth.size }
  }

  /** 每月一次：归档超龄事实 + 压缩旧摘要。启动/编译成功后调用，可撤销。 */
  maybeArchive({ everyDays, beforeDays, now = Date.now() } = {}) {
    const s = this.meta.settings || {}
    const every = Number(everyDays || s.archiveEveryDays) || 30
    const lastCheck = this.meta.lastArchiveCheck ? Date.parse(this.meta.lastArchiveCheck) : 0
    if (lastCheck && now - lastCheck < every * 86400000) return { skipped: 'recent', archived: 0, compacted: 0 }
    if (this.readOnly) return { skipped: 'readonly', archived: 0, compacted: 0 }
    this.undoSnapshot('monthly-archive')
    const before = Number(beforeDays || s.archiveAfterDays) || 365
    const a = this.archiveFacts({ beforeDays: before, now, snapshot: false })
    const c = this.compactSummaries({ now, snapshot: false })
    this.saveMeta({ lastArchiveCheck: new Date().toISOString() })
    return { archived: a.archived, months: a.months, compacted: c.compacted, summaryMonths: c.months }
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
      if (text !== null) {
        const changed = text !== this.memoryProfile
        this.memoryProfile = text
        // 文件可能被用户手改（README 承诺可直接编辑）；同步解析结果，
        // 否则下一次编译/跨天滚动会拿旧内存副本覆盖手改内容。
        this.compiled = parseCompiledMarkdown(text)
        if (changed) this._etag = ''
      }
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
    const target = this.memory.find((m) => m.id === id)
    this.memory = this.memory.filter((m) => m.id !== id)
    if (this.memory.length === before) throw new Error('未找到该记忆')
    this.saveMemory()
    // 旧版本曾把手动记忆同步进 facts；删除同名事实并写墓碑，
    // 避免下一次编译从 journal 里把它复活。当前版本不会新增同步事实。
    if (target) {
      const text = String(target.content || '').trim()
      for (const fact of this.facts.slice()) {
        if (String(fact.fact || '').trim() === text) this.deleteFact(fact.id)
      }
    }
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

  // ---------- 经验候选（编译产出，需用户确认） ----------
  saveExperienceCandidates(items = this.experienceCandidates) {
    const next = normalizeExperienceCandidates(items).slice(-50)
    this._safeWrite(this.experienceCandidatesFile, JSON.stringify(next, null, 2))
    this.experienceCandidates = next
    this._etag = ''
    return true
  }

  addExperienceCandidates(items = []) {
    const seen = new Set(this.experience.map((e) => normalizeFactKey(e.content)))
    for (const c of this.experienceCandidates) seen.add(normalizeFactKey(c.content))
    const added = []
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue
      const content = String(raw.content || '').trim().slice(0, 300)
      const category = String(raw.category || '未分类').trim().slice(0, 40) || '未分类'
      const key = normalizeFactKey(content)
      if (!content || !key || seen.has(key)) continue
      seen.add(key)
      added.push({
        id: genId('ec'),
        category,
        content,
        source: String(raw.source || 'compile'),
        status: 'pending',
        created_at: new Date().toISOString(),
      })
    }
    if (added.length) this.saveExperienceCandidates([...this.experienceCandidates, ...added])
    return added
  }

  acceptExperienceCandidate(id) {
    const item = this.experienceCandidates.find((c) => c.id === id && c.status === 'pending')
    if (!item) throw new Error('未找到该经验候选')
    const saved = this.addExperience({ category: item.category, content: item.content })
    this.experienceCandidates = this.experienceCandidates.filter((c) => c.id !== id)
    this.saveExperienceCandidates()
    return saved
  }

  dismissExperienceCandidate(id) {
    const item = this.experienceCandidates.find((c) => c.id === id && c.status === 'pending')
    if (!item) throw new Error('未找到该经验候选')
    item.status = 'dismissed'
    this.saveExperienceCandidates()
    return true
  }

  replaceExperienceCandidates(items = []) {
    const dismissed = this.experienceCandidates.filter((c) => c.status === 'dismissed')
    const seen = new Set(this.experience.map((e) => normalizeFactKey(e.content)))
    for (const c of dismissed) seen.add(normalizeFactKey(c.content))
    const next = []
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue
      const content = String(raw.content || '').trim().slice(0, 300)
      const key = normalizeFactKey(content)
      if (!content || !key || seen.has(key)) continue
      seen.add(key)
      next.push({
        id: genId('ec'),
        category: String(raw.category || '未分类').trim().slice(0, 40) || '未分类',
        content,
        source: 'consolidate',
        status: 'pending',
        created_at: new Date().toISOString(),
      })
    }
    this.saveExperienceCandidates([...next, ...dismissed])
    return next
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
      ['facts-archive.jsonl', this.factsArchiveFile],
      ['archive-index.jsonl', this.archiveIndexFile],
      ['summary-months.json', this.summaryMonthsFile],
      ['fact-tombstones.json', this.factTombstonesFile],
      ['experience-candidates.json', this.experienceCandidatesFile],
      ['summaries.json', this.summariesFile],
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
      ['facts.jsonl', this.factsFile],
      ['facts-archive.jsonl', this.factsArchiveFile],
      ['archive-index.jsonl', this.archiveIndexFile],
      ['summary-months.json', this.summaryMonthsFile],
      ['fact-tombstones.json', this.factTombstonesFile],
      ['memory.md', this.memoryMdFile],
      ['facts.md', this.factsMdFile],
      ['today.md', this.todayMdFile],
      ['week.md', this.weekMdFile],
      ['longterm.md', this.longtermMdFile],
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
    for (const name of ['pinned.md', 'memory.jsonl', 'experience.jsonl', 'facts.jsonl', 'fact-tombstones.json', 'memory.md', 'facts.md', 'today.md', 'week.md', 'longterm.md']) {
      const text = readTextStrict(join(dir, name))
      if (text !== null) this._safeWrite(this.p(name), text)
    }
    // 冷存储三件套：快照里没有说明是这次操作才创建的，撤销时要清空，否则归档/大纲会残留。
    for (const name of ['facts-archive.jsonl', 'archive-index.jsonl', 'summary-months.json']) {
      const text = readTextStrict(join(dir, name))
      this._safeWrite(this.p(name), text === null ? '' : text)
    }
    this._removeTree(dir)
    this.loadAll()
    return { undoId: latest, restored: ['pinned.md', 'memory.jsonl', 'experience.jsonl', 'facts.jsonl', 'facts-archive.jsonl', 'archive-index.jsonl', 'summary-months.json', 'fact-tombstones.json', 'memory.md', 'facts.md', 'today.md', 'week.md', 'longterm.md'] }
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
        experienceCandidates: this.experienceCandidates.filter((c) => c.status === 'pending').length,
        facts: this.facts.length,
        archivedFacts: this.archivedFacts.length,
        archiveMonths: this.archiveIndex.length,
        summaries: Object.keys(this.summaries || {}).length,
        summaryMonths: Object.keys(this.summaryMonths || {}).length,
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

export function normalizeExperienceCandidates(items) {
  const out = []
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue
    const content = String(it.content || '').trim()
    if (!content) continue
    out.push({
      id: typeof it.id === 'string' && it.id ? it.id : genId('ec'),
      category: String(it.category || '未分类').trim() || '未分类',
      content: content.slice(0, 300),
      source: String(it.source || 'compile'),
      status: it.status === 'dismissed' ? 'dismissed' : 'pending',
      created_at: it.created_at || new Date().toISOString(),
    })
    if (out.length >= 100) break
  }
  return out
}

export function normalizeFacts(items) {
  const out = []
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue
    const fact = String(it.fact || '').trim()
    if (!fact) continue
    const createdAt = it.created_at || new Date().toISOString()
    out.push({
      id: typeof it.id === 'string' && it.id ? it.id : genId('f'),
      fact: fact.slice(0, 200),
      tags: normalizeTags(it.tags),
      // 没有显式时间时用写入日期兜底：事实必须能按时间判断新旧。
      time: it.time ? String(it.time).slice(0, 32) : String(createdAt).slice(0, 10) || null,
      session: it.session ? String(it.session) : null,
      source: it.source || 'auto',
      created_at: createdAt,
      updated_at: it.updated_at || createdAt,
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
