/**
 * 本地检索：CJK bigram + 英文词 + BM25。
 *
 * 不依赖任何第三方库、不调用模型、不联网。条目数在几千以内时
 * 全量建索引 + 内存打分是毫秒级，足以覆盖个人自用场景。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const ZERO_WIDTH_RE = /[\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g

/** 归一化：小写、去零宽、标点变空白、统一空白。 */
export function normalizeText(text) {
  return String(text || '')
    .replace(ZERO_WIDTH_RE, '')
    .toLowerCase()
    .replace(/[\p{P}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 分词：
 *  - 英文/数字按词
 *  - 连续 CJK 段：长度 1 → 单字；长度 ≥2 → 全部相邻 bigram（再补整段，便于整段精确命中）
 *  - 单字查询也能命中（保留单字 token）
 */
export function tokenize(text) {
  const s = normalizeText(text)
  const tokens = []
  if (!s) return tokens
  const re = /[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu
  let m
  while ((m = re.exec(s))) {
    const part = m[0]
    if (CJK_RE.test(part)) {
      if (part.length === 1) tokens.push(part)
      else {
        for (let i = 0; i < part.length; i++) tokens.push(part[i])
        for (let i = 0; i + 1 < part.length; i++) tokens.push(part.slice(i, i + 2))
      }
    } else {
      tokens.push(part)
    }
  }
  return tokens
}

function termFreq(tokens) {
  const tf = new Map()
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
  return tf
}

/**
 * 建索引。
 * @param {Array<{id:string, text:string, tags?:string[]}>} docs
 */
export function buildIndex(docs) {
  const entries = []
  const df = new Map()
  let totalLen = 0
  for (const doc of docs) {
    const tokens = tokenize(`${doc.text || ''} ${(doc.tags || []).join(' ')}`)
    const tf = termFreq(tokens)
    entries.push({ id: doc.id, tf, len: tokens.length, norm: normalizeText(doc.text) })
    totalLen += tokens.length
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1)
  }
  return {
    entries,
    df,
    avgLen: entries.length ? totalLen / entries.length : 0,
    size: entries.length,
  }
}

/**
 * BM25 检索，返回 [{id, score}] 降序。
 * @param {{entries:any[],df:Map<string,number>,avgLen:number}} index
 * @param {string} query
 * @param {{topK?:number, minScore?:number}} opts
 */
export function searchIndex(index, query, opts = {}) {
  const topK = Math.max(1, Math.min(50, Number(opts.topK) || 5))
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.01
  const qNorm = normalizeText(query)
  const qTokens = tokenize(query)
  if (!qNorm || !qTokens.length || !index || !index.entries.length) return []
  const qSet = [...new Set(qTokens)]
  const N = index.entries.length
  const k1 = 1.2
  const b = 0.75
  const scored = []
  for (const entry of index.entries) {
    let score = 0
    for (const term of qSet) {
      const freq = entry.tf.get(term)
      if (!freq) continue
      const df = index.df.get(term) || 0
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      const denom = freq + k1 * (1 - b + b * (entry.len / (index.avgLen || 1)))
      score += idf * ((freq * (k1 + 1)) / (denom || 1))
    }
    if (score <= 0) continue
    // 整段短语命中加分（"长期记忆" 比两个 bigram 更精确）
    if (qNorm.length >= 2 && entry.norm.includes(qNorm)) score += 2.5
    scored.push({ id: entry.id, score })
  }
  scored.sort((a, b2) => b2.score - a.score)
  return scored.filter((x) => x.score >= minScore).slice(0, topK)
}

/** 估算文本的 UTF-8 字节数（v1 用 length*2，中文会超预算）。 */
export function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8')
}

/** 按字节预算截断（不切坏多字节字符），可选加省略号。 */
export function truncateByBytes(text, maxBytes, suffix = '…') {
  const s = String(text || '')
  if (byteLength(s) <= maxBytes) return s
  const suffixBytes = byteLength(suffix)
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (byteLength(s.slice(0, mid)) + suffixBytes <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + suffix
}

/** 两段文本的 bigram Jaccard 相似度（用于确定性近似去重）。 */
export function similarity(a, b) {
  const sa = normalizeText(a)
  const sb = normalizeText(b)
  if (sa === sb) return 1
  const grams = (s) => {
    const out = new Set()
    if (s.length === 1) out.add(s)
    for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const ga = grams(sa)
  const gb = grams(sb)
  if (!ga.size || !gb.size) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}
