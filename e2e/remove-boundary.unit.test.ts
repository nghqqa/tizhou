// removeTempDataDir 删除边界：包含校验、前缀、链接/junction、幂等
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDataDir } from './helpers'

describe('removeTempDataDir 删除边界', () => {
  it('真实 mkdtemp 创建的 tizhou-e2e-* 目录可删除，且可重复清理（幂等）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tizhou-e2e-unit-'))
    expect(existsSync(dir)).toBe(true)
    await removeTempDataDir(dir)
    expect(existsSync(dir)).toBe(false)
    // 幂等：目标不存在时再次清理不抛错
    await expect(removeTempDataDir(dir)).resolves.toBeUndefined()
  })

  it('临时目录之外的同前缀目录被拒绝', async () => {
    const outside = join(process.cwd(), 'e2e-artifacts', 'tizhou-e2e-outside')
    mkdirSync(outside, { recursive: true })
    await expect(removeTempDataDir(outside)).rejects.toThrow(/临时目录之外/)
    // 手工清理测试目录
    rmSync(outside, { recursive: true, force: true })
  })

  it('系统临时目录根本身被拒绝', async () => {
    await expect(removeTempDataDir(tmpdir())).rejects.toThrow(/临时目录之外|非 E2E 临时目录/)
  })

  it('普通目录名（无 tizhou-e2e- 前缀）被拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-unit-'))
    await expect(removeTempDataDir(dir)).rejects.toThrow(/非 E2E 临时目录/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('包含 .. 段的路径被拒绝', async () => {
    const dir = tmpdir() + '\\tizhou-e2e-x\\..\\tizhou-e2e-y'
    await expect(removeTempDataDir(dir)).rejects.toThrow(/\.\./)
  })

  it('junction 链接只移除链接本身，不递归跟随真实目标', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'tizhou-e2e-real-'))
    writeFileSync(join(realDir, 'keep.txt'), 'keep', 'utf8')
    const link = join(tmpdir(), 'tizhou-e2e-junction-link')
    symlinkSync(realDir, link, 'junction')
    await removeTempDataDir(link)
    // 链接已移除；真实目标内容完好（未被跟随删除）
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(realDir, 'keep.txt'))).toBe(true)
    rmSync(realDir, { recursive: true, force: true })
  })
})
