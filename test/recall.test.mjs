import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { makeTmp } from './_tmp.mjs'

function fakeCtx() {
  const tools = []
  const ctx = {
    tools: { register(def) { tools.push(def); return () => {} } },
    systemPrompt: { section() { return () => {} }, context() { return () => {} } },
    webServer: { register() { return () => {} } },
    on() { return () => {} },
    logger: { log() {}, warn() {}, error() {} },
  }
  return { ctx, tools }
}

test('召回对同一件事的改写只返回一条，预算留给新信息', (t) => {
  const dir = makeTmp(t, 'recall-')
  const { ctx, tools } = fakeCtx()
  apply(ctx, { dataDir: dir })
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  const variants = [
    '用户有一台 4G 内存的老笔记本',
    '用户的设备是一台 4G 内存的老笔记本',
    '用户使用老笔记本，内存只有 4G',
    '用户的老笔记本内存是 4G',
    '用户有一台内存 4G 的老笔记本',
    '用户的笔记本内存 4G，比较老',
  ]
  for (const content of variants) by.lan_remember.execute({ content, layer: 'memory', tags: ['设备'] })
  by.lan_remember.execute({ content: '用户的名字是 kieran', layer: 'memory', tags: ['身份'] })

  const res = by.lan_recall.execute({ query: '老笔记本 内存', top_k: 5 })
  assert.ok(Array.isArray(res.results))
  assert.equal(res.results.length, 1, '六条同义改写应只留一条')
  assert.ok(res.results[0].content.includes('笔记本'))
})

test('时间衰减让新事实排在旧事实之前', (t) => {
  const dir = makeTmp(t, 'recall-decay-')
  const { ctx, tools } = fakeCtx()
  // 预置两条同义事实，只差时间；绕过运行时自动合并，直接落库。
  writeFileSync(join(dir, 'facts.jsonl'), [
    JSON.stringify({ id: 'f1', fact: '用户偏好安静的工作环境', tags: ['偏好'], time: '2024-01-01', created_at: '2024-01-01T00:00:00Z' }),
    JSON.stringify({ id: 'f2', fact: '用户偏好在安静的工作环境里做事', tags: ['偏好'], time: '2026-11-09', created_at: '2026-11-09T00:00:00Z' }),
  ].join('\n') + '\n', 'utf8')
  apply(ctx, { dataDir: dir })
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  const res = by.lan_recall.execute({ query: '安静 工作环境', layer: 'fact', top_k: 5 })
  assert.ok(Array.isArray(res.results))
  assert.equal(res.results.length, 1, '同义事实去重后只留一条')
  assert.ok(res.results[0].content.includes('里做事'), '保留的应是被衰减加权后的新事实')
})

test('召回条数不超过 top_k，候选扩量不能撑大返回结果', (t) => {
  const dir = makeTmp(t, 'recall-topk-')
  const { ctx, tools } = fakeCtx()
  apply(ctx, { dataDir: dir })
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  const topics = ['表格编辑', '缩进层级', '手机端操作', '自动备份', '端口安全', '访问速度', '中文输入', '语音输入', '日历视图', '标签折叠', '任务分组', '视图记忆']
  for (const topic of topics) by.lan_remember.execute({ content: `用户关注${topic}`, layer: 'memory', tags: [topic] })
  const res = by.lan_recall.execute({ query: '用户', top_k: 3 })
  assert.equal(res.results.length, 3, '返回条数必须受 top_k 约束')
})

test('弱命中按最高分比例过滤，不把无关条目带进结果', (t) => {
  const dir = makeTmp(t, 'recall-floor-')
  const { ctx, tools } = fakeCtx()
  apply(ctx, { dataDir: dir })
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  by.lan_remember.execute({ content: '用户关注表格编辑的体验', layer: 'memory', tags: ['表格'] })
  by.lan_remember.execute({ content: '用户关注端口对公网开放的安全风险', layer: 'memory', tags: ['安全'] })
  by.lan_remember.execute({ content: '用户重视笔记备份，希望避免只有本机一份', layer: 'memory', tags: ['备份'] })
  const res = by.lan_recall.execute({ query: '用户 表格编辑', top_k: 5 })
  assert.equal(res.results.length, 1, '只共享“用户”二字的弱命中应被过滤')
})

test('归档事实默认不参与召回，includeArchive 时才查', (t) => {
  const dir = makeTmp(t, 'recall-arch-')
  writeFileSync(join(dir, 'facts.jsonl'), [
    JSON.stringify({ id: 'f_old', fact: '用户 2024 年关注过旧项目 A', tags: ['历史'], time: '2024-01-01', created_at: '2024-01-01T00:00:00Z' }),
    JSON.stringify({ id: 'f_new', fact: '用户最近在忙 ESMO 2026', tags: ['近期'], time: '2026-11-09', created_at: '2026-11-09T00:00:00Z' }),
  ].join('\n') + '\n', 'utf8')
  const { ctx, tools } = fakeCtx()
  apply(ctx, { dataDir: dir })
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  const plain = by.lan_recall.execute({ query: '旧项目 A', layer: 'fact', top_k: 5 })
  assert.equal(plain.results.length, 0, '归档事实默认不返回')
  const deep = by.lan_recall.execute({ query: '旧项目 A', layer: 'fact', top_k: 5, includeArchive: true })
  assert.equal(deep.results.length, 1)
  assert.equal(deep.results[0].archived, true)
})
