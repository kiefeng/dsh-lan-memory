import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Store, parsePersonaMarkdown, serializePersonaMarkdown, parsePinnedMarkdown, normalizeTags } from '../lib/store.js'
import { makeTmp } from './_tmp.mjs'

function tmpStore(t) {
  const dir = makeTmp(t, 'store-')
  const store = new Store({ dataDir: dir, logger: { log() {}, warn() {}, error() {} } })
  return { dir, store }
}

test('init 创建默认人格与空文件', (t) => {
  const { dir, store } = tmpStore(t)
  store.init()
  assert.ok(existsSync(join(dir, 'persona.md')))
  assert.ok(store.persona.soul.includes('澜'))
  assert.ok(store.persona.moodContract.includes('mood'))
  assert.equal(store.pinned.length, 0)
  assert.equal(store.memory.length, 0)
})

test('pinned 兼容 v1/v2 两种格式并可往返', (t) => {
  const { store } = tmpStore(t)
  store.init()
  const parsed = parsePinnedMarkdown('- [偏好] 喜欢简洁\n[项目] 用 pnpm\n- 普通一行')
  assert.equal(parsed.length, 3)
  assert.equal(parsed[0].tag, '偏好')
  assert.equal(parsed[1].tag, '项目')
  assert.equal(parsed[2].tag, '通用')
  store.savePinned(parsed)
  store.loadAll()
  assert.equal(store.pinned.length, 3)
  assert.equal(store.pinned[1].content, '用 pnpm')
})

test('persona.md 解析与保存', (t) => {
  const { store } = tmpStore(t)
  store.init()
  const md = serializePersonaMarkdown({ soul: 'SOUL-X', moodContract: 'MOOD-Y' })
  const p = parsePersonaMarkdown(md, { soul: '', moodContract: '' })
  assert.equal(p.soul, 'SOUL-X')
  assert.equal(p.moodContract, 'MOOD-Y')
  store.savePersona({ soul: '新人格', moodContract: '新契约' })
  store.loadAll()
  assert.equal(store.persona.soul, '新人格')
  assert.throws(() => store.savePersona({ soul: '' }), /SOUL 不能为空/)
})

test('记忆 CRUD 与 etag 变化', (t) => {
  const { store } = tmpStore(t)
  store.init()
  const before = store.etag()
  const item = store.addMemory({ content: '用户喜欢简洁的回答', tags: ['偏好', '沟通'] })
  assert.ok(item.id)
  assert.notEqual(store.etag(), before)
  store.saveMemory()
  store.loadAll()
  assert.equal(store.memory.length, 1)
  assert.equal(store.memory[0].content, '用户喜欢简洁的回答')
  store.updateMemory(item.id, { content: '用户喜欢简洁直接的答案' })
  assert.equal(store.memory[0].content, '用户喜欢简洁直接的答案')
  store.deleteMemory(item.id)
  assert.equal(store.memory.length, 0)
  assert.throws(() => store.deleteMemory('nope'), /未找到/)
})

test('自动事实删除后加墓碑，编译不会把它写回来', (t) => {
  const { store } = tmpStore(t)
  store.init()
  const first = store.appendFacts([{ fact: '用户喜欢深潜' }])[0]
  assert.ok(first)
  store.deleteFact(first.id)
  assert.equal(store.facts.length, 0)
  assert.equal(store.appendFacts([{ fact: '用户喜欢深潜。' }]).length, 0)
  const manual = store.addFact({ fact: '用户喜欢深潜。' })
  assert.ok(manual, '手动新增应能解除墓碑')
  assert.equal(store.facts.length, 1)
})

test('write 后保留 .bak 上一版', (t) => {
  const { store, dir } = tmpStore(t)
  store.init()
  store.savePersona({ soul: 'A', moodContract: 'M' })
  store.savePersona({ soul: 'B', moodContract: 'M' })
  assert.ok(existsSync(join(dir, 'persona.md.bak')))
  assert.ok(readFileSync(join(dir, 'persona.md.bak'), 'utf8').includes('A'))
})

test('手改 memory.md 后 readMemoryProfile 会同步解析四段', (t) => {
  const { store, dir } = tmpStore(t)
  store.init()
  writeFileSync(join(dir, 'memory.md'), '## 重要事实\n\n手动改成 A\n\n## 今天\n\n手动改成 B\n', 'utf8')
  const text = store.readMemoryProfile()
  assert.ok(text.includes('手动改成 A'))
  assert.equal(store.compiled.facts, '手动改成 A')
  assert.equal(store.compiled.today, '手动改成 B')
})

test('journal 追加/读取/状态/待整理', (t) => {
  const { store } = tmpStore(t)
  store.init()
  store.appendJournal({ id: 'j1', ts: Date.now(), session: 's1', turn: 1, user: '记一下我喜欢深潜', assistant: '好', tools: ['read'] })
  store.appendJournal({ id: 'j2', ts: Date.now(), session: 's1', turn: 2, user: '继续', assistant: '嗯', tools: [] })
  assert.equal(store.readJournal(30).length, 2)
  assert.equal(store.pendingJournal().length, 2)
  store.setJournalStatus('j1', 'promoted')
  assert.equal(store.pendingJournal().length, 1)
  assert.equal(store.allJournal()[0].state === 'promoted' || store.allJournal()[1].state === 'promoted', true)
})

test('收件箱待整理会自动过期并限制条数，避免无限积压', (t) => {
  const { store } = tmpStore(t)
  store.init()
  const now = Date.now()
  store.appendJournal({ id: 'new1', ts: now, session: 's1', turn: 1, user: '新线索一', assistant: '好', tools: [] })
  store.appendJournal({ id: 'new2', ts: now, session: 's1', turn: 2, user: '新线索二', assistant: '好', tools: [] })
  store.appendJournal({ id: 'new3', ts: now, session: 's1', turn: 3, user: '新线索三', assistant: '好', tools: [] })
  store.appendJournal({ id: 'old1', ts: now - 20 * 24 * 3600 * 1000, session: 's1', turn: 0, user: '很久以前的线索', assistant: '好', tools: [] })
  store.saveMeta({ settings: { journalPendingDays: 14, journalPendingMax: 2 } })
  const pending = store.pendingJournal()
  assert.equal(pending.length, 2)
  assert.ok(!pending.some((r) => r.id === 'old1'))
  // 文件里仍在，只是不计入待整理
  assert.equal(store.readJournal(30).length, 4)
})

test('快照/恢复/撤销', (t) => {
  const { store } = tmpStore(t)
  store.init()
  store.addMemory({ content: '原始条目' })
  const dir = store.snapshot('test')
  assert.ok(existsSync(join(dir, 'manifest.json')))
  store.addMemory({ content: '新增条目' })
  assert.equal(store.memory.length, 2)
  store.restoreBackup(dir.split(/[\\/]/).pop())
  assert.equal(store.memory.length, 1)
  assert.equal(store.memory[0].content, '原始条目')
  // 备份被篡改时拒绝恢复
  const backup = store.listBackups().find((b) => b.reason === 'test')
  writeFileSync(join(store.backupDir, backup.dir, 'memory.jsonl'), '{"content":"tampered"}\n')
  assert.throws(() => store.restoreBackup(backup.dir), /校验失败/)
})

test('undoSnapshot/undoLast 恢复整理前内容', (t) => {
  const { store } = tmpStore(t)
  store.init()
  store.addMemory({ content: '会保留的条目' })
  store.undoSnapshot('organize')
  store.addMemory({ content: '整理后被删的条目' })
  store.saveMemory()
  store.undoLast()
  assert.equal(store.memory.length, 1)
  assert.equal(store.memory[0].content, '会保留的条目')
})

test('mood 上限 200', (t) => {
  const { store } = tmpStore(t)
  store.init()
  for (let i = 0; i < 230; i++) store.recordMood(`Vibe: ${i}`)
  assert.equal(store.moods.length, 200)
  assert.equal(store.moods[store.moods.length - 1].text, 'Vibe: 229')
})

test('v1 数据迁移：复制不移动、persona.json 转 md', (t) => {
  const home = makeTmp(t, 'home-')
  const v1 = join(home, 'hanako')
  mkdirSync(v1, { recursive: true })
  writeFileSync(join(v1, 'pinned.md'), '[偏好] 喜欢安静\n')
  writeFileSync(join(v1, 'memory.jsonl'), JSON.stringify({ id: 'm1', tags: ['x'], content: '旧记忆', created_at: '2026-08-01T00:00:00Z' }) + '\n')
  writeFileSync(join(v1, 'experience.jsonl'), JSON.stringify({ category: 'tool usage', content: '旧经验' }) + '\n')
  writeFileSync(join(v1, 'persona.json'), JSON.stringify({ soul: '旧SOUL', moodContract: '旧MOOD' }))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  })
  const dir = join(home, 'lan-memory')
  const store = new Store({ dataDir: dir, logger: { log() {}, warn() {}, error() {} } })
  const report = store.init()
  assert.equal(report.found, true)
  assert.equal(store.pinned.length, 1)
  assert.equal(store.memory.length, 1)
  assert.equal(store.experience.length, 1)
  assert.equal(store.persona.soul, '旧SOUL')
  // 旧目录保持不动
  assert.ok(existsSync(join(v1, 'persona.json')))
  assert.ok(existsSync(join(v1, 'memory.jsonl')))
})

test('normalizeTags 去重与截断', () => {
  assert.deepEqual(normalizeTags('a, b，a  c'), ['a', 'b', 'c'])
  assert.deepEqual(normalizeTags(['x', 'x', '']), ['x'])
})
