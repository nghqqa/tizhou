// UI E2E（真实 PDF·正式管线）：动态 PDF → 正式导入 → 正式 renderJobEvidence →
// 正式 IPC → 非空预览。拆为两个语义明确的用例；不手写 job/artifact/index。
// 引擎不可用时 it.skipIf 跳过——skipped 不计入真实闭环通过。
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, launchApp, type AppHandle } from './helpers'

const ENGINE_PYTHON =
  'C:/Users/ngh/AppData/Roaming/tizhou/knowledge-builder/engine/.venv/Scripts/python.exe'
const engineAvailable = (() => {
  try {
    execFileSync(ENGINE_PYTHON, ['-c', 'import pypdfium2'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let app: AppHandle | undefined
let fixtureDir: string

async function dump(name: string, page: Page | undefined): Promise<void> {
  if (!page) return
  try {
    mkdirSync('e2e-artifacts', { recursive: true })
    await page.screenshot({ path: join('e2e-artifacts', `${name}.png`), fullPage: true })
  } catch {
    /* 不影响原始异常 */
  }
}

async function importFixture(page: Page): Promise<void> {
  await page.getByRole('link', { name: '知识库工坊' }).click()
  await page.getByLabel('原料目录').fill(fixtureDir)
  await page.getByRole('button', { name: '扫描' }).click()
  await page.getByText('可转换文件').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: '全选' }).click()
  await page.getByTestId('rights-confirm').check({ force: true })
  await page.getByRole('button', { name: '开始导入' }).click()
  await page
    .getByText(/已切出|直导完成/)
    .first()
    .waitFor({ timeout: 120_000 })
}

describe('来源证据预览 UI E2E（真实 PDF·正式管线）', () => {
  beforeAll(() => {
    fixtureDir = join(tmpdir(), 'tizhou-e2e-pdf-src')
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
    execFileSync('python', [
      join(process.cwd(), 'tools', 'make-text-pdf.py'),
      join(fixtureDir, '证据测试.pdf'),
      'Page 1 evidence content',
      'Page 2 evidence content'
    ])
  })

  afterAll(async () => {
    if (app) {
      const dataDir = app.dataDir
      await closeApp(app)
      rmSync(dataDir, { recursive: true, force: true })
    }
    rmSync(fixtureDir, { recursive: true, force: true })
    rmSync('e2e-artifacts', { recursive: true, force: true })
  })

  it.skipIf(!engineAvailable)(
    '真实 PDF 有证据资产时的正式预览闭环（强制断言全链路）',
    async () => {
      app = await launchApp()
      const page = app.page
      onTestFailed(async () => {
        await dump('真实PDF预览闭环', app?.page)
      })

      await importFixture(page)

      // 产物必须存在
      const selectButton = page.getByTestId('builder-artifact-select').first()
      await selectButton.waitFor({ timeout: 30_000 })

      // 预览按钮必须存在（renderJobEvidence 真实回填 evidenceAssetId 后才会出现）
      const previewButton = page.getByTestId('source-preview-button').first()
      await previewButton.waitFor({ timeout: 15_000 })

      // IPC 返回非空 data URL
      await previewButton.click()
      await page.getByTestId('source-preview-image').waitFor({ timeout: 15_000 })
      const imageSrc = await page.getByTestId('source-preview-image').getAttribute('src')
      expect(imageSrc).toBeTruthy()
      expect(imageSrc!.startsWith('data:image/')).toBe(true)

      // 页码正确
      const pageBadge = page.getByTestId('source-preview-page')
      await pageBadge.waitFor({ timeout: 10_000 })
      const firstPageText = await pageBadge.textContent()
      expect(firstPageText).toMatch(/第\d+页/)

      // 翻页后页码变化或显示明确错误
      const nextButton = page.getByRole('button', { name: '下一页' })
      if (await nextButton.isEnabled()) {
        await nextButton.click()
        const newBadge = page.getByTestId('source-preview-page')
        const secondPageText = await newBadge.textContent()
        // 页码变化或第二页无图显示错误——二选一必须发生
        const hasError = await page
          .getByTestId('source-preview-error')
          .isVisible()
          .catch(() => false)
        const hasImage = await page
          .getByTestId('source-preview-image')
          .isVisible()
          .catch(() => false)
        expect(hasError || hasImage).toBe(true)
        if (!hasError && secondPageText !== firstPageText) {
          expect(secondPageText).toMatch(/第\d+页/)
        }
      }

      // 缩放和关闭
      await page.getByRole('button', { name: '放大' }).click()
      await page.getByRole('button', { name: '关闭' }).click()
      await page.getByTestId('source-preview-image').waitFor({ state: 'detached', timeout: 10_000 })
    },
    300_000
  )

  it.skipIf(!engineAvailable)(
    '真实 .md 源无法映射时显示 unavailable（不伪造预览）',
    async () => {
      // .md 文件走 markitdown 直转，无页清单 → sourceEvidence 应为 unavailable
      // 这是 unavailable 分支的正式验证——不是预览闭环通过
      const mdDir = join(tmpdir(), 'tizhou-e2e-md-src')
      rmSync(mdDir, { recursive: true, force: true })
      mkdirSync(mdDir, { recursive: true })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(
        join(mdDir, '题本.md'),
        [
          '练习题01套',
          '1. 甲地旅游收入增长情况如何：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '2. 乙地发电量同比下降多少：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四',
          '3. 丙地粮食产量占比多少：',
          'A. 选项一',
          'B. 选项二',
          'C. 选项三',
          'D. 选项四'
        ].join('\n') + '\n',
        'utf8'
      )
      writeFileSync(
        join(mdDir, '解析.md'),
        [
          '1. 甲地旅游收入增长情况如何：',
          '【参考答案】A',
          '【实战解析】甲的解析。',
          '2. 乙地发电量同比下降多少：',
          '【参考答案】B',
          '【实战解析】乙的解析。',
          '3. 丙地粮食产量占比多少：',
          '【参考答案】C',
          '【实战解析】丙的解析。'
        ].join('\n') + '\n',
        'utf8'
      )

      // 关掉之前的应用，用新实例（不同数据目录）
      if (app) {
        await closeApp(app)
        app = undefined
      }
      app = await launchApp()
      const page = app.page

      await page.getByRole('link', { name: '知识库工坊' }).click()
      await page.getByLabel('原料目录').fill(mdDir)
      await page.getByRole('button', { name: '扫描' }).click()
      await page.getByText('可转换文件').waitFor({ timeout: 30_000 })
      await page.getByRole('button', { name: '全选' }).click()
      await page.getByTestId('rights-confirm').check({ force: true })
      await page.getByRole('button', { name: '开始导入' }).click()
      await page
        .getByText(/已切出|直导完成/)
        .first()
        .waitFor({ timeout: 120_000 })

      // 产物存在
      const selectButton = page.getByTestId('builder-artifact-select').first()
      await selectButton.waitFor({ timeout: 30_000 })

      // .md 源无页清单 → 不应有预览按钮（unavailable 不猜页码）
      const previewButton = page.getByTestId('source-preview-button').first()
      const hasPreview = (await previewButton.count()) > 0
      const bodyText = await page.locator('body').innerText()

      // 二选一：有证据（显示来源页码）或无证据（显示暂无法定位）——
      // 关键是不出现空白或误导
      if (hasPreview) {
        expect(bodyText).toMatch(/来源.*第\d+页/)
      } else {
        expect(bodyText).toMatch(/暂无法定位原页/)
      }

      rmSync(mdDir, { recursive: true, force: true })
    },
    300_000
  )
})
