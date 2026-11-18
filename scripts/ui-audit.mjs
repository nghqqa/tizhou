#!/usr/bin/env node
// 全站 UI 巡检脚本：真实 Electron + Playwright，遍历全部页面 × 双主题 × 双视口。
// 每页执行几何断言（无横向溢出 / 同行网格顶对齐 / 顶层纵向间距 ≥12px / nowrap 文本不被裁剪）
// 与零 console.error / pageerror，并输出整页截图到仓库外临时目录供人工逐张审查。
// 用法：node scripts/ui-audit.mjs [--out <dir>] [--seed a|b|both] [--theme dark|light|both] [--viewport 1280x800,1024x720]
// 临时数据目录前缀 tizhou-ui-audit-（失败时保留供诊断，成功后清理）；截图目录不清理、不进 Git。
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 参数 ----
function parseArgs(argv) {
  const parsed = {
    out: join(tmpdir(), 'tizhou-ui-audit'),
    seed: 'both',
    themes: ['dark', 'light'],
    viewports: ['1280x800', '1024x720']
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') parsed.out = resolve(argv[++i])
    else if (arg === '--seed') parsed.seed = argv[++i]
    else if (arg === '--theme') parsed.themes = argv[++i].split(',')
    else if (arg === '--viewport') parsed.viewports = argv[++i].split(',')
    else if (arg === '--help') parsed.help = true
  }
  return parsed
}
const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    '用法：node scripts/ui-audit.mjs [--out <dir>] [--seed a|b|both] [--theme dark,light] [--viewport 1280x800,1024x720]'
  )
  process.exit(0)
}

// ---- 页面清单（覆盖全部 19 个路由与关键派生状态）----
const PAGES = [
  { name: 'dashboard', hash: '#/' },
  { name: 'practice-config', hash: '#/practice' },
  { name: 'review', hash: '#/review' },
  { name: 'exam-home', hash: '#/exam' },
  { name: 'exam-run', hash: '#/exam/run' },
  { name: 'exam-result', hash: '#/exam/result/audit-exam-done' },
  { name: 'knowledge-builder', hash: '#/knowledge-builder' },
  { name: 'knowledge-xingce', hash: '#/knowledge/xingce' },
  { name: 'thinking-xingce', hash: '#/thinking/xingce' },
  { name: 'knowledge-shenlun', hash: '#/knowledge/shenlun' },
  { name: 'thinking-shenlun', hash: '#/thinking/shenlun' },
  { name: 'patterns', hash: '#/patterns' },
  { name: 'shenlun-solution', hash: '#/shenlun-solution' },
  { name: 'reports', hash: '#/reports' },
  { name: 'ai', hash: '#/ai' },
  { name: 'ai-training', hash: '#/ai-training' },
  { name: 'diagnosis', hash: '#/diagnosis' },
  { name: 'environment', hash: '#/environment' },
  { name: 'model-settings', hash: '#/model-settings' },
  { name: 'settings', hash: '#/settings' }
]

// ---- 应用启动（与 e2e/helpers 同约定：测试运行时 + 临时数据目录）----
async function launch(dataDir) {
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: {
      ...process.env,
      WORKBENCH_SMOKE_DATA_DIR: dataDir,
      WORKBENCH_E2E: '1',
      WORKBENCH_E2E_UPDATE_SCENARIO: 'none'
    },
    timeout: 60_000
  })
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('今日工作台').first().waitFor({ timeout: 60_000 })
  return { electronApp, page, dataDir }
}

// ---- 种子（直接种 SQLite，与 e2e/helpers.seedQuestions 同姿势）----
function openDb(dataDir) {
  const dbPath = join(dataDir, 'workbench.sqlite')
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}（内建库未初始化）`)
  return new DatabaseSync(dbPath)
}

function vaultIdOf(db) {
  const row = db.prepare('SELECT id FROM vault_registry LIMIT 1').get()
  if (!row) throw new Error('vault_registry 为空')
  return row.id
}

function insertQuestion(db, vaultId, q) {
  const insert = db.prepare(`INSERT INTO questions(
      id, vault_id, subject, category, type, stem, options_json, answer_json,
      explanation, difficulty, source, tags_json, content_hash, indexed_at
    ) VALUES (?, ?, 'xingce', ?, 'single', ?, ?, ?, '巡检种子解析。', 2, 'UI 巡检种子', '[]', ?, ?)`)
  insert.run(
    q.id,
    vaultId,
    q.category,
    q.stem,
    JSON.stringify(q.options),
    JSON.stringify([q.answer]),
    q.hash,
    new Date().toISOString()
  )
}

function makeQuestion(id, category, tag) {
  return {
    id,
    category,
    stem: `巡检种子题 ${id}：这是一段用于填充版面的题干文本，${category}，占位词 ${tag}。`,
    options: [
      { key: 'A', text: '选项甲' },
      { key: 'B', text: '选项乙' },
      { key: 'C', text: '选项丙' },
      { key: 'D', text: '选项丁' }
    ],
    answer: 'A',
    hash: createHash('sha256').update(id).digest('hex')
  }
}

function insertAttempts(db, attempts) {
  const insert = db.prepare(`INSERT INTO attempts(
      id, question_id, answer_json, correct, duration_seconds, mode,
      session_id, wrong_cause, question_snapshot_json, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, 'practice', NULL, ?, ?, ?, ?)`)
  for (const a of attempts)
    insert.run(
      a.id,
      a.questionId,
      '["A"]',
      a.correct ? 1 : 0,
      a.duration,
      a.cause ?? null,
      JSON.stringify(a.snapshot),
      a.snapshotHash,
      a.at
    )
}

function snapshotOf(q) {
  return {
    id: q.id,
    subject: 'xingce',
    category: q.category,
    type: 'single',
    stem: q.stem,
    options: q.options,
    answer: [q.answer],
    explanation: '巡检种子解析。',
    difficulty: 2,
    source: 'UI 巡检种子',
    tags: [],
    contentHash: q.hash
  }
}

/** A 组：低样本边界态：仅 1 个模块 7 次作答（正确率 57.1%），驱动诊断空优势/圆环 57.1% */
function seedA(dataDir) {
  const db = openDb(dataDir)
  const vaultId = vaultIdOf(db)
  const questions = Array.from({ length: 7 }, (_, i) =>
    makeQuestion(`audit-a-${i + 1}`, '资料分析', `甲${i}`)
  )
  for (const q of questions) insertQuestion(db, vaultId, q)
  const base = Date.parse('2026-11-18T09:00:00.000Z')
  const attempts = questions.map((q, i) => ({
    id: `audit-a-at-${i + 1}`,
    questionId: q.id,
    correct: i < 4,
    duration: 35 + i,
    cause: i < 4 ? null : '计算失误',
    snapshot: snapshotOf(q),
    snapshotHash: q.hash,
    at: new Date(base + i * 60_000).toISOString()
  }))
  insertAttempts(db, attempts)
  db.close()
}

/** B 组：丰富真实态：多模块作答 + 错题 + 到期复习 + 已完成/进行中模考 + 知识文档走内建库 */
function seedB(dataDir) {
  const db = openDb(dataDir)
  const vaultId = vaultIdOf(db)
  const plan = [
    { category: '资料分析', count: 12, correct: 10 },
    { category: '判断推理', count: 10, correct: 7 },
    { category: '言语理解', count: 8, correct: 4 },
    { category: '常识判断', count: 5, correct: 2 },
    { category: '数量关系', count: 3, correct: 1 }
  ]
  const base = Date.parse('2026-11-17T02:00:00.000Z')
  let seq = 0
  const allQuestions = []
  for (const [pi, p] of plan.entries()) {
    const questions = Array.from({ length: p.count }, (_, i) =>
      makeQuestion(`audit-b-${pi}-${i + 1}`, p.category, `乙${pi}${i}`)
    )
    allQuestions.push(...questions)
    for (const q of questions) insertQuestion(db, vaultId, q)
    const attempts = questions.map((q, i) => ({
      id: `audit-b-at-${++seq}`,
      questionId: q.id,
      correct: i < p.correct,
      duration: 20 + ((seq * 7) % 40),
      cause: i < p.correct ? null : ['概念不清', '计算失误', '审题偏差', '时间不够'][seq % 4],
      snapshot: snapshotOf(q),
      snapshotHash: q.hash,
      at: new Date(base + seq * 30 * 60_000).toISOString()
    }))
    insertAttempts(db, attempts)
  }
  // 错题本：取言语理解/数量关系答错的题
  const wrong = allQuestions.filter((q) => q.category === '言语理解' || q.category === '数量关系')
  const insertWrong = db.prepare(`INSERT OR REPLACE INTO wrong_questions(
      question_id, wrong_count, correct_streak, mastered, last_wrong_cause, first_wrong_at, last_attempt_at
    ) VALUES (?, 2, 0, 0, '概念不清', ?, ?)`)
  const insertReview = db.prepare(
    'INSERT OR REPLACE INTO review_tasks(question_id, due_at, completed_at) VALUES (?, ?, NULL)'
  )
  const dueAt = new Date(Date.now() - 6 * 3600_000).toISOString() // 已到期
  for (const q of wrong.slice(0, 6)) {
    insertWrong.run(q.id, new Date(base).toISOString(), new Date(base + 3600_000).toISOString())
    insertReview.run(q.id, dueAt)
  }
  // 已完成模考（复盘页）+ 进行中模考（作答页）
  const examQuestions = allQuestions.filter((q) => q.category === '资料分析').slice(0, 6)
  const snapshots = {}
  for (const q of examQuestions) snapshots[q.id] = snapshotOf(q)
  const insertExam = db.prepare(`INSERT INTO exam_sessions(
      id, title, subject, started_at, updated_at, finished_at, duration_minutes,
      question_ids_json, question_snapshots_json, answers_json, status, score, correct_count
    ) VALUES (?, ?, 'xingce', ?, ?, ?, 30, ?, ?, ?, ?, ?, ?)`)
  const answers = {}
  for (const [i, q] of examQuestions.entries()) {
    answers[q.id] = {
      questionId: q.id,
      answer: i < 4 ? [q.answer] : ['C'],
      durationSeconds: 30 + i
    }
  }
  insertExam.run(
    'audit-exam-done',
    '巡检已完成模考',
    new Date(base).toISOString(),
    new Date(base + 30 * 60_000).toISOString(),
    new Date(base + 30 * 60_000).toISOString(),
    JSON.stringify(examQuestions.map((q) => q.id)),
    JSON.stringify(snapshots),
    JSON.stringify(answers),
    'finished',
    66.7,
    4
  )
  const activeQuestions = allQuestions.filter((q) => q.category === '判断推理').slice(0, 4)
  const activeSnapshots = {}
  for (const q of activeQuestions) activeSnapshots[q.id] = snapshotOf(q)
  insertExam.run(
    'audit-exam-live',
    '巡检进行中模考',
    new Date(Date.now() - 10 * 60_000).toISOString(),
    new Date(Date.now() - 60_000).toISOString(),
    null,
    JSON.stringify(activeQuestions.map((q) => q.id)),
    JSON.stringify(activeSnapshots),
    '{}',
    'active',
    null,
    null
  )
  db.close()
}

// ---- 几何断言（在页面内执行）----
function auditExpression() {
  const issues = []
  const doc = document.documentElement
  if (doc.scrollWidth > window.innerWidth + 1)
    issues.push(`横向溢出：scrollWidth=${doc.scrollWidth} > viewport=${window.innerWidth}`)
  // 同行网格子项顶部对齐（按 2.5px 聚类分行，行内 spread ≤1px）
  for (const grid of document.querySelectorAll('.grid, .dashboard-grid, .stats-row')) {
    const tops = [...grid.children]
      .filter((child) => child.getBoundingClientRect().height > 0)
      .map((child) => child.getBoundingClientRect().top)
      .sort((a, b) => a - b)
    if (tops.length < 2) continue
    const clusters = [[tops[0]]]
    for (const top of tops.slice(1)) {
      const cluster = clusters[clusters.length - 1]
      if (top - cluster[cluster.length - 1] <= 2.5) cluster.push(top)
      else clusters.push([top])
    }
    for (const cluster of clusters) {
      const spread = Math.max(...cluster) - Math.min(...cluster)
      if (spread > 1)
        issues.push(`网格同行顶不对齐：<${grid.className}> spread=${spread.toFixed(1)}px`)
    }
  }
  // .page 顶层相邻块纵向间距 ≥12px（无 0px 贴死）
  const page = document.querySelector('.page')
  if (page) {
    const kids = [...page.children].filter((el) => {
      const style = getComputedStyle(el)
      return (
        style.display !== 'none' &&
        style.position !== 'absolute' &&
        el.getBoundingClientRect().height > 0
      )
    })
    for (let i = 1; i < kids.length; i += 1) {
      const prev = kids[i - 1].getBoundingClientRect()
      const cur = kids[i].getBoundingClientRect()
      const gap = cur.top - prev.bottom
      if (gap < 12)
        issues.push(
          `顶层间距不足：第 ${i + 1} 块 <${kids[i].className || kids[i].tagName}> gap=${gap.toFixed(1)}px`
        )
    }
  }
  // nowrap / 徽章文本被裁剪
  for (const el of document.querySelectorAll('.score-ring-center span, .advice-badge, .pill')) {
    if (el.scrollWidth > el.clientWidth + 1)
      issues.push(`文本被裁剪：<${el.className}> scroll=${el.scrollWidth} client=${el.clientWidth}`)
  }
  return issues
}

// ---- 巡检主流程 ----
function now(name) {
  return { name, issues: [], consoleErrors: [], screenshot: '' }
}

async function traverse(run, page, theme, viewport, outDir, tag) {
  for (const item of PAGES) {
    const record = now(`${tag}/${theme}/${viewport}/${item.name}`)
    try {
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, item.hash)
      await page.waitForSelector('.page', { timeout: 15_000 })
      await page.waitForTimeout(900) // 图表动画与懒加载落定
      const issues = await page.evaluate(auditExpression)
      record.issues = issues
      const shot = join(outDir, tag, viewport, theme, `${item.name}.png`)
      mkdirSync(dirname(shot), { recursive: true })
      await page.screenshot({ path: shot, fullPage: true })
      record.screenshot = shot
    } catch (error) {
      record.issues.push(`巡检异常：${error instanceof Error ? error.message : String(error)}`)
    }
    run.results.push(record)
    const bad = record.issues.length + record.consoleErrors.length
    console.log(
      `${bad ? '✗' : '✓'} ${record.name}${bad ? `（${record.issues.join('；')}${record.consoleErrors.length ? `；console ${record.consoleErrors.length} 条` : ''}）` : ''}`
    )
  }
}

/** 有状态子流程：练习答题态/汇总态、诊断三态（表单/预览/活动） */
async function subFlows(run, page, theme, viewport, outDir, tag) {
  const shot = async (name) => {
    const path = join(outDir, tag, viewport, theme, `${name}.png`)
    mkdirSync(dirname(path), { recursive: true })
    await page.waitForTimeout(600)
    await page.screenshot({ path, fullPage: true })
    const issues = await page.evaluate(auditExpression)
    const record = now(`${tag}/${theme}/${viewport}/${name}`)
    record.issues = issues
    record.screenshot = path
    run.results.push(record)
    console.log(
      `${issues.length ? '✗' : '✓'} ${record.name}${issues.length ? `（${issues.join('；')}）` : ''}`
    )
  }
  // 练习：开始 → 答题态 → 连答到组尾 → 汇总态
  try {
    await page.evaluate(() => {
      window.location.hash = '#/practice'
    })
    await page.waitForSelector('.page', { timeout: 15_000 })
    await page.waitForTimeout(600)
    const startButton = page.getByRole('button', { name: /生成训练|开始练习|直接开始/ }).first()
    if (await startButton.count()) {
      await startButton.click()
      const option = page.locator('.option-button').first()
      const essayInput = page.getByTestId('exam-essay-input')
      await option.or(essayInput).first().waitFor({ timeout: 30_000 })
      const answerCurrent = async () => {
        if (await option.count()) await option.click()
        else await essayInput.fill('巡检种子作答要点。')
      }
      await answerCurrent()
      await shot('practice-answering')
      for (let i = 0; i < 60; i += 1) {
        // 汇总解析模式：先提交本题才出现下一题；即时解析模式直接出现下一题
        const submit = page.getByRole('button', { name: /提交答案/ }).first()
        if (await submit.count()) {
          await submit.click()
          await page.waitForTimeout(400)
        }
        const next = page.getByRole('button', { name: /下一题|完成本组/ }).first()
        if (!(await next.count())) break
        const label = (await next.textContent()) ?? ''
        await next.click()
        if (label.includes('完成本组')) break
        await option.or(essayInput).first().waitFor({ timeout: 30_000 })
        await answerCurrent()
      }
      await page.waitForTimeout(900)
      await shot('practice-summary')
    } else {
      console.log(`ℹ ${tag}: 练习页无可用开始按钮，跳过答题子流程（已有进行中会话则为恢复态）`)
    }
  } catch (error) {
    const path = join(outDir, tag, viewport, theme, 'practice-flow-error.png')
    try {
      mkdirSync(dirname(path), { recursive: true })
      await page.screenshot({ path, fullPage: true })
    } catch {
      /* 转储失败不影响原流程 */
    }
    console.log(
      `✗ ${tag} 练习子流程异常：${error instanceof Error ? error.message : String(error)}；现场截图 ${path}`
    )
  }
  // 诊断：表单 → 生成预览 → 应用计划
  try {
    await page.evaluate(() => {
      window.location.hash = '#/diagnosis'
    })
    await page.waitForSelector('.page', { timeout: 15_000 })
    await page.waitForTimeout(800)
    const previewButton = page.getByRole('button', { name: '生成预览' })
    if (await previewButton.count()) {
      await previewButton.click()
      await page.getByRole('button', { name: '应用计划' }).waitFor({ timeout: 30_000 })
      await shot('diagnosis-plan-preview')
      await page.getByRole('button', { name: '应用计划' }).click()
      await page.getByRole('button', { name: '取消计划' }).waitFor({ timeout: 30_000 })
      await shot('diagnosis-plan-active')
    } else {
      console.log(`ℹ ${tag}: 诊断页无生成预览按钮（可能已有活动计划），跳过`)
    }
  } catch (error) {
    const path = join(outDir, tag, viewport, theme, 'diagnosis-flow-error.png')
    try {
      mkdirSync(dirname(path), { recursive: true })
      await page.screenshot({ path, fullPage: true })
    } catch {
      /* 转储失败不影响原流程 */
    }
    console.log(
      `✗ ${tag} 诊断子流程异常：${error instanceof Error ? error.message : String(error)}；现场截图 ${path}`
    )
  }
}

async function runSeed(seed) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tizhou-ui-audit-'))
  console.log(`\n[audit] 种子组 ${seed.toUpperCase()} 数据目录：${dataDir}`)
  const bootstrap = await launch(dataDir)
  await bootstrap.electronApp.close()
  await new Promise((r) => setTimeout(r, 1500))
  if (seed === 'a') seedA(dataDir)
  else seedB(dataDir)
  const run = { results: [] }
  const app = await launch(dataDir)
  const { page } = app
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`${page.url()}：${msg.text()}`)
  })
  page.on('pageerror', (error) => consoleErrors.push(`${page.url()}：pageerror ${error.message}`))
  try {
    for (const viewport of args.viewports) {
      const [width, height] = viewport.split('x').map(Number)
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(400)
      for (const theme of args.themes) {
        const current = await page.evaluate(() => document.documentElement.dataset.theme)
        if (current !== theme) {
          await page.getByRole('button', { name: /切换到浅色模式|切换到深色模式/ }).click()
          await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme, {
            timeout: 10_000
          })
          await page.waitForTimeout(400)
        }
        await traverse(run, page, theme, viewport, args.out, seed)
      }
    }
    // 子流程固定在最后一个主题/视口组合下执行（dark/最后一个视口），保持确定性
    const lastViewport = args.viewports[args.viewports.length - 1]
    await subFlows(run, page, args.themes[args.themes.length - 1], lastViewport, args.out, seed)
  } finally {
    consoleErrorsPerSeed.set(seed, consoleErrors)
    await app.electronApp.close()
  }
  return { seed, dataDir, results: run.results, consoleErrors }
}

const consoleErrorsPerSeed = new Map()
const seeds = args.seed === 'both' ? ['a', 'b'] : [args.seed]
const summary = { startedAt: new Date().toISOString(), seeds: [], totalIssues: 0 }
for (const seed of seeds) {
  const result = await runSeed(seed)
  const allIssues = result.results.flatMap((r) => r.issues)
  const consoleErrors = result.consoleErrors
  summary.seeds.push({
    seed: result.seed,
    dataDir: result.dataDir,
    pages: result.results.length,
    issueCount: allIssues.length,
    consoleErrorCount: consoleErrors.length,
    issues: [...new Set(allIssues)],
    consoleErrors: [...new Set(consoleErrors)].slice(0, 10)
  })
  summary.totalIssues += allIssues.length
  if (result.consoleErrors.length) summary.totalIssues += consoleErrors.length
  if (!args.out.startsWith(tmpdir())) rmSync(result.dataDir, { recursive: true, force: true })
  else rmSync(result.dataDir, { recursive: true, force: true })
}
writeFileSync(join(args.out, 'audit-summary.json'), JSON.stringify(summary, null, 2))
console.log(`\n[audit] 完成：${summary.totalIssues} 个问题；截图目录 ${args.out}`)
if (summary.totalIssues > 0) process.exitCode = 1
