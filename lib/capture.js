/**
 * 零 LLM 捕获：把每一轮对话压成一条 journal 记录。
 *
 * 只监听官方 `session/event`（提交后触发），不读 Session 内部事件树、
 * 不调模型、不联网。捕获侧做纯机械去噪：
 *  - 只收"用户本人"消息（source.kind = user / user-rpc），插件注入的
 *    runtime-context、team-message、agent-message 一律不收，避免自我喂养；
 *  - 每轮一条、最小信息量门槛、精确 hash 去重、每日上限（由 store 裁剪）；
 *  - 子代理会话没有用户亲笔消息，自然不会落盘；
 *  - 任何失败只记 lastError，不影响用户回合。
 */
import { byteLength, truncateByBytes } from './search.js'
import { shortHash } from './store.js'

const USER_SOURCE_KINDS = new Set(['user', 'user-rpc'])
const MODEL_SOURCE_KINDS = new Set(['model'])
const MAX_SESSIONS = 64
const MIN_USER_CHARS = 2

export function extractMood(text) {
  const m = /<mood>([\s\S]*?)<\/mood>/i.exec(String(text || ''))
  if (!m) return ''
  return m[1].trim().slice(0, 2000)
}

export function createCapture({ store, logger = console, enabled = true }) {
  const buffers = new Map()
  const recentIds = new Set()
  const stats = {
    events: 0,
    flushed: 0,
    skipped: 0,
    lastFlush: null,
    lastError: null,
    types: {},
    userSources: {},
  }
  let enabledFlag = !!enabled

  function setEnabled(v) {
    enabledFlag = !!v
    if (!enabledFlag) buffers.clear()
  }

  function isEnabled() { return enabledFlag }

  function touch(sessionId, turn) {
    let buf = buffers.get(sessionId)
    if (!buf) {
      if (buffers.size >= MAX_SESSIONS) {
        // 丢弃最久未动的会话缓冲，防止长进程泄漏
        const oldest = buffers.keys().next().value
        if (oldest) buffers.delete(oldest)
      }
      buf = { turn: turn || 0, user: [], assistant: '', tools: [], startedAt: Date.now() }
      buffers.set(sessionId, buf)
    }
    if (typeof turn === 'number' && turn !== buf.turn) buf.turn = turn
    return buf
  }

  function flush(session, turn, ts) {
    const id = session && (session.id || session.sessionId)
    if (!id) return null
    const buf = buffers.get(id)
    buffers.delete(id)
    if (!buf) return null
    const user = buf.user.join(' / ').trim()
    if (user.length < MIN_USER_CHARS) {
      stats.skipped++
      return null
    }
    if (!enabledFlag) {
      stats.skipped++
      return null
    }
    const assistant = String(buf.assistant || '').trim()
    const rec = {
      v: 1,
      id: shortHash(`${id}:${turn}:${user.slice(0, 80)}:${ts || buf.startedAt}`),
      ts: ts || Date.now(),
      session: id,
      turn: Number(turn) || buf.turn,
      user: truncateByBytes(user, 500, '…'),
      assistant: truncateByBytes(assistant, 800, '…'),
      tools: [...new Set(buf.tools)].slice(0, 8),
    }
    if (!rec.assistant && byteLength(rec.user) < 8) {
      stats.skipped++
      return null
    }
    if (recentIds.has(rec.id)) {
      stats.skipped++
      return null
    }
    try {
      const ok = store.appendJournal(rec)
      if (ok) {
        recentIds.add(rec.id)
        if (recentIds.size > 500) {
          const first = recentIds.values().next().value
          recentIds.delete(first)
        }
        stats.flushed++
        stats.lastFlush = new Date().toISOString()
      }
      return ok ? rec : null
    } catch (e) {
      stats.lastError = String(e && e.message ? e.message : e)
      logger.warn?.('[lan] journal append failed:', stats.lastError)
      return null
    }
  }

  function handleSessionEvent(session, event) {
    if (!event || typeof event !== 'object') return
    const type = event.type
    if (!type) return
    stats.events++
    stats.types[type] = (stats.types[type] || 0) + 1
    const id = session && (session.id || session.sessionId)
    if (!id) return
    try {
      switch (type) {
        case 'turn/start': {
          // 上一轮若因异常没 flush，先落盘再开新轮
          const old = buffers.get(id)
          if (old) flush(session, old.turn, Date.now())
          touch(id, event.data && event.data.turn)
          break
        }
        case 'user/message': {
          const msg = event.data
          const source = msg && msg.source && msg.source.kind
          stats.userSources[String(source)] = (stats.userSources[String(source)] || 0) + 1
          if (!USER_SOURCE_KINDS.has(source)) return
          const text = contentText(msg)
          if (!text) return
          const buf = touch(id)
          buf.user.push(text)
          break
        }
        case 'assistant/message': {
          const msg = event.data && event.data.message
          const source = msg && msg.source && msg.source.kind
          if (!MODEL_SOURCE_KINDS.has(source)) return
          const text = contentText(msg)
          if (!text) return
          const buf = touch(id, event.data && event.data.turn)
          // 同一轮可能有多条 assistant 消息（工具前后），保留最后一条可见文本
          buf.assistant = text
          const mood = extractMood(text)
          if (mood) recordMood(mood, event.time || Date.now(), { session: id, turn: event.data && event.data.turn, seq: event.seq })
          break
        }
        case 'tool/call': {
          const name = event.data && (event.data.name || event.data.toolName)
          if (!name) return
          const buf = touch(id, event.data && event.data.turn)
          buf.tools.push(String(name))
          break
        }
        case 'turn/end': {
          const turn = (event.data && event.data.turn) || (buffers.get(id) || {}).turn
          flush(session, turn, event.time || Date.now())
          break
        }
        default:
          break
      }
    } catch (e) {
      stats.lastError = String(e && e.message ? e.message : e)
      logger.warn?.('[lan] capture failed:', stats.lastError)
    }
  }

  let lastMoodSig = ''
  function recordMood(text, ts, meta = {}) {
    const sig = `${meta.session || ''}:${meta.turn ?? ''}:${text.length}:${text.slice(0, 40)}`
    if (sig === lastMoodSig) return
    lastMoodSig = sig
    try { store.recordMood(text, ts, meta) } catch (e) { stats.lastError = `mood: ${e.message}` }
  }

  function flushAll() {
    for (const [id, buf] of [...buffers.entries()]) {
      const fakeSession = { id }
      flush(fakeSession, buf.turn, Date.now())
    }
  }

  /**
   * 按 session id 主动落盘当前缓存。
   * 实机验证发现：turn/end 不一定经 session/event 到达插件，
   * 所以 index 会在 turn-stopping / agent idle / disposed 时兜底调用。
   */
  function flushSession(sessionId, ts = Date.now()) {
    if (!sessionId) return null
    const buf = buffers.get(sessionId)
    if (!buf) return null
    return flush({ id: sessionId }, buf.turn, ts)
  }

  function getStats() {
    return {
      enabled: enabledFlag,
      events: stats.events,
      flushed: stats.flushed,
      skipped: stats.skipped,
      bufferedSessions: buffers.size,
      lastFlush: stats.lastFlush,
      lastError: stats.lastError,
      types: { ...stats.types },
      userSources: { ...stats.userSources },
    }
  }

  return { handleSessionEvent, flushAll, flushSession, getStats, setEnabled, isEnabled }
}

function contentText(message) {
  const content = message && message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}
