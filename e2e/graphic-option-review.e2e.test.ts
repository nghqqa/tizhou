// E2E：图形推理图片选项端到端渲染（OptionContent 经 vault.asset 取图）与模考逐题复盘。
// 种子方式：真实磁盘知识库（图片附件只能来自磁盘 vault，内置示例库是虚拟路径）——
// bootstrap 建库后注入 3 道 options 带 image 的图形推理题 + PNG 附件，再以该库为活动库启动。
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Page } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeApp,
  dumpE2EArtifacts,
  launchApp,
  removeTempDataDir,
  waitForQuestionAndAnswer,
  type AppHandle
} from './helpers'

// 1×1 透明 PNG：只需通过图片白名单与 dataUrl 渲染，不需要真实图形内容
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

const GRAPHIC_QUESTION_COUNT = 3

function graphicQuestionMarkdown(index: number): string {
  const option = (key: string): string =>
    `  - key: ${key}\n    text: ""\n    image: images/e2e-graphic-opt.png`
  return [
    '---',
    `id: e2e-graphic-${String(index).padStart(3, '0')}`,
    'subject: xingce',
    'category: 图形推理',
    'kind: question',
    'questionType: single',
    'difficulty: 3',
    'source: E2E 图形种子',
    'tags: [图形推理, E2E]',
    `stem: E2E 图形推理第 ${index} 题，从所给的四个选项中选择最合适的一项填入问号处，使之呈现一定的规律性。`,
    'options:',
    option('A'),
    option('B'),
    option('C'),
    option('D'),
    'answer: A',
    `explanation: E2E 图形推理解析：第 ${index} 题按图形规律应选 A，选项以图片形式呈现。`,
    '---',
    '',
    `# E2E 图形推理第 ${index} 题`,
    '',
    '选项为图片，验证渲染层经 vault.asset 读取 dataUrl。'
  ].join('\n')
}

/** 建磁盘 seed vault（图片题 md + PNG 附件），并把活动库切换到它（bootstrap 后调用） */
function seedGraphicVault(dataDir: string): string {
  const vaultDir = mkdtempSync(join(tmpdir(), 'tizhou-e2e-graphic-vault-'))
  const questionDir = join(vaultDir, '图形推理')
  mkdirSync(questionDir, { recursive: true })
  mkdirSync(join(questionDir, 'images'), { recursive: true })
  writeFileSync(join(questionDir, 'images', 'e2e-graphic-opt.png'), MINIMAL_PNG)
  const optionsJson = JSON.stringify(
    ['A', 'B', 'C', 'D'].map((key) => ({
      key,
      text: '',
      image: 'images/e2e-graphic-opt.png'
    }))
  )
  const db = new DatabaseSync(join(dataDir, 'workbench.sqlite'))
  const now = new Date().toISOString()
  try {
    db.prepare('UPDATE vault_registry SET active = 0').run()
    db.prepare(
      `INSERT INTO vault_registry(
        id, name, path, connected_at, last_indexed_at, question_count,
        document_count, warnings_json, is_builtin, active
      ) VALUES ('e2e-graphic-vault', 'E2E 图形图片题库', ?, ?, ?, ?, 0, '[]', 0, 1)`
    ).run(vaultDir, now, now, GRAPHIC_QUESTION_COUNT)
    const insert = db.prepare(
      `INSERT INTO questions(
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, tags_json, file_path, content_hash, indexed_at
      ) VALUES (?, 'e2e-graphic-vault', 'xingce', '图形推理', 'single', ?, ?, '["A"]', ?,
        3, 'E2E 图形种子', '[]', ?, ?, ?)`
    )
    for (let index = 1; index <= GRAPHIC_QUESTION_COUNT; index += 1) {
      const id = `e2e-graphic-${String(index).padStart(3, '0')}`
      const markdown = graphicQuestionMarkdown(index)
      const filePath = join(questionDir, `${id}.md`)
      writeFileSync(filePath, markdown, 'utf8')
      insert.run(
        id,
        `E2E 图形推理第 ${index} 题，从所给的四个选项中选择最合适的一项填入问号处，使之呈现一定的规律性。`,
        optionsJson,
        `E2E 图形推理解析：第 ${index} 题按图形规律应选 A，选项以图片形式呈现。`,
        filePath,
        createHash('sha256').update(markdown).digest('hex'),
        now
      )
    }
  } finally {
    db.close()
  }
  return vaultDir
}

let app: AppHandle | undefined
let vaultDir: string | undefined
let suiteFailed = false

describe('图形推理图片选项与模考逐题复盘（真实磁盘知识库种子）', () => {
  beforeAll(async () => {
    // bootstrap：让应用完成数据库迁移与内置库初始化
    const bootstrap = await launchApp()
    const dataDir = bootstrap.dataDir
    await closeApp(bootstrap)
    // Windows 下文件句柄释放有延迟：稍候再种入，避免 SQLite 锁冲突
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    vaultDir = seedGraphicVault(dataDir)
    app = await launchApp({ dataDir })
  }, 180_000)

  afterAll(async () => {
    if (app) await closeApp(app)
    const dataDir = app?.dataDir
    app = undefined
    if (vaultDir) await removeTempDataDir(vaultDir)
    if (!dataDir) return
    if (suiteFailed) {
      console.error(`[e2e] 用例失败，保留数据目录供诊断：${dataDir}`)
      return
    }
    await removeTempDataDir(dataDir)
  })

  it('模考作答区渲染图片选项 → 交卷 → 逐题复盘展示选项图与作答对照', async () => {
    if (!app) throw new Error('应用未启动')
    const page: Page = app.page
    onTestFailed(async () => {
      suiteFailed = true
      await dumpE2EArtifacts(page, '图形选项复盘')
    })
    await page.getByRole('link', { name: '模拟考试' }).click()
    await page.getByRole('button', { name: '创建并开始' }).click()
    await page.getByTestId('exam-submit').waitFor({ timeout: 60_000 })

    // 逐题作答：全程记录是否遇到过图片选项（OptionContent 经 vault.asset 渲染 dataUrl）
    let sawImageOption = false
    for (let question = 0; question < 30; question += 1) {
      const kind = await waitForQuestionAndAnswer(page)
      if (kind === 'objective') {
        if ((await page.locator('.option-button img[src^="data:image"]').count()) > 0)
          sawImageOption = true
        await page.getByTestId('exam-option-A').click()
      } else {
        await page.getByTestId('exam-essay-input').fill(`E2E 模考作答（第 ${question + 1} 题）`)
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      const next = page.getByRole('button', { name: '下一题' })
      if (await next.isDisabled()) break
      await next.click()
    }
    // 试卷池为内置 8 题 + 图形 3 题：三道图片题必然进入试卷
    expect(sawImageOption).toBe(true)

    await page.getByTestId('exam-submit').click()
    await page.getByRole('button', { name: '确认交卷' }).click()
    await page.waitForURL(/\/exam\/result\//, { timeout: 60_000 })

    // 逐题复盘区：选项图（dataUrl）、你的作答与参考答案对照、模块正确率分布
    await page.getByText('逐题复盘').first().waitFor({ timeout: 30_000 })
    const reviewImages = page.locator('.review-option img[src^="data:image"]')
    expect(await reviewImages.count()).toBeGreaterThanOrEqual(1)
    await page
      .getByText(/你的作答：/)
      .first()
      .waitFor({ timeout: 30_000 })
    await page.getByText('图形推理').first().waitFor({ timeout: 30_000 })
  }, 180_000)
})
