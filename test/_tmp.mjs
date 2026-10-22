import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 本机沙箱下系统 Temp 目录不可写，测试统一下降到仓库内 .tmp/。
 * 每个测试用独立目录，结束后删除。
 */
const ROOT = join(process.cwd(), '.tmp')
mkdirSync(ROOT, { recursive: true })

export function makeTmp(t, prefix = 'case-') {
  const dir = mkdtempSync(join(ROOT, prefix))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ } })
  return dir
}
