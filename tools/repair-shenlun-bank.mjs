#!/usr/bin/env node
// 修复既有 merged-bank 中 kgst-sl-* 申论题目：
// 1. 清洗 CJK 部首补充区/康熙部首（恢复全角中文标点，清除页脚残渣）
// 2. 运行联考跨卷自动拼补引擎，还原同材料多省卷丢失的正文断行与段尾腰斩
// 3. 回填题干中缺失的「给定资料N」序号
// 4. 原位覆盖已存在的 kgst-sl-*.md（不改变题目 id，保护用户草稿/作答历史），并同步更新 workbench.sqlite

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { argv, exit } from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import matter from 'gray-matter'
import { questionMarkdown, regionFromPaperTitle } from './lib/import-core.mjs'
import {
  normalizeShenlunRawText,
  resolveMaterialIdRefs,
  stitchCrossPaperMaterials
} from './lib/shenlun-repair.mjs'
import {
  classifyXzShenlunType,
  normalizeXzRegion,
  selectRelevantShenlunBlocks
} from './direct-import.mjs'

function parseArgs(args) {
  const opts = { dryRun: false, src: '', vault: '', sqlite: '', log: '' }
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--src') opts.src = args[++i] ?? ''
    else if (arg === '--vault') opts.vault = args[++i] ?? ''
    else if (arg === '--sqlite') opts.sqlite = args[++i] ?? ''
    else if (arg === '--log') opts.log = args[++i] ?? ''
  }
  return opts
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

const opts = parseArgs(argv)
if (!opts.src || !opts.vault) {
  console.error(
    '用法: node tools/repair-shenlun-bank.mjs --src <kaogong-shuati目录> --vault <merged-bank目录> [--sqlite <workbench.sqlite>] [--dry-run] [--log <json路径>]'
  )
  exit(1)
}

const tikuPath = join(opts.src, 'tiku.db')
const matPath = join(opts.src, 'materials.db')
if (!existsSync(tikuPath) || !existsSync(matPath)) {
  throw new Error(`未在 ${opts.src} 找到 tiku.db 与 materials.db`)
}
if (!existsSync(opts.vault)) {
  throw new Error(`目标题库目录不存在：${opts.vault}`)
}

// 1. 收集目标目录中现存的 kgst-sl-*.md（严格仅修复已有题目，不增删）
const existingFiles = new Map()
for (const name of readdirSync(opts.vault)) {
  if (!name.startsWith('kgst-sl-') || !name.endsWith('.md')) continue
  const fp = join(opts.vault, name)
  const raw = readFileSync(fp, 'utf8')
  const parsed = matter(raw)
  const qid = String(parsed.data?.id ?? name.replace(/\.md$/, ''))
  if (qid.startsWith('kgst-sl-')) {
    existingFiles.set(qid, { fileName: name, filePath: fp, raw, frontmatter: parsed.data })
  }
}
console.log(`[repair-shenlun] 目标目录现存 kgst-sl 题目：${existingFiles.size} 题`)

// 2. 加载上游全量 materials.db + tiku.db，清洗并执行联考跨卷自动拼补
const tikuDb = new DatabaseSync(tikuPath, { readOnly: true })
const matDb = new DatabaseSync(matPath, { readOnly: true })

const paperNames = new Map()
for (const pRow of tikuDb.prepare('SELECT id, name FROM papers').all()) {
  paperNames.set(pRow.id, String(pRow.name ?? '').trim())
}

const rawBlocks = []
for (const row of matDb
  .prepare('SELECT paperId, idx, title, text FROM materials ORDER BY paperId, idx')
  .all()) {
  const text = normalizeShenlunRawText(String(row.text ?? ''))
    .replace(
      /\[materialid\]\d+\[\/materialid\](?:\s*[-～~—–]\s*\[materialid\]\d+\[\/materialid\])*/gi,
      ''
    )
    .trim()
  if (!text) continue
  const label = normalizeShenlunRawText(String(row.title ?? '').trim())
  const numMatch = label.match(/(\d+)/)
  rawBlocks.push({
    paperId: row.paperId,
    paperName: paperNames.get(row.paperId) || '',
    idx: Number(row.idx) || rawBlocks.length + 1,
    title: label,
    titleNum: numMatch ? Number(numMatch[1]) : null,
    text
  })
}

console.log(`[repair-shenlun] 加载上游材料块 ${rawBlocks.length} 段，开始跨卷拼补…`)
const t0 = Date.now()
const stitched = stitchCrossPaperMaterials(rawBlocks)
console.log(
  `[repair-shenlun] 跨卷拼补完成（耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s）：总补丁 ${stitched.stats.totalPatches} 处（中段 ${stitched.stats.midPatches}，完整尾 ${stitched.stats.tailFullPatches}，保守句尾 ${stitched.stats.tailSentencePatches}），覆盖 ${stitched.stats.patchedBlocks} 段 / ${stitched.stats.patchedPapers} 卷`
)

const materialsByPaper = new Map()
for (const block of stitched.blocks) {
  const list = materialsByPaper.get(block.paperId) ?? []
  list.push({
    idx: Number(block.idx) || list.length + 1,
    titleNum: block.titleNum,
    text: block.text,
    rendered: block.title ? `### ${block.title}\n\n${block.text}` : block.text
  })
  materialsByPaper.set(block.paperId, list)
}

const rows = tikuDb
  .prepare(
    `SELECT q.questionId, q.paperId, q.chapter, q.content, q.answer, q.analysis,
            p.name AS paperName, p.category AS paperRegion
     FROM questions q
     JOIN papers p ON p.id = q.paperId
     WHERE p.subjectName LIKE '%申论%' OR p.subject = 'shenlun'
     ORDER BY q.paperId, q.id`
  )
  .all()

const rowById = new Map()
for (const row of rows) {
  rowById.set(`kgst-sl-${row.questionId}`, row)
}

let updatedCount = 0
let unchangedCount = 0
let missingInUpstream = 0
let stemRefRestored = 0
const sqliteUpdates = []

for (const [qid, existing] of existingFiles) {
  const row = rowById.get(qid)
  if (!row) {
    missingInUpstream += 1
    continue
  }

  const rawContent = String(row.content ?? '')
  const cleanStemBeforeResolve = normalizeShenlunRawText(rawContent)
    .replace(
      /\[materialid\]\d+\[\/materialid\](?:\s*[-～~—–]\s*\[materialid\]\d+\[\/materialid\])*/gi,
      ''
    )
    .trim()
  const paperName = String(row.paperName ?? '').trim()
  const category = classifyXzShenlunType(row.chapter, cleanStemBeforeResolve)
  const rawAnalysis = normalizeShenlunRawText(String(row.analysis ?? '').trim())
  const rawAnswer = normalizeShenlunRawText(String(row.answer ?? '').trim())
  const explanation =
    rawAnalysis || rawAnswer || '暂无参考答案；可在「申论作答」页配合 AI 批改或本地规则评分练习。'
  const allMatBlocks = materialsByPaper.get(row.paperId) ?? []
  const pickedBlocks = selectRelevantShenlunBlocks(
    allMatBlocks,
    cleanStemBeforeResolve,
    category,
    explanation
  )
  const stem = resolveMaterialIdRefs(rawContent, allMatBlocks, pickedBlocks, category)
  if (stem !== cleanStemBeforeResolve) stemRefRestored += 1

  const material = pickedBlocks
    .map((b) => b.rendered)
    .join('\n\n')
    .trim()
  if (!stem || material.length < 40) continue

  const fm = existing.frontmatter ?? {}
  const rawRegion = String(row.paperRegion ?? '').trim() || regionFromPaperTitle(paperName) || ''
  const region = fm.region || normalizeXzRegion(rawRegion) || undefined
  const yearMatch = paperName.match(/(20\d{2})/)
  const year = fm.year ?? (yearMatch ? Number(yearMatch[1]) : undefined)

  const question = {
    id: qid,
    subject: 'shenlun',
    category: fm.category || category,
    tags: Array.isArray(fm.tags)
      ? fm.tags
      : [region || '未标注', ...(year ? [`${year}`] : []), 'kaogong-shuati'],
    source: fm.source || `开源真题/kaogong-shuati/${paperName || row.paperId}`,
    sourceFile: fm.sourceFile || `tiku.db#paper-${row.paperId}`,
    year,
    region,
    paper: fm.paper || paperName || undefined,
    questionType: 'essay',
    difficulty: fm.difficulty ?? 3,
    material,
    stem,
    options: [],
    answer: [],
    explanation
  }

  const nextMarkdown = questionMarkdown(question)
  if (nextMarkdown === existing.raw) {
    unchangedCount += 1
    continue
  }

  updatedCount += 1
  if (!opts.dryRun) {
    writeFileSync(existing.filePath, nextMarkdown, 'utf8')
    const st = statSync(existing.filePath)
    sqliteUpdates.push({
      shortId: qid,
      filePath: existing.filePath,
      stem,
      material,
      explanation,
      contentHash: sha256(nextMarkdown),
      mtimeMs: st.mtimeMs,
      size: st.size
    })
  }
}

tikuDb.close()
matDb.close()

if (opts.log) {
  writeFileSync(
    opts.log,
    JSON.stringify(
      {
        dryRun: opts.dryRun,
        existingCount: existingFiles.size,
        updatedCount,
        unchangedCount,
        missingInUpstream,
        stemRefRestored,
        stitchStats: stitched.stats,
        logs: stitched.logs
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(`[repair-shenlun] 拼补日志已写出：${opts.log}`)
}

if (!opts.dryRun && opts.sqlite && sqliteUpdates.length > 0) {
  if (!existsSync(opts.sqlite)) {
    console.warn(`[repair-shenlun] 未找到 SQLite 数据库，跳过同步：${opts.sqlite}`)
  } else {
    try {
      const db = new DatabaseSync(opts.sqlite)
      db.exec('PRAGMA busy_timeout = 5000;')
      const nowIso = new Date().toISOString()
      const normPath = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
      const targetVaultNorm = normPath(opts.vault)
      const allVaults = db.prepare('SELECT id, path, active FROM vault_registry').all()
      const vaultRow =
        allVaults.find((row) => {
          const vp = normPath(String(row.path))
          return (
            targetVaultNorm === vp ||
            targetVaultNorm.startsWith(`${vp}\\`) ||
            targetVaultNorm.startsWith(`${vp}/`)
          )
        }) ?? allVaults.find((row) => Number(row.active) === 1)
      if (!vaultRow) {
        db.close()
        throw new Error(`workbench.sqlite 中未找到匹配 ${opts.vault} 的 vault_registry 记录`)
      }
      const vaultId = String(vaultRow.id)
      const stmt = db.prepare(
        `UPDATE questions
         SET stem = ?, material = ?, explanation = ?, content_hash = ?,
             file_mtime_ms = ?, file_size = ?, indexed_at = ?
         WHERE id = ? AND vault_id = ?`
      )
      db.exec('BEGIN IMMEDIATE')
      let synced = 0
      try {
        for (const item of sqliteUpdates) {
          const fullId = `${vaultId}:${item.shortId}`
          const res = stmt.run(
            item.stem,
            item.material,
            item.explanation,
            item.contentHash,
            item.mtimeMs,
            item.size,
            nowIso,
            fullId,
            vaultId
          )
          synced += Number(res.changes ?? 0)
        }
        db.exec('COMMIT')
        console.log(`[repair-shenlun] SQLite 同步完成：更新 ${synced} 条记录`)
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      } finally {
        db.close()
      }
    } catch (err) {
      console.warn(
        `[repair-shenlun] 警告：SQLite 同步失败（${err instanceof Error ? err.message : String(err)}）。Markdown 文件已全部写盘，可在题舟设置中点击「重新索引」完成同步。`
      )
    }
  }
}

console.log(
  JSON.stringify(
    {
      dryRun: opts.dryRun,
      existingCount: existingFiles.size,
      updatedCount,
      unchangedCount,
      missingInUpstream,
      stemRefRestored,
      stitchStats: stitched.stats
    },
    null,
    2
  )
)
