import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { makeTmp } from './_tmp.mjs'

const quiet = { log() {}, warn() {}, error() {} }

/** 找一个确定存活的 pid（当前进程的父进程）；拿不到就跳过用例。 */
function livePid() {
  try {
    process.kill(process.ppid, 0)
    return process.ppid
  } catch {
    return null
  }
}

test('陈旧锁（进程不在）会在启动时被接管', (t) => {
  const dir = makeTmp(t, 'lock-stale-')
  const old = Date.now() - 10 * 60 * 1000
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 999999, at: old, heartbeat: old }), 'utf8')
  const store = new Store({ dataDir: dir, logger: quiet })
  store.init()
  assert.equal(store.readOnly, false)
  const info = JSON.parse(readFileSync(join(dir, '.lock'), 'utf8'))
  assert.equal(info.pid, process.pid)
  assert.ok(info.heartbeat > old, '接管后应写入新心跳')
  store.releaseLock()
  assert.equal(existsSync(join(dir, '.lock')), false)
})

test('心跳过期的活进程锁可被接管，不再永久只读', (t) => {
  const pid = livePid()
  if (!pid) { t.skip('拿不到存活 pid'); return }
  const dir = makeTmp(t, 'lock-expired-')
  const old = Date.now() - 10 * 60 * 1000
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid, at: old, heartbeat: old }), 'utf8')
  const store = new Store({ dataDir: dir, logger: quiet })
  store.init()
  assert.equal(store.readOnly, false)
  store.releaseLock()
})

test('心跳新鲜的活锁保持只读，并暴露占用 pid', (t) => {
  const pid = livePid()
  if (!pid) { t.skip('拿不到存活 pid'); return }
  const dir = makeTmp(t, 'lock-live-')
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid, at: Date.now(), heartbeat: Date.now() }), 'utf8')
  const store = new Store({ dataDir: dir, logger: quiet })
  store.init()
  assert.equal(store.readOnly, true)
  assert.equal(store.lockInfo.pid, pid)
  assert.throws(() => store.addMemory({ content: '不该写进去' }), /只读/)
  // 只读状态不删别人的锁
  store.releaseLock()
  assert.equal(existsSync(join(dir, '.lock')), true)
})

test('takeoverLock 强制接管后可写', (t) => {
  const pid = livePid()
  if (!pid) { t.skip('拿不到存活 pid'); return }
  const dir = makeTmp(t, 'lock-takeover-')
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid, at: Date.now(), heartbeat: Date.now() }), 'utf8')
  const store = new Store({ dataDir: dir, logger: quiet })
  store.init()
  assert.equal(store.readOnly, true)
  store.takeoverLock()
  assert.equal(store.readOnly, false)
  const item = store.addMemory({ content: '接管后能写' })
  assert.ok(item && item.id)
  store.releaseLock()
})
