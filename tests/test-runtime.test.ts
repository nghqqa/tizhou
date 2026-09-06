// 测试运行时判定：--smoke-test 与 WORKBENCH_E2E 的启用边界
import { describe, expect, it } from 'vitest'
import { resolveTestRuntime } from '../src/main/services/test-runtime'

const PACKAGED = { isPackaged: true, argv: ['tizhou.exe'] as string[] }
const UNPACKAGED = { isPackaged: false, argv: ['electron', '.'] as string[] }

describe('resolveTestRuntime', () => {
  it('正式包 + WORKBENCH_E2E：E2E 注入不生效（能力边界）', () => {
    const flags = resolveTestRuntime({
      ...PACKAGED,
      env: { WORKBENCH_E2E: '1' }
    })
    expect(flags.isE2EMode).toBe(false)
    expect(flags.isTestRuntime).toBe(false)
    expect(flags.dataDirOverride).toBeUndefined()
  })

  it('开发态 + WORKBENCH_E2E：E2E 注入生效', () => {
    const flags = resolveTestRuntime({
      ...UNPACKAGED,
      env: { WORKBENCH_E2E: '1' }
    })
    expect(flags.isE2EMode).toBe(true)
    expect(flags.isTestRuntime).toBe(true)
  })

  it('打包版 + --smoke-test：打包冒烟可用', () => {
    const flags = resolveTestRuntime({
      ...PACKAGED,
      argv: ['tizhou.exe', '--smoke-test']
    })
    expect(flags.isSmokeTest).toBe(true)
    expect(flags.isE2EMode).toBe(false)
    expect(flags.isTestRuntime).toBe(true)
  })

  it('正式启动 + WORKBENCH_SMOKE_DATA_DIR：不改变数据目录', () => {
    const flags = resolveTestRuntime({
      ...PACKAGED,
      env: { WORKBENCH_SMOKE_DATA_DIR: 'C:/临时/数据目录' }
    })
    expect(flags.isSmokeTest).toBe(false)
    expect(flags.isTestRuntime).toBe(false)
    expect(flags.dataDirOverride).toBeUndefined()
  })

  it('冒烟运行时下 WORKBENCH_SMOKE_DATA_DIR 才提供数据目录覆盖', () => {
    const flags = resolveTestRuntime({
      ...PACKAGED,
      argv: ['tizhou.exe', '--smoke-test'],
      env: { WORKBENCH_SMOKE_DATA_DIR: 'C:/临时/数据目录' }
    })
    expect(flags.dataDirOverride).toBeDefined()
    expect(flags.dataDirOverride).toContain('数据目录')
  })
})
