// UI E2E（模拟证据·组件行为验证）：验证预览 Dialog 组件行为（IPC 取图/翻页/缩放/错误态）。
// 注意：证据资产由测试注入（模拟渲染完成状态），非正式 renderJobEvidence 产物——
// 真实 PDF 正式管线验证见 source-pdf-pipeline.e2e.test.ts。
// 不使用真实用户 PDF、不依赖外部网络与已安装 OCR 模型（文字层 PDF 走 markitdown 直转管线；
// 证据图片由测试内直接写入 job evidence/ 目录模拟渲染完成状态）。
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Page } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeApp, dumpE2EArtifacts, launchApp, removeTempDataDir, type AppHandle } from './helpers'

let app: AppHandle | undefined

async function dump(name: string, page: Page | undefined): Promise<void> {
  if (!page) return
  try {
    const safe = name.replace(/[\\/:*?"<>|]/g, '_')
    mkdirSync('e2e-artifacts', { recursive: true })
    await page.screenshot({ path: join('e2e-artifacts', `${safe}.png`), fullPage: true })
  } catch {
    /* 转储失败不影响原始异常 */
  }
}

describe('来源页预览 UI E2E（模拟证据·组件行为）', () => {
  beforeAll(async () => {
    // 动态生成夹具（.md 直转与 PDF 文字层管线一致；证据图片由测试注入模拟渲染完成）
    const fixtureDir = join('C:/Users/ngh/AppData/Local/Temp', 'tizhou-e2e-preview-src')
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(join(fixtureDir, '双页题本.md'), twoPageMarkdown(), 'utf8')
    writeFileSync(join(fixtureDir, '解析.md'), solutionMarkdown(), 'utf8')
    app = await launchApp()
  })
  afterAll(async () => {
    if (app) {
      const dataDir = app.dataDir
      await closeApp(app)
      await removeTempDataDir(dataDir)
    }
  })

  it('导入 → 审核产物 → 来源页预览（图/页码/翻页/错误态）', async () => {
    if (!app) throw new Error('app 未启动')
    const page = app.page
    try {
      // 1. 导入动态 .md 源（与 PDF 文字直转同一管线）
      await page.getByRole('link', { name: '知识库工坊' }).click()
      const sourceDir = join('C:/Users/ngh/AppData/Local/Temp', 'tizhou-e2e-preview-src')
      await page.getByLabel('原料目录').fill(sourceDir)
      await page.getByRole('button', { name: '扫描' }).click()
      await page.getByText('可转换文件').waitFor({ timeout: 30_000 })
      await page.getByRole('button', { name: '全选' }).click()
      await page.getByTestId('rights-confirm').click()
      await page.getByRole('button', { name: '开始导入' }).click()

      // 2. 等待审核产物
      await page
        .getByText(/待审核|已切出|直导完成/)
        .first()
        .waitFor({ timeout: 120_000 })

      // 3. 断言产物存在（列表第一条）
      const firstArtifact = page.getByTestId('builder-artifact-select').first()
      await firstArtifact.waitFor({ timeout: 30_000 })

      // 4. 注入证据资产（模拟渲染完成）：在 Node 侧直接写文件（不经 evaluate 注入）
      const dataRoot = app.dataDir
      const injectEvidence = await import('node:fs')
      const nodePathMod = await import('node:path')
      const nodeCrypto = await import('node:crypto')
      {
        const fs = injectEvidence
        const nodePath = nodePathMod
        const crypto = nodeCrypto
        const jobsDir = nodePath.join(dataRoot, 'knowledge-builder', 'jobs')
        const jobs = fs.readdirSync(jobsDir).filter((n: string) => n.startsWith('kbjob-'))
        const jobDir = nodePath.join(jobsDir, jobs[jobs.length - 1] ?? '')
        const evidenceDir = nodePath.join(jobDir, 'evidence', 'd1')
        fs.mkdirSync(evidenceDir, { recursive: true })
        // 最小 JPEG（SOI/EOI + 最小数据）
        fs.writeFileSync(
          nodePath.join(evidenceDir, 'evidence-p1.jpg'),
          Buffer.from(
            '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzM//AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A9/oooooA//9k=',
            'base64'
          )
        )
        // 与 source-evidence.evidenceAssetId 相同的哈希规则
        const assetId =
          'ev-' + crypto.createHash('sha256').update('src1#p1').digest('hex').slice(0, 20)
        fs.writeFileSync(
          nodePath.join(jobDir, 'evidence', 'index.json'),
          JSON.stringify({ [assetId]: 'd1/evidence-p1.jpg' })
        )
        // 给第一个产物补 sourceEvidence（管线在 .md 直转下为 unavailable——测试注入
        // available 形态以验证 UI 行为；真实 PDF 路径由管线自然产生）
        const artifactsDir = nodePath.join(jobDir, 'artifacts')
        const files = fs.readdirSync(artifactsDir).filter((n: string) => n.endsWith('.json'))
        if (files.length > 0) {
          const artifactPath = nodePath.join(artifactsDir, files[0]!)
          const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
          artifact.sourceEvidence = {
            status: 'available',
            references: [
              {
                role: 'question',
                sourceId: 'src1',
                relativePath: '双页题本.md',
                pages: [
                  { pageNumber: 1, mapping: 'exact', evidenceAssetId: assetId },
                  { pageNumber: 2, mapping: 'exact' }
                ]
              }
            ]
          }
          fs.writeFileSync(artifactPath, JSON.stringify(artifact))
        }
      }

      // 5. 重新加载页面拿注入后的产物（导航刷新状态）
      await page.reload()
      await page.getByRole('link', { name: '知识库工坊' }).click()
      await page.getByTestId('builder-artifact-select').first().waitFor({ timeout: 30_000 })

      // 6. 断言来源页显示
      const sourceLabel = page.getByText(/来源.*第.*页/)
      await sourceLabel.first().waitFor({ timeout: 15_000 })

      // 7. 点击来源预览按钮
      const previewButton = page.getByTestId('source-preview-button').first()
      await previewButton.waitFor({ timeout: 15_000 })
      await previewButton.click()

      // 8. 断言预览图片非空（IPC 取 dataUrl 成功）
      await page.getByTestId('source-preview-image').waitFor({ timeout: 15_000 })
      const imageVisible = await page.getByTestId('source-preview-image').isVisible()
      expect(imageVisible).toBe(true)
      const pageBadge = page.getByTestId('source-preview-page')
      await pageBadge.waitFor({ timeout: 10_000 })
      expect(await pageBadge.textContent()).toContain('第1页')

      // 9. 切换下一页 → 页码变化 + 该页无 assetId → 显示明确错误（不空白）
      await page.getByRole('button', { name: '下一页' }).click()
      await page.getByTestId('source-preview-error').waitFor({ timeout: 15_000 })
      expect(await page.getByTestId('source-preview-error').textContent()).toContain(
        '证据图片不可用'
      )

      // 10. 回上一页恢复图片，缩放后关闭
      await page.getByRole('button', { name: '上一页' }).click()
      await page.getByTestId('source-preview-image').waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: '放大' }).click()
      await page.getByRole('button', { name: '关闭' }).click()
      await page.getByTestId('source-preview-image').waitFor({ state: 'detached', timeout: 10_000 })

      // 11. 键盘语义：焦点在标题选择按钮上按 Enter 打开产物
      const selectButton = page.getByTestId('builder-artifact-select').first()
      // 记录目标产物标题（按钮内 strong 文本）
      const targetTitle = await selectButton.locator('strong').textContent()
      expect(targetTitle).toBeTruthy()
      await selectButton.focus()
      await selectButton.press('Enter')
      await page.waitForTimeout(1_000)
      // 打开的产物标题必须与目标一致（不是仅检查面板有内容）
      const previewPanelText = await page
        .locator('.builder-artifact-preview')
        .innerText()
        .catch(() => '')
      expect(previewPanelText.length).toBeGreaterThan(10)
      expect(previewPanelText).toContain(targetTitle!.slice(0, 10))

      // 12. 来源预览按钮与标题按钮是独立元素（同级，非嵌套）
      const buttonTagNames = await page
        .getByTestId('builder-artifact-item')
        .first()
        .locator('button')
        .evaluateAll((buttons) =>
          buttons.map((btn) => ({
            tag: btn.tagName,
            testid: btn.getAttribute('data-testid'),
            parentTag: btn.parentElement?.tagName
          }))
        )
      // 所有 button 的父元素都不是 button（无嵌套）
      for (const info of buttonTagNames) {
        expect(info.parentTag).not.toBe('BUTTON')
      }

      // 13. DOM 中不存在 button 嵌套 button
      const nestedButtons = await page
        .getByTestId('builder-artifact-item')
        .first()
        .locator('button button')
        .count()
      expect(nestedButtons).toBe(0)
    } catch (error) {
      onTestFailed(async () => {
        await dump('来源页预览', app?.page)
      })
      throw error
    }
  })
}, 300_000)

function twoPageMarkdown(): string {
  return (
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
    ].join('\n') + '\n'
  )
}

function solutionMarkdown(): string {
  return (
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
    ].join('\n') + '\n'
  )
}
