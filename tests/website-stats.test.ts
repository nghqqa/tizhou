import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildNginxRedirectsConfig,
  parseReleaseRedirects
} from '../website/scripts/gen-nginx-redirects.mjs'
import {
  aggregateWebsiteStats,
  formatStatsReport,
  isLikelyBot,
  parseNginxLogLine
} from '../scripts/website-stats.mjs'
import { renderStatsDashboardHtml, startStatsUiServer } from '../scripts/website-stats-ui.mjs'

describe('Nginx 302 跳转片段生成与官网访问统计', () => {
  it('能从真实 website/src/release.ts 生成五条安全的 302 no-store 跳转规则', () => {
    const releaseSource = readFileSync(join(process.cwd(), 'website', 'src', 'release.ts'), 'utf8')
    const parsed = parseReleaseRedirects(releaseSource)
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(parsed.targets.map((item) => item.path)).toEqual([
      '/go/download-cnb',
      '/go/download-github',
      '/go/releases-cnb',
      '/go/checksum-cnb',
      '/go/checksum-github'
    ])
    const conf = buildNginxRedirectsConfig(parsed)
    expect(conf).toContain('location = /go/download-cnb {')
    expect(conf).toContain('add_header Cache-Control "no-store, no-cache, must-revalidate" always;')
    expect(conf).toContain('add_header X-Robots-Tag "noindex, nofollow" always;')
    expect(conf).toContain(`tizhou-setup-${parsed.version}.exe;`)
  })

  it('拒绝非法或含注入字符的跳转 URL', () => {
    const bad = `
      export const release = {
        version: '1.0.52',
        directDownload: { url: 'http://evil.test/a.exe; return 200 ok' },
        checksumUrls: { cnb: 'https://cnb.cool/a', github: 'https://github.com/a' },
        releasePages: { cnb: 'https://cnb.cool/r', github: 'https://github.com/r' }
      }
    `
    expect(() => parseReleaseRedirects(bad)).toThrow(/不是合法的 https URL/)
  })

  it('精确解析 Nginx combined 日志并聚合首页访问、下载转化率、渠道与去爬虫过滤', () => {
    const browserUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
    const logs = [
      // 真实访客 A：从小红书落地 ?from=xhs，随后点击 CNB 国内下载
      `1.2.3.4 - - [27/Nov/2026:10:00:01 +0800] "GET /?from=xhs HTTP/2.0" 200 2410 "https://www.xiaohongshu.com/explore/123" "${browserUa}" "-"`,
      `1.2.3.4 - - [27/Nov/2026:10:00:15 +0800] "GET /go/download-cnb?from=xhs HTTP/2.0" 302 154 "https://tizhou.nghqqa.cn/?from=xhs" "${browserUa}" "-"`,
      // 静态资源请求不应计入首页 PV
      `1.2.3.4 - - [27/Nov/2026:10:00:02 +0800] "GET /assets/index-abc.js HTTP/2.0" 200 120000 "https://tizhou.nghqqa.cn/" "${browserUa}" "-"`,
      // 真实访客 B：从 GitHub 来，未下载
      `5.6.7.8 - - [27/Nov/2026:11:00:00 +0800] "GET / HTTP/2.0" 200 2410 "https://github.com/nghqqa/tizhou" "${browserUa}" "-"`,
      // 真实访客 C：昨天直接访问并点 GitHub 下载与校验文件
      `9.10.11.12 - - [26/Nov/2026:09:12:00 +0800] "GET / HTTP/2.0" 200 2410 "-" "${browserUa}" "-"`,
      `9.10.11.12 - - [26/Nov/2026:09:13:00 +0800] "GET /go/download-github HTTP/2.0" 302 154 "https://tizhou.nghqqa.cn/" "${browserUa}" "-"`,
      `9.10.11.12 - - [26/Nov/2026:09:13:30 +0800] "GET /go/checksum-cnb HTTP/2.0" 302 154 "https://tizhou.nghqqa.cn/" "${browserUa}" "-"`,
      // 爬虫与探针应被默认过滤
      `8.8.8.8 - - [27/Nov/2026:12:00:00 +0800] "GET / HTTP/1.1" 200 2410 "-" "Mozilla/5.0 (compatible; bingbot/2.0)" "-"`,
      `8.8.4.4 - - [27/Nov/2026:12:01:00 +0800] "GET /go/download-cnb HTTP/2.0" 302 154 "-" "curl/8.5.0" "-"`,
      // 窗口之外的历史记录（超过 14 天）
      `1.1.1.1 - - [01/Nov/2026:08:00:00 +0800] "GET / HTTP/2.0" 200 2410 "-" "${browserUa}" "-"`
    ]

    expect(isLikelyBot('curl/8.5.0')).toBe(true)
    expect(isLikelyBot('node')).toBe(true)
    expect(isLikelyBot(browserUa)).toBe(false)
    expect(parseNginxLogLine('malformed line')).toBeNull()

    const stats = aggregateWebsiteStats(logs, { days: 14, todayKey: '2026-11-27' })
    expect(stats.botEventsFiltered).toBe(2)
    expect(stats.summary.homePv).toBe(3)
    expect(stats.summary.homeUv).toBe(3)
    expect(stats.summary.downloadCnbPv).toBe(1)
    expect(stats.summary.downloadGithubPv).toBe(1)
    expect(stats.summary.downloadTotalPv).toBe(2)
    expect(stats.summary.downloadTotalUv).toBe(2)
    expect(stats.summary.checksumPv).toBe(1)
    expect(stats.summary.conversionUvPct).toBe(66.7)
    expect(stats.channels).toEqual([
      {
        tag: 'xhs',
        homePv: 1,
        homeUv: 1,
        downloadPv: 1,
        downloadUv: 1,
        conversionUvPct: 100
      }
    ])
    expect(stats.referers.map((r) => r.host)).toEqual([
      '(直接访问 / 站内)',
      'github.com',
      'www.xiaohongshu.com'
    ])
    expect(stats.daily).toHaveLength(2)

    const report = formatStatsReport(stats)
    expect(report).toContain('首页访问：  PV 3  |  UV 3')
    expect(report).toContain('按 UV 66.7%')
    expect(report).toContain('xhs')
  })

  it('本地可视化看板服务严格监听 127.0.0.1、附带安全响应头并拦截跨站 API 请求', async () => {
    let calls = 0
    const sampleLines = [
      '1.2.3.4 - - [27/Nov/2026:10:00:01 +0800] "GET /?from=xhs HTTP/2.0" 200 2410 "https://www.xiaohongshu.com/explore/1" "Mozilla/5.0 Chrome/131.0.0.0" "-"',
      '1.2.3.4 - - [27/Nov/2026:10:00:10 +0800] "GET /go/download-cnb?from=xhs HTTP/2.0" 302 154 "https://tizhou.nghqqa.cn/?from=xhs" "Mozilla/5.0 Chrome/131.0.0.0" "-"'
    ]
    const handle = await startStatsUiServer({
      sourceLabel: '测试样例',
      loadPayload: async ({ days, includeBots, forceRefresh }) => {
        if (forceRefresh || calls === 0) calls += 1
        return {
          stats: aggregateWebsiteStats(sampleLines, {
            days,
            includeBots,
            todayKey: '2026-11-27'
          }),
          githubReleases: {
            releaseCount: 1,
            totalExe: 3,
            recent: [{ tag: 'v1.0.52', downloads: 3 }]
          },
          fetchedAt: '2026-11-27T10:00:00.000Z',
          sourceLabel: '测试样例',
          cached: !forceRefresh && calls > 0
        }
      }
    })
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

      // 首页 HTML：含 color-scheme meta、每次请求独立的 CSP nonce 及核心安全头
      const homeRes = await fetch(handle.url)
      expect(homeRes.status).toBe(200)
      const csp = homeRes.headers.get('content-security-policy') ?? ''
      expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic' 'report-sample'/)
      expect(csp).toContain("frame-ancestors 'none'")
      expect(homeRes.headers.get('x-frame-options')).toBe('DENY')
      expect(homeRes.headers.get('x-content-type-options')).toBe('nosniff')
      expect(homeRes.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      const html = await homeRes.text()
      expect(html).toContain('<meta name="color-scheme" content="light dark" />')
      expect(html).toContain('题舟官网 · 流量与下载转化看板')

      // 跨站 API 请求被 Fetch Metadata 拒绝
      const crossSiteRes = await fetch(`${handle.url}api/stats?days=14`, {
        headers: { 'Sec-Fetch-Site': 'cross-site' }
      })
      expect(crossSiteRes.status).toBe(403)
      expect(crossSiteRes.headers.get('vary')).toContain('Sec-Fetch-Site')

      // 正常同源查询与强制刷新
      const apiRes = await fetch(`${handle.url}api/stats?days=14&includeBots=0&refresh=1`, {
        headers: { 'Sec-Fetch-Site': 'same-origin' }
      })
      expect(apiRes.status).toBe(200)
      const json = (await apiRes.json()) as {
        stats: { summary: { homeUv: number; downloadCnbPv: number; conversionUvPct: number } }
      }
      expect(json.stats.summary.homeUv).toBe(1)
      expect(json.stats.summary.downloadCnbPv).toBe(1)
      expect(json.stats.summary.conversionUvPct).toBe(100)
      expect(calls).toBe(1)
    } finally {
      await handle.close()
    }
  })

  it('共享看板模板 website/deploy/stats-dashboard.html 占位符完整且替换后零残留', () => {
    const raw = readFileSync(
      join(process.cwd(), 'website', 'deploy', 'stats-dashboard.html'),
      'utf8'
    )
    for (const token of [
      '__CSP_NONCE__',
      '__API_BASE__',
      '__BADGE_TEXT__',
      '__SOURCE_LABEL__',
      '__INITIAL_DAYS__',
      '__INITIAL_INCLUDE_BOTS__'
    ]) {
      expect(raw).toContain(token)
    }
    expect(raw).toContain('<meta name="robots" content="noindex, nofollow" />')

    const rendered = renderStatsDashboardHtml({
      nonce: 'abc123==',
      apiBasePath: '/stats/api',
      badgeText: '密钥鉴权 · 仅聚合计数',
      sourceLabel: '服务器实时日志'
    })
    expect(rendered).not.toMatch(/__[A-Z_]+__/)
    expect(rendered).toContain('nonce="abc123=="')
    expect(rendered).toContain("const API_BASE = '/stats/api'")
  })
})
