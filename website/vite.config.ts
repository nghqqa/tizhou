import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { release } from './src/release'

// OG/分享标签需要绝对地址：以 release.ts 的 siteUrl 为唯一来源，在 dev/build 时注入 index.html
function injectSocialMeta(): Plugin {
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="题舟 Tizhou" />`,
    `<meta property="og:title" content="题舟 Tizhou · 本地优先的开源考公学习工作台" />`,
    `<meta property="og:description" content="数据存本机，无广告无会员，PDF 题本一键建库；扫描件本地 OCR，纯刷题完全离线。MIT 开源，Windows 10/11。" />`,
    `<meta property="og:url" content="${release.siteUrl}/" />`,
    `<meta property="og:image" content="${release.siteUrl}/og-image.jpg" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<link rel="canonical" href="${release.siteUrl}/" />`
  ].join('\n    ')
  return {
    name: 'tizhou-social-meta',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace('<!--OGMETA-->__PLACEHOLDER__', tags).replace('<!--OGMETA-->', tags)
      }
    }
  }
}

function sanitizeChangelogText(text: string): string {
  const emDash = String.fromCharCode(0x2014)
  const enDash = String.fromCharCode(0x2013)
  const doubleEmRe = new RegExp(emDash + emDash, 'g')
  const singleDashRe = new RegExp(`[${emDash}${enDash}]`, 'g')

  return text
    .replace(doubleEmRe, '，')
    .replace(singleDashRe, '-')
    .replace(/\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, (full, a: string, b: string) =>
      full === '127.0.0.1' || full === '0.0.0.0' ? full : `${a}.${b}.x.x`
    )
    .replace(/[Cc]:[\\/]+Users[\\/][^\s`"')，。；]*/g, '<USER_HOME>')
}

// 构建期清洗根目录 CHANGELOG.md?raw，避免把历史文档里的特殊连接号、网段数字或本地路径原样打进静态产物
function sanitizeChangelogPlugin(): Plugin {
  return {
    name: 'tizhou-changelog-sanitize',
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, '/')
      if (!normalizedId.endsWith('/CHANGELOG.md?raw')) {
        return null
      }
      const rawMatch = code.match(/^export default\s+("[\s\S]*");?\s*$/)
      if (!rawMatch?.[1]) {
        throw new Error(`[tizhou-changelog-sanitize] 未预期的 ?raw 模块格式：${id}`)
      }
      const raw = JSON.parse(rawMatch[1]) as string
      const sanitized = sanitizeChangelogText(raw)
      return {
        code: `export default ${JSON.stringify(sanitized)};`,
        map: null
      }
    }
  }
}

// base 使用相对路径：无论部署在根路径、Nginx/Caddy 子目录还是本地静态服务器，资源都不会 404
export default defineConfig({
  base: './',
  plugins: [react(), injectSocialMeta(), sanitizeChangelogPlugin()],
  server: { port: 5173 },
  preview: { port: 4173 }
})
