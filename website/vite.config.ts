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

// base 使用相对路径：无论部署在根路径、Nginx/Caddy 子目录还是本地静态服务器，资源都不会 404
export default defineConfig({
  base: './',
  plugins: [react(), injectSocialMeta()],
  server: { port: 5173 },
  preview: { port: 4173 }
})
