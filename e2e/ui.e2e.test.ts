// UI E2E：真实 Electron 实例 + 临时数据目录 + mock updater。
// 覆盖：启动/导航、模考全流程、保存失败阻止交卷、申论草稿（跨重启持久化）、
// 报告、备份/迁移入口、更新检查状态、错误边界。
// 顺序无关：每个 describe 通过 beforeAll 创建自己的应用实例与数据目录，
// 任意用例都可以用 -t 单独运行；失败统一转储截图与页面 HTML。
// 不调用真实 AI、不访问真实更新服务、不依赖本机已有数据库。
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Page } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  closeApp,
  dumpE2EArtifacts,
  launchApp,
  launchSeededExamApp,
  removeTempDataDir,
  waitForQuestionAndAnswer,
  type AppHandle
} from './helpers'

let app: AppHandle | undefined
/** 当前套件内是否有用例失败：失败时保留临时数据目录供诊断 */
let failedInCurrentSuite = false

async function useApp(handle: AppHandle): Promise<Page> {
  app = handle
  return handle.page
}

async function closeCurrent(): Promise<void> {
  if (!app) return
  await closeApp(app)
  app = undefined
}

/** 套件收尾：关闭应用后清理 tizhou-e2e-* 临时数据目录（失败时保留并输出路径） */
async function closeCurrentAndClean(): Promise<void> {
  const dataDir = app?.dataDir
  await closeCurrent()
  app = undefined
  if (!dataDir) return
  if (failedInCurrentSuite) {
    console.error(`[e2e] 用例失败，保留数据目录供诊断：${dataDir}`)
    failedInCurrentSuite = false
    return
  }
  await removeTempDataDir(dataDir)
}

/** 统一用例包装：onTestFailed 异步等待失败转储（截图 + 页面 HTML），不覆盖原始异常 */
function itE2E(name: string, fn: (page: Page) => Promise<void>): void {
  it(
    name,
    async () => {
      onTestFailed(async () => {
        failedInCurrentSuite = true
        await dumpE2EArtifacts(app?.page, name)
      })
      await fn(app!.page)
    },
    180_000
  )
}

describe('启动、导航与全局功能', () => {
  beforeAll(async () => {
    app = await launchApp()
  })
  afterAll(async () => {
    await closeCurrentAndClean()
  })

  itE2E('应用启动并显示工作台，侧栏导航与路由切换可用', async (page) => {
    await page.getByRole('link', { name: '专项练习' }).click()
    expect(page.url()).toContain('/practice')
    await page.getByRole('link', { name: '模拟考试' }).click()
    expect(page.url()).toContain('/exam')
    await page.getByRole('link', { name: '知识库工坊' }).click()
    expect(page.url()).toContain('/knowledge-builder')
    await page.getByRole('link', { name: '今日工作台' }).click()
    expect(page.url()).not.toContain('/exam')
  })

  itE2E('申论页面：草稿输入、保存，重启后持久化', async () => {
    // 注意：重启后必须从 app 取新页——旧 page 已随应用关闭
    let page = app!.page
    await page.getByRole('link', { name: '申论作答' }).click()
    let draft = page.getByTestId('shenlun-draft-input')
    await draft.waitFor({ timeout: 30_000 })
    await draft.fill('E2E 申论草稿：第一，明确观点；第二，给出论据；第三，总结提升。')
    await page.getByRole('button', { name: '保存草稿' }).click()
    await page.getByText('保存中').waitFor({ state: 'hidden', timeout: 30_000 })

    // 关闭应用后用同一临时数据目录重启：草稿从数据库恢复（持久化证据）
    const dataDir = app.dataDir
    await closeCurrent()
    // Windows 下句柄释放有延迟：稍候再重启，避免 SQLite 锁冲突
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    app = await launchApp({ dataDir })
    page = app.page
    await page.getByRole('link', { name: '申论作答' }).click()
    draft = page.getByTestId('shenlun-draft-input')
    await draft.waitFor({ timeout: 30_000 })
    const restoredValue = await draft.inputValue()
    expect(restoredValue).toMatch(/E2E 申论草稿/)
  })

  itE2E('报告页加载并展示核心数据', async (page) => {
    await page.getByRole('link', { name: '学习报告' }).click()
    expect(page.url()).toContain('/reports')
    await page.getByText('学习报告').first().waitFor({ timeout: 30_000 })
  })

  itE2E('备份与迁移入口：设置页可见且可用', async (page) => {
    await page.getByRole('link', { name: '应用设置' }).click()
    // 备份设置（自动备份开关 + 保留数量）
    await page.getByText('保留备份数量').waitFor({ timeout: 30_000 })
    // 迁移入口：导出迁移包按钮
    await page
      .getByRole('button', { name: /导出迁移包|导出/ })
      .first()
      .waitFor({ timeout: 30_000 })
  })

  itE2E('更新检查：无更新时提示最新版本并显示更新源', async (page) => {
    const messages: string[] = []
    page.on('dialog', (dialog) => {
      messages.push(dialog.message())
      void dialog.accept()
    })
    await page.getByRole('button', { name: '检查更新' }).click()
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const latest = messages.join('\n')
    expect(latest).toContain('当前已是最新版本')
    expect(latest).toContain('更新源：GitHub')
  })

  itE2E('页面渲染崩溃：错误边界显示，侧栏仍可用，可重新加载', async (page) => {
    await page.getByRole('link', { name: '今日工作台' }).click()
    await page.getByTestId('e2e-crash').click()
    await page.getByText('页面加载失败').waitFor({ timeout: 30_000 })
    // 侧栏仍然可用
    await page.getByRole('link', { name: '模拟考试' }).click()
    expect(page.url()).toContain('/exam')
    // 回到仪表盘：错误边界复位
    await page.getByRole('link', { name: '今日工作台' }).click()
    await page.getByTestId('e2e-crash').waitFor({ timeout: 30_000 })
  })
})

describe('模考全流程（独立种子题库，正常保存）', () => {
  beforeAll(async () => {
    app = await launchSeededExamApp()
  })
  afterAll(async () => {
    await closeCurrentAndClean()
  })

  itE2E('创建模考 → 逐题作答（客观/申论自动识别）→ 交卷 → 结果页', async (page) => {
    await page.getByRole('link', { name: '模拟考试' }).click()
    await page.getByRole('button', { name: '创建并开始' }).click()
    await page.getByTestId('exam-submit').waitFor({ timeout: 60_000 })

    // 逐题作答：题目类型由 waitForQuestionAndAnswer 判定，不依赖出现顺序
    for (let question = 0; question < 30; question += 1) {
      const kind = await waitForQuestionAndAnswer(page)
      if (kind === 'objective') {
        await page.getByTestId('exam-option-A').click()
      } else {
        const essay = page.getByTestId('exam-essay-input')
        await essay.fill(`E2E 申论作答（第 ${question + 1} 题）`)
        // 等待 600ms 防抖自动保存触发完成
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      const next = page.getByRole('button', { name: '下一题' })
      if (await next.isDisabled()) break
      await next.click()
    }

    // 交卷：等待客观题与申论的挂起保存全部落盘
    await page.getByTestId('exam-submit').click()
    await page.getByRole('button', { name: '确认交卷' }).click()
    await page.waitForURL(/\/exam\/result\//, { timeout: 60_000 })
    expect(page.url()).toContain('/exam/result/')
  })
})

describe('模考（保存失败阻止交卷，重试后放行）', () => {
  beforeAll(async () => {
    app = await launchSeededExamApp({ failSaveOnce: true })
  })
  afterAll(async () => {
    await closeCurrentAndClean()
  })

  itE2E('首次交卷被阻止并自动重试，再次交卷成功', async (page) => {
    await page.getByRole('link', { name: '模拟考试' }).click()
    await page.getByRole('button', { name: '创建并开始' }).click()
    // 显式等待首题加载：客观/申论都可（保存失败注入与题型无关）
    const kind = await waitForQuestionAndAnswer(page)
    if (kind === 'objective') {
      await page.getByTestId('exam-option-A').click()
    } else {
      await page.getByTestId('exam-essay-input').fill('E2E 申论作答内容（首题）')
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    await page.getByTestId('exam-submit').click()
    await page.getByRole('button', { name: '确认交卷' }).click()
    // 交卷被阻止：drain 发现失败 → 自动重试 → 提示稍后再次交卷
    await page.getByText('尚未保存成功，已自动重试').waitFor({ timeout: 30_000 })
    expect(page.url()).not.toContain('/exam/result/')

    // 再次交卷：重试已成功，放行
    await page.getByTestId('exam-submit').click()
    await page.getByRole('button', { name: '确认交卷' }).click()
    await page.waitForURL(/\/exam\/result\//, { timeout: 60_000 })
  })
})

describe('更新检查状态：无更新', () => {
  beforeAll(async () => {
    app = await launchApp()
  })
  afterAll(async () => {
    await closeCurrentAndClean()
  })
  itE2E('提示最新版本并显示更新源', async (page) => {
    const messages: string[] = []
    page.on('dialog', (dialog) => {
      messages.push(dialog.message())
      void dialog.accept()
    })
    await page.getByRole('button', { name: '检查更新' }).click()
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const latest = messages.join('\n')
    expect(latest).toContain('当前已是最新版本')
    expect(latest).toContain('更新源：GitHub')
  })
})

describe('更新检查状态：有更新（发现 → 下载 → 安装提示）', () => {
  beforeAll(async () => {
    app = await launchApp({ updateScenario: 'available' })
  })
  afterAll(async () => {
    await closeCurrentAndClean()
  })
  itE2E('完整事件链提示', async (page) => {
    const messages: string[] = []
    page.on('dialog', (dialog) => {
      messages.push(dialog.message())
      void dialog.accept()
    })
    await page.getByRole('button', { name: '检查更新' }).click()
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(messages.some((message) => message.includes('发现新版本 9.9.9'))).toBe(true)
    expect(messages.some((message) => message.includes('更新已下载完成'))).toBe(true)
  })
})

describe('更新检查状态：检查失败', () => {
  beforeAll(async () => {
    app = await launchApp({ updateScenario: 'error' })
  })
  afterAll(async () => {
    await closeCurrentAndClean()
  })
  itE2E('明确错误提示', async (page) => {
    const messages: string[] = []
    page.on('dialog', (dialog) => {
      messages.push(dialog.message())
      void dialog.accept()
    })
    await page.getByRole('button', { name: '检查更新' }).click()
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(messages.some((message) => message.includes('检查更新失败'))).toBe(true)
    expect(messages.some((message) => message.includes('模拟更新服务不可用'))).toBe(true)
  })
})
