#!/usr/bin/env node
// 将 shenlun-export-* 数据包中的增量资产按题舟契约接入本地知识库并同步 SQLite：
// 1. 导入 knowledge/ 下 23 份申论方法论与表达/格式/素材文档到 <vault>/shenlun-knowledge/
// 2. 补齐 shenlun_materials 中因旧版字数门槛漏掉的短「金句」到 <vault>/tizhou-kaogong-vault/kg-sc-<id>.md
// 3. 将 db/shenlun_hotspots.json（专题聚合视图）整理为结构化《申论热点专题素材汇编》写入 <vault>/shenlun-knowledge/
// 4. 同步写入 workbench.sqlite 的 documents 表并更新 vault_registry.document_count

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { argv, exit } from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import matter from 'gray-matter'
import { yamlQuote } from './lib/import-core.mjs'

export const KNOWLEDGE_MAPPINGS = [
  // kind: "method"（18 份，进入「申论方法」）
  {
    srcRel: 'references/shenlun.md',
    outFile: 'sl-doc-huasheng-shenlun.md',
    id: 'sl-doc-huasheng-shenlun',
    kind: 'method',
    title: '申论总体方法论（花生十三体系）',
    tags: ['申论方法', '花生十三', '题型体系']
  },
  {
    srcRel: 'shenlun-mingshi/beikao-jihua.md',
    outFile: 'sl-doc-beikao-jihua.md',
    id: 'sl-doc-beikao-jihua',
    kind: 'method',
    title: '申论备考计划与方法论',
    tags: ['申论方法', '备考计划', '学习路径']
  },
  {
    srcRel: 'shenlun-mingshi/cailiao-yuedu.md',
    outFile: 'sl-doc-cailiao-yuedu.md',
    id: 'sl-doc-cailiao-yuedu',
    kind: 'method',
    title: '申论材料阅读方法',
    tags: ['申论方法', '材料阅读', '批注法']
  },
  {
    srcRel: 'shenlun-mingshi/danyiti-guina.md',
    outFile: 'sl-doc-danyiti-guina.md',
    id: 'sl-doc-danyiti-guina',
    kind: 'method',
    title: '单一题（归纳概括）详解',
    tags: ['申论方法', '单一题', '归纳概括']
  },
  {
    srcRel: 'shenlun-mingshi/zonghe-fenxi.md',
    outFile: 'sl-doc-zonghe-fenxi.md',
    id: 'sl-doc-zonghe-fenxi',
    kind: 'method',
    title: '综合分析题详解',
    tags: ['申论方法', '综合分析']
  },
  {
    srcRel: 'shenlun-mingshi/duice-tichu.md',
    outFile: 'sl-doc-duice-tichu.md',
    id: 'sl-doc-duice-tichu',
    kind: 'method',
    title: '提出对策题详解',
    tags: ['申论方法', '提出对策']
  },
  {
    srcRel: 'shenlun-mingshi/gongwen-xiezuo.md',
    outFile: 'sl-doc-gongwen-xiezuo.md',
    id: 'sl-doc-gongwen-xiezuo',
    kind: 'method',
    title: '公文写作题（贯彻执行题）详解',
    tags: ['申论方法', '公文写作', '贯彻执行']
  },
  {
    srcRel: 'shenlun-mingshi/dazuowen.md',
    outFile: 'sl-doc-dazuowen.md',
    id: 'sl-doc-dazuowen',
    kind: 'method',
    title: '大作文（申发论述）详解',
    tags: ['申论方法', '大作文', '申发论述']
  },
  {
    srcRel: 'shenlun-mingshi/fenlundian-lunzheng.md',
    outFile: 'sl-doc-fenlundian-lunzheng.md',
    id: 'sl-doc-fenlundian-lunzheng',
    kind: 'method',
    title: '大作文分论点与论证专项',
    tags: ['申论方法', '大作文', '分论点', '论证']
  },
  {
    srcRel: 'shenlun-mingshi/mingshi-duibi.md',
    outFile: 'sl-doc-mingshi-duibi.md',
    id: 'sl-doc-mingshi-duibi',
    kind: 'method',
    title: '七位申论名师方法论横向对比',
    tags: ['申论方法', '名师对比']
  },
  {
    srcRel: 'shenlun-mingshi/mingshi-xiangjie.md',
    outFile: 'sl-doc-mingshi-xiangjie.md',
    id: 'sl-doc-mingshi-xiangjie',
    kind: 'method',
    title: '七位申论名师方法详解',
    tags: ['申论方法', '名师体系']
  },
  {
    srcRel: 'shenlun-mingshi/taoti-fupan.md',
    outFile: 'sl-doc-taoti-fupan.md',
    id: 'sl-doc-taoti-fupan',
    kind: 'method',
    title: '套题复盘方法与错题本模板',
    tags: ['申论方法', '套题复盘', '错题本']
  },
  {
    srcRel: 'shenlun-mingshi/zhenti-shili.md',
    outFile: 'sl-doc-zhenti-shili.md',
    id: 'sl-doc-zhenti-shili',
    kind: 'method',
    title: '申论真题示例与六步解析',
    tags: ['申论方法', '真题示例', '六步解析']
  },
  {
    srcRel: 'shenlun-smbl/bai-lu-methodology.md',
    outFile: 'sl-doc-smbl-bailu.md',
    id: 'sl-doc-smbl-bailu',
    kind: 'method',
    title: '白鹭（半月谈）申论方法论',
    tags: ['申论方法', '白鹭', '半月谈']
  },
  {
    srcRel: 'shenlun-smbl/xiaoma-methodology.md',
    outFile: 'sl-doc-smbl-xiaoma.md',
    id: 'sl-doc-smbl-xiaoma',
    kind: 'method',
    title: '小马哥申论方法论',
    tags: ['申论方法', '小马哥', '框架化答题']
  },
  {
    srcRel: 'shenlun-smbl/yuan-dong-methodology.md',
    outFile: 'sl-doc-smbl-yuandong.md',
    id: 'sl-doc-smbl-yuandong',
    kind: 'method',
    title: '袁东大作文方法论',
    tags: ['申论方法', '袁东', '大作文']
  },
  {
    srcRel: 'shenlun-smbl/writing-rules.md',
    outFile: 'sl-doc-smbl-writing-rules.md',
    id: 'sl-doc-smbl-writing-rules',
    kind: 'method',
    title: '申论小题作答铁律与材料信号词',
    tags: ['申论方法', '作答铁律', '材料信号词', '小马哥', '白鹭']
  },
  {
    srcRel: 'shenlun-smbl/scoring-rules.md',
    outFile: 'sl-doc-smbl-scoring-rules.md',
    id: 'sl-doc-smbl-scoring-rules',
    kind: 'method',
    title: '申论阅卷评分方法（采分点覆盖法）',
    tags: ['申论方法', '评分规则', '采分点']
  },

  // kind: "knowledge"（5 份，进入「申论知识」）
  {
    srcRel: 'references/shenlun-biaoda.md',
    outFile: 'sl-doc-huasheng-biaoda.md',
    id: 'sl-doc-huasheng-biaoda',
    kind: 'knowledge',
    title: '申论规范表达与金句积累（花生十三体系）',
    tags: ['申论知识', '规范表达', '金句', '花生十三']
  },
  {
    srcRel: 'references/shenlun-sucai.md',
    outFile: 'sl-doc-huasheng-sucai.md',
    id: 'sl-doc-huasheng-sucai',
    kind: 'knowledge',
    title: '申论素材库与金句积累（花生十三体系）',
    tags: ['申论知识', '申论素材', '大作文素材', '花生十三']
  },
  {
    srcRel: 'shenlun-mingshi/gongwen-gezhi.md',
    outFile: 'sl-doc-gongwen-gezhi.md',
    id: 'sl-doc-gongwen-gezhi',
    kind: 'knowledge',
    title: '公文格式速查手册（15+文种）',
    tags: ['申论知识', '公文格式', '速查手册']
  },
  {
    srcRel: 'shenlun-mingshi/guifan-biaoda.md',
    outFile: 'sl-doc-guifan-biaoda.md',
    id: 'sl-doc-guifan-biaoda',
    kind: 'knowledge',
    title: '申论规范表达与政府高频用语',
    tags: ['申论知识', '规范表达', '政府用语']
  },
  {
    srcRel: 'shenlun-mingshi/jinju-sucai.md',
    outFile: 'sl-doc-jinju-sucai.md',
    id: 'sl-doc-jinju-sucai',
    kind: 'knowledge',
    title: '申论金句与分论点素材库',
    tags: ['申论知识', '金句', '素材库', '分论点']
  }
]

function parseArgs(args) {
  const opts = {
    src: '',
    vault: '',
    sqlite: '',
    dryRun: false,
    sourceLabel: 'shenlun-export-20261124'
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--src') opts.src = args[++i] ?? ''
    else if (arg === '--vault') opts.vault = args[++i] ?? ''
    else if (arg === '--sqlite') opts.sqlite = args[++i] ?? ''
    else if (arg === '--source-label') opts.sourceLabel = args[++i] ?? opts.sourceLabel
  }
  return opts
}

function cleanPlainText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`\[\]|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractSummary(markdownBody, fallbackTitle) {
  const lines = String(markdownBody ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const picked = []
  let inCodeFence = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue
    if (!line) {
      if (picked.length > 0) break
      continue
    }
    if (/^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line) || /^\|[-:\s|]+\|$/.test(line)) {
      if (picked.length > 0) break
      continue
    }
    const plain = cleanPlainText(line)
    if (plain) picked.push(plain)
    if (picked.join(' ').length >= 140) break
  }
  const summary = picked.join(' ').slice(0, 140).trim()
  if (summary) return summary
  const fallback = cleanPlainText(markdownBody).slice(0, 140).trim()
  return fallback || fallbackTitle
}

function buildDocMarkdown({
  id,
  subject = 'shenlun',
  kind,
  title,
  summary,
  tags,
  sourceLabel,
  body
}) {
  const normalizedBody = String(body ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()

  return [
    '---',
    `id: ${yamlQuote(id)}`,
    `subject: ${yamlQuote(subject)}`,
    `kind: ${yamlQuote(kind)}`,
    `title: ${yamlQuote(title)}`,
    `summary: ${yamlQuote(summary)}`,
    `tags: ${JSON.stringify(tags)}`,
    `source: ${yamlQuote(sourceLabel)}`,
    'reviewStatus: "approved"',
    'generatedBy: "direct-import"',
    '---',
    '',
    normalizedBody,
    ''
  ].join('\n')
}

function buildHotspotCompendium(hotspotsRaw, sourceLabel) {
  const hotspots = Array.isArray(hotspotsRaw)
    ? hotspotsRaw
    : Array.isArray(hotspotsRaw?.hotspots)
      ? hotspotsRaw.hotspots
      : []

  const enriched = hotspots.map((entry, idx) => {
    const segs = entry?.segs && typeof entry.segs === 'object' ? entry.segs : {}
    const others = Array.isArray(entry?.others) ? entry.others : []
    const segEntries = []
    for (const segName of [
      '内涵',
      '角度',
      '金句',
      ...Object.keys(segs).filter((k) => !['内涵', '角度', '金句'].includes(k))
    ]) {
      const list = Array.isArray(segs[segName]) ? segs[segName] : []
      for (const item of list) {
        segEntries.push({ label: segName, item })
      }
    }
    const otherEntries = others.map((item) => ({
      label: String(item?.type || '素材').trim(),
      item
    }))
    const allEntries = [...segEntries, ...otherEntries]
    return {
      idx,
      topic: String(entry?.topic || `专题${idx + 1}`).trim(),
      entries: allEntries
    }
  })

  const totalItems = enriched.reduce((sum, h) => sum + h.entries.length, 0)
  const multiTopics = enriched
    .filter((h) => h.entries.length >= 2)
    .sort((a, b) => b.entries.length - a.entries.length || a.idx - b.idx)
  const singleTopics = enriched.filter((h) => h.entries.length === 1)

  const lines = [
    `# 申论热点专题素材汇编（${enriched.length}专题 / ${totalItems}条）`,
    '',
    `按 \`db/shenlun_hotspots.json\` 专题视图整理，共收录 **${enriched.length}** 个申论高频专题、**${totalItems}** 条政策理论、金句、案例与范文素材。`,
    '',
    `## 一、核心高频专题（${multiTopics.length}个多素材专题）`,
    ''
  ]

  for (const h of multiTopics) {
    lines.push(`### ${h.topic}（${h.entries.length}条）`, '')
    h.entries.forEach(({ label, item }, i) => {
      const content = String(item?.content ?? '')
        .replace(/\r\n/g, '\n')
        .trim()
      const refSource = String(item?.source ?? '').trim()
      const idSuffix = item?.id != null ? ` #${item.id}` : ''
      lines.push(`#### ${i + 1}. [${label}${idSuffix}]`, '', content, '')
      if (refSource) {
        lines.push(`> 出处：${refSource}`, '')
      }
    })
  }

  lines.push(`## 二、其余专题索引（${singleTopics.length}个单项专题）`, '')

  const preferredTypes = ['政策理论', '金句', '案例', '范文']
  const buckets = new Map(preferredTypes.map((t) => [t, []]))
  for (const h of singleTopics) {
    const entry = h.entries[0]
    const typeKey = String(entry?.item?.type || entry?.label || '其他').trim()
    if (!buckets.has(typeKey)) buckets.set(typeKey, [])
    buckets.get(typeKey).push({ topic: h.topic, item: entry.item })
  }

  for (const [typeKey, items] of buckets) {
    if (!items.length) continue
    lines.push(`### ${typeKey}（${items.length}条）`, '')
    for (const { topic, item } of items) {
      const content = String(item?.content ?? '')
        .replace(/\r\n/g, '\n')
        .trim()
      const refSource = String(item?.source ?? '').trim()
      const idSuffix = item?.id != null ? `（#${item.id}）` : ''
      lines.push(`**${topic}${idSuffix}**`, '', content, '')
      if (refSource) {
        lines.push(`> 出处：${refSource}`, '')
      }
    }
  }

  const title = `申论热点专题素材汇编（${enriched.length}专题 / ${totalItems}条）`
  const sampleTopics = multiTopics
    .slice(0, 8)
    .map((h) => h.topic)
    .join('、')
  const summary =
    `聚合 ${enriched.length} 个申论热点专题与 ${totalItems} 条政策理论/金句/案例/范文素材，涵盖${sampleTopics}等高频主题。`.slice(
      0,
      140
    )
  const body = lines.join('\n').trimEnd()
  const markdown = buildDocMarkdown({
    id: 'sl-doc-hotspots-compendium',
    kind: 'knowledge',
    title,
    summary,
    tags: ['申论知识', '热点专题', '申论素材', '金句', '政策理论', '案例', '范文'],
    sourceLabel,
    body
  })

  return {
    id: 'sl-doc-hotspots-compendium',
    fileName: 'sl-doc-hotspots-compendium.md',
    kind: 'knowledge',
    title,
    summary,
    tags: ['申论知识', '热点专题', '申论素材', '金句', '政策理论', '案例', '范文'],
    markdown,
    meta: {
      totalTopics: enriched.length,
      totalItems,
      multiTopics: multiTopics.length,
      singleTopics: singleTopics.length
    }
  }
}

export function runImportShenlunExport(opts) {
  const srcDir = resolve(opts.src)
  const vaultDir = resolve(opts.vault)
  const sourceLabel = opts.sourceLabel || 'shenlun-export-20261124'

  const knowledgeSrcDir = join(srcDir, 'knowledge')
  const sqliteSrcPath = join(srcDir, 'db', 'shenlun.sqlite')
  const hotspotsPath = join(srcDir, 'db', 'shenlun_hotspots.json')

  if (!existsSync(knowledgeSrcDir)) throw new Error(`未找到 knowledge 目录：${knowledgeSrcDir}`)
  if (!existsSync(sqliteSrcPath)) throw new Error(`未找到 db/shenlun.sqlite：${sqliteSrcPath}`)
  if (!existsSync(hotspotsPath)) throw new Error(`未找到 db/shenlun_hotspots.json：${hotspotsPath}`)
  if (!existsSync(vaultDir)) throw new Error(`目标题库目录不存在：${vaultDir}`)

  const slKnowledgeOutDir = join(vaultDir, 'shenlun-knowledge')
  const kgVaultOutDir = join(vaultDir, 'tizhou-kaogong-vault')

  const docsToWrite = []

  // 1. 准备 23 份 knowledge/ 文档
  let knowledgeDocCount = 0
  let methodDocCount = 0
  for (const spec of KNOWLEDGE_MAPPINGS) {
    const srcPath = join(knowledgeSrcDir, spec.srcRel)
    if (!existsSync(srcPath)) throw new Error(`缺少预期知识文档：${srcPath}`)
    const raw = readFileSync(srcPath, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/^(?:[ \t]*\n)+/, '')
      .trimEnd()
    const summary = extractSummary(raw, spec.title)
    const markdown = buildDocMarkdown({
      id: spec.id,
      kind: spec.kind,
      title: spec.title,
      summary,
      tags: spec.tags,
      sourceLabel,
      body: raw
    })
    docsToWrite.push({
      group: 'knowledge',
      id: spec.id,
      subject: 'shenlun',
      kind: spec.kind,
      title: spec.title,
      summary,
      tags: spec.tags,
      filePath: join(slKnowledgeOutDir, spec.outFile),
      markdown
    })
    if (spec.kind === 'method') methodDocCount += 1
    else knowledgeDocCount += 1
  }

  // 2. 扫描已有 kg-sc-*.md，补齐缺失素材（预期 28 条金句）
  const existingScIds = new Set()
  const existingTitles = new Set()
  if (existsSync(kgVaultOutDir)) {
    for (const fileName of readdirSync(kgVaultOutDir)) {
      if (!fileName.startsWith('kg-sc-') || !fileName.endsWith('.md')) continue
      const raw = readFileSync(join(kgVaultOutDir, fileName), 'utf8')
      const fm = matter(raw).data ?? {}
      const docId = String(fm.id || fileName.replace(/\.md$/, '')).trim()
      existingScIds.add(docId)
      if (fm.title) existingTitles.add(String(fm.title).trim())
    }
  }

  const slDb = new DatabaseSync(sqliteSrcPath, { readOnly: true })
  const allMaterials = slDb
    .prepare('SELECT id, type, topic, content, source FROM shenlun_materials ORDER BY id')
    .all()
  slDb.close()

  let addedMaterialsCount = 0
  const missingTypeCounts = {}
  for (const row of allMaterials) {
    const id = `kg-sc-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`
    if (existingScIds.has(id)) continue

    const matType = String(row.type ?? '').trim()
    const matTopic = String(row.topic ?? '').trim()
    const content = String(row.content ?? '')
      .replace(/\r\n/g, '\n')
      .trim()
    const refSource = String(row.source ?? '').trim()
    if (!content) continue

    const baseTitle = matTopic || matType || '申论素材'
    let title = baseTitle
    if (existingTitles.has(title)) {
      let suffix = 2
      while (existingTitles.has(`${baseTitle}（${suffix}）`)) suffix += 1
      title = `${baseTitle}（${suffix}）`
    }
    existingTitles.add(title)

    const tags = ['申论素材', matType, matTopic].filter(Boolean)
    const summary = cleanPlainText(content).slice(0, 120) || title
    const body = [
      `# ${title}`,
      '',
      content,
      ...(refSource ? ['', `> 出处：${refSource}`] : [])
    ].join('\n')
    const markdown = buildDocMarkdown({
      id,
      kind: 'knowledge',
      title,
      summary,
      tags,
      sourceLabel,
      body
    })

    docsToWrite.push({
      group: 'material',
      id,
      subject: 'shenlun',
      kind: 'knowledge',
      title,
      summary,
      tags,
      filePath: join(kgVaultOutDir, `${id}.md`),
      markdown
    })
    addedMaterialsCount += 1
    missingTypeCounts[matType || '未分类'] = (missingTypeCounts[matType || '未分类'] || 0) + 1
  }

  // 3. 整理热点专题汇编文档
  const hotspotsRaw = JSON.parse(readFileSync(hotspotsPath, 'utf8'))
  const compendium = buildHotspotCompendium(hotspotsRaw, sourceLabel)
  docsToWrite.push({
    group: 'hotspot',
    id: compendium.id,
    subject: 'shenlun',
    kind: compendium.kind,
    title: compendium.title,
    summary: compendium.summary,
    tags: compendium.tags,
    filePath: join(slKnowledgeOutDir, compendium.fileName),
    markdown: compendium.markdown
  })

  // 4. 用 gray-matter 逐一校验生成结果
  for (const doc of docsToWrite) {
    const parsed = matter(doc.markdown)
    const parsedContent = parsed.content.trim()
    if (!parsed.data?.id || !parsed.data?.title || !parsedContent) {
      throw new Error(`生成的文档校验失败：${doc.filePath}`)
    }
    doc.parsedContent = parsedContent
  }

  let sqliteSynced = 0
  let activeVaultId = ''
  let totalVaultDocuments = 0

  if (!opts.dryRun) {
    mkdirSync(slKnowledgeOutDir, { recursive: true })
    mkdirSync(kgVaultOutDir, { recursive: true })
    for (const doc of docsToWrite) {
      mkdirSync(dirname(doc.filePath), { recursive: true })
      writeFileSync(doc.filePath, doc.markdown, 'utf8')
    }

    if (opts.sqlite) {
      const sqlitePath = resolve(opts.sqlite)
      if (!existsSync(sqlitePath)) {
        throw new Error(`未找到 workbench.sqlite：${sqlitePath}`)
      }
      const wb = new DatabaseSync(sqlitePath)
      wb.exec('PRAGMA busy_timeout = 5000;')
      const normVaultPath = (p) =>
        process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
      const targetVaultNorm = normVaultPath(vaultDir)
      const allVaults = wb.prepare('SELECT id, path, active FROM vault_registry').all()
      const vaultRow =
        allVaults.find((row) => normVaultPath(String(row.path)) === targetVaultNorm) ??
        allVaults.find((row) => Number(row.active) === 1)
      if (!vaultRow) {
        wb.close()
        throw new Error(`workbench.sqlite 中未找到匹配的 vault_registry 记录（目标：${vaultDir}）`)
      }
      activeVaultId = String(vaultRow.id)
      const indexedAt = new Date().toISOString()

      const upsertStmt = wb.prepare(
        `INSERT OR REPLACE INTO documents(
           id, vault_id, subject, kind, title, summary, content, tags_json, file_path, indexed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      wb.exec('BEGIN IMMEDIATE')
      try {
        for (const doc of docsToWrite) {
          upsertStmt.run(
            `${activeVaultId}:${doc.id}`,
            activeVaultId,
            doc.subject,
            doc.kind,
            doc.title,
            doc.summary,
            doc.parsedContent,
            JSON.stringify(doc.tags),
            doc.filePath,
            indexedAt
          )
          sqliteSynced += 1
        }
        const countRow = wb
          .prepare('SELECT COUNT(*) AS cnt FROM documents WHERE vault_id = ?')
          .get(activeVaultId)
        totalVaultDocuments = Number(countRow?.cnt ?? 0)
        wb.prepare(
          'UPDATE vault_registry SET document_count = ?, last_indexed_at = ? WHERE id = ?'
        ).run(totalVaultDocuments, indexedAt, activeVaultId)
        wb.exec('COMMIT')
      } catch (err) {
        wb.exec('ROLLBACK')
        throw err
      } finally {
        wb.close()
      }
    }
  }

  return {
    dryRun: opts.dryRun,
    srcDir,
    vaultDir,
    knowledgeFilesTotal: KNOWLEDGE_MAPPINGS.length,
    methodDocs: methodDocCount,
    knowledgeDocs: knowledgeDocCount,
    addedMaterials: addedMaterialsCount,
    missingTypeCounts,
    hotspotCompendium: compendium.meta,
    totalWritten: docsToWrite.length,
    sqliteSynced,
    activeVaultId,
    totalVaultDocuments
  }
}

const isDirectMain =
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('import-shenlun-export.mjs')

if (isDirectMain) {
  const opts = parseArgs(argv.slice(2))
  if (!opts.src || !opts.vault) {
    console.error(
      '用法: node tools/import-shenlun-export.mjs --src <shenlun-export目录> --vault <题库根目录> [--sqlite <workbench.sqlite>] [--dry-run]'
    )
    exit(1)
  }
  const summary = runImportShenlunExport(opts)
  console.log(JSON.stringify(summary, null, 2))
}
