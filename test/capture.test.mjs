import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../lib/store.js'
import { createCapture, extractMood } from '../lib/capture.js'
import { makeTmp } from './_tmp.mjs'

function setup(t, opts = {}) {
  const dir = makeTmp(t, 'cap-')
  const store = new Store({ dataDir: dir, logger: { log() {}, warn() {}, error() {} } })
  store.init()
  const capture = createCapture({ store, logger: { log() {}, warn() {}, error() {} }, enabled: opts.enabled !== false })
  return { store, capture, dir }
}

const userEvent = (text, turn = 1, source = 'user') => ({
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: { id: 'u1', role: 'user', source: { kind: source }, content: [{ type: 'text', text }] },
})
const assistantEvent = (text, turn = 1) => ({
  type: 'assistant/message',
  seq: 2,
  time: Date.now() + 1,
  data: { turn, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] } },
})
const toolEvent = (name) => ({ type: 'tool/call', seq: 3, time: Date.now() + 2, data: { turn: 1, step: 1, callId: 'c1', name, arguments: {} } })
const turnStart = (turn = 1) => ({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn } })
const turnEnd = (turn = 1) => ({ type: 'turn/end', seq: 9, time: Date.now() + 3, data: { turn, reason: { kind: 'completed' } } })

test('一轮对话落一条 journal，并捕获 mood', (t) => {
  const { store, capture } = setup(t)
  const s = { id: 'session-1' }
  capture.handleSessionEvent(s, turnStart(1))
  capture.handleSessionEvent(s, userEvent('记住我最近在学自由潜水'))
  capture.handleSessionEvent(s, toolEvent('read'))
  capture.handleSessionEvent(s, assistantEvent('好的，记下了。\n<mood>\nVibe: 海面微澜\nSparks: 鲸歌\n</mood>'))
  capture.handleSessionEvent(s, turnEnd(1))
  const journal = store.readJournal(30)
  assert.equal(journal.length, 1)
  assert.equal(journal[0].turn, 1)
  assert.ok(journal[0].user.includes('自由潜水'))
  assert.ok(journal[0].assistant.includes('记下了'))
  assert.deepEqual(journal[0].tools, ['read'])
  assert.equal(store.moods.length, 1)
  assert.ok(store.moods[0].text.includes('海面微澜'))
  assert.equal(store.moods[0].session, 'session-1')
  assert.equal(store.moods[0].turn, 1)
  assert.equal(store.findMood({ session: 'session-1', turn: 1 }).ts, store.moods[0].ts)
})

test('插件注入的 runtime-context 不被捕获', (t) => {
  const { store, capture } = setup(t)
  const s = { id: 'session-2' }
  capture.handleSessionEvent(s, turnStart(1))
  capture.handleSessionEvent(s, userEvent('这是一段插件注入的记忆上下文', 1, 'runtime-context'))
  capture.handleSessionEvent(s, assistantEvent('好的'))
  capture.handleSessionEvent(s, turnEnd(1))
  assert.equal(store.readJournal(30).length, 0)
})

test('子代理/团队消息不作为用户亲笔消息捕获', (t) => {
  const { store, capture } = setup(t)
  const s = { id: 'session-sub' }
  capture.handleSessionEvent(s, turnStart(1))
  capture.handleSessionEvent(s, userEvent('来自父代理的任务', 1, 'agent-message'))
  capture.handleSessionEvent(s, assistantEvent('子代理的结论'))
  capture.handleSessionEvent(s, turnEnd(1))
  assert.equal(store.readJournal(30).length, 0)
})

test('相同内容重复回放不会重复落盘（幂等）', (t) => {
  const { store, capture } = setup(t)
  const s = { id: 'session-3' }
  const now = Date.now()
  const run = () => {
    capture.handleSessionEvent(s, { ...turnStart(1), time: now })
    capture.handleSessionEvent(s, { ...userEvent('同一条记忆'), time: now })
    capture.handleSessionEvent(s, { ...assistantEvent('收到'), time: now + 1 })
    capture.handleSessionEvent(s, { ...turnEnd(1), time: now + 2 })
  }
  run()
  run()
  assert.equal(store.readJournal(30).length, 1)
})

test('关闭捕获后不再写 journal，但 mood 仍记录', (t) => {
  const { store, capture } = setup(t, { enabled: false })
  const s = { id: 'session-4' }
  capture.handleSessionEvent(s, turnStart(1))
  capture.handleSessionEvent(s, userEvent('关闭捕获时的一句话'))
  capture.handleSessionEvent(s, assistantEvent('答\n<mood>Vibe: 深海无风</mood>'))
  capture.handleSessionEvent(s, turnEnd(1))
  assert.equal(store.readJournal(30).length, 0)
  assert.equal(store.moods.length, 1)
  assert.equal(capture.getStats().enabled, false)
})

test('turn/end 缺失时可由 flushSession 兜底落盘', (t) => {
  const { store, capture } = setup(t)
  const s = { id: 'session-5' }
  capture.handleSessionEvent(s, turnStart(1))
  capture.handleSessionEvent(s, userEvent('没有 turn/end 也要记下来'))
  capture.handleSessionEvent(s, assistantEvent('收到'))
  assert.equal(store.readJournal(30).length, 0)
  const rec = capture.flushSession('session-5', Date.now())
  assert.ok(rec && rec.id)
  assert.equal(store.readJournal(30).length, 1)
  assert.equal(capture.getStats().flushed, 1)
  assert.ok(capture.getStats().types['user/message'] >= 1)
  assert.ok(capture.getStats().userSources.user >= 1)
  capture.flushSession('session-5', Date.now())
  assert.equal(store.readJournal(30).length, 1)
})

test('extractMood 解析四字段文本', () => {
  const mood = extractMood('前言\n<mood>\nVibe: 海面微澜\nSparks: a\nReflections: b\nWill: c\n</mood>\n后记')
  assert.ok(mood.includes('Vibe'))
  assert.ok(!mood.includes('</mood>'))
  assert.equal(extractMood('没有状态池'), '')
  assert.ok(extractMood('<qing>\nVibe: 旧别名\n</qing>').includes('Vibe'))
})
