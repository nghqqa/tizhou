// 测试运行时判定：集中定义 --smoke-test 与 WORKBENCH_E2E 两种测试模式的启用条件。
// 规则：
// - isSmokeTest：命令行包含 --smoke-test 即成立（打包版与开发态都可运行打包冒烟）
// - isE2EMode：仅「非打包实例 + WORKBENCH_E2E=1」同时满足——正式包永不启用 E2E 注入
// - WORKBENCH_SMOKE_DATA_DIR 只在 isTestRuntime（冒烟或 E2E）下生效，
//   正式包普通启动时单独设置该变量不会改变数据目录
import { resolve } from 'node:path'

export interface TestRuntimeInput {
  isPackaged: boolean
  argv: string[]
  env?: Record<string, string | undefined>
}

export interface TestRuntimeFlags {
  isSmokeTest: boolean
  isE2EMode: boolean
  isTestRuntime: boolean
  /** 仅测试运行时生效的数据目录覆盖；正式启动恒为 undefined */
  dataDirOverride?: string
}

export function resolveTestRuntime(input: TestRuntimeInput): TestRuntimeFlags {
  const isSmokeTest = input.argv.includes('--smoke-test')
  const isE2EMode = !input.isPackaged && input.env?.WORKBENCH_E2E === '1'
  const isTestRuntime = isSmokeTest || isE2EMode
  const override = input.env?.WORKBENCH_SMOKE_DATA_DIR
  const dataDirOverride = isTestRuntime && override ? resolve(override) : undefined
  return { isSmokeTest, isE2EMode, isTestRuntime, dataDirOverride }
}
