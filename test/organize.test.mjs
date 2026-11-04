import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../lib/store.js'
import { createOrganizer, planDeterministic, planFactClusters, autoMergeFacts, factPairSignals } from '../lib/organize.js'
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

test('事实近似重复可预览、合并并撤销', (t) => {
  const { store } = setup(t)
  store.addFact({ fact: '用户喜欢深海潜水并观察鲸鱼的声音和动作', tags: ['偏好'] })
  store.addFact({ fact: '用户喜欢深海潜水并观察鲸鱼的声音和动向', tags: ['兴趣'] })
  const clusters = planFactClusters(store.facts)
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].ids.length, 2)
  assert.ok(clusters[0].ids.includes(clusters[0].keepId))
  store.undoSnapshot('merge-facts')
  const result = store.mergeFacts(clusters[0])
  assert.equal(store.facts.length, 1)
  assert.ok(store.factTombstones.length >= 1)
  assert.ok(result.tags.includes('偏好') && result.tags.includes('兴趣'))
  const undo = store.undoLast()
  assert.equal(store.facts.length, 2)
  assert.ok(undo.restored.includes('facts.jsonl'))
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

test('reviewPack ≤4KB：线索先做机械精简，并强制提炼后再写入', (t) => {
  const { store, organizer } = setup(t)
  store.addMemory({ content: '用户喜欢深潜' })
  store.addMemory({ content: '用户喜欢深潜。' })
  store.appendJournal({
    id: 'j1',
    ts: Date.now(),
    session: 's1',
    turn: 1,
    user: '记一下我最近在学自由潜水\n```js\nconst secret = 12345\n```',
    assistant: '好的，已记下。另外这里是一大段重复说明。重复说明。重复说明。' + '很长的尾巴'.repeat(40),
    tools: ['read'],
  })
  const pack = organizer.reviewPack()
  assert.ok(Buffer.byteLength(pack, 'utf8') <= 4096)
  assert.ok(pack.includes('待整理'))
  assert.ok(pack.includes('写入规则'))
  assert.ok(pack.includes('禁止把线索或对话原文整段复制'))
  assert.ok(pack.includes('自由潜水'))
  assert.ok(!pack.includes('const secret'), '代码块应在线索摘要里被清掉')
  // 模型看过即标记 reviewed：不再计入待整理，原始记录仍在 journal 文件里
  assert.equal(store.pendingJournal().length, 0)
  assert.equal(store.allJournal()[0].state, 'reviewed')
  assert.equal(store.readJournal(30).length, 1)
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

test('中文改写靠标签重叠抓重复，不再只认字符串相似度', (t) => {
  const { store } = setup(t)
  // 这两条字符串相似度只有 0.64，旧阈值 0.85 抓不到，但标签完全一致。
  store.addFact({ fact: '用户名是 kieran，主机名是 kieran-om。', tags: ['身份', '用户名', '主机名'] })
  store.addFact({ fact: '用户的 Linux 用户名是 kieran，主机名是 kieran-om。', tags: ['身份', '用户名', '主机名'] })
  // 华硕这两条相似度 0.5：能进预览，但不够高置信，不该自动合并。
  store.addFact({ fact: '用户使用一台较老的华硕笔记本，配置为4G内存和5400转机械硬盘。', tags: ['设备', '硬件', '笔记本'] })
  store.addFact({ fact: '用户有一台老华硕笔记本，配置为4G内存和机械硬盘。', tags: ['设备', '硬件', '笔记本'] })
  store.addFact({ fact: '用户对 Arch Linux 及 Omarchy 的安装与使用有兴趣。', tags: ['兴趣', 'Linux'] })
  const sig = factPairSignals(store.facts[0], store.facts[1])
  assert.ok(sig.sim < 0.85, '这对的字符串相似度应低于旧阈值')
  const clusters = planFactClusters(store.facts)
  assert.equal(clusters.length, 2)
  const k = clusters.find((c) => c.ids.includes(store.facts[0].id))
  const hw = clusters.find((c) => c.ids.includes(store.facts[2].id))
  assert.equal(k.auto, true, '标签完全一致且相似度过半的簇允许自动合并')
  assert.equal(hw.auto, false, '只有 0.5 相似度的簇只进预览')
})

test('高置信重复事实自动合并，写墓碑并可撤销', (t) => {
  const { store } = setup(t)
  store.addFact({ fact: '用户名是 kieran，主机名是 kieran-om。', tags: ['身份', '用户名', '主机名'] })
  store.addFact({ fact: '用户的 Linux 用户名是 kieran，主机名是 kieran-om。', tags: ['身份', '用户名', '主机名'] })
  const res = autoMergeFacts(store)
  assert.ok(res.merged >= 2)
  assert.equal(store.facts.length, 1)
  assert.ok(store.factTombstones.length >= 1)
  assert.ok(store.meta.lastFactMerge && store.meta.lastFactMerge.merged >= 2)
  const undo = store.undoLast()
  assert.equal(store.facts.length, 2)
  assert.ok(undo.restored.includes('facts.jsonl'))
})

test('同一话题的不同属性不会被自动合并', (t) => {
  const { store } = setup(t)
  store.addFact({ fact: '用户特别在意 SilverBullet 的表格编辑体验。', tags: ['偏好', '表格编辑', '编辑体验'] })
  store.addFact({ fact: '用户特别在意 SilverBullet 的缩进层级是否清楚。', tags: ['偏好', '层级显示', '编辑体验'] })
  const res = autoMergeFacts(store)
  assert.equal(res.merged, 0)
  assert.equal(store.facts.length, 2)
})
