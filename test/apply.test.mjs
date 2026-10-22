import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { apply } from '../lib/index.js'
import { makeTmp } from './_tmp.mjs'

function fakeCtx() {
  const tools = []
  const sections = []
  const contexts = []
  const routes = []
  const events = []
  const ctx = {
    tools: { register(def) { tools.push(def); return () => {} } },
    systemPrompt: {
      section(def) { sections.push(def); return () => {} },
      context(def) { contexts.push(def); return () => {} },
    },
    webServer: { register(route) { routes.push(route); return () => {} } },
    on(name, fn) { events.push({ name, fn }); return () => {} },
    logger: { log() {}, warn() {}, error() {} },
  }
  return { ctx, tools, sections, contexts, routes, events }
}

function setup(t) {
  const dir = makeTmp(t, 'apply-')
  const home = makeTmp(t, 'home-')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  })
  const f = fakeCtx()
  const dispose = apply(f.ctx, { dataDir: dir })
  return { ...f, dispose, dir }
}

test('注册 6 工具 / 3 section / 3 context / 1 路由 / 4 事件', (t) => {
  const { tools, sections, contexts, routes, events } = setup(t)
  assert.deepEqual(tools.map((x) => x.name).sort(), ['lan_forget', 'lan_list', 'lan_organize', 'lan_recall', 'lan_remember', 'lan_status'])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.parameters && tool.parameters.type === 'object')
    assert.ok(tool.output && typeof tool.output.render === 'function')
  }
  assert.equal(sections.length, 3)
  assert.equal(contexts.length, 3)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/lan-memory')
  assert.deepEqual(events.map((e) => e.name), ['session/event', 'agent/turn-stopping', 'agent/status', 'agent/disposed'])
})

test('工具链路：remember → recall → list → forget → status', (t) => {
  const { tools } = setup(t)
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  const r1 = by.lan_remember.execute({ content: '用户喜欢深潜', layer: 'memory', tags: ['偏好'] })
  assert.equal(r1.ok, true)
  assert.ok(r1.id)
  const pinned = by.lan_remember.execute({ content: '回答要简洁', layer: 'pinned', tags: ['沟通'] })
  assert.equal(pinned.ok, true)
  const exp = by.lan_remember.execute({ content: '先读再改', layer: 'experience', category: 'tool usage' })
  assert.equal(exp.ok, true)
  const recall = by.lan_recall.execute({ query: '深潜', top_k: 3 })
  assert.equal(recall.results.length, 1)
  assert.ok(recall.results[0].content.includes('深潜'))
  const list = by.lan_list.execute({ layer: 'memory' })
  assert.equal(list.total, 1)
  const dry = by.lan_forget.execute({ layer: 'memory', keyword: '深潜' })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.matches.length, 1)
  const del = by.lan_forget.execute({ layer: 'memory', keyword: '深潜', dry_run: false })
  assert.equal(del.removed, 1)
  const status = by.lan_status.execute({})
  assert.equal(status.counts.memory, 0)
  assert.equal(status.counts.pinned, 1)
  assert.equal(status.counts.experience, 1)
})

test('lan_organize review-pack 返回 ≤4KB 文本', (t) => {
  const { tools } = setup(t)
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  by.lan_remember.execute({ content: '用户喜欢深潜' })
  by.lan_remember.execute({ content: '用户喜欢深潜。' })
  const r = by.lan_organize.execute({ action: 'review-pack' })
  assert.ok(r.pack.includes('待整理'))
  assert.ok(Buffer.byteLength(r.pack, 'utf8') <= 4096)
  const preview = by.lan_organize.execute({ action: 'preview' })
  assert.ok(preview.report.actions.length >= 1)
  const applied = by.lan_organize.execute({ action: 'apply-local' })
  assert.equal(applied.report.changed, true)
  const undo = by.lan_organize.execute({ action: 'undo' })
  assert.ok(undo.undoId)
})

test('lan_remember 拒绝超长和整段对话，要求先提炼', (t) => {
  const { tools } = setup(t)
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  const long = '这是一段很长的原文。'.repeat(60)
  const rejected = by.lan_remember.execute({ content: long })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /超过单条上限/)
  const dialogue = '用户：帮我看看这个\n助手：好的\n用户：那这个呢\n助手：也可以\n用户：还有这个\n助手：可以'
  const rejected2 = by.lan_remember.execute({ content: dialogue })
  assert.equal(rejected2.ok, false)
  assert.match(rejected2.error, /整段对话/)
  const ok = by.lan_remember.execute({ content: '用户偏好简洁直接的回答。' })
  assert.equal(ok.ok, true)
})

test('persona 注入区块使用 interpolate:false', (t) => {
  const { sections, contexts } = setup(t)
  for (const s of [...sections, ...contexts]) assert.equal(s.interpolate, false)
  const persona = sections.find((s) => s.name === 'lan:persona')
  assert.equal(typeof persona.text, 'function')
  assert.ok(String(persona.text()).includes('澜'))
})

test('dispose 释放锁', (t) => {
  const { dispose, dir } = setup(t)
  assert.ok(existsSync(dir + '/.lock'))
  dispose()
  assert.ok(!existsSync(dir + '/.lock'))
})
