#!/usr/bin/env node
// 官网访问量与下载转化率统计 CLI（零 Cookie / 零前端埋点）：
// 读取服务器 /var/log/nginx/tizhou-website.access.log*（含 .gz 历史轮转日志）或本地日志文件，
// 汇总首页 PV/UV、/go/download-cnb 与 /go/download-github 302 点击量、下载转化率及来源渠道。
//
// 用法：
//   npm run website:stats                       查看近 14 天统计（含 GitHub Releases 近期下载）
//   npm run website:stats -- --days 1           仅看今天
//   npm run website:stats -- --days 30          查看近 30 天
//   npm run website:stats -- --include-bots     包含爬虫与探针流量
//   npm run website:stats -- --file path.log    分析本地日志文件（不连服务器）
//   npm run website:stats -- --no-github        不查询 GitHub Releases 下载数
//   npm run website:stats -- --json             输出 JSON
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWN_HOST = 'tizhou.nghqqa.cn'
const GITHUB_REPO = 'nghqqa/tizhou'

const MONTH_MAP = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12'
}

const LOG_LINE_RE =
  /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)\s+[^"]+"\s+(\d{3})\s+(\d+|-)\s+"([^"]*)"\s+"([^"]*)"(?:\s+"([^"]*)")?/

const BOT_UA_RE =
  /^(?:node(?:\/|$)|python|curl|wget|go-http-client)|bot\b|spider|crawler|slurp|bingpreview|mediapartners|adsbot|headless|playwright|puppeteer|phantomjs|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp|libwww|scrapy|httpclient|node-fetch|undici|axios\/|censys|zgrab|shodan|nuclei|masscan|nmap|ahrefs|semrush|mj12bot|dotbot|bytespider|petalbot|yandex|baiduspider|sogou|360spider|yisouspider|googlebot|bingbot|duckduckbot|applebot|facebookexternalhit|twitterbot|whatsapp|telegrambot|slackbot|discordbot|dnspod-monitor|uptimerobot|pingdom|statuscake|monitor/i

const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i
const SOURCE_TAG_RE = /^[a-zA-Z0-9_-]{1,32}$/

function parseTimeToDateKey(timeLocal) {
  const m = String(timeLocal ?? '').match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):/)
  if (!m) return null
  const month = MONTH_MAP[m[2]]
  if (!month) return null
  return `${m[3]}-${month}-${m[1]}`
}

function resolveClientIp(remoteAddr, forwardedFor) {
  if (forwardedFor && forwardedFor !== '-' && PRIVATE_IP_RE.test(remoteAddr)) {
    const first = forwardedFor.split(',')[0]?.trim()
    if (first && first !== '-') return first
  }
  return remoteAddr
}

function extractSourceTag(search) {
  if (!search) return ''
  try {
    const params = new URLSearchParams(search)
    const raw = (params.get('from') ?? params.get('utm_source') ?? '').trim()
    return SOURCE_TAG_RE.test(raw) ? raw : ''
  } catch {
    return ''
  }
}

function extractRefererHost(referer) {
  if (!referer || referer === '-') return ''
  try {
    const url = new URL(referer)
    return url.hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function isLikelyBot(userAgent) {
  const ua = String(userAgent ?? '').trim()
  if (!ua || ua === '-') return true
  return BOT_UA_RE.test(ua)
}

export function parseNginxLogLine(line) {
  const match = String(line ?? '').match(LOG_LINE_RE)
  if (!match) return null
  const [, remoteAddr, timeLocal, method, rawTarget, statusRaw, , referer, userAgent, xff] = match
  const dateKey = parseTimeToDateKey(timeLocal)
  if (!dateKey) return null
  const qIndex = rawTarget.indexOf('?')
  const pathname = qIndex >= 0 ? rawTarget.slice(0, qIndex) : rawTarget
  const search = qIndex >= 0 ? rawTarget.slice(qIndex + 1) : ''
  return {
    ip: resolveClientIp(remoteAddr, xff),
    dateKey,
    method,
    pathname,
    sourceTag: extractSourceTag(search),
    status: Number(statusRaw),
    refererHost: extractRefererHost(referer),
    userAgent,
    isBot: isLikelyBot(userAgent)
  }
}

function addDays(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays))
  return dt.toISOString().slice(0, 10)
}

function localTodayKey(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function classifyEvent(entry) {
  if (entry.method !== 'GET') return null
  if (
    (entry.pathname === '/' || entry.pathname === '/index.html') &&
    (entry.status === 200 || entry.status === 304)
  ) {
    return 'home'
  }
  if (entry.status >= 300 && entry.status < 400) {
    if (entry.pathname === '/go/download-cnb') return 'download-cnb'
    if (entry.pathname === '/go/download-github') return 'download-github'
    if (entry.pathname === '/go/releases-cnb') return 'releases-cnb'
    if (entry.pathname === '/go/checksum-cnb' || entry.pathname === '/go/checksum-github') {
      return 'checksum'
    }
  }
  return null
}

function ratioPct(numerator, denominator) {
  if (!denominator) return null
  return Number(((numerator / denominator) * 100).toFixed(1))
}

export function aggregateWebsiteStats(lines, options = {}) {
  const { days = 14, includeBots = false, todayKey = localTodayKey() } = options
  const minDateKey = days > 0 ? addDays(todayKey, -(days - 1)) : ''

  let totalLines = 0
  let parsedLines = 0
  let botEventsFiltered = 0

  const homeIps = new Set()
  const downloadIps = new Set()
  const downloadCnbIps = new Set()
  const downloadGithubIps = new Set()

  let homePv = 0
  let downloadCnbPv = 0
  let downloadGithubPv = 0
  let releasesCnbPv = 0
  let checksumPv = 0

  const dailyMap = new Map()
  const channelMap = new Map()
  const refererMap = new Map()

  const ensureDay = (dateKey) => {
    let bucket = dailyMap.get(dateKey)
    if (!bucket) {
      bucket = {
        dateKey,
        homePv: 0,
        homeIps: new Set(),
        downloadCnbPv: 0,
        downloadGithubPv: 0,
        downloadIps: new Set()
      }
      dailyMap.set(dateKey, bucket)
    }
    return bucket
  }

  const ensureChannel = (tag) => {
    let bucket = channelMap.get(tag)
    if (!bucket) {
      bucket = { tag, homePv: 0, homeIps: new Set(), downloadPv: 0, downloadIps: new Set() }
      channelMap.set(tag, bucket)
    }
    return bucket
  }

  const ensureReferer = (host) => {
    let bucket = refererMap.get(host)
    if (!bucket) {
      bucket = { host, homePv: 0, homeIps: new Set() }
      refererMap.set(host, bucket)
    }
    return bucket
  }

  for (const rawLine of lines) {
    if (!rawLine || !rawLine.trim()) continue
    totalLines += 1
    const entry = parseNginxLogLine(rawLine)
    if (!entry) continue
    parsedLines += 1
    if (minDateKey && entry.dateKey < minDateKey) continue

    const kind = classifyEvent(entry)
    if (!kind) continue

    if (!includeBots && entry.isBot) {
      botEventsFiltered += 1
      continue
    }

    const day = ensureDay(entry.dateKey)

    if (kind === 'home') {
      homePv += 1
      homeIps.add(entry.ip)
      day.homePv += 1
      day.homeIps.add(entry.ip)
      if (entry.sourceTag) {
        const ch = ensureChannel(entry.sourceTag)
        ch.homePv += 1
        ch.homeIps.add(entry.ip)
      }
      const refLabel =
        !entry.refererHost || entry.refererHost === OWN_HOST
          ? '(直接访问 / 站内)'
          : entry.refererHost
      const ref = ensureReferer(refLabel)
      ref.homePv += 1
      ref.homeIps.add(entry.ip)
    } else if (kind === 'download-cnb' || kind === 'download-github') {
      if (kind === 'download-cnb') {
        downloadCnbPv += 1
        downloadCnbIps.add(entry.ip)
        day.downloadCnbPv += 1
      } else {
        downloadGithubPv += 1
        downloadGithubIps.add(entry.ip)
        day.downloadGithubPv += 1
      }
      downloadIps.add(entry.ip)
      day.downloadIps.add(entry.ip)
      if (entry.sourceTag) {
        const ch = ensureChannel(entry.sourceTag)
        ch.downloadPv += 1
        ch.downloadIps.add(entry.ip)
      }
    } else if (kind === 'releases-cnb') {
      releasesCnbPv += 1
    } else if (kind === 'checksum') {
      checksumPv += 1
    }
  }

  const downloadTotalPv = downloadCnbPv + downloadGithubPv
  const daily = [...dailyMap.values()]
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .map((d) => ({
      date: d.dateKey,
      homePv: d.homePv,
      homeUv: d.homeIps.size,
      downloadCnbPv: d.downloadCnbPv,
      downloadGithubPv: d.downloadGithubPv,
      downloadTotalPv: d.downloadCnbPv + d.downloadGithubPv,
      downloadUv: d.downloadIps.size,
      conversionUvPct: ratioPct(d.downloadIps.size, d.homeIps.size)
    }))

  const channels = [...channelMap.values()]
    .sort((a, b) => b.downloadIps.size - a.downloadIps.size || b.homeIps.size - a.homeIps.size)
    .map((c) => ({
      tag: c.tag,
      homePv: c.homePv,
      homeUv: c.homeIps.size,
      downloadPv: c.downloadPv,
      downloadUv: c.downloadIps.size,
      conversionUvPct: ratioPct(c.downloadIps.size, c.homeIps.size)
    }))

  const referers = [...refererMap.values()]
    .sort(
      (a, b) =>
        b.homeIps.size - a.homeIps.size || b.homePv - a.homePv || a.host.localeCompare(b.host)
    )
    .slice(0, 12)
    .map((r) => ({
      host: r.host,
      homePv: r.homePv,
      homeUv: r.homeIps.size
    }))

  return {
    windowDays: days,
    fromDate: minDateKey || '全部',
    toDate: todayKey,
    includeBots,
    totalLines,
    parsedLines,
    botEventsFiltered,
    summary: {
      homePv,
      homeUv: homeIps.size,
      downloadCnbPv,
      downloadCnbUv: downloadCnbIps.size,
      downloadGithubPv,
      downloadGithubUv: downloadGithubIps.size,
      downloadTotalPv,
      downloadTotalUv: downloadIps.size,
      releasesCnbPv,
      checksumPv,
      conversionUvPct: ratioPct(downloadIps.size, homeIps.size),
      conversionPvPct: ratioPct(downloadTotalPv, homePv)
    },
    daily,
    channels,
    referers
  }
}

export function formatStatsReport(stats, githubReleases = null) {
  const s = stats.summary
  const fmtPct = (v) => (v == null ? '-' : `${v.toFixed(1)}%`)
  const lines = [
    `题舟官网流量与下载转化率报表（范围：${stats.fromDate} ~ ${stats.toDate}，${stats.includeBots ? '含爬虫' : `已过滤 ${stats.botEventsFiltered} 条爬虫/探针事件`}）`,
    '──────────────────────────────────────────────────────────────',
    `首页访问：  PV ${s.homePv}  |  UV ${s.homeUv}`,
    `下载点击：  合计 PV ${s.downloadTotalPv}（UV ${s.downloadTotalUv}）  [国内 CNB: ${s.downloadCnbPv} 次 / ${s.downloadCnbUv} UV；GitHub: ${s.downloadGithubPv} 次 / ${s.downloadGithubUv} UV]`,
    `下载转化率：按 UV ${fmtPct(s.conversionUvPct)}（下载 UV / 首页 UV）  |  按 PV ${fmtPct(s.conversionPvPct)}`,
    `辅助入口：  Releases 页 ${s.releasesCnbPv} 次  |  SHA256 校验文件 ${s.checksumPv} 次`
  ]

  if (stats.daily.length > 0) {
    lines.push(
      '',
      '按天趋势：',
      '日期        | 首页PV | 首页UV | CNB下载 | GH下载 | 下载UV | 下载率(UV)'
    )
    lines.push('------------+--------+--------+---------+--------+--------+-----------')
    for (const d of stats.daily) {
      lines.push(
        `${d.date}  | ${String(d.homePv).padStart(6)} | ${String(d.homeUv).padStart(6)} | ${String(d.downloadCnbPv).padStart(7)} | ${String(d.downloadGithubPv).padStart(6)} | ${String(d.downloadUv).padStart(6)} | ${fmtPct(d.conversionUvPct).padStart(9)}`
      )
    }
  } else {
    lines.push('', '按天趋势：当前时间窗口内暂无有效访问记录。')
  }

  if (stats.channels.length > 0) {
    lines.push(
      '',
      '投放渠道（?from= / ?utm_source=）：',
      '渠道标识             | 访问UV | 下载UV | 下载率(UV)'
    )
    lines.push('---------------------+--------+--------+-----------')
    for (const c of stats.channels) {
      lines.push(
        `${c.tag.padEnd(20)} | ${String(c.homeUv).padStart(6)} | ${String(c.downloadUv).padStart(6)} | ${fmtPct(c.conversionUvPct).padStart(9)}`
      )
    }
  }

  if (stats.referers.length > 0) {
    lines.push('', '来源域名（Referer）：')
    for (const r of stats.referers) {
      lines.push(`  - ${r.host.padEnd(28)} UV ${String(r.homeUv).padStart(4)}  (PV ${r.homePv})`)
    }
  }

  if (githubReleases) {
    lines.push(
      '',
      `GitHub Releases .exe 下载参考（含自动更新与直接访问，近 ${githubReleases.releaseCount} 个版本合计 ${githubReleases.totalExe} 次）：`,
      `  ${githubReleases.recent.map((item) => `${item.tag}: ${item.downloads}`).join('  |  ')}`
    )
  }

  return lines.join('\n')
}

function parseCliArgs(argv) {
  const opts = {
    days: 14,
    includeBots: false,
    file: '',
    logPrefix: '',
    noGithub: false,
    json: false,
    help: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--include-bots') opts.includeBots = true
    else if (arg === '--no-github') opts.noGithub = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--days') {
      opts.days = Math.max(0, Number(argv[++i] ?? 14))
    } else if (arg.startsWith('--days=')) {
      opts.days = Math.max(0, Number(arg.slice('--days='.length)))
    } else if (arg === '--file') {
      opts.file = String(argv[++i] ?? '')
    } else if (arg.startsWith('--file=')) {
      opts.file = arg.slice('--file='.length)
    } else if (arg === '--log') {
      opts.logPrefix = String(argv[++i] ?? '')
    } else if (arg.startsWith('--log=')) {
      opts.logPrefix = arg.slice('--log='.length)
    }
  }
  return opts
}

function resolveBashExecutable() {
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    if (existsSync(gitBash)) return gitBash
  }
  return 'bash'
}

function readRemoteLogsViaSsh(logPrefixOverride) {
  const envFile = join(ROOT, 'website', 'deploy', '.env.deploy')
  if (!existsSync(envFile)) {
    throw new Error('缺少 website/deploy/.env.deploy，无法通过 SSH 读取服务器访问日志')
  }
  if (logPrefixOverride && !/^\/[a-zA-Z0-9._/-]+$/.test(logPrefixOverride)) {
    throw new Error(`非法的远端日志路径前缀：${logPrefixOverride}`)
  }
  const bashScript = [
    'set -euo pipefail',
    'set -a',
    'source website/deploy/.env.deploy',
    'set +a',
    'LOG_PREFIX="${DEPLOY_ACCESS_LOG_OVERRIDE:-${DEPLOY_ACCESS_LOG:-/var/log/nginx/tizhou-website.access.log}}"',
    'SSH_OPTS=(-p "${DEPLOY_PORT:-22}" -o BatchMode=yes -o ConnectTimeout=10)',
    'if [ -n "${DEPLOY_SSH_KEY:-}" ]; then SSH_OPTS+=(-i "$DEPLOY_SSH_KEY"); fi',
    'ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$DEPLOY_HOST" bash -s -- "$LOG_PREFIX" <<\'REMOTE\'',
    'set -euo pipefail',
    'LOG_PREFIX="$1"',
    'for f in "${LOG_PREFIX}"-*.gz; do',
    '  [ -f "$f" ] && zcat "$f" || true',
    'done',
    'for f in "${LOG_PREFIX}"-*; do',
    '  case "$f" in',
    '    *.gz) ;;',
    '    *) [ -f "$f" ] && cat "$f" || true ;;',
    '  esac',
    'done',
    '[ -f "$LOG_PREFIX" ] && cat "$LOG_PREFIX" || true',
    'REMOTE'
  ].join('\n')

  const res = spawnSync(resolveBashExecutable(), ['-s'], {
    cwd: ROOT,
    input: bashScript,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...(logPrefixOverride ? { DEPLOY_ACCESS_LOG_OVERRIDE: logPrefixOverride } : {})
    }
  })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`SSH 读取访问日志失败（退出码 ${res.status}）：${(res.stderr || '').trim()}`)
  }
  return String(res.stdout ?? '').split(/\r?\n/)
}

function readLocalLogFile(filePath) {
  const resolved = resolve(filePath)
  const buf = readFileSync(resolved)
  const text = resolved.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')
  return text.split(/\r?\n/)
}

function fetchGithubReleaseSummary() {
  try {
    const raw = execFileSync('gh', ['api', `repos/${GITHUB_REPO}/releases?per_page=100`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000
    })
    const releases = JSON.parse(raw)
    let totalExe = 0
    const recent = []
    for (const rel of releases) {
      const cnt = (rel.assets ?? [])
        .filter((asset) => String(asset.name ?? '').endsWith('.exe'))
        .reduce((sum, asset) => sum + Number(asset.download_count ?? 0), 0)
      totalExe += cnt
      if (recent.length < 5) recent.push({ tag: rel.tag_name, downloads: cnt })
    }
    return { releaseCount: releases.length, totalExe, recent }
  } catch {
    return null
  }
}

const isDirectRun =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isDirectRun) {
  const opts = parseCliArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(
      [
        '用法：npm run website:stats -- [options]',
        '  --days N          统计最近 N 天（默认 14，0 表示全部）',
        '  --include-bots    包含爬虫与探针请求',
        '  --file <path>     读取本地 Nginx 日志（支持 .gz），不连服务器',
        '  --log <prefix>    覆盖远端日志路径前缀（默认 /var/log/nginx/tizhou-website.access.log）',
        '  --no-github       不查询 GitHub Releases 下载参考数',
        '  --json            输出 JSON'
      ].join('\n')
    )
    process.exit(0)
  }
  const lines = opts.file ? readLocalLogFile(opts.file) : readRemoteLogsViaSsh(opts.logPrefix)
  const stats = aggregateWebsiteStats(lines, {
    days: opts.days,
    includeBots: opts.includeBots
  })
  const githubReleases = opts.noGithub ? null : fetchGithubReleaseSummary()
  if (opts.json) {
    console.log(JSON.stringify({ ...stats, githubReleases }, null, 2))
  } else {
    console.log(formatStatsReport(stats, githubReleases))
  }
}
