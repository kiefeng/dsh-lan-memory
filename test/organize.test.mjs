import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../lib/store.js'
import { createOrganizer, planDeterministic } from '../lib/organize.js'
import { makeTmp } from './_tmp.mjs'

function setup(t) {
  const dir = makeTmp(t, 'org-')
  const store = new Store({ dataDir: dir, logger: { log() {}, warn() {}, error() {} } })
  store.init()
  const organizer = createOrganizer(store, { log() {} })
  return { store, organizer, dir }
}

test('精确重复与近似重复会被识别为合并动作', (t) => {
  const { store, organizer } = setup(t)
  store.addMemory({ content: '用户喜欢深潜', tags: ['偏好'] })
  store.addMemory({ content: '用户喜欢深潜。', tags: ['沟通'] })
  store.addMemory({ content: '项目使用 pnpm', tags: ['项目'] })
  const preview = organizer.preview()
  assert.equal(preview.countsBefore.memory, 3)
  const merges = preview.actions.filter((a) => a.kind === 'merge')
  assert.equal(merges.length, 1)
  assert.equal(merges[0].ids.length, 2)
  assert.ok(merges[0].merged.tags.includes('偏好') && merges[0].merged.tags.includes('沟通'))
  assert.equal(preview.countsAfter.memory, 2)
  // 干跑不写盘
  assert.equal(store.memory.length, 3)
})

test('applyLocal 合并后可撤销', (t) => {
  const { store, organizer } = setup(t)
  store.addMemory({ content: '用户喜欢深潜', tags: ['偏好'] })
  store.addMemory({ content: '用户喜欢深潜。', tags: ['沟通'] })
  const report = organizer.applyLocal()
  assert.equal(report.changed, true)
  assert.equal(store.memory.length, 1)
  assert.ok(report.undoId)
  assert.ok(store.meta.lastOrganize)
  const undo = organizer.undo()
  assert.ok(undo.undoId)
  assert.equal(store.memory.length, 2)
})

test('无重复时 applyLocal 不写 undo', (t) => {
  const { store, organizer } = setup(t)
  store.addMemory({ content: '完全不同的记忆甲' })
  store.addMemory({ content: '另一条无关内容乙' })
  const report = organizer.applyLocal()
  assert.equal(report.changed, false)
  assert.equal(report.undoId, null)
})

test('reviewPack ≤4KB 且包含待整理与动作说明', (t) => {
  const { store, organizer } = setup(t)
  store.addMemory({ content: '用户喜欢深潜' })
  store.addMemory({ content: '用户喜欢深潜。' })
  store.appendJournal({ id: 'j1', ts: Date.now(), session: 's1', turn: 1, user: '记一下我最近在学自由潜水', assistant: '好的，已记下', tools: ['read'] })
  const pack = organizer.reviewPack()
  assert.ok(Buffer.byteLength(pack, 'utf8') <= 4096)
  assert.ok(pack.includes('待整理'))
  assert.ok(pack.includes('允许的动作'))
  assert.ok(pack.includes('自由潜水'))
})

test('planDeterministic 容量溢出生成删除动作', () => {
  const memory = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    content: `完全不同的内容 ${i} ${'x'.repeat(30)}`,
    tags: [],
    updated_at: new Date().toISOString(),
  }))
  const plan = planDeterministic(memory, [], { maxMemory: 3 })
  assert.equal(plan.overflow.length, 2)
})

test('过期条目只提示不自动删除', (t) => {
  const { store, organizer } = setup(t)
  store.addMemory({ content: '很久以前的记忆' })
  store.memory[0].updated_at = '2020-01-01T00:00:00.000Z'
  store.saveMemory()
  const preview = organizer.preview()
  const stale = preview.actions.find((a) => a.reason === 'stale')
  assert.ok(stale)
  assert.equal(stale.kind, 'none')
  assert.equal(preview.countsAfter.memory, preview.countsBefore.memory)
})
