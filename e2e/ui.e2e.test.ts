// UI E2E：真实 Electron 实例 + 临时数据目录 + mock updater。
// 覆盖：启动/导航、模考全流程、保存失败阻止交卷、申论草稿、报告、备份入口、
// 更新检查状态、错误边界。
// 不调用真实 AI、不访问真实更新服务、不依赖本机已有数据库。
import { afterAll, afterEach, describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeApp, launchApp, seedQuestions, type AppHandle } from './helpers'

let app: AppHandle
let seededDataDir: string

describe('启动、导航与全局功能', () => {
  beforeEach(() => {
    // 各用例自带起始导航；此处不做全局点击，避免与用例导航竞态
  })

  it('应用启动并显示工作台，侧栏导航与路由切换可用', async () => {
    app = await launchApp()
    const { page } = app
    // 侧栏导航到几个核心页面并断言路由变化
    await page.getByRole('link', { name: '专项练习' }).click()
    expect(page.url()).toContain('/practice')
    await page.getByRole('link', { name: '模拟考试' }).click()
    expect(page.url()).toContain('/exam')
    await page.getByRole('link', { name: '知识库工坊' }).click()
    expect(page.url()).toContain('/knowledge-builder')
    await page.getByRole('link', { name: '今日工作台' }).click()
    expect(page.url()).not.toContain('/exam')
  })

  it('申论页面：草稿输入与保存', async () => {
    const { page } = app
    await page.getByRole('link', { name: '申论作答' }).click()
    const draft = page.getByPlaceholder(
      '建议先列要点，再组织成完整答案。草稿会在停止输入后自动保存。'
    )
    await draft.waitFor({ timeout: 30_000 })
    await draft.fill('E2E 申论草稿：第一，明确观点；第二，给出论据；第三，总结提升。')
    await page.getByRole('button', { name: '保存草稿' }).click()
    await page.getByText('保存中').waitFor({ state: 'hidden', timeout: 30_000 })
    const draftValue = await draft.inputValue()
    expect(draftValue).toMatch(/E2E 申论草稿/)
  })

  it('报告页加载并展示核心数据', async () => {
    const { page } = app
    await page.getByRole('link', { name: '学习报告' }).click()
    expect(page.url()).toContain('/reports')
    await page.getByText('学习报告').first().waitFor({ timeout: 30_000 })
  })

  it('备份与迁移入口：设置页可见且可用', async () => {
    const { page } = app
    try {
      await page.getByRole('link', { name: '应用设置' }).click()
      // 备份设置（自动备份开关 + 保留数量）
      await page.getByText('保留备份数量').waitFor({ timeout: 30_000 })
      // 迁移入口：导出迁移包按钮
      await page
        .getByRole('button', { name: /导出迁移包|导出/ })
        .first()
        .waitFor({ timeout: 30_000 })
    } catch {
      const html = await page.content()
      writeFileSync('e2e-artifacts/设置页.html', html, 'utf8')
      throw new Error('设置页未出现「保留备份数量」，已转储 e2e-artifacts/设置页.html')
    }
  })

  it('更新检查：无更新时提示最新版本并显示更新源', async () => {
    const { page } = app
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

  it('页面渲染崩溃：错误边界显示，侧栏仍可用，可重新加载', async () => {
    const { page } = app
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

  afterAll(async () => {
    if (app) {
      seededDataDir = app.dataDir
      await closeApp(app)
    }
  })
})

describe('模考全流程（正常保存，种子题库）', () => {
  it('创建模考 → 逐题作答（含申论）→ 交卷 → 结果页', async () => {
    // 种子：基于第一个实例的数据目录（应用已建库建表）
    expect(seededDataDir).toBeTruthy()
    expect(seedQuestions(seededDataDir)).toBe(21)

    app = await launchApp({ dataDir: seededDataDir })
    const { page } = app
    await page.getByRole('link', { name: '模拟考试' }).click()
    await page.getByRole('button', { name: '创建并开始' }).click()
    // 进入答题页
    await page.getByTestId('exam-submit').waitFor({ timeout: 60_000 })

    // 逐题作答：客观题点 A，申论题填草稿；「下一题」禁用即最后一题，转交卷
    for (let question = 0; question < 30; question += 1) {
      const optionA = page.getByTestId('exam-option-A')
      if (await optionA.count()) {
        await optionA.first().click()
      } else {
        const textarea = page.getByPlaceholder(
          '建议先列要点，再组织成完整答案。草稿会在停止输入后自动保存。'
        )
        if (await textarea.count())
          await textarea.first().fill(`E2E 申论作答（第 ${question + 1} 题）`)
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

  afterAll(async () => {
    if (app) await closeApp(app)
  })
})

describe('模考（保存失败阻止交卷，重试后放行）', () => {
  it('首次交卷被阻止并自动重试，再次交卷成功', async (ctx) => {
    // 复用同一数据目录（题库已种子化）；WORKBENCH_E2E_FAIL_SAVE=once 使首次保存失败
    app = await launchApp({ dataDir: seededDataDir, failSaveOnce: true })
    const { page } = app
    try {
      await page.getByRole('link', { name: '模拟考试' }).click()
      await page.getByRole('button', { name: '创建并开始' }).click()
      await page.getByTestId('exam-submit').waitFor({ timeout: 60_000 })

      // 只答第一题（其余留空也可交卷）：首次保存注入失败
      await page.getByTestId('exam-option-A').click()
      await page.getByTestId('exam-submit').click()
      await page.getByRole('button', { name: '确认交卷' }).click()
      // 交卷被阻止：drain 发现失败 → 自动重试 → 提示稍后再次交卷
      await page.getByText('尚未保存成功，已自动重试').waitFor({ timeout: 30_000 })
      expect(page.url()).not.toContain('/exam/result/')

      // 再次交卷：重试已成功，放行
      await page.getByTestId('exam-submit').click()
      await page.getByRole('button', { name: '确认交卷' }).click()
      await page.waitForURL(/\/exam\/result\//, { timeout: 60_000 })
    } catch (error) {
      await dumpFailure('保存失败-首次交卷', page)
      throw error
    }
  })

  afterEach(async () => {
    if (app) await closeApp(app)
  })
})

// 失败现场转储：截图 + 页面文本，写入 e2e-artifacts/
async function dumpFailure(name: string, page: import('playwright').Page): Promise<void> {
  try {
    const safe = name.replace(/[\\/:*?"<>|]/g, '_')
    const dir = 'e2e-artifacts'
    mkdirSync(dir, { recursive: true })
    await page.screenshot({ path: join(dir, `${safe}.png`), fullPage: true })
    writeFileSync(join(dir, `${name}.html`), await page.content(), 'utf8')
    console.error(`[e2e 失败现场] ${dir}/${name}.png`)
  } catch {
    /* 转储失败不影响原错误 */
  }
}

describe('更新检查状态（mock updater 场景）', () => {
  it('有更新：提示发现新版本 → 下载 → 提示安装', async () => {
    app = await launchApp({ updateScenario: 'available' })
    const { page } = app
    const messages: string[] = []
    page.on('dialog', (dialog) => {
      messages.push(dialog.message())
      void dialog.accept()
    })
    await page.getByRole('button', { name: '检查更新' }).click()
    // 事件链：发现新版本 → 确认下载 → 下载完成 → 确认安装（mock 不做真实安装）
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(messages.some((message) => message.includes('发现新版本 9.9.9'))).toBe(true)
    expect(messages.some((message) => message.includes('更新已下载完成'))).toBe(true)
  })

  it('检查失败：明确错误提示', async () => {
    app = await launchApp({ updateScenario: 'error' })
    const { page } = app
    const messages: string[] = []
    page.on('dialog', (dialog) => {
      messages.push(dialog.message())
      void dialog.accept()
    })
    await page.getByRole('button', { name: '检查更新' }).click()
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(messages.some((message) => message.includes('检查更新失败'))).toBe(true)
    expect(messages.some((message) => message.includes('模拟更新服务不可用'))).toBe(true)
  })

  afterEach(async () => {
    if (app) await closeApp(app)
  })
})
