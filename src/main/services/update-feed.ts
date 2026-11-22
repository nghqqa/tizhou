// 更新源自动选择：优先国内 cnb.cool（快），不可达或版本落后时回退 GitHub。
// 纯函数 + 可注入 fetch，便于单测；不改变默认 GitHub 行为（cnb 探测失败时原样走默认）。

export interface UpdateFeed {
  provider: 'github' | 'generic'
  /** generic 时为更新文件目录（latest.yml 与安装包所在），github 时缺省走内置配置 */
  url?: string
  source: 'cnb' | 'github'
}

export const CNB_LATEST_API = 'https://api.cnb.cool/nghqqa/tizhou/-/releases/latest'
export const CNB_DOWNLOAD_BASE = 'https://cnb.cool/nghqqa/tizhou/-/releases/download'
export const GITHUB_LATEST_API = 'https://api.github.com/repos/nghqqa/tizhou/releases/latest'
export const CNB_PROBE_TIMEOUT_MS = 4000
export const GITHUB_PROBE_TIMEOUT_MS = 3000

/** 由 release tag 构造 cnb 下载目录（tag 保留 v 前缀，如 v1.0.9） */
export function cnbFeedUrlFromTag(tag: string): string {
  return `${CNB_DOWNLOAD_BASE}/${tag}`
}

/** 宽松 semver 比较：a ≥ b 返回 true（只处理数字段，异常时返回 false 保守回退） */
export function versionGte(a: string, b: string): boolean {
  const parse = (v: string): number[] | undefined => {
    const cleaned = v.replace(/^v/i, '').split(/[-+]/)[0] ?? ''
    if (!/^[\d.]+$/.test(cleaned)) return undefined
    return cleaned.split('.').map((part) => Number(part) || 0)
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return false
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l > r
  }
  return true
}

async function fetchTag(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as { tag_name?: unknown }
    return typeof data.tag_name === 'string' ? data.tag_name : undefined
  } catch {
    return undefined
  }
}

/** 解析本次检查使用的更新源：cnb 可达且不落后于 GitHub 时优先国内，否则回退 GitHub。
 *  options.probeDisabled：跳过真实网络探测、固定回退 GitHub——供主进程在 E2E 模式下
 *  显式注入（service 层不读取 E2E 环境变量，保持纯净）。 */
export async function resolveUpdateFeed(
  fetchImpl: typeof fetch = fetch,
  options: { probeDisabled?: boolean } = {}
): Promise<UpdateFeed> {
  if (options.probeDisabled) return { provider: 'github', source: 'github' }
  const [cnbTag, githubTag] = await Promise.all([
    fetchTag(CNB_LATEST_API, CNB_PROBE_TIMEOUT_MS, fetchImpl),
    // GitHub 探测只是版本对照，慢或被墙都不阻塞主流程（Promise.all 内各自超时）
    fetchTag(GITHUB_LATEST_API, GITHUB_PROBE_TIMEOUT_MS, fetchImpl).catch(() => undefined)
  ])
  if (cnbTag && (!githubTag || versionGte(cnbTag, githubTag))) {
    return { provider: 'generic', url: cnbFeedUrlFromTag(cnbTag), source: 'cnb' }
  }
  return { provider: 'github', source: 'github' }
}

/** 拉取指定版本的发版更新说明（Markdown），超时或不可达时安全返回 undefined 不阻塞更新 */
export async function fetchReleaseNotes(
  version: string,
  source: 'cnb' | 'github' | undefined,
  fetchImpl: typeof fetch = fetch,
  options: { probeDisabled?: boolean } = {}
): Promise<string | undefined> {
  if (options.probeDisabled) {
    return `### 新特性与改进\n\n- 模拟版本 ${version} 更新说明（E2E 测试用）`
  }
  const cleanVer = version.replace(/^v/, '').trim()
  if (!cleanVer) return undefined

  const tryRaw = async (url: string): Promise<string | undefined> => {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'tizhou-updater' },
        signal: AbortSignal.timeout(2500)
      })
      if (!res.ok) return undefined
      const text = (await res.text()).trim()
      return text || undefined
    } catch {
      return undefined
    }
  }

  if (source === 'cnb') {
    const cnbRaw = await tryRaw(
      `https://cnb.cool/nghqqa/tizhou/-/git/raw/master/docs/release-notes-${cleanVer}.md`
    )
    if (cnbRaw) return cnbRaw
  }

  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/nghqqa/tizhou/releases/tags/v${cleanVer}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tizhou-updater' },
        signal: AbortSignal.timeout(2500)
      }
    )
    if (res.ok) {
      const data = (await res.json()) as { body?: unknown }
      if (typeof data.body === 'string' && data.body.trim()) return data.body.trim()
    }
  } catch {
    /* 回退 raw 文档 */
  }

  return tryRaw(
    `https://raw.githubusercontent.com/nghqqa/tizhou/master/docs/release-notes-${cleanVer}.md`
  )
}
