import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, buildIndex, searchIndex, byteLength, truncateByBytes, similarity, normalizeText } from '../lib/search.js'

test('CJK 分词产出单字与 bigram', () => {
  const t = tokenize('长期记忆')
  assert.ok(t.includes('长期'))
  assert.ok(t.includes('期记'))
  assert.ok(t.includes('记忆'))
  assert.ok(t.includes('长'))
})

test('中英混合分词', () => {
  const t = tokenize('用 pnpm 管理 DSH 记忆')
  assert.ok(t.includes('pnpm'))
  assert.ok(t.includes('dsh'))
  assert.ok(t.includes('记忆'))
})

test('BM25 能召回中文相关条目', () => {
  const docs = [
    { id: 'm1', text: '用户喜欢深潜，讨厌被打断', tags: ['偏好'] },
    { id: 'm2', text: '项目使用 pnpm 管理依赖', tags: ['项目'] },
    { id: 'm3', text: '回答要简洁直接，不要客套', tags: ['沟通'] },
  ]
  const idx = buildIndex(docs)
  const hits = searchIndex(idx, '深潜', { topK: 5 })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].id, 'm1')
  const none = searchIndex(idx, '量子计算', { topK: 5 })
  assert.equal(none.length, 0)
})

test('短语命中加分让精确条目排前', () => {
  const docs = [
    { id: 'a', text: '记忆系统设计' },
    { id: 'b', text: '记忆' },
  ]
  const idx = buildIndex(docs)
  const hits = searchIndex(idx, '记忆系统', { topK: 2 })
  assert.equal(hits[0].id, 'a')
})

test('字节预算按 UTF-8 计算', () => {
  assert.equal(byteLength('记忆'), 6)
  assert.equal(byteLength('abc'), 3)
  const cut = truncateByBytes('记忆记忆记忆', 10, '…')
  assert.ok(byteLength(cut) <= 10)
  assert.ok(!cut.includes('\uFFFD'))
})

test('相似度：完全相同为 1，近似高于阈值，无关为 0', () => {
  assert.equal(similarity('用户喜欢深潜', '用户喜欢深潜'), 1)
  assert.ok(similarity('用户喜欢深潜和安静', '用户喜欢深潜') > 0.6)
  assert.equal(similarity('完全无关的内容', 'abcde'), 0)
})

test('normalizeText 去零宽并小写', () => {
  assert.equal(normalizeText('  ABC\u200b  D  '), 'abc d')
})
