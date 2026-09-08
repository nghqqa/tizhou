#!/usr/bin/env node
// 知识库近重复扫描器（借鉴 kaogong-assistant 的相似度引擎思路）：
// 字符 3-gram → 64bit simhash → 4×16bit 分带倒排找候选 → Jaccard 精排定簇 → 并查集合并。
// 只检测不改库：产出 Markdown 报告 + 簇台账 JSONL（status: open/resolved/ignored），
// 处置决策由人工登记，避免脚本静默删题。
//
// 用法：
//   node tools/dedup-simhash.mjs <库目录> [--out <报告目录>] [--threshold 0.72] [--max-bucket 500]
// 不带 --out 时，报告写入兄弟目录 <库目录>.dedup-audit/（不污染知识库本身）。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { argv, exit } from 'node:process'
import matter from 'gray-matter'

const stripPunct = (value) => String(value ?? '').replace(/[^\p{L}\p{N}]+/gu, '')

// ---- simhash ----

function gramSetOf(text) {
  const normalized = stripPunct(text)
  const grams = new Set()
  if (normalized.length <= 3) {
    if (normalized) grams.add(normalized)
    return grams
  }
  for (let i = 0; i <= normalized.length - 3; i += 1) grams.add(normalized.slice(i, i + 3))
  return grams
}

function simhash64(grams) {
  const weights = new Array(64).fill(0)
  for (const gram of grams) {
    const digest = createHash('md5').update(gram, 'utf8').digest()
    let value = 0n
    for (let byte = 0; byte < 8; byte += 1) value = (value << 8n) | BigInt(digest[byte])
    for (let bit = 0; bit < 64; bit += 1) weights[bit] += (value >> BigInt(bit)) & 1n ? 1 : -1
  }
  let hash = 0n
  for (let bit = 0; bit < 64; bit += 1) if (weights[bit] > 0) hash |= 1n << BigInt(bit)
  return hash
}

function bandKeys(hash, bands = 4, width = 16) {
  const keys = []
  for (let band = 0; band < bands; band += 1) {
    keys.push((hash >> BigInt(band * width)) & ((1n << BigInt(width)) - 1n))
  }
  return keys
}

function jaccard(a, b) {
  if (a.size > b.size) return jaccard(b, a)
  let hit = 0
  for (const gram of a) if (b.has(gram)) hit += 1
  return hit / (a.size + b.size - hit)
}

// ---- 库扫描 ----

function walkMarkdown(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(fullPath)
    }
  }
  visit(root)
  return files
}

function questionTextOf(data, content) {
  const options = Array.isArray(data.options) ? data.options : []
  const parts = [data.stem || data.title, data.material, ...options.map((option) => option?.text)]
  const joined = parts.filter(Boolean).join('\n')
  return joined || String(content ?? '').slice(0, 400)
}

// ---- 主流程 ----

const vaultDir = resolve(argv[2] ?? '')
if (!vaultDir || !existsSync(vaultDir) || !statSync(vaultDir).isDirectory()) {
  console.error(
    '用法: node tools/dedup-simhash.mjs <库目录> [--out <报告目录>] [--threshold 0.72] [--max-bucket 500]'
  )
  exit(1)
}
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? Number(argv[index + 1]) : fallback
}
const threshold = flag('threshold', 0.72)
const maxBucket = flag('max-bucket', 500)
const outIndex = argv.indexOf('--out')
const outDir =
  outIndex >= 0 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]) : `${vaultDir}.dedup-audit`
mkdirSync(outDir, { recursive: true })

console.log(`扫描 ${vaultDir} …`)
const docs = []
for (const path of walkMarkdown(vaultDir)) {
  let parsed
  try {
    parsed = matter(readFileSync(path, 'utf8'))
  } catch {
    continue
  }
  const data = parsed.data ?? {}
  const text = questionTextOf(data, parsed.content)
  const grams = gramSetOf(text)
  if (grams.size < 4) continue // 过短文本无鉴别力（空壳/占位文档）
  docs.push({
    path,
    rel: relative(vaultDir, path).replace(/\\/g, '/'),
    category: String(data.category ?? data.title ?? '').trim(),
    head: stripPunct(text).slice(0, 40),
    grams,
    hash: null
  })
}
console.log(`解析 ${docs.length} 个 Markdown 文件，构建 simhash 索引 …`)
for (const doc of docs) doc.hash = simhash64(doc.grams)

const bands = new Map()
for (let index = 0; index < docs.length; index += 1) {
  for (const key of bandKeys(docs[index].hash)) {
    const bucket = bands.get(key)
    if (bucket) bucket.push(index)
    else bands.set(key, [index])
  }
}

const candidates = new Set()
let oversizedBuckets = 0
for (const bucket of bands.values()) {
  if (bucket.length < 2) continue
  if (bucket.length > maxBucket) {
    oversizedBuckets += 1
    continue
  }
  for (let i = 0; i < bucket.length; i += 1)
    for (let j = i + 1; j < bucket.length; j += 1)
      candidates.add(
        bucket[i] < bucket[j] ? `${bucket[i]}:${bucket[j]}` : `${bucket[j]}:${bucket[i]}`
      )
}

console.log(
  `候选对 ${candidates.size} 个（跳过超大桶 ${oversizedBuckets} 个），Jaccard ≥ ${threshold} 精排 …`
)
const parent = docs.map((_, index) => index)
const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])))
const union = (a, b) => {
  parent[find(a)] = find(b)
}
const nearPairs = []
const maxSimByRoot = new Map()
for (const key of candidates) {
  const [i, j] = key.split(':').map(Number)
  const similarity = jaccard(docs[i].grams, docs[j].grams)
  if (similarity >= threshold) {
    nearPairs.push([i, j, similarity])
    union(i, j)
  }
}
for (const [i, j, similarity] of nearPairs) {
  const root = find(i)
  const current = maxSimByRoot.get(root)
  if (current === undefined || similarity > current) maxSimByRoot.set(root, similarity)
}

const clusters = new Map()
for (let index = 0; index < docs.length; index += 1) {
  const root = find(index)
  const members = clusters.get(root)
  if (members) members.push(index)
  else clusters.set(root, [index])
}
const realClusters = [...clusters.values()].filter((members) => members.length >= 2)
realClusters.sort((a, b) => b.length - a.length)

const ledgerPath = join(outDir, 'dedup-clusters.jsonl')
const ledgerLines = realClusters.map((members, clusterId) =>
  JSON.stringify({
    cluster_id: clusterId + 1,
    status: 'open',
    max_similarity: Number((maxSimByRoot.get(find(members[0])) ?? 0).toFixed(4)),
    members: members.map((index) => ({
      file: docs[index].rel,
      category: docs[index].category,
      head: docs[index].head
    }))
  })
)
writeFileSync(ledgerPath, ledgerLines.length ? ledgerLines.join('\n') + '\n' : '', 'utf8')

const report = [
  '# 知识库近重复扫描报告',
  '',
  `- 库目录：${vaultDir}`,
  `- 扫描文件：${docs.length}；阈值：Jaccard ≥ ${threshold}；分带：4×16bit；桶上限：${maxBucket}`,
  `- 近重复对：${nearPairs.length}；重复簇：${realClusters.length}；跳过超大桶：${oversizedBuckets}`,
  `- 台账：dedup-clusters.jsonl（status 初始为 open；处置后人工改为 resolved/ignored 并补 note）`,
  '',
  '| 簇 | 成员数 | 最高相似度 | 类别 | 成员（相对路径 @ 题干摘要） |',
  '|---|---|---|---|---|'
]
realClusters.slice(0, 200).forEach((members, index) => {
  const similarity = maxSimByRoot.get(find(members[0])) ?? 0
  const categories = [...new Set(members.map((item) => docs[item].category).filter(Boolean))].join(
    ' / '
  )
  const list = members.map((item) => `${docs[item].rel} @ ${docs[item].head}`).join('<br>')
  report.push(
    `| ${index + 1} | ${members.length} | ${similarity.toFixed(3)} | ${categories} | ${list} |`
  )
})
if (realClusters.length > 200)
  report.push('', `（其余 ${realClusters.length - 200} 个簇见台账 JSONL）`)
writeFileSync(join(outDir, 'simhash-report.md'), report.join('\n') + '\n', 'utf8')

console.log(
  `完成：${docs.length} 个文件，${nearPairs.length} 个近重复对，${realClusters.length} 个簇。` +
    `\n报告：${join(outDir, 'simhash-report.md')}\n台账：${ledgerPath}`
)
