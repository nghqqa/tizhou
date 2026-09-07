// UI E2E 助手：确定性启动 Electron（临时数据目录 + mock updater 场景）与题库种子
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  existsSync,
  realpathSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface AppHandle {
  electronApp: ElectronApplication
  page: Page
  dataDir: string
}

export interface LaunchOptions {
  /** mock updater 场景：none=无更新 available=有更新并可下载 error=检查失败 */
  updateScenario?: 'none' | 'available' | 'error'
  /** 第一次 exam.save 抛错（验证交卷阻止与自动重试） */
  failSaveOnce?: boolean
  /** 复用既有数据目录（已种子化/已含完成模考） */
  dataDir?: string
}

/** 启动完整应用：临时数据目录 + WORKBENCH_E2E 挂钩（mock updater / 保存失败注入 / e2e=1 窗口标记） */
export async function launchApp(options: LaunchOptions = {}): Promise<AppHandle> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'tizhou-e2e-'))
  return launchRaw(dataDir, options)
}

/** 模考套件专用：自举建库建表 → 种入题库 → 启动正式实例。
 *  每个套件独立调用即可获得隔离的临时数据目录与确定的题目集合，
 *  不依赖任何其他测试的执行顺序。 */
export async function launchSeededExamApp(
  options: { failSaveOnce?: boolean } = {}
): Promise<AppHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tizhou-e2e-exam-'))
  // 第一次启动：让应用完成数据库迁移与内建知识库初始化
  const bootstrap = await launchRaw(dataDir, {})
  await closeApp(bootstrap)
  // Windows 下文件句柄释放有延迟：稍候再种入，避免 SQLite 锁冲突
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const seeded = seedQuestions(dataDir)
  if (seeded === 0) throw new Error('E2E 种子失败：内建知识库未初始化')
  // 第二次启动：正式实例（题目集合确定，随机抽取也是全集）
  return launchRaw(dataDir, { failSaveOnce: options.failSaveOnce })
}

async function launchRaw(
  dataDir: string,
  options: { failSaveOnce?: boolean; updateScenario?: 'none' | 'available' | 'error' }
): Promise<AppHandle> {
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      WORKBENCH_SMOKE_DATA_DIR: dataDir,
      // 复用用户机器已装的 MarkItDown 引擎（与生产引擎同一 venv；E2E 不依赖外部网络）
      WORKBENCH_MARKITDOWN_PYTHON:
        process.env.WORKBENCH_MARKITDOWN_PYTHON ??
        'C:/Users/ngh/AppData/Roaming/tizhou/knowledge-builder/engine/.venv/Scripts/python.exe',
      WORKBENCH_E2E: '1',
      WORKBENCH_E2E_UPDATE_SCENARIO: options.updateScenario ?? 'none',
      WORKBENCH_E2E_FAIL_SAVE: options.failSaveOnce ? 'once' : ''
    },
    timeout: 60_000
  })
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // 工作台就绪：默认路由的可见内容
  await page.getByText('今日工作台').first().waitFor({ timeout: 60_000 })
  return { electronApp, page, dataDir }
}

export async function closeApp(app: AppHandle): Promise<void> {
  await app.electronApp.close()
}

/** 删除 E2E 临时数据目录（仅接受 tizhou-e2e-* 目录）：Windows 文件占用时有限次重试 */
/** 删除 E2E 临时数据目录（严格边界版）：
 *  - 目标与系统临时目录都做 resolve，并用 path.relative 验证目标严格位于临时目录内；
 *  - 末段目录名必须以 tizhou-e2e- 开头；
 *  - 拒绝空路径、临时目录根本身、绝对路径逃逸与 .. 段；
 *  - 目标是符号链接/junction 时不递归跟随，只移除链接本身；
 *  - 目标不存在时幂等返回；
 *  - 3 次重试后仍失败则抛错（调用方据用例成败决定门禁失败或保留诊断）。 */
export async function removeTempDataDir(dir: string): Promise<void> {
  if (!dir || !dir.trim()) throw new Error('拒绝删除：目录路径为空')
  if (/(^|[\\/])\.\.($|[\\/])/.test(dir)) throw new Error(`拒绝包含 .. 的路径：${dir}`)
  const segments = dir.split(/[\\/]/).filter(Boolean)
  const base = segments[segments.length - 1] ?? ''
  if (!base.startsWith('tizhou-e2e-')) throw new Error(`拒绝删除非 E2E 临时目录：${dir}`)

  const tempRoot = resolve(tmpdir())
  const target = resolve(dir)
  const rel = relative(tempRoot, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`拒绝删除系统临时目录之外的目标：${dir}`)

  // 不存在 → 幂等返回
  let stats: Stats | undefined
  let real = target
  try {
    stats = lstatSync(target)
    real = realpathSync(target)
  } catch {
    return
  }
  // 链接与 junction 一律只移除链接本身，不递归跟随其真实目标
  if (stats.isSymbolicLink() || real !== target) {
    try {
      rmSync(target, { force: true })
    } catch {
      rmdirSync(target)
    }
    return
  }
  if (!stats.isDirectory()) throw new Error(`拒绝删除非目录目标：${dir}`)

  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true })
      if (!existsSync(target)) return
      lastError = new Error('目录仍存在')
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw lastError instanceof Error ? lastError : new Error(`目录删除失败：${dir}`)
}

/** 向已初始化的本地数据库种入 20 道客观题 + 1 道申论题（内建库），供模考 E2E 使用 */
export function seedQuestions(dataDir: string): number {
  mkdirSync(join(dataDir), { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'workbench.sqlite'))
  const vault = db.prepare('SELECT id FROM vault_registry LIMIT 1').get() as
    { id: string } | undefined
  if (!vault) {
    db.close()
    return 0
  }
  const insert = db.prepare(
    `INSERT INTO questions (
       id, vault_id, subject, category, type, stem, options_json, answer_json,
       explanation, difficulty, source, tags_json, content_hash, indexed_at
     ) VALUES (?, ?, 'xingce', '资料分析', ?, ?, ?, ?, 'E2E 解析内容。', 2, 'E2E 种子', '[]', ?, ?)`
  )
  const now = new Date().toISOString()
  let seeded = 0
  for (let index = 1; index <= 21; index += 1) {
    const isEssay = index === 21
    const id = `e2e-q-${index}`
    const hash = createHash('sha256').update(id).digest('hex')
    insert.run(
      id,
      vault.id,
      isEssay ? 'essay' : 'single',
      isEssay
        ? 'E2E 申论题：请结合材料写一篇短文，谈谈你的看法。'
        : `E2E 测试题目第 ${index} 题：下列哪个选项正确？`,
      isEssay
        ? '[]'
        : JSON.stringify([
            { key: 'A', text: '选项甲' },
            { key: 'B', text: '选项乙' },
            { key: 'C', text: '选项丙' },
            { key: 'D', text: '选项丁' }
          ]),
      isEssay ? '[]' : JSON.stringify(['A']),
      hash,
      now
    )
    seeded += 1
  }
  db.close()
  return seeded
}

// ---- 题目作答等待：客观选项 / 申论输入 / 明确错误状态三者必居其一 ----
export type QuestionKind = 'objective' | 'essay'

/** 等待当前题目加载完成（客观选项或申论输入框之一可见），返回题型。
 *  三者都未出现（超时）时转储现场信息后抛错，不吞掉真实错误。 */
export async function waitForQuestionAndAnswer(page: Page): Promise<QuestionKind> {
  const option = page.getByTestId('exam-option-A')
  const essayInput = page.getByTestId('exam-essay-input')
  try {
    await option.or(essayInput).first().waitFor({ state: 'visible', timeout: 30_000 })
  } catch {
    const url = page.url()
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '')
    console.error(`[e2e] 题目未加载：url=${url}\n页面文本（前 400 字）：${bodyText.slice(0, 400)}`)
    await dumpE2EArtifacts(page, '题目未加载')
    throw new Error(`30 秒内未出现客观选项或申论输入框：url=${url}`)
  }
  if (await essayInput.count()) return 'essay'
  return 'objective'
}

/** 失败现场转储：截图 + 页面 HTML 写入 e2e-artifacts/；内部捕获异常不影响调用方 */
export async function dumpE2EArtifacts(page: Page, name: string): Promise<void> {
  try {
    const safe = name.replace(/[\/:*?"<>|]/g, '_')
    const dir = 'e2e-artifacts'
    mkdirSync(dir, { recursive: true })
    await page.screenshot({ path: join(dir, `${safe}.png`), fullPage: true })
    writeFileSync(join(dir, `${safe}.html`), await page.content(), 'utf8')
  } catch {
    /* 转储失败不影响原流程 */
  }
}
