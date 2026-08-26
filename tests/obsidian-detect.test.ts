import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectedObsidian } from '../src/main/services/obsidian-detect'

describe('detectedObsidian', () => {
  let directory: string
  const savedEnv: Record<string, string | undefined> = {}

  const envKeys = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'USERPROFILE'] as const

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-obsidian-detect-'))
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    rmSync(directory, { recursive: true, force: true })
  })

  function plant(root: string, relative: string): string {
    const executable = join(root, relative)
    mkdirSync(join(executable, '..'), { recursive: true })
    writeFileSync(executable, 'stub')
    return executable
  }

  it('检测官方安装器默认的当前用户目录', () => {
    const executable = plant(directory, 'Programs/Obsidian/Obsidian.exe')
    process.env.LOCALAPPDATA = directory
    expect(detectedObsidian()).toBe(executable)
  })

  it('检测 Microsoft Store 版执行别名', () => {
    const executable = plant(directory, 'Microsoft/WindowsApps/Obsidian.exe')
    process.env.LOCALAPPDATA = directory
    expect(detectedObsidian()).toBe(executable)
  })

  it('检测全机安装目录（Program Files）', () => {
    const executable = plant(directory, 'Obsidian/Obsidian.exe')
    process.env.PROGRAMFILES = directory
    expect(detectedObsidian()).toBe(executable)
  })

  it('检测 Scoop 安装目录', () => {
    const executable = plant(directory, 'scoop/apps/obsidian/current/Obsidian.exe')
    process.env.USERPROFILE = directory
    expect(detectedObsidian()).toBe(executable)
  })

  it('候选同时存在时优先官方默认目录', () => {
    const official = plant(directory, 'Programs/Obsidian/Obsidian.exe')
    plant(directory, 'Microsoft/WindowsApps/Obsidian.exe')
    process.env.LOCALAPPDATA = directory
    expect(detectedObsidian()).toBe(official)
  })

  it('所有位置都不存在时返回空字符串', () => {
    process.env.LOCALAPPDATA = directory
    process.env.PROGRAMFILES = directory
    process.env.USERPROFILE = directory
    expect(detectedObsidian()).toBe('')
  })

  it('环境变量缺失时不抛错并返回空字符串', () => {
    expect(() => detectedObsidian()).not.toThrow()
  })
})
