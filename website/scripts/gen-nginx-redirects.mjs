// 根据 website/src/release.ts 生成 Nginx 302 跳转片段（/go/*），
// 每次 deploy.sh 部署时自动同步到服务器，实现零前端埋点、零 Cookie 的下载点击统计。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SAFE_HTTPS_URL_RE = /^https:\/\/[^\s'";{}<>\\]+$/

function assertSafeUrl(value, label) {
  const trimmed = String(value ?? '').trim()
  if (!SAFE_HTTPS_URL_RE.test(trimmed)) {
    throw new Error(`release.ts 中的 ${label} 不是合法的 https URL：${trimmed || '(空)'}`)
  }
  return trimmed
}

function extractBlockField(source, blockName, fieldName) {
  const blockRe = new RegExp(`${blockName}\\s*:\\s*\\{([\\s\\S]*?)\\}`)
  const blockMatch = source.match(blockRe)
  if (!blockMatch) {
    throw new Error(`release.ts 缺少 ${blockName} 配置块`)
  }
  const fieldRe = new RegExp(`${fieldName}\\s*:\\s*'([^']+)'`)
  const fieldMatch = blockMatch[1].match(fieldRe)
  if (!fieldMatch) {
    throw new Error(`release.ts 缺少 ${blockName}.${fieldName} 字段`)
  }
  return fieldMatch[1]
}

export function parseReleaseRedirects(source) {
  const text = String(source ?? '')
  const versionMatch = text.match(/version:\s*'(\d+\.\d+\.\d+)'/)
  if (!versionMatch) {
    throw new Error('release.ts 缺少合法的 version 字段')
  }
  return {
    version: versionMatch[1],
    targets: [
      {
        path: '/go/download-cnb',
        url: assertSafeUrl(extractBlockField(text, 'directDownload', 'url'), 'directDownload.url')
      },
      {
        path: '/go/download-github',
        url: assertSafeUrl(extractBlockField(text, 'releasePages', 'github'), 'releasePages.github')
      },
      {
        path: '/go/releases-cnb',
        url: assertSafeUrl(extractBlockField(text, 'releasePages', 'cnb'), 'releasePages.cnb')
      },
      {
        path: '/go/checksum-cnb',
        url: assertSafeUrl(extractBlockField(text, 'checksumUrls', 'cnb'), 'checksumUrls.cnb')
      },
      {
        path: '/go/checksum-github',
        url: assertSafeUrl(extractBlockField(text, 'checksumUrls', 'github'), 'checksumUrls.github')
      }
    ]
  }
}

export function buildNginxRedirectsConfig(parsed) {
  const lines = [
    `# 自动生成：由 website/scripts/gen-nginx-redirects.mjs 基于 website/src/release.ts 生成（v${parsed.version}）`,
    '# 使用 302 + no-store 保证每次点击都经由 Nginx 记入访问日志，发版切换版本立即生效不缓存。',
    ''
  ]
  for (const item of parsed.targets) {
    lines.push(
      `location = ${item.path} {`,
      '    add_header Cache-Control "no-store, no-cache, must-revalidate" always;',
      '    add_header X-Robots-Tag "noindex, nofollow" always;',
      `    return 302 ${item.url};`,
      '}',
      ''
    )
  }
  return lines.join('\n')
}

const isDirectRun =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isDirectRun) {
  const here = dirname(fileURLToPath(import.meta.url))
  const releaseTsPath = join(dirname(here), 'src', 'release.ts')
  const parsed = parseReleaseRedirects(readFileSync(releaseTsPath, 'utf8'))
  const output = buildNginxRedirectsConfig(parsed)
  const outIdx = process.argv.indexOf('--out')
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    const outPath = resolve(process.argv[outIdx + 1])
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, output, 'utf8')
  } else {
    process.stdout.write(output)
  }
}
