/**
 * 确定性整理 + 整理包。
 *
 * 两条路径：
 *  - apply-local：纯本地规则（精确/近似去重、合并标签），秒级、可干跑、可撤销；
 *    不调用模型、不新增条目、不碰 persona.md。
 *  - review-pack：把"待整理条目 + 重复簇 + 过期候选"打成 ≤4KB 的 Markdown，
 *    交给当前会话的模型用 lan_remember / lan_forget 执行。整理动作只有
 *    改写 / 合并 / 删除三类，默认不新增。
 */
import { similarity, normalizeText, truncateByBytes, byteLength } from './search.js'

const STALE_DAYS = 180

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
}

function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  return { find, union }
}

/**
 * 计算记忆/经验的重复簇。
 * @returns {{clusters: Array<{ids:string[], reason:string, keep:string, merged:{content:string,tags:string[]}}>, stale:string[], overflow:string[]}}
 */
export function planDeterministic(memory, experience, settings = {}) {
  const maxMemory = Number(settings.maxMemory) || 1000
  const staleBefore = isoDaysAgo(STALE_DAYS)

  const detect = (items, layer) => {
    const clusters = []
    const uf = unionFind(items.length)
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const sim = similarity(items[i].content, items[j].content)
        if (sim >= 0.85) uf.union(i, j)
      }
    }
    const groups = new Map()
    for (let i = 0; i < items.length; i++) {
      const root = uf.find(i)
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root).push(i)
    }
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue
      const exact = idxs.every((i) => normalizeText(items[i].content) === normalizeText(items[idxs[0]].content))
      const sorted = idxs.slice().sort((a, b) => {
        const lenDiff = items[b].content.length - items[a].content.length
        if (lenDiff) return lenDiff
        return String(items[b].updated_at || items[b].created_at || '').localeCompare(String(items[a].updated_at || items[a].created_at || ''))
      })
      const keep = items[sorted[0]]
      const mergedTags = []
      for (const i of idxs) for (const t of items[i].tags || []) if (!mergedTags.includes(t)) mergedTags.push(t)
      clusters.push({
        layer,
        ids: idxs.map((i) => items[i].id),
        reason: exact ? 'exact-duplicate' : 'near-duplicate',
        keepId: keep.id,
        merged: { content: keep.content, tags: mergedTags },
        preview: `合并 ${idxs.length} 条为：${truncateByBytes(keep.content, 120)}`,
      })
    }
    return clusters
  }

  const memClusters = detect(memory, 'memory')
  const expClusters = detect(experience, 'experience')
  const stale = memory.filter((m) => m.updated_at && m.updated_at < staleBefore).map((m) => m.id)
  const overflow = memory.length > maxMemory ? memory.slice(0, memory.length - maxMemory).map((m) => m.id) : []
  return { clusters: [...memClusters, ...expClusters], stale, overflow }
}

export function createOrganizer(store, logger = console) {
  function counts() {
    return {
      pinned: store.pinned.length,
      memory: store.memory.length,
      experience: store.experience.length,
    }
  }

  function buildActions(plan) {
    const actions = []
    for (const c of plan.clusters) {
      actions.push({
        kind: 'merge',
        layer: c.layer,
        ids: c.ids,
        keepId: c.keepId,
        merged: c.merged,
        preview: c.preview,
        reason: c.reason,
      })
    }
    if (plan.overflow.length) {
      actions.push({
        kind: 'delete',
        layer: 'memory',
        ids: plan.overflow,
        preview: `超出容量上限，删除最旧的 ${plan.overflow.length} 条`,
        reason: 'capacity',
      })
    }
    if (plan.stale.length) {
      actions.push({
        kind: 'none',
        layer: 'memory',
        ids: plan.stale,
        preview: `${plan.stale.length} 条超过 ${STALE_DAYS} 天未更新（仅提示，不自动删除）`,
        reason: 'stale',
      })
    }
    return actions
  }

  /** 干跑：只算不写。 */
  function preview() {
    const plan = planDeterministic(store.memory, store.experience, store.meta.settings)
    const actions = buildActions(plan)
    const after = counts()
    for (const a of actions) {
      if (a.kind === 'merge') {
        if (a.layer === 'memory') after.memory -= a.ids.length - 1
        else after.experience -= a.ids.length - 1
      } else if (a.kind === 'delete' && a.layer === 'memory') {
        after.memory -= a.ids.length
      }
    }
    return { countsBefore: counts(), countsAfter: after, actions, undoId: null }
  }

  /** 执行确定性整理（写盘 + undo 快照）。 */
  function applyLocal() {
    const before = counts()
    const plan = planDeterministic(store.memory, store.experience, store.meta.settings)
    const actions = buildActions(plan)
    const effective = actions.filter((a) => a.kind === 'merge' || a.kind === 'delete')
    if (!effective.length) {
      return { countsBefore: before, countsAfter: counts(), actions, undoId: null, changed: false }
    }
    const undoId = store.undoSnapshot('organize')
    const remove = new Set()
    const replace = new Map()
    for (const a of effective) {
      if (a.kind === 'merge') {
        replace.set(a.layer, (replace.get(a.layer) || []).concat([a]))
        for (const id of a.ids) if (id !== a.keepId) remove.add(`${a.layer}:${id}`)
      } else if (a.kind === 'delete') {
        for (const id of a.ids) remove.add(`${a.layer}:${id}`)
      }
    }
    const nextMemory = store.memory
      .filter((m) => !remove.has(`memory:${m.id}`))
      .map((m) => {
        const merges = (replace.get('memory') || []).filter((a) => a.keepId === m.id)
        if (!merges.length) return m
        const merged = merges[0].merged
        return { ...m, content: merged.content, tags: merged.tags, updated_at: new Date().toISOString() }
      })
    const nextExperience = store.experience
      .filter((e) => !remove.has(`experience:${e.id}`))
      .map((e) => {
        const merges = (replace.get('experience') || []).filter((a) => a.keepId === e.id)
        if (!merges.length) return e
        const merged = merges[0].merged
        return { ...e, content: merged.content, tags: merged.tags }
      })
    store.saveMemory(nextMemory)
    store.saveExperience(nextExperience)
    const report = {
      countsBefore: before,
      countsAfter: { pinned: store.pinned.length, memory: store.memory.length, experience: store.experience.length },
      actions,
      undoId,
      changed: true,
    }
    store.saveMeta({
      lastOrganize: {
        at: new Date().toISOString(),
        undoId,
        summary: `合并/删除 ${effective.reduce((n, a) => n + a.ids.length, 0)} 条`,
        countsAfter: report.countsAfter,
      },
    })
    store.writeDerivedViews()
    logger.log?.('[lan] organize applied', report.countsBefore, '->', report.countsAfter)
    return report
  }

  /** 机械清洗：去掉代码块/链接/标题符号，只留可读文字。 */
  function stripNoise(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/^[\s#>*-]+/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** 线索摘要：按句子拼到预算为止。只是给模型的输入，不是最终记忆。 */
  function digestText(text, maxChars) {
    const clean = stripNoise(text)
    if (!clean) return ''
    const sentences = clean.split(/(?<=[。！？!?])\s*/).filter(Boolean)
    let out = ''
    for (const s of sentences) {
      if (out && out.length + s.length > maxChars) break
      out += s
    }
    if (!out) out = clean
    return truncateByBytes(out, maxChars)
  }

  /** 生成给模型用的整理包（不写盘）。 */
  function reviewPack() {
    const pending = store.pendingJournal().slice(0, 12)
    const plan = planDeterministic(store.memory, store.experience, store.meta.settings)
    const lines = []
    lines.push('## 澜记忆整理包')
    lines.push('')
    lines.push(`当前：常驻 ${store.pinned.length} / 检索 ${store.memory.length} / 经验 ${store.experience.length}；待整理 ${pending.length} 条。`)
    lines.push('')
    if (pending.length) {
      lines.push('### 线索（已机械截断，不是记忆；禁止直接复制）')
      for (const rec of pending) {
        lines.push(`- [${rec.id}] 用户：${digestText(rec.user, 120) || '（无）'}`)
        if (rec.assistant) lines.push(`  结论：${digestText(rec.assistant, 160)}`)
      }
      lines.push('')
    }
    const clusters = plan.clusters.slice(0, 8)
    if (clusters.length) {
      lines.push('### 重复候选（建议合并，保留一条更完整的）')
      for (const c of clusters) lines.push(`- ${c.layer}: ${c.ids.join(', ')} → ${truncateByBytes(c.merged.content, 120)}`)
      lines.push('')
    }
    if (plan.stale.length) {
      lines.push(`### 过期候选：${plan.stale.length} 条超过 ${STALE_DAYS} 天未更新（仅提示，不强制删）`)
      lines.push('')
    }
    lines.push('### 写入规则（必须遵守）')
    lines.push('1. 先把线索提炼成 1-3 句、≤300 字的事实/偏好/决定；禁止把线索或对话原文整段复制进 lan_remember。')
    lines.push('2. 没有长期价值的内容直接忽略，不要为了整理而整理。')
    lines.push('3. 优先合并到已有记忆（先 lan_recall）；单次改动 ≤10 条；只做改写/合并/删除。')
    lines.push('4. 人格与 pinned 不在整理范围内。')
    lines.push('')
    lines.push('完成后不需要向用户汇报细节；如无线索可回复"无需整理"。')
    let pack = lines.join('\n')
    if (byteLength(pack) > 4096) pack = truncateByBytes(pack, 4096)
    // 交给模型看过的线索标记为 reviewed：不再计入待整理徽标，避免收件箱无限积压。
    // 原始记录仍留在 journal/*.jsonl，想回看/提炼随时可以。
    if (!store.readOnly) {
      for (const rec of pending) {
        try { store.setJournalStatus(rec.id, 'reviewed') } catch { /* 忽略单条失败 */ }
      }
    }
    return pack
  }

  function undo() {
    const res = store.undoLast()
    return { ...res, counts: counts() }
  }

  return { preview, applyLocal, reviewPack, undo, planDeterministic }
}
