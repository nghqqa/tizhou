#!/usr/bin/env node
// 一键化发版流水线：把手工发版 runbook 固化为硬门禁脚本。
// 完整流程六阶段：
//   Stage 1 前置门禁     分支/工作区/版本一致性/CHANGELOG 段落/发版说明/防误传路径
//   Stage 2 校验与打包   format:check → typecheck → test → test:e2e → smoke:packaged → package，
//                        latest.yml 强校验 + SHA256SUMS.txt 生成与回读二次校验
//   Stage 3 Tag 与推送   幂等创建附注 tag v*（必须指向 HEAD），双端推送 master 与 tag，等待 origin CI 全绿
//   Stage 4 双源上架     GitHub（gh release）+ CNB（复用 cnb-upload 模块）幂等创建/覆盖上传四件套
//   Stage 5 匿名门禁     无任何鉴权核验双源四件套公开直链（哈希/版本/字节数/Range 首尾字节）
//   Stage 6 官网同步     website 三文件版本替换 → website typecheck + build → verify-website 全绿
//
// 用法：
//   npm run release                        完整发版（版本读根 package.json）
//   npm run release -- --version 1.0.17    强校验传入版本与 package.json 一致
//   npm run release -- --skip-tests        跳过耗时测试阶段（默认不跳过）
//   npm run release -- --dry-run           前置检查 + 既有 dist 产物核验 + release.ts 替换预演，零远端写入
//   npm run release -- --verify-only [ver] 仅匿名门禁校验（本地 dist 若存在则一并核验 + GitHub/CNB 线上双源）
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CNB_REPO, ensureCnbRelease, resolveCnbToken, uploadCnbAssets } from './cnb-upload.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GITHUB_REPO = 'nghqqa/tizhou'
const VERSION_RE = /^\d+\.\d+\.\d+$/

// ── 通用小工具 ────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log('[release]', ...parts)
const banner = (n, label) => console.log(`\n[release] ── Stage ${n}/6 ${label} ──`)
const formatBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${n} B`)
/** 归一化文本比较（容 CRLF 与尾随空白，杜绝换行符差异误判） */
const normalizeText = (text) =>
  String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim()

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'))
const writeJson = (filePath, value) =>
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')

/** 执行子进程；win32 下 npm/npx 走 shell（.cmd 解析），git/gh/node 直接 PATH 解析 */
function run(cmd, args, opts = {}) {
  const {
    cwd = ROOT,
    label = [cmd, ...args].join(' '),
    inherit = false,
    shell = process.platform === 'win32' && /^(npm|npx)(\.cmd)?$/.test(cmd),
    timeout
  } = opts
  const res = spawnSync(cmd, args, {
    cwd,
    timeout,
    shell,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })
  if (res.error) throw new Error(`${label}：进程启动失败：${res.error.message}`)
  if (res.status !== 0) {
    const tail = (text) =>
      String(text ?? '')
        .trimEnd()
        .split(/\r?\n/)
        .slice(-15)
        .join('\n')
    throw new Error(
      `${label}：退出码 ${res.status}` +
        (res.stdout && !inherit ? `\n${tail(res.stdout)}` : '') +
        (res.stderr ? `\n${tail(res.stderr)}` : '')
    )
  }
  return String(res.stdout ?? '')
}

// ── 纯函数（导出供 tests/release-script.test.ts 覆盖）─────

/** 解析 electron-builder latest.yml（files 数组形态或 legacy path/sha512 形态），畸形结构直接抛错 */
export function parseLatestYml(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) throw new Error('latest.yml 内容为空')
  let version = null
  const files = []
  const legacy = {}
  let inFiles = false
  let current = null
  const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, '')
  const assignField = (target, key, value) => {
    if (key === 'size') target.size = Number(value.trim())
    else target[key] = unquote(value)
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = line.match(/^(\s*)-\s+/)
    if (item && inFiles) {
      if (current) files.push(current)
      current = {}
      const kv = line.slice(item[0].length).match(/^([\w-]+):\s*(.*)$/)
      if (kv) assignField(current, kv[1], kv[2])
      continue
    }
    if (current && /^\s/.test(line)) {
      const kv = line.trim().match(/^([\w-]+):\s*(.*)$/)
      if (kv) assignField(current, kv[1], kv[2])
      continue
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (!kv) continue
    if (current) {
      files.push(current)
      current = null
    }
    if (kv[1] === 'version') version = unquote(kv[2])
    else if (kv[1] === 'files') inFiles = true
    else legacy[kv[1]] = unquote(kv[2])
  }
  if (current) files.push(current)
  if (files.length === 0 && legacy.path) {
    files.push({ url: legacy.path, sha512: legacy.sha512 ?? '', size: null })
  }
  if (!version) throw new Error('latest.yml 缺少 version 字段')
  if (files.length === 0 || files.some((entry) => !entry.url)) {
    throw new Error('latest.yml 未解析到任何有效文件条目')
  }
  return { version, files }
}

/** latest.yml 与目标版本/磁盘字节数强校验；任一不符即抛错（篡改/错版/截断全部拦截） */
export function assertLatestYmlConsistency(yml, { version, exeName, exeSize }) {
  if (yml.version !== version) {
    throw new Error(`latest.yml version 不一致：期望 ${version}，实际 ${yml.version}`)
  }
  const entry = yml.files.find((item) => item.url === exeName)
  if (!entry) {
    throw new Error(
      `latest.yml 缺少 ${exeName} 条目（实际包含：${yml.files.map((item) => item.url).join(', ')}）`
    )
  }
  if (exeSize != null) {
    if (!Number.isFinite(entry.size)) {
      throw new Error(`latest.yml ${exeName} 缺少有效 size 字段`)
    }
    if (entry.size !== exeSize) {
      throw new Error(`latest.yml 字节数与磁盘不符：期望 ${exeSize}，实际 ${entry.size}`)
    }
  }
  return entry
}

/** 流式计算文件 SHA-256（安装包 130MB 级别不整读进内存） */
export async function computeSha256Hex(filePath) {
  return await new Promise((resolveHash, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** 生成 sha256sum -b 风格内容：`<hex> *<name>` 行，LF 结尾 */
export function buildSha256SumsText(entries) {
  return entries.map((entry) => `${entry.hash} *${entry.name}`).join('\n') + '\n'
}

/** 解析 SHA256SUMS.txt → Map<name, hash>；存在非法行直接抛错 */
export function parseSha256SumsText(content) {
  const byName = new Map()
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
  for (const line of lines) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (!match) throw new Error(`SHA256SUMS.txt 存在非法行：${line.slice(0, 80)}`)
    byName.set(match[2].trim(), match[1].toLowerCase())
  }
  if (byName.size === 0) throw new Error('SHA256SUMS.txt 内容为空')
  return byName
}

/** 回读二次校验：逐条核对哈希，且不允许出现预期之外的条目 */
export function verifySha256SumsContent(content, entries) {
  const byName = parseSha256SumsText(content)
  for (const entry of entries) {
    const actual = byName.get(entry.name)
    if (!actual) throw new Error(`SHA256SUMS.txt 缺少 ${entry.name} 条目`)
    if (actual !== entry.hash.toLowerCase()) {
      throw new Error(
        `SHA256SUMS.txt 哈希不一致：${entry.name} 期望 ${entry.hash.toLowerCase()}，实际 ${actual}`
      )
    }
  }
  if (byName.size !== entries.length) {
    const expected = new Set(entries.map((entry) => entry.name))
    const extra = [...byName.keys()].filter((name) => !expected.has(name))
    throw new Error(`SHA256SUMS.txt 出现意外条目：${extra.join(', ')}`)
  }
  return true
}

/** 防误传门禁：仓库根目录不允许遗留 SHA256SUMS.txt（校验和只允许存在于 dist/） */
export function assertNoStrayRootSha256Sums(rootDir) {
  const stray = path.join(rootDir, 'SHA256SUMS.txt')
  if (fs.existsSync(stray)) {
    throw new Error(
      `检测到仓库根目录存在遗留 SHA256SUMS.txt：${stray}\n` +
        '请先清理该文件——校验和只允许生成在 dist/ 内，根目录同名文件会让下游误读旧版本哈希'
    )
  }
}

/** 防误传路径门禁：目标路径必须严格位于指定目录内（构建产物路径强制 ROOT/dist） */
export function assertInsideDir(filePath, dirPath, label) {
  const resolved = path.resolve(filePath)
  const dir = path.resolve(dirPath)
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error(
      `${label ?? '路径'} 越出 ${dir}：${resolved}（构建产物路径必须固定在 dist/ 内，防误传门禁）`
    )
  }
  return resolved
}

export function distPath(...names) {
  return assertInsideDir(
    path.resolve(ROOT, 'dist', ...names),
    path.resolve(ROOT, 'dist'),
    'dist 产物路径'
  )
}

/** release.ts 版本替换：带数字/点边界的全量替换 + sizeHint 更新，未命中/残留即抛错（幂等安全） */
export function applyReleaseTsReplacement(source, { oldVersion, newVersion, sizeHint }) {
  if (!VERSION_RE.test(oldVersion) || !VERSION_RE.test(newVersion)) {
    throw new Error(`版本号格式非法：old=${oldVersion} new=${newVersion}（期望 X.Y.Z）`)
  }
  // 边界语义：前面不能是数字（11.0.16 不算 1.0.16 的落点）；后面不能是数字或「.数字」
  // （1.0.161 / 1.0.16.5 视为更长版本号），但「.exe」这类「.非数字」必须放行
  const boundary = (ver) => new RegExp(`(?<!\\d)${ver.replace(/\./g, '\\.')}(?!\\d)(?!\\.\\d)`, 'g')
  if (!boundary(oldVersion).test(source)) {
    throw new Error(
      `release.ts 未找到版本 ${oldVersion}，替换中止（请先人工核对 website/src/release.ts）`
    )
  }
  let next = source.replace(boundary(oldVersion), newVersion)
  if (sizeHint) next = next.replace(/sizeHint:\s*'[^']*'/, `sizeHint: '${sizeHint}'`)
  if (oldVersion !== newVersion && boundary(oldVersion).test(next)) {
    throw new Error(`release.ts 替换后仍残留 ${oldVersion}，中止（防止半版本号误替换）`)
  }
  return next
}

/** 解析 Content-Range 头的总长度（`bytes 0-0/136141710` → 136141710；非法返回 null） */
export function parseContentRangeTotal(header) {
  const match = String(header ?? '').match(/^bytes\s+\d+-\d+\/(\d+)$/)
  return match ? Number(match[1]) : null
}

/** Range 响应硬校验：206 + 区间精确 + 总长度精确，任一不符即抛错 */
export function assertRangeResponse({
  status,
  contentRange,
  rangeStart,
  rangeEnd,
  expectedTotal,
  label
}) {
  if (status !== 206) throw new Error(`${label}：Range 请求应返回 206，实际 ${status}`)
  const match = String(contentRange ?? '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/)
  if (!match) throw new Error(`${label}：Content-Range 缺失或格式非法（${contentRange || '无'}）`)
  if (Number(match[1]) !== rangeStart || Number(match[2]) !== rangeEnd) {
    throw new Error(
      `${label}：Content-Range 区间不符：期望 ${rangeStart}-${rangeEnd}，实际 ${match[1]}-${match[2]}`
    )
  }
  if (Number(match[3]) !== expectedTotal) {
    throw new Error(`${label}：Content-Range 总长度不符：期望 ${expectedTotal}，实际 ${match[3]}`)
  }
}

/** CLI 参数解析：--version X / --version=X / --dry-run / --skip-tests / --verify-only [ver] */
export function parseArgs(argv = []) {
  const parsed = { version: '', dryRun: false, skipTests: false, verifyOnly: false, help: false }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--skip-tests') parsed.skipTests = true
    else if (arg === '--verify-only') parsed.verifyOnly = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--version') {
      const value = argv[index + 1]
      if (!value) throw new Error('--version 需要跟版本号参数')
      parsed.version = value
      index += 1
    } else if (arg.startsWith('--version=')) {
      parsed.version = arg.slice('--version='.length)
    } else rest.push(arg)
  }
  if (parsed.version && !VERSION_RE.test(parsed.version)) {
    throw new Error(`--version 版本号格式非法：${parsed.version}（期望 X.Y.Z）`)
  }
  // --verify-only 支持位置参数版本：node scripts/release.mjs --verify-only 1.0.16
  if (parsed.verifyOnly && !parsed.version && rest.length > 0 && VERSION_RE.test(rest[0])) {
    parsed.version = rest.shift()
  }
  parsed.rest = rest
  return parsed
}

// ── 匿名 HTTP 门禁探针 ────────────────────────────────────

/** 匿名 fetch（绝不携带任何鉴权头）；Range 探测用 */
async function fetchAnonymous(url, { range, method = 'GET', timeoutMs = 60_000 } = {}) {
  const headers = {}
  if (range) headers.Range = range
  return await fetch(url, {
    method,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  })
}

async function fetchTextGate(url, label) {
  const res = await fetchAnonymous(url)
  if (res.status === 404) throw new Error(`${label}：线上 404（资产未上架或版本号有误）：${url}`)
  if (res.status !== 200) throw new Error(`${label}：期望 200，实际 ${res.status}`)
  return await res.text()
}

async function drainResponse(res) {
  try {
    await res.body?.cancel()
  } catch {
    // 释放连接失败不阻断
  }
}

/** Range 双字节探针：206 + Content-Range 区间与总长度精确匹配 */
async function assertRangeGate(url, start, end, expectedTotal, label) {
  const res = await fetchAnonymous(url, { range: `bytes=${start}-${end}` })
  if (res.status === 200) {
    await drainResponse(res)
    throw new Error(`${label}：服务器忽略 Range（返回 200 全量响应），匿名门禁拒绝`)
  }
  const contentRange = res.headers.get('content-range') ?? ''
  await drainResponse(res)
  assertRangeResponse({
    status: res.status,
    contentRange,
    rangeStart: start,
    rangeEnd: end,
    expectedTotal,
    label
  })
}

/** SHA256SUMS 退避重试：命中 CDN 旧缓存时按 3/6/12/20/30s 重试后仍不一致才判死 */
async function fetchSumsGate(url, expectedSums, label) {
  const delays = [3_000, 6_000, 12_000, 20_000, 30_000]
  const expectedMap = expectedSums ? parseSha256SumsText(expectedSums) : null
  for (let attempt = 0; ; attempt += 1) {
    const text = await fetchTextGate(url, label)
    const actualMap = parseSha256SumsText(text)
    if (!expectedMap || sumsMapsEqual(expectedMap, actualMap)) return text
    if (attempt >= delays.length) {
      throw new Error(
        `${label}：与目标版本哈希不一致（疑似 CDN 旧缓存残留），已退避重试 ${attempt} 次`
      )
    }
    log(
      `ℹ ${label}：内容与目标版本不符（疑似旧缓存），${delays[attempt] / 1000}s 后重试（${attempt + 1}/${delays.length}）`
    )
    await sleep(delays[attempt])
  }
}

function sumsMapsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const [name, hash] of a) {
    if (b.get(name) !== hash) return false
  }
  return true
}

// ── Stage 实现 ────────────────────────────────────────────

function sourceUrls(version) {
  return [
    { label: 'GitHub', base: `https://github.com/${GITHUB_REPO}/releases/download/v${version}` },
    { label: 'CNB', base: `https://cnb.cool/${CNB_REPO}/-/releases/download/v${version}` }
  ]
}

/** Stage 1 前置门禁：防误传 + 版本一致性 + CHANGELOG/发版说明 +（可放宽的）分支/工作区 */
async function stage1Preflight(ctx) {
  banner(1, '前置门禁')
  assertNoStrayRootSha256Sums(ROOT)
  log('✓ 根目录无遗留 SHA256SUMS.txt')
  const pkg = readJson(path.join(ROOT, 'package.json'))
  ctx.version = ctx.requestedVersion || pkg.version
  if (!VERSION_RE.test(ctx.version)) {
    throw new Error(`版本号格式非法：${ctx.version}（期望 X.Y.Z）`)
  }
  if (ctx.requestedVersion && ctx.requestedVersion !== pkg.version) {
    throw new Error(
      `--version ${ctx.requestedVersion} 与 package.json 版本 ${pkg.version} 不一致（强校验失败）`
    )
  }
  const lock = readJson(path.join(ROOT, 'package-lock.json'))
  if (lock.version !== ctx.version) {
    throw new Error(`package-lock.json 版本 ${lock.version} 与 ${ctx.version} 不一致`)
  }
  log(`✓ package.json / package-lock.json 版本一致：${ctx.version}`)
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
  const sectionRe = new RegExp(`^## ${ctx.version.replace(/\./g, '\\.')}([\\s-]|$)`, 'm')
  if (!sectionRe.test(changelog)) {
    throw new Error(`CHANGELOG.md 缺少 "## ${ctx.version}" 段落`)
  }
  log(`✓ CHANGELOG.md 存在 ${ctx.version} 段落`)
  const notesPath = path.join(ROOT, 'docs', `release-notes-${ctx.version}.md`)
  if (!fs.existsSync(notesPath) || fs.statSync(notesPath).size === 0) {
    throw new Error(`发版说明缺失或为空：docs/release-notes-${ctx.version}.md`)
  }
  ctx.notesPath = notesPath
  log(`✓ 发版说明就绪：docs/release-notes-${ctx.version}.md`)
  ctx.exeName = `tizhou-setup-${ctx.version}.exe`
  if (!ctx.relaxGit) {
    const branch = run('git', ['branch', '--show-current']).trim()
    if (branch !== 'master') throw new Error(`必须在 master 分支发版，当前分支：${branch}`)
    const porcelain = run('git', ['status', '--porcelain'])
    if (porcelain.trim()) {
      throw new Error(
        `工作区不干净，先提交或清理：\n${porcelain
          .trimEnd()
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')}`
      )
    }
    log('✓ 当前在 master 分支且工作区干净')
  } else {
    log('ℹ 宽松模式（--dry-run/--verify-only）：跳过分支/工作区检查')
  }
}

/**
 * 本地 dist/ 产物核验：三件套存在非空 → latest.yml 强校验 → SHA256SUMS 重算比对。
 * writeSums=true（完整/dry-run 流程）：生成 dist/SHA256SUMS.txt 并回读二次校验；
 * writeSums=false（--verify-only）：只读，不落盘；返回 false 表示本地缺该版本产物。
 */
async function verifyLocalDist(ctx, { writeSums }) {
  const exeName = ctx.exeName
  const exePath = distPath(exeName)
  const blockmapPath = distPath(`${exeName}.blockmap`)
  const ymlPath = distPath('latest.yml')
  const sumsPath = distPath('SHA256SUMS.txt')
  ctx.distFiles = [exePath, blockmapPath, ymlPath, sumsPath]
  if (!fs.existsSync(exePath) || !fs.existsSync(blockmapPath) || !fs.existsSync(ymlPath)) {
    return false
  }
  for (const [filePath, name] of [
    [exePath, exeName],
    [blockmapPath, `${exeName}.blockmap`],
    [ymlPath, 'latest.yml']
  ]) {
    const size = fs.statSync(filePath).size
    if (size <= 0) throw new Error(`构建产物为空文件：${name}`)
    log(`✓ dist/${name} 存在（${formatBytes(size)}）`)
  }
  ctx.exeSize = fs.statSync(exePath).size
  ctx.blockmapSize = fs.statSync(blockmapPath).size
  ctx.ymlRaw = fs.readFileSync(ymlPath, 'utf8')
  const yml = parseLatestYml(ctx.ymlRaw)
  assertLatestYmlConsistency(yml, { version: ctx.version, exeName, exeSize: ctx.exeSize })
  log(`✓ latest.yml 强校验通过：version=${yml.version}，${exeName} size=${ctx.exeSize} 与磁盘一致`)
  const entries = [
    { name: exeName, hash: await computeSha256Hex(exePath) },
    { name: `${exeName}.blockmap`, hash: await computeSha256Hex(blockmapPath) },
    { name: 'latest.yml', hash: await computeSha256Hex(ymlPath) }
  ]
  for (const entry of entries) log(`  sha256(${entry.name}) = ${entry.hash}`)
  ctx.expectedSums = buildSha256SumsText(entries)
  ctx.expectedYmlRaw = ctx.ymlRaw
  if (fs.existsSync(sumsPath)) {
    verifySha256SumsContent(fs.readFileSync(sumsPath, 'utf8'), entries)
    log('✓ 既有 SHA256SUMS.txt 与磁盘重算哈希一致')
  }
  if (writeSums) {
    fs.writeFileSync(sumsPath, ctx.expectedSums, 'utf8')
    verifySha256SumsContent(fs.readFileSync(sumsPath, 'utf8'), entries)
    log('✓ SHA256SUMS.txt 已生成并通过回读二次校验')
  }
  return true
}

/** Stage 2 校验、打包与 SHA256SUMS 自检 */
async function stage2BuildAndVerify(ctx) {
  banner(2, '校验、打包与 SHA256SUMS 自检')
  if (!ctx.dryRun) {
    const steps = ['format:check', 'typecheck', 'test', 'test:e2e', 'smoke:packaged']
    if (ctx.skipTests) {
      log(`ℹ --skip-tests：跳过 ${steps.join(' → ')}`)
    } else {
      const timeouts = { test: 20 * 60_000, 'test:e2e': 60 * 60_000, 'smoke:packaged': 15 * 60_000 }
      for (const step of steps) {
        log(`▸ npm run ${step} ...`)
        run('npm', ['run', step], { inherit: true, timeout: timeouts[step] ?? 10 * 60_000 })
        log(`✓ npm run ${step} 通过`)
      }
    }
    log('▸ npm run package ...')
    run('npm', ['run', 'package'], { inherit: true, timeout: 30 * 60_000 })
    log('✓ npm run package 完成')
  } else {
    log('ℹ --dry-run：不执行测试与打包，直接核验既有 dist/ 产物')
  }
  const fullSet = await verifyLocalDist(ctx, { writeSums: true })
  if (!fullSet) {
    if (ctx.dryRun) {
      throw new Error(
        '--dry-run 需要本地 dist/ 已有该版本全套产物（exe/blockmap/latest.yml），请先执行完整流程或 npm run package'
      )
    }
    throw new Error('npm run package 后仍未找到构建产物，请检查 electron-builder 输出')
  }
}

/** Stage 3 幂等 tag + 双端推送 + CI 门禁 */
async function stage3TagPushAndCI(ctx) {
  banner(3, 'Tag、双端推送与 CI 门禁')
  const tagName = `v${ctx.version}`
  const head = run('git', ['rev-parse', 'HEAD']).trim()
  const existing = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  if (existing.status === 0 && existing.stdout.trim()) {
    if (existing.stdout.trim() !== head) {
      throw new Error(
        `本地 tag ${tagName} 已存在但指向 ${existing.stdout.trim()}（HEAD 为 ${head}），中止——请人工核对后删除错位 tag`
      )
    }
    log(`✓ 本地 tag ${tagName} 已存在且指向 HEAD`)
  } else {
    run('git', ['tag', '-a', tagName, '-m', `题舟 ${tagName}`])
    log(`✓ 已创建附注 tag ${tagName}`)
  }
  for (const remote of ['origin', 'cnb']) {
    const probe = spawnSync('git', ['remote', 'get-url', remote], { cwd: ROOT, encoding: 'utf8' })
    if (probe.status !== 0)
      throw new Error(`缺少 git 远端 ${remote}（git remote add ${remote} <url>）`)
    await pushWithRetry(remote, 'master')
    await pushWithRetry(remote, tagName)
  }
  await waitGithubCiGreen(head)
}

async function pushWithRetry(remote, ref, attempts = 3) {
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = spawnSync('git', ['push', remote, ref], { cwd: ROOT, encoding: 'utf8' })
    if (res.status === 0) {
      log(`✓ push ${remote} ${ref}${attempt > 1 ? `（第 ${attempt} 次重试成功）` : ''}`)
      return
    }
    lastError = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trimEnd()
    if (res.error) lastError = res.error.message
    if (attempt < attempts) {
      log(`ℹ push ${remote} ${ref} 失败，${5 * attempt}s 后重试（${attempt}/${attempts}）`)
      await sleep(5_000 * attempt)
    }
  }
  throw new Error(
    `push ${remote} ${ref} 连续 ${attempts} 次失败：\n${lastError.split('\n').slice(-10).join('\n')}`
  )
}

/** 等待 origin 上该 commit 的全部 workflow run 结论 success（skipped 视为通过） */
async function waitGithubCiGreen(headSha, { timeoutMs = 40 * 60_000, intervalMs = 30_000 } = {}) {
  log(`▸ 等待 origin CI（commit ${headSha.slice(0, 8)}）...`)
  const deadline = Date.now() + timeoutMs
  let announced = false
  while (Date.now() < deadline) {
    const res = spawnSync(
      'gh',
      [
        'run',
        'list',
        '--repo',
        GITHUB_REPO,
        '--commit',
        headSha,
        '--limit',
        '30',
        '--json',
        'status,conclusion,workflowName'
      ],
      { cwd: ROOT, encoding: 'utf8' }
    )
    if (res.status !== 0) throw new Error(`gh run list 失败：${String(res.stderr ?? '').trimEnd()}`)
    let runs = []
    try {
      runs = JSON.parse(res.stdout || '[]')
    } catch {
      runs = []
    }
    if (runs.length === 0) {
      if (!announced) {
        log('ℹ 尚未发现该 commit 的 workflow run，等待 CI 排队...')
        announced = true
      }
      await sleep(intervalMs)
      continue
    }
    const failed = runs.filter(
      (item) =>
        item.status === 'completed' &&
        item.conclusion !== 'success' &&
        item.conclusion !== 'skipped'
    )
    if (failed.length > 0) {
      throw new Error(
        `CI 结论非 success：\n${failed.map((item) => `  - ${item.workflowName}: ${item.conclusion}`).join('\n')}`
      )
    }
    const pending = runs.filter((item) => item.status !== 'completed')
    if (pending.length === 0) {
      log(`✓ CI 全部通过（${runs.length} 个 workflow run）`)
      return
    }
    log(
      `ℹ CI 进行中：${pending.map((item) => `${item.workflowName}:${item.status}`).join(', ')}，${intervalMs / 1000}s 后复查`
    )
    await sleep(intervalMs)
  }
  throw new Error('等待 CI 超时（40 分钟），请人工核查 GitHub Actions 后重跑发版脚本')
}

/** Stage 4 GitHub + CNB 双源幂等上架 */
async function stage4Publish(ctx) {
  banner(4, 'GitHub + CNB 双源幂等上架')
  const tagName = `v${ctx.version}`
  const title = `题舟 ${tagName}`
  log('▸ GitHub Release ...')
  const view = spawnSync(
    'gh',
    ['release', 'view', tagName, '--repo', GITHUB_REPO, '--json', 'name'],
    {
      cwd: ROOT,
      encoding: 'utf8'
    }
  )
  if (view.status === 0) {
    log(`✓ GitHub Release ${tagName} 已存在，走覆盖上传`)
  } else {
    run('gh', [
      'release',
      'create',
      tagName,
      '--repo',
      GITHUB_REPO,
      '--verify-tag',
      '--title',
      title,
      '--notes-file',
      ctx.notesPath
    ])
    log(`✓ GitHub Release ${tagName} 已创建（标题「${title}」，正文取自发版说明）`)
  }
  run('gh', ['release', 'upload', '--clobber', tagName, '--repo', GITHUB_REPO, ...ctx.distFiles])
  log('✓ GitHub 四件套已上传（--clobber 幂等覆盖）')
  const assetsOut = run('gh', [
    'release',
    'view',
    tagName,
    '--repo',
    GITHUB_REPO,
    '--json',
    'assets'
  ])
  const assets = JSON.parse(assetsOut || '{"assets":[]}').assets ?? []
  for (const localPath of ctx.distFiles) {
    const name = path.basename(localPath)
    const asset = assets.find((item) => item.name === name)
    if (!asset) throw new Error(`GitHub Release 缺少资产：${name}`)
    const localSize = fs.statSync(localPath).size
    if (asset.size !== localSize) {
      throw new Error(`GitHub 资产字节数不符：${name} 远端 ${asset.size} 本地 ${localSize}`)
    }
  }
  log(`✓ GitHub 资产核对通过（${ctx.distFiles.length} 件，字节数一致）`)
  log('▸ CNB Release ...')
  const token = resolveCnbToken()
  const notes = fs.readFileSync(ctx.notesPath, 'utf8')
  const rel = await ensureCnbRelease({ token, version: tagName, title, notes })
  log(
    `✓ CNB Release ${tagName} ${rel.created ? '已创建' : '已存在并更新元数据'}（id=${rel.id}，make_latest 已 PATCH）`
  )
  await uploadCnbAssets({ token, releaseId: rel.id, files: ctx.distFiles })
  log('✓ CNB 四件套已上传（overwrite 幂等）')
}

/** Stage 5 双源匿名下载门禁（核心卡点）：零鉴权核验公开直链 */
async function stage5AnonymousGates(ctx) {
  banner(5, '双源匿名下载门禁')
  const exeName = ctx.exeName
  if (!ctx.exeSize) {
    // --verify-only 且本地无产物：先用第一源的 latest.yml 推导安装包字节数
    const bootUrl = `${sourceUrls(ctx.version)[0].base}/latest.yml`
    const bootRaw = await fetchTextGate(bootUrl, 'boot/latest.yml')
    const entry = assertLatestYmlConsistency(parseLatestYml(bootRaw), {
      version: ctx.version,
      exeName,
      exeSize: null
    })
    if (!Number.isFinite(entry.size) || entry.size <= 0) {
      throw new Error('线上 latest.yml 缺少有效 size，无法执行 Range 门禁')
    }
    ctx.exeSize = entry.size
    log(`ℹ 本地无产物参照，安装包字节数取自线上 latest.yml：${ctx.exeSize}`)
  }
  const results = {}
  for (const src of sourceUrls(ctx.version)) {
    results[src.label] = await verifyAnonymousSource(src, ctx)
  }
  const [gh, cnb] = [results.GitHub, results.CNB]
  if (!sumsMapsEqual(parseSha256SumsText(gh.sums), parseSha256SumsText(cnb.sums))) {
    throw new Error('双源 SHA256SUMS.txt 内容不一致（跨源互证失败）')
  }
  if (normalizeText(gh.ymlRaw) !== normalizeText(cnb.ymlRaw)) {
    throw new Error('双源 latest.yml 内容不一致（跨源互证失败）')
  }
  if (gh.exeSize !== cnb.exeSize) {
    throw new Error(`双源安装包字节数不一致：GitHub ${gh.exeSize} / CNB ${cnb.exeSize}`)
  }
  if (gh.blockmapSize !== cnb.blockmapSize) {
    throw new Error(`双源 blockmap 长度不一致：GitHub ${gh.blockmapSize} / CNB ${cnb.blockmapSize}`)
  }
  log('✓ 双源互证一致：SHA256SUMS / latest.yml / 字节数全部吻合')
}

async function verifyAnonymousSource(src, ctx) {
  const { label, base } = src
  const exeName = ctx.exeName
  const blockmapName = `${exeName}.blockmap`
  log(`▸ ${label}（${base}）`)
  // 1. SHA256SUMS.txt：200 + 与目标版本哈希一致（旧缓存退避重试）
  const sums = await fetchSumsGate(
    `${base}/SHA256SUMS.txt`,
    ctx.expectedSums ?? null,
    `${label}/SHA256SUMS.txt`
  )
  const sumsMap = parseSha256SumsText(sums)
  const wanted = [exeName, blockmapName, 'latest.yml']
  for (const name of wanted) {
    if (!sumsMap.has(name)) throw new Error(`${label}/SHA256SUMS.txt 缺少 ${name} 条目`)
  }
  if (sumsMap.size !== wanted.length) {
    throw new Error(`${label}/SHA256SUMS.txt 条目数异常：${[...sumsMap.keys()].join(', ')}`)
  }
  log(`✓ SHA256SUMS.txt 匿名 200 且${ctx.expectedSums ? '与目标版本哈希一致' : '条目完整'}`)
  // 2. latest.yml：200 + version/文件名/字节数匹配
  const ymlRaw = await fetchTextGate(`${base}/latest.yml`, `${label}/latest.yml`)
  const yml = parseLatestYml(ymlRaw)
  const entry = assertLatestYmlConsistency(yml, {
    version: ctx.version,
    exeName,
    exeSize: ctx.exeSize
  })
  if (ctx.expectedYmlRaw && normalizeText(ymlRaw) !== normalizeText(ctx.expectedYmlRaw)) {
    throw new Error(`${label}/latest.yml 与本地内容不一致（疑似旧缓存或版本错位）`)
  }
  log(`✓ latest.yml 匿名 200：version=${yml.version}，${exeName} size=${entry.size}`)
  // 3. blockmap：HEAD Content-Length 匹配（不可靠时回退 Range 探测）
  const headRes = await fetchAnonymous(`${base}/${blockmapName}`, { method: 'HEAD' })
  if (!headRes.ok) throw new Error(`${label}/${blockmapName}：HEAD 请求失败 ${headRes.status}`)
  let headLen = Number(headRes.headers.get('content-length') ?? '0')
  await drainResponse(headRes)
  if (!headLen) {
    const rangeRes = await fetchAnonymous(`${base}/${blockmapName}`, { range: 'bytes=0-0' })
    headLen = parseContentRangeTotal(rangeRes.headers.get('content-range')) ?? 0
    await drainResponse(rangeRes)
    if (!headLen) {
      throw new Error(
        `${label}/${blockmapName}：无法确定长度（HEAD 无 Content-Length 且 Range 无总长）`
      )
    }
    log(`ℹ ${label}/${blockmapName}：HEAD 无长度，经 Range 探测为 ${headLen}`)
  }
  if (ctx.blockmapSize && headLen !== ctx.blockmapSize) {
    throw new Error(`${label}/${blockmapName}：长度不符：期望 ${ctx.blockmapSize}，实际 ${headLen}`)
  }
  if (ctx.blockmapSize) log(`✓ ${blockmapName} 长度一致：${headLen}`)
  else log(`ℹ ${blockmapName} 线上长度 ${headLen}（无本地参照，跨源互比）`)
  // 4. 安装包 Range 首尾字节：206 + Content-Range 总长度精确匹配
  await assertRangeGate(`${base}/${exeName}`, 0, 0, ctx.exeSize, `${label}/${exeName} 首字节`)
  await assertRangeGate(
    `${base}/${exeName}`,
    ctx.exeSize - 1,
    ctx.exeSize - 1,
    ctx.exeSize,
    `${label}/${exeName} 尾字节`
  )
  log(`✓ ${exeName} Range 首尾字节 206 且总长度精确匹配（${ctx.exeSize}）`)
  return { sums, ymlRaw, exeSize: entry.size, blockmapSize: headLen }
}

/** Stage 6 官网元数据同步与本地验收（Stage 5 全绿后才执行） */
async function stage6WebsiteSync(ctx) {
  banner(6, '官网元数据同步与本地验收')
  const version = ctx.version
  const sizeHint = `约 ${Math.round(ctx.exeSize / 1024 / 1024)} MB`
  const webPkgPath = path.join(ROOT, 'website', 'package.json')
  const lockPath = path.join(ROOT, 'website', 'package-lock.json')
  const releaseTsPath = path.join(ROOT, 'website', 'src', 'release.ts')
  const webPkg = readJson(webPkgPath)
  const releaseTs = fs.readFileSync(releaseTsPath, 'utf8')
  const tsVersion = releaseTs.match(/version:\s*'(\d+\.\d+\.\d+)'/)?.[1]
  if (!tsVersion) throw new Error('website/src/release.ts 未找到 version 字段')
  if (tsVersion !== webPkg.version) {
    throw new Error(
      `website 元数据错位：package.json=${webPkg.version}，release.ts=${tsVersion}，请先人工对齐`
    )
  }
  if (tsVersion === version) {
    log(`ℹ website 元数据已是 ${version}，跳过替换，直接本地验收`)
  } else {
    const transformed = applyReleaseTsReplacement(releaseTs, {
      oldVersion: tsVersion,
      newVersion: version,
      sizeHint
    })
    log(`替换预演：${tsVersion} → ${version}，sizeHint → ${sizeHint}`)
    if (ctx.dryRun) {
      printDryRunDiff(releaseTs, transformed)
      log('ℹ --dry-run：官网三文件不落盘、不执行构建验收')
      return
    }
    fs.writeFileSync(releaseTsPath, transformed, 'utf8')
    writeJson(webPkgPath, { ...webPkg, version })
    const lock = readJson(lockPath)
    lock.version = version
    if (lock.packages?.['']) lock.packages[''].version = version
    writeJson(lockPath, lock)
    run('npx', [
      'prettier',
      '--write',
      'website/package.json',
      'website/package-lock.json',
      'website/src/release.ts'
    ])
    log('✓ website 三文件已更新并格式化：package.json / package-lock.json / src/release.ts')
  }
  if (ctx.dryRun) return
  log('▸ website typecheck ...')
  run('npm', ['run', 'typecheck'], {
    cwd: path.join(ROOT, 'website'),
    inherit: true,
    timeout: 5 * 60_000
  })
  log('▸ website build ...')
  run('npm', ['run', 'build'], {
    cwd: path.join(ROOT, 'website'),
    inherit: true,
    timeout: 10 * 60_000
  })
  log('▸ 根仓 verify-website ...')
  run('node', ['scripts/verify-website.ts'], { inherit: true, timeout: 10 * 60_000 })
  log('✓ 官网元数据同步与本地验收全绿')
  console.log(`
──────────────────────────────────────────────────
发版收尾提示（脚本不做 git 提交与官网部署）：
  1. 提交官网元数据：
     git add website/package.json website/package-lock.json website/src/release.ts
     git commit -m "chore(website): 发布元数据同步 ${version}"
  2. 推送：git push origin master && git push cnb master
  3. 部署官网：bash website/deploy/deploy.sh
──────────────────────────────────────────────────`)
}

function printDryRunDiff(before, after) {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let shown = 0
  for (let index = 0; index < Math.max(oldLines.length, newLines.length); index += 1) {
    if (oldLines[index] !== newLines[index]) {
      log(`  - ${String(oldLines[index] ?? '').trim()}`)
      log(`  + ${String(newLines[index] ?? '').trim()}`)
      shown += 1
      if (shown >= 12) {
        log('  ...')
        break
      }
    }
  }
}

// ── 入口 ──────────────────────────────────────────────────

function printUsage() {
  console.log(`用法：node scripts/release.mjs [options]
  （无参数）                  完整六阶段发版（版本读根 package.json）
  --version X.Y.Z            强校验传入版本与 package.json 一致
  --skip-tests               跳过 format:check→…→smoke:packaged 测试阶段（默认不跳过）
  --dry-run                  前置检查 + 既有 dist 产物核验 + release.ts 替换预演（零远端写入）
  --verify-only [X.Y.Z]      仅匿名门禁校验（本地 dist 若存在则一并核验 + GitHub/CNB 线上双源）`)
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    printUsage()
    return
  }
  if (parsed.dryRun && parsed.verifyOnly) throw new Error('--dry-run 与 --verify-only 互斥')
  if (parsed.rest.length > 0) {
    throw new Error(
      `无法识别的位置参数：${parsed.rest.join(' ')}（--verify-only 的版本号需紧跟其后）`
    )
  }
  const ctx = {
    requestedVersion: parsed.version,
    dryRun: parsed.dryRun,
    verifyOnly: parsed.verifyOnly,
    skipTests: parsed.skipTests,
    relaxGit: parsed.dryRun || parsed.verifyOnly
  }
  console.log(
    `[release] 题舟发版流水线 · ${ctx.dryRun ? 'DRY-RUN' : ctx.verifyOnly ? 'VERIFY-ONLY' : 'FULL'} 模式`
  )
  await stage1Preflight(ctx)
  if (ctx.verifyOnly) {
    log('▸ 核验本地 dist/（若存在该版本产物）...')
    const fullSet = await verifyLocalDist(ctx, { writeSums: false })
    if (fullSet) log('✓ 本地 dist/ 产物核验通过')
    await stage5AnonymousGates(ctx)
    console.log(`\n[release] ✓✓ v${ctx.version} 双源匿名门禁全绿`)
    return
  }
  await stage2BuildAndVerify(ctx)
  if (ctx.dryRun) {
    await stage6WebsiteSync(ctx)
    console.log('\n[release] ✓✓ --dry-run 预演全部通过：未执行 tag/push/上架/任何远端写入')
    return
  }
  await stage3TagPushAndCI(ctx)
  await stage4Publish(ctx)
  await stage5AnonymousGates(ctx)
  await stage6WebsiteSync(ctx)
  console.log(`\n[release] ✓✓ v${ctx.version} 六阶段发版流水线全绿`)
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\n[release] ✗ ${message}`)
    process.exit(1)
  })
}
