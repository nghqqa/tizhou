// 官网本地自动化验收（不依赖外部部署环境）：
//   1. 静态检查 dist/：可见文案零 em/en-dash、无真实 IP 与个人路径泄露、站内引用的图片全部存在且非空、
//      OG/robots/sitemap 与 release.ts 的 siteUrl 一致；
//   2. 用 Playwright Chromium 启动 vite preview：
//      桌面（1440x900）与移动（390x844）双端断言关键区块渲染、截图全部加载（naturalWidth > 0）、
//      零 console error / pageerror、无横向溢出，并验证流程 Tab 切换与 FAQ 展开可用。
//
// 用法：node scripts/verify-website.ts   （需先 cd website && npm run build）
import { chromium } from 'playwright'
import { createServer, type Server } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'website', 'dist')
const RELEASE_TS = join(ROOT, 'website', 'src', 'release.ts')
const TEXT_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.xml', '.md'])
const problems: string[] = []
const fail = (message: string): void => {
  problems.push(message)
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })

// ── 1. 静态检查 ────────────────────────────────────────────

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('[verify] 未找到 website/dist/index.html，请先在 website/ 下执行 npm run build')
  process.exit(1)
}

const releaseSource = readFileSync(RELEASE_TS, 'utf8')
const siteUrlMatch = releaseSource.match(/siteUrl:\s*'(https?:\/\/[^']+)'/)
const siteUrl = siteUrlMatch?.[1]?.replace(/\/$/, '') ?? ''
if (!siteUrl) fail('release.ts 缺少 siteUrl')

let checkedFiles = 0
for (const file of walk(DIST)) {
  if (!TEXT_EXT.has(file.slice(file.lastIndexOf('.')))) continue
  checkedFiles += 1
  const content = readFileSync(file, 'utf8')
  const rel = file.slice(DIST.length + 1)
  if (content.includes('\u2014') || content.includes('\u2013')) {
    fail(`${rel} 含 em-dash 或 en-dash 字符`)
  }
  // 真实 IPv4 检测：放行回环、版本号样式与占位符；其余四段数字视为疑似泄露
  const ipMatches = content.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []
  for (const ip of ipMatches) {
    if (ip === '127.0.0.1' || ip === '0.0.0.0') continue
    if (/^\d{1,3}\.\d{1,3}$/.test(ip)) continue
    fail(`${rel} 出现疑似服务器 IP：${ip}`)
  }
  if (/[Cc]:[\\/]+Users[\\/]/.test(content)) {
    fail(`${rel} 出现个人用户目录路径`)
  }
}

// 截图资源：5 张且非空（> 10KB）
const shotsDir = join(DIST, 'screenshots')
const shots = existsSync(shotsDir) ? readdirSync(shotsDir) : []
const expectedShots = [
  '01-dashboard.webp',
  '02-practice-graphic.webp',
  '03-exam-review.webp',
  '04-knowledge-builder.webp',
  '05-shenlun.webp'
]
for (const name of expectedShots) {
  const full = join(shotsDir, name)
  if (!existsSync(full)) fail(`缺少截图：screenshots/${name}`)
  else if (statSync(full).size < 10 * 1024) fail(`截图过小（疑似空图）：screenshots/${name}`)
}
for (const extra of shots) {
  if (!expectedShots.includes(extra))
    fail(`screenshots/ 出现未预期文件：${extra}（请检查是否为旧产物）`)
}

// bundle 中引用的图片必须存在
const bundle = walk(DIST)
  .filter((file) => file.endsWith('.js'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
for (const ref of bundle.match(/screenshots\/[\w.-]+\.webp/g) ?? []) {
  if (!existsSync(join(DIST, ref))) fail(`bundle 引用的图片不存在：${ref}`)
}

// OG / robots / sitemap 一致性
const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8')
if (!indexHtml.includes(`content="${siteUrl}/og-image.jpg"`))
  fail('dist/index.html 缺少 og:image 或地址不符')
if (!indexHtml.includes(`<meta property="og:title"`)) fail('dist/index.html 缺少 og:title')
if (!indexHtml.includes('rel="canonical"')) fail('dist/index.html 缺少 canonical')
const robots = readFileSync(join(DIST, 'robots.txt'), 'utf8')
if (!robots.includes(`Sitemap: ${siteUrl}/sitemap.xml`)) fail('robots.txt 的 Sitemap 地址不符')
const sitemap = readFileSync(join(DIST, 'sitemap.xml'), 'utf8')
if (!sitemap.includes(`<loc>${siteUrl}/</loc>`)) fail('sitemap.xml 的 loc 地址不符')
if (indexHtml.includes('<!--OGMETA-->')) fail('index.html 的 OG 占位符未被替换')

console.log(`[verify] 静态检查完成：扫描 ${checkedFiles} 个文本文件，5 张截图与引用完整性已核对`)

// ── 2. 预览双端检查（内建静态服务器：随机端口、无子进程、随脚本退出） ──

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8'
}

const server = createServer((request, response) => {
  const url = (request.url ?? '/').split('?')[0]!
  let filePath = normalize(join(DIST, decodeURIComponent(url)))
  if (!filePath.startsWith(normalize(DIST))) {
    response.statusCode = 403
    response.end()
    return
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory())
    filePath = join(filePath, 'index.html')
  if (!existsSync(filePath)) {
    // 单页站点回退
    filePath = join(DIST, 'index.html')
  }
  response.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream')
  response.end(readFileSync(filePath))
})

const listenPort: number = await new Promise((resolvePort, rejectPort) => {
  server.once('error', rejectPort)
  server.listen(0, '127.0.0.1', () => {
    resolvePort((server.address() as { port: number }).port)
  })
})

interface CheckResult {
  label: string
  consoleErrors: string[]
  pageErrors: string[]
}

async function checkViewport(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  label: string,
  width: number,
  height: number
): Promise<CheckResult> {
  const page = await browser.newPage({ viewport: { width, height } })
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.goto(`http://127.0.0.1:${listenPort}/`, { waitUntil: 'load', timeout: 30_000 })
  await page.waitForSelector('#faq', { timeout: 15_000 })

  // 逐屏滚动触发懒加载图片，再回到顶部
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8)
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    window.scrollTo(0, 0)
  })
  await page.waitForLoadState('load')

  // 关键区块全部渲染
  for (const selector of ['#download', '#flow', '#why', '#start', '#faq', '.site-footer']) {
    const visible = await page.locator(selector).first().isVisible()
    if (!visible) fail(`[${label}] 关键区块不可见：${selector}`)
  }

  // 截图全部真实加载
  const images = await page.evaluate(() =>
    [...document.querySelectorAll('img')].map((img) => ({
      src: img.getAttribute('src') ?? '',
      loaded: (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0
    }))
  )
  if (images.length < 2) fail(`[${label}] 页面图片数量异常：${images.length}`)
  for (const image of images) {
    if (!image.loaded) fail(`[${label}] 图片未加载成功：${image.src}`)
  }

  // 无横向滚动溢出
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  if (overflow > 1) fail(`[${label}] 存在横向溢出：${overflow}px`)

  // 流程 Tab 切换：4 个 Tab 逐一点击，断言每张 WebP 截图真实加载
  if (label === 'desktop') {
    const expectedFlowImages = [
      '02-practice-graphic',
      '03-exam-review',
      '04-knowledge-builder',
      '05-shenlun'
    ]
    const tabs = page.locator('.flow-tab')
    const tabCount = await tabs.count()
    if (tabCount !== 4) fail(`[desktop] 流程 Tab 数量异常：${tabCount}`)
    const flowImg = page.locator('.flow .shot-body img')
    for (let index = 0; index < expectedFlowImages.length; index += 1) {
      await tabs.nth(index).click()
      // 等待切换后的图片 src 更新且真实加载完成（切换后开始异步加载，立即断言会有竞态）
      const switched = await page
        .waitForFunction(
          ({ probe, sel }) => {
            const img = document.querySelector(sel) as HTMLImageElement | null
            return Boolean(
              img &&
              img.getAttribute('src')?.includes(probe) &&
              img.complete &&
              img.naturalWidth > 0
            )
          },
          { probe: expectedFlowImages[index]!, sel: '.flow .shot-body img' },
          { timeout: 10_000 }
        )
        .then(() => true)
        .catch(() => false)
      if (!switched) {
        const actual = await flowImg.getAttribute('src')
        fail(`[desktop] Tab ${index + 1} 截图不符或未加载：${actual ?? '(空)'}`)
      }
    }

    // 灯箱：点击截图放大，Esc 关闭
    await page.locator('.shot-body').first().click()
    if (!(await page.locator('.lightbox img').isVisible())) fail('[desktop] 灯箱未打开')
    const zoomLoaded = await page
      .locator('.lightbox img')
      .evaluate((img) => img.complete && img.naturalWidth > 0)
    if (!zoomLoaded) fail('[desktop] 灯箱大图未加载成功')
    await page.keyboard.press('Escape')
    const closed = await page
      .locator('.lightbox')
      .waitFor({ state: 'detached', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (!closed) fail('[desktop] Esc 未关闭灯箱')

    // FAQ 展开交互
    await page.locator('.faq details summary').first().click()
    const opened = await page
      .locator('.faq details')
      .first()
      .evaluate((node) => node.hasAttribute('open'))
    if (!opened) fail('[desktop] FAQ 无法展开')
  }

  consoleErrors.forEach((error) => fail(`[${label}] console error: ${error.slice(0, 200)}`))
  pageErrors.forEach((error) => fail(`[${label}] pageerror: ${error.slice(0, 200)}`))
  console.log(
    `[verify] ${label}（${width}x${height}）：区块/图片/溢出/console 检查完成，图片 ${images.length} 张`
  )
  await page.close()
  return { label, consoleErrors, pageErrors }
}

await (async () => {
  // 优先用 Playwright 自带 Chromium；未安装对应版本浏览器时回退到系统 Edge / Chrome
  const browser = await chromium
    .launch()
    .catch(() =>
      chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch({ channel: 'chrome' }))
    )
  try {
    await checkViewport(browser, 'desktop', 1440, 900)
    await checkViewport(browser, 'mobile', 390, 844)
  } finally {
    await browser.close()
    server.close()
  }
})()

// ── 3. 汇总 ───────────────────────────────────────────────

if (problems.length > 0) {
  console.error(`[verify] 未通过，共 ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log('[verify] 全部通过：静态检查 + 桌面/移动双端预览检查')
}
