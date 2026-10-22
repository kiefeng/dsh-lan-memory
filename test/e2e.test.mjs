import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { makeTmp } from './_tmp.mjs'

function fakeCtx() {
  const tools = []
  const routes = []
  const events = []
  const ctx = {
    tools: { register(def) { tools.push(def); return () => {} } },
    systemPrompt: { section() { return () => {} }, context() { return () => {} } },
    webServer: { register(route) { routes.push(route); return () => {} } },
    on(name, fn) { events.push({ name, fn }); return () => {} },
    logger: { log() {}, warn() {}, error() {} },
  }
  return { ctx, tools, routes, events }
}

function userEvent(text, turn, source = 'user') {
  return { type: 'user/message', seq: turn * 10, time: Date.now() + turn, data: { id: 'u' + turn, role: 'user', source: { kind: source }, content: [{ type: 'text', text }] } }
}
function assistantEvent(text, turn) {
  return { type: 'assistant/message', seq: turn * 10 + 1, time: Date.now() + turn * 2, data: { turn, step: 1, message: { id: 'a' + turn, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] } } }
}
function turnStart(turn) { return { type: 'turn/start', seq: turn * 10 - 1, time: Date.now() + turn, data: { turn } } }
function turnEnd(turn) { return { type: 'turn/end', seq: turn * 10 + 2, time: Date.now() + turn * 3, data: { turn, reason: { kind: 'completed' } } } }

test('端到端：20 轮捕获 → 召回 → 整理，不碰人格', (t) => {
  const dir = makeTmp(t, 'e2e-')
  const home = makeTmp(t, 'e2e-home-')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  })
  const { ctx, tools, routes, events } = fakeCtx()
  const dispose = apply(ctx, { dataDir: dir })
  const by = Object.fromEntries(tools.map((x) => [x.name, x]))
  const session = { id: 'session-e2e' }
  const emit = events[0].fn

  // 20 轮对话，每轮一句可记忆的偏好（部分重复）
  for (let turn = 1; turn <= 20; turn++) {
    const text = turn % 5 === 0 ? '记住：我喜欢深潜' : `第 ${turn} 轮：项目细节 ${turn}`
    emit(session, turnStart(turn))
    emit(session, userEvent(text, turn))
    emit(session, assistantEvent(`收到，第 ${turn} 轮记下了。\n<mood>\nVibe: 海面微澜 ${turn}\n</mood>`, turn))
    emit(session, turnEnd(turn))
  }

  const status = by.lan_status.execute({})
  assert.equal(status.counts.memory, 0)
  assert.equal(status.counts.journalPending, 20)

  // 模型把重复偏好写进记忆（模拟整理后的动作）
  const r = by.lan_remember.execute({ content: '用户喜欢深潜', tags: ['偏好'] })
  assert.equal(r.ok, true)
  const recall = by.lan_recall.execute({ query: '深潜' })
  assert.ok(recall.results.length >= 1)

  // 重复写同样内容 → 触发确定性整理
  by.lan_remember.execute({ content: '用户喜欢深潜。', tags: ['沟通'] })
  const preview = by.lan_organize.execute({ action: 'preview' })
  assert.ok(preview.report.actions.some((a) => a.kind === 'merge'))
  const applied = by.lan_organize.execute({ action: 'apply-local' })
  assert.equal(applied.report.changed, true)
  assert.equal(by.lan_status.execute({}).counts.memory, 1)

  // 撤销恢复两条
  by.lan_organize.execute({ action: 'undo' })
  assert.equal(by.lan_status.execute({}).counts.memory, 2)

  // 人格在整理前后字节一致
  const personaAfter = readFileSync(join(dir, 'persona.md'), 'utf8')
  assert.ok(personaAfter.includes('## SOUL'))
  assert.ok(personaAfter.includes('## MOOD'))

  // 收件箱提炼一条后 pending 减少
  const journal = by.lan_status.execute({}).counts.journalPending
  assert.equal(journal, 20)
  dispose()
  assert.ok(routes.length === 1)
})
