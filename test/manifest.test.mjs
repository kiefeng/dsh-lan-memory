import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('清单：DSH 兼容性与入口', () => {
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(pkg.engines && pkg.engines.dsh, '必须声明 engines.dsh')
  assert.match(pkg.engines.dsh, /\^?0\.2\.1-rc\.2|>=0\.2\.1-rc\.2/)
  assert.ok(existsSync(join(ROOT, 'lib/index.js')))
  assert.ok(existsSync(join(ROOT, 'lib/client.js')))
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')))
})

test('bundle patch 插入的行名等于包名', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('insert:'))
  assert.ok(patch.includes(`name: '${pkg.name}'`))
})

test('client 声明只含宿主认识的字段', () => {
  const client = pkg.dsh.client
  assert.equal(client.platform, 'web')
  assert.ok(Array.isArray(client.inject))
  for (const key of Object.keys(client)) assert.ok(['platform', 'inject', 'external', 'immediately'].includes(key))
  assert.ok(client.inject.every((x) => typeof x === 'string'))
})

test('文件清单覆盖运行所需文件', () => {
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md']) {
    assert.ok(pkg.files.includes(entry), `files 缺少 ${entry}`)
  }
  assert.ok(!pkg.files.includes('ui'), '独立面板已移除，files 不应再包含 ui')
})

test('client 半区注册设置页与状态池卡片', () => {
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(client.includes('window.__ModuleLoader__.load'))
  assert.ok(client.includes("id: 'dsh-lan-memory'"))
  assert.ok(client.includes("slots.inject('settings.section'"))
  assert.ok(client.includes("slots.inject('conversation.chat.turnTail'"))
  assert.ok(client.includes("id: 'lan-mood'"))
  assert.ok(client.includes('/api/mood'), '状态池卡片应从 host 读取结构化 mood')
})

test('node 半区不 import 任何 DSH 包（避免 v1 的漏依赖问题）', () => {
  for (const file of ['lib/index.js', 'lib/store.js', 'lib/search.js', 'lib/capture.js', 'lib/organize.js', 'lib/http.js', 'lib/defaults.js']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(!/from\s+'@deepseek-ai\//.test(text), `${file} 不应 import DSH 包`)
    assert.ok(!/require\('@deepseek-ai\//.test(text), `${file} 不应 require DSH 包`)
  }
})
