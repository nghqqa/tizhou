// 构建前生成 robots.txt 与 sitemap.xml：站点地址以 src/release.ts 的 siteUrl 为唯一来源
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const source = readFileSync(join(root, 'src', 'release.ts'), 'utf8')
const match = source.match(/siteUrl:\s*'(https?:\/\/[^']+)'/)
if (!match) throw new Error('release.ts 中未找到 siteUrl')
const siteUrl = match[1].replace(/\/$/, '')

mkdirSync(join(root, 'public'), { recursive: true })

writeFileSync(
  join(root, 'public', 'robots.txt'),
  ['User-agent: *', 'Allow: /', 'Disallow: /go/', '', `Sitemap: ${siteUrl}/sitemap.xml`, ''].join(
    '\n'
  ),
  'utf8'
)

const today = new Date().toISOString().slice(0, 10)
writeFileSync(
  join(root, 'public', 'sitemap.xml'),
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${siteUrl}/</loc>`,
    `    <lastmod>${today}</lastmod>`,
    '    <changefreq>weekly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '</urlset>',
    ''
  ].join('\n'),
  'utf8'
)

console.log(`[gen-seo] siteUrl=${siteUrl}，已生成 public/robots.txt 与 public/sitemap.xml`)
