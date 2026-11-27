// 官网流量与下载转化率本地可视化看板服务（仅监听 127.0.0.1，零公网暴露、零外部 CDN 依赖）。
// 与线上 website/deploy/stats-server.py 共用同一份前端模板 website/deploy/stats-dashboard.html。
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_PATH = join(ROOT, 'website', 'deploy', 'stats-dashboard.html')

function createCspNonce() {
  return randomBytes(16).toString('base64')
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderStatsDashboardHtml({
  nonce,
  initialDays = 14,
  initialIncludeBots = false,
  sourceLabel = '服务器实时日志',
  apiBasePath = '/api/stats',
  badgeText = '仅本机访问 · 零 Cookie'
}) {
  const safeNonce = escapeHtmlText(nonce)
  const safeSource = escapeHtmlText(sourceLabel)
  const safeBadge = escapeHtmlText(badgeText)
  const safeApiBase = escapeHtmlText(apiBasePath)
  const safeDays = Number.isFinite(Number(initialDays)) ? Math.max(0, Number(initialDays)) : 14
  const safeIncludeBots = initialIncludeBots ? 'true' : 'false'

  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  return template
    .replaceAll('__CSP_NONCE__', safeNonce)
    .replaceAll('__SOURCE_LABEL__', safeSource)
    .replaceAll('__BADGE_TEXT__', safeBadge)
    .replaceAll('__API_BASE__', safeApiBase)
    .replaceAll('__INITIAL_DAYS__', String(safeDays))
    .replaceAll('__INITIAL_INCLUDE_BOTS__', safeIncludeBots)
}

export function openBrowserUrl(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    // 打开浏览器失败时终端已打印访问地址，不阻断服务运行
  }
}

export async function startStatsUiServer({
  loadPayload,
  port = 0,
  host = '127.0.0.1',
  initialDays = 14,
  initialIncludeBots = false,
  sourceLabel = '服务器实时日志'
}) {
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://${host}`)
    const pathname = reqUrl.pathname

    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')

    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'Method Not Allowed' }))
      return
    }

    if (pathname === '/favicon.ico') {
      res.statusCode = 204
      res.end()
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      const nonce = createCspNonce()
      const csp = [
        `script-src 'nonce-${nonce}' 'strict-dynamic' 'report-sample'`,
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join('; ')
      res.statusCode = 200
      res.setHeader('Content-Security-Policy', csp)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(
        renderStatsDashboardHtml({
          nonce,
          initialDays,
          initialIncludeBots,
          sourceLabel
        })
      )
      return
    }

    if (pathname === '/api/stats') {
      res.setHeader('Vary', 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site')
      const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
      if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
        res.statusCode = 403
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'Forbidden cross-site request' }))
        return
      }
      const daysParam = reqUrl.searchParams.get('days')
      const days = daysParam !== null && /^\d+$/.test(daysParam) ? Number(daysParam) : initialDays
      const includeBots = reqUrl.searchParams.get('includeBots') === '1'
      const forceRefresh = reqUrl.searchParams.get('refresh') === '1'
      try {
        const payload = await loadPayload({ days, includeBots, forceRefresh })
        res.statusCode = 200
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(payload))
      } catch (error) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          })
        )
      }
      return
    }

    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'Not Found' }))
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${host}:${actualPort}/`

  const close = () =>
    new Promise((resolveClose) => {
      server.close(() => resolveClose())
    })

  return { server, url, port: actualPort, close }
}
