#!/usr/bin/env node
/**
 * 独立 smoke 构建验证：
 * - 输出到 dist-smoke/（不污染正式 dist/）
 * - 使用独立数据目录（不影响真实用户数据）
 * - 断言 SMOKE_READY + exit 0 + stderr 无错误
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(import.meta.dirname, '..')
const SMOKE_DIST = join(ROOT, 'dist-smoke')
const SMOKE_DATA_DIR = join(tmpdir(), `tizhou-smoke-${randomUUID().slice(0, 8)}`)
const SMOKE_EXE = join(SMOKE_DIST, 'win-unpacked', '题舟.exe')

// 1. 清理旧 smoke 产物
if (existsSync(SMOKE_DIST)) rmSync(SMOKE_DIST, { recursive: true, force: true })
console.log(`[smoke] 清理 ${SMOKE_DIST}`)

// 2. 确保已构建（如 out/ 不存在则先 build）
const outDir = join(ROOT, 'out')
if (!existsSync(join(outDir, 'main', 'index.js'))) {
  console.log('[smoke] out/ 不存在，先执行 build...')
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
}

// 3. 打包到 dist-smoke（不影响 dist/）
console.log('[smoke] 打包到 dist-smoke/ ...')
execFileSync(
  'npx.cmd',
  ['electron-builder', '--win', 'nsis', '--config.directories.output=dist-smoke'],
  { cwd: ROOT, stdio: 'inherit', timeout: 300000, shell: true }
)

// 4. 验证 exe 存在
if (!existsSync(SMOKE_EXE)) {
  console.error(`[smoke] FAIL: 未找到 ${SMOKE_EXE}`)
  process.exit(1)
}
console.log(`[smoke] exe 存在: ${SMOKE_EXE}`)

// 5. 启动 --smoke-test，使用独立数据目录
console.log(`[smoke] 数据目录: ${SMOKE_DATA_DIR}`)
const result = spawnSync(SMOKE_EXE, ['--smoke-test'], {
  timeout: 60000,
  encoding: 'utf8',
  env: {
    ...process.env,
    WORKBENCH_SMOKE_DATA_DIR: SMOKE_DATA_DIR
  }
})

// 6. 断言退出码
if (result.status !== 0) {
  console.error(`[smoke] FAIL: 退出码 ${result.status}`)
  console.error('[smoke] stdout:', result.stdout)
  console.error('[smoke] stderr:', result.stderr)
  process.exit(1)
}
console.log('[smoke] 退出码: 0 ✓')

// 7. 断言 stdout 包含 SMOKE_READY
if (!result.stdout.includes('SMOKE_READY')) {
  console.error('[smoke] FAIL: stdout 未包含 SMOKE_READY')
  console.error('[smoke] stdout:', result.stdout)
  process.exit(1)
}
console.log('[smoke] SMOKE_READY ✓')

// 8. 断言 stderr 无致命错误
const stderr = result.stderr || ''
const FATAL_PATTERNS = ['Uncaught Exception', 'SyntaxError', 'SMOKE_FAIL', 'Cannot find module']
for (const pattern of FATAL_PATTERNS) {
  if (stderr.includes(pattern)) {
    console.error(`[smoke] FAIL: stderr 包含 "${pattern}"`)
    console.error('[smoke] stderr:', stderr)
    process.exit(1)
  }
}
console.log('[smoke] stderr 无致命错误 ✓')

// 9. 清理 smoke 数据目录
try {
  if (existsSync(SMOKE_DATA_DIR)) rmSync(SMOKE_DATA_DIR, { recursive: true, force: true })
} catch {
  // 清理失败不阻断
}

console.log('')
console.log('[smoke] 全部断言通过')
process.exit(0)
