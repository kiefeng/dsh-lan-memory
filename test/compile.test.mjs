import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { createCompiler } from '../lib/compile.js'
import { makeTmp } from './_tmp.mjs'

function makeStore(t) {
  const dir = makeTmp(t, 'compile-')
  const store = new Store({ dataDir: dir, logger: { log() {}, warn() {}, error() {} } })
  store.init()
  store.appendJournal({ id: 'j1', ts: Date.now(), session: 's1', turn: 1, user: '我喜欢深潜，回答尽量直接。', assistant: '记下了。', tools: [] })
  store.appendJournal({ id: 'j2', ts: Date.now(), session: 's1', turn: 2, user: '以后先给结论，不要铺垫。', assistant: '好。', tools: [] })
  return { dir, store }
}

function fakeLlm(respond) {
  return {
    listProviders() { return [{ id: 'fake' }] },
    async listModels() { return [{ id: 'fake-model' }] },
    async *stream(options) {
      const prompt = options.messages[0].content[0].text
      const text = respond(prompt)
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('自动编译：抽取事实 → 写 facts/画像 → 标记 compiled', async (t) => {
  const { dir, store } = makeStore(t)
  const llm = fakeLlm((prompt) => {
    if (prompt.includes('摘要器')) return '用户喜欢深潜，偏好先给结论。'
    if (prompt.includes('抽取器')) {
      return JSON.stringify([
        { fact: '用户喜欢深潜', tags: ['兴趣', '深潜'], time: null },
        { fact: '用户偏好先给结论', tags: ['偏好', '沟通'], time: null },
      ])
    }
    return JSON.stringify({
      facts: '用户喜欢深潜；偏好先给结论，不铺垫。',
      today: '上午聊了记忆系统的自动整理。',
      week: '本周在迭代本地记忆插件。',
      longterm: '用户偏好直接、可修改的本地工具。',
    })
  })
  const compiler = createCompiler({ store, llm, logger: { log() {}, warn() {}, error() {} } })
  const result = await compiler.run({ force: true })
  assert.equal(result.ok, true)
  assert.equal(result.factsAdded, 2)
  assert.equal(store.facts.length, 2)
  assert.ok(Object.keys(store.summaries || {}).length >= 1)
  assert.equal(store.pendingJournal().length, 0)
  assert.ok(existsSync(join(dir, 'memory.md')))
  assert.ok(readFileSync(join(dir, 'memory.md'), 'utf8').includes('## 重要事实'))
  assert.ok(store.memoryProfile.includes('用户喜欢深潜'))
  assert.equal(store.meta.compile.state, 'ok')

  // 再跑一次没有新线索：只重编译画像，不重复写事实
  const again = await compiler.run({ force: true })
  assert.equal(again.ok, true)
  assert.equal(again.compiled, 0)
  assert.equal(store.facts.length, 2)
})

test('编译失败：不标记线索、保留待编译、记录错误', async (t) => {
  const dir = makeTmp(t, 'compile-fail-')
  const store = new Store({ dataDir: dir, logger: { log() {}, warn() {}, error() {} } })
  store.init()
  store.appendJournal({ id: 'j1', ts: Date.now(), session: 's1', turn: 1, user: '继续', assistant: '好。', tools: [] })
  const llm = {
    listProviders() { return [{ id: 'fake' }] },
    async listModels() { return [{ id: 'fake-model' }] },
    async *stream() { throw new Error('network down') },
  }
  const compiler = createCompiler({ store, llm, logger: { log() {}, warn() {}, error() {} } })
  const result = await compiler.run({ force: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /network down/)
  assert.equal(store.pendingJournal().length, 1)
  assert.equal(store.facts.length, 0)
  assert.match(store.meta.compile.lastError, /network down/)
})

test('模型不返回 JSON 时用本地摘要兜底，不丢线索', async (t) => {
  const { store } = makeStore(t)
  const llm = fakeLlm(() => '抱歉，我无法按 JSON 输出。')
  const compiler = createCompiler({ store, llm, logger: { log() {}, warn() {}, error() {} } })
  const result = await compiler.run({ force: true })
  assert.equal(result.ok, true)
  assert.equal(result.fallback, true)
  assert.ok(result.factsAdded >= 1)
  assert.equal(store.pendingJournal().length, 0)
  assert.ok(store.memoryProfile.includes('深潜'))
})

test('memory.md 可手动编辑，下一次编译作为当前画像输入', (t) => {
  const { store } = makeStore(t)
  store.writeCompiled({ facts: '旧事实', today: '旧今天', week: '旧本周', longterm: '旧长期' })
  store.saveMemoryProfile('## 重要事实\n\n手改后的事实\n\n## 今天\n\n（暂无）\n\n## 本周\n\n（暂无）\n\n## 长期\n\n（暂无）')
  assert.equal(store.compiled.facts, '手改后的事实')
  assert.ok(store.readMemoryProfile().includes('手改后的事实'))
})
