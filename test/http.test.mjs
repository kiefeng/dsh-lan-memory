import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Store } from '../lib/store.js'
import { createOrganizer } from '../lib/organize.js'
import { createCapture } from '../lib/capture.js'
import { createHttpHandler } from '../lib/http.js'
import { makeTmp } from './_tmp.mjs'

async function setup(t) {
  const dir = makeTmp(t, 'http-')
  const store = new Store({ dataDir: dir, logger: { log() {}, warn() {}, error() {} } })
  store.init()
  const organizer = createOrganizer(store, { log() {} })
  const capture = createCapture({ store, logger: { log() {}, warn() {}, error() {} }, enabled: true })
  const handler = createHttpHandler({
    store,
    organizer,
    capture,
    logger: { warn() {} },
    getHealth: () => ({ version: 'test', tools: 6, sections: 3, contexts: 3, routes: 1, capture: capture.getStats() }),
  })
  const server = http.createServer((req, res) => { handler.handle(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); try { store.releaseLock() } catch { /* 忽略 */ } })
  return { base, store, port }
}

function post(base, path, body, extra = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lan-ui': '1', ...extra },
    body: JSON.stringify(body || {}),
  })
}

test('GET state / health；旧面板路由已移除', async (t) => {
  const { base } = await setup(t)
  const state = await (await fetch(base + '/lan-memory/api/state')).json()
  assert.equal(state.ok, true)
  assert.ok(state.etag)
  assert.ok(state.dataDir)
  assert.ok(state.counts)
  assert.ok(Array.isArray(state.pinned))
  assert.equal(state.panelUrl, null, 'state 不再暴露面板地址')
  const health = await (await fetch(base + '/lan-memory/api/health')).json()
  assert.equal(health.ok, true)
  assert.equal(health.tools, 6)
  const panel = await fetch(base + '/lan-memory/')
  assert.equal(panel.status, 404)
})

test('写请求缺 x-lan-ui 头被拒绝', async (t) => {
  const { base } = await setup(t)
  const r = await fetch(base + '/lan-memory/api/memory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layer: 'memory', action: 'add', entry: { content: 'x' } }),
  })
  assert.equal(r.status, 403)
})

test('跨站 Origin 被拒绝', async (t) => {
  const { base } = await setup(t)
  const r = await post(base, '/lan-memory/api/memory', { layer: 'memory', action: 'add', entry: { content: 'x' } }, { origin: 'http://evil.example' })
  assert.equal(r.status, 403)
})

test('写记忆 → state 更新 → etag 变化', async (t) => {
  const { base } = await setup(t)
  const before = await (await fetch(base + '/lan-memory/api/state')).json()
  const r = await post(base, '/lan-memory/api/memory', {
    layer: 'memory', action: 'add', entry: { content: '用户喜欢深潜', tags: ['偏好'] }, ifMatch: before.etag,
  }, { origin: base })
  assert.equal(r.status, 200)
  const data = await r.json()
  assert.equal(data.ok, true)
  assert.notEqual(data.etag, before.etag)
  const state = await (await fetch(base + '/lan-memory/api/state')).json()
  assert.equal(state.memory.length, 1)
  assert.equal(state.memory[0].content, '用户喜欢深潜')
})

test('ifMatch 过期返回 409 并带新 etag', async (t) => {
  const { base } = await setup(t)
  const state = await (await fetch(base + '/lan-memory/api/state')).json()
  await post(base, '/lan-memory/api/memory', { layer: 'memory', action: 'add', entry: { content: '第一条' }, ifMatch: state.etag }, { origin: base })
  const r = await post(base, '/lan-memory/api/memory', { layer: 'memory', action: 'add', entry: { content: '第二条' }, ifMatch: state.etag }, { origin: base })
  assert.equal(r.status, 409)
  const data = await r.json()
  assert.equal(data.ok, false)
  assert.ok(data.etag && data.etag !== state.etag)
})

test('pinned / experience 增改删', async (t) => {
  const { base } = await setup(t)
  let state = await (await fetch(base + '/lan-memory/api/state')).json()
  let r = await post(base, '/lan-memory/api/memory', { layer: 'pinned', action: 'add', entry: { tag: '偏好', content: '喜欢安静' }, ifMatch: state.etag }, { origin: base })
  assert.equal(r.status, 200)
  r = await post(base, '/lan-memory/api/memory', { layer: 'experience', action: 'add', entry: { category: 'tool usage', content: '先读再改' } }, { origin: base })
  assert.equal(r.status, 200)
  state = await (await fetch(base + '/lan-memory/api/state')).json()
  assert.equal(state.pinned.length, 1)
  assert.equal(state.experience.length, 1)
  r = await post(base, '/lan-memory/api/memory', { layer: 'pinned', action: 'delete', index: 0 }, { origin: base })
  assert.equal(r.status, 200)
  state = await (await fetch(base + '/lan-memory/api/state')).json()
  assert.equal(state.pinned.length, 0)
})

test('persona 保存后 state 可见', async (t) => {
  const { base } = await setup(t)
  const state = await (await fetch(base + '/lan-memory/api/state')).json()
  const r = await fetch(base + '/lan-memory/api/persona', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-lan-ui': '1', origin: base },
    body: JSON.stringify({ soul: '新人格底稿', moodContract: '新状态池契约', ifMatch: state.etag }),
  })
  assert.equal(r.status, 200)
  const after = await (await fetch(base + '/lan-memory/api/state')).json()
  assert.equal(after.persona.soul, '新人格底稿')
  assert.equal(after.persona.moodContract, '新状态池契约')
})

test('收件箱：promote 后待整理减少', async (t) => {
  const { base, store } = await setup(t)
  store.appendJournal({ id: 'j1', ts: Date.now(), session: 's1', turn: 1, user: '用户说喜欢自由潜水', assistant: '记下了', tools: [] })
  let state = await (await fetch(base + '/lan-memory/api/state')).json()
  assert.equal(state.counts.journalPending, 1)
  const r = await post(base, '/lan-memory/api/journal', { action: 'promote', id: 'j1', layer: 'memory', tags: ['偏好'] }, { origin: base })
  assert.equal(r.status, 200)
  state = await (await fetch(base + '/lan-memory/api/state')).json()
  assert.equal(state.counts.journalPending, 0)
  assert.equal(state.memory.length, 1)
})

test('整理 preview / apply / undo 与备份列表', async (t) => {
  const { base, store } = await setup(t)
  store.addMemory({ content: '用户喜欢深潜' })
  store.addMemory({ content: '用户喜欢深潜。' })
  let state = await (await fetch(base + '/lan-memory/api/state')).json()
  let r = await post(base, '/lan-memory/api/organize', { mode: 'preview', ifMatch: state.etag }, { origin: base })
  assert.equal(r.status, 200)
  let data = await r.json()
  assert.ok(data.report.actions.length >= 1)
  assert.equal(store.memory.length, 2)
  r = await post(base, '/lan-memory/api/organize', { mode: 'apply-local', ifMatch: data.etag }, { origin: base })
  data = await r.json()
  assert.equal(data.report.changed, true)
  assert.equal(store.memory.length, 1)
  r = await post(base, '/lan-memory/api/backup', {}, { origin: base })
  assert.equal(r.status, 200)
  const backups = await (await fetch(base + '/lan-memory/api/backups')).json()
  assert.ok(backups.items.length >= 1)
  r = await post(base, '/lan-memory/api/organize', { mode: 'undo', ifMatch: (await (await fetch(base + '/lan-memory/api/state')).json()).etag }, { origin: base })
  assert.equal(r.status, 200)
  assert.equal(store.memory.length, 2)
})

test('mood 接口按 session+turn 返回结构化状态池', async (t) => {
  const { base, store } = await setup(t)
  store.recordMood(
    'Vibe: 海面微澜\nSparks: 鲸歌\n洋流\nReflections: 傲娇自查\nWill: 深潜到底',
    Date.now(),
    { session: 's1', turn: 2, seq: 9 },
  )
  const res = await fetch(base + '/lan-memory/api/mood?session=s1&turn=2')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.ok, true)
  assert.equal(data.mood.vibe, '海面微澜')
  assert.deepEqual(data.mood.sparks, ['鲸歌', '洋流'])
  assert.deepEqual(data.mood.will, ['深潜到底'])
  assert.equal(data.mood.turn, 2)
  assert.equal(data.mood.session, 's1')
})

test('mood 接口兼容只有一句 Vibe 的裸文本', async (t) => {
  const { base, store } = await setup(t)
  store.recordMood('海面稳住，编译管线接上了。', Date.now(), { session: 's2', turn: 3, seq: 10 })
  const data = await (await fetch(base + '/lan-memory/api/mood?session=s2&turn=3')).json()
  assert.equal(data.mood.vibe, '海面稳住，编译管线接上了。')
  assert.equal(data.mood.text, '海面稳住，编译管线接上了。')
})

test('settings 允许修改编译相关上限', async (t) => {
  const { base, store } = await setup(t)
  const state = await (await fetch(base + '/lan-memory/api/state')).json()
  const r = await post(base, '/lan-memory/api/settings', {
    settings: { maxManualBytes: 1234, maxEntryChars: 280, journalPendingMax: 40 },
    ifMatch: state.etag,
  }, { origin: base })
  assert.equal(r.status, 200)
  assert.equal(store.meta.settings.maxManualBytes, 1234)
  assert.equal(store.meta.settings.maxEntryChars, 280)
  assert.equal(store.meta.settings.journalPendingMax, 40)
})

test('删除手动记忆时同名自动事实写墓碑，避免编译复活', async (t) => {
  const { base, store } = await setup(t)
  const memory = store.addMemory({ content: '用户喜欢深潜' })
  store.addFact({ fact: '用户喜欢深潜', source: 'auto' })
  const state = await (await fetch(base + '/lan-memory/api/state')).json()
  const r = await post(base, '/lan-memory/api/memory', {
    layer: 'memory', action: 'delete', id: memory.id, ifMatch: state.etag,
  }, { origin: base })
  assert.equal(r.status, 200)
  assert.equal(store.memory.length, 0)
  assert.equal(store.facts.length, 0)
  assert.ok(store.factTombstones.length >= 1)
})

test('事实合并预览与确认写入', async (t) => {
  const { base, store } = await setup(t)
  store.addFact({ fact: '用户喜欢深海潜水并观察鲸鱼的声音和动作', tags: ['偏好'] })
  store.addFact({ fact: '用户喜欢深海潜水并观察鲸鱼的声音和动向', tags: ['兴趣'] })
  let state = await (await fetch(base + '/lan-memory/api/state')).json()
  const preview = await post(base, '/lan-memory/api/facts', { action: 'merge-preview', ifMatch: state.etag }, { origin: base })
  assert.equal(preview.status, 200)
  const clusters = (await preview.json()).clusters
  assert.equal(clusters.length, 1)
  state = await (await fetch(base + '/lan-memory/api/state')).json()
  const applied = await post(base, '/lan-memory/api/facts', {
    action: 'merge-apply', clusters: [clusters[0]], ifMatch: state.etag,
  }, { origin: base })
  assert.equal(applied.status, 200)
  assert.equal(store.facts.length, 1)
  assert.ok(store.factTombstones.length >= 1)
})

test('经验候选接受后进入经验库，忽略后不再出现', async (t) => {
  const { base, store } = await setup(t)
  store.addExperienceCandidates([
    { category: '记忆系统', content: '合并事实前先预览。' },
    { category: '记忆系统', content: '另一个候选。' },
  ])
  const pending = store.experienceCandidates.filter((c) => c.status === 'pending')
  assert.equal(pending.length, 2)
  let state = await (await fetch(base + '/lan-memory/api/state')).json()
  const accepted = await post(base, '/lan-memory/api/experience-candidates', {
    action: 'accept', id: pending[0].id, ifMatch: state.etag,
  }, { origin: base })
  assert.equal(accepted.status, 200)
  assert.equal(store.experience.length, 1)
  state = await (await fetch(base + '/lan-memory/api/state')).json()
  const dismissed = await post(base, '/lan-memory/api/experience-candidates', {
    action: 'dismiss', id: pending[1].id, ifMatch: state.etag,
  }, { origin: base })
  assert.equal(dismissed.status, 200)
  assert.equal(store.experienceCandidates.filter((c) => c.status === 'pending').length, 0)
})

test('export 返回附件 JSON', async (t) => {
  const { base } = await setup(t)
  const r = await fetch(base + '/lan-memory/api/export')
  assert.equal(r.status, 200)
  assert.ok((r.headers.get('content-disposition') || '').includes('attachment'))
  const data = await r.json()
  assert.ok(data.persona)
  assert.ok(Array.isArray(data.memory))
})

test('未知 API 404', async (t) => {
  const { base } = await setup(t)
  const r = await fetch(base + '/lan-memory/api/nope')
  assert.equal(r.status, 404)
})
