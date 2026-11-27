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
})
