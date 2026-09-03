// 更新源自动选择：cnb 优先、GitHub 回退
import { describe, expect, it } from 'vitest'
import { cnbFeedUrlFromTag, resolveUpdateFeed, versionGte } from '../src/main/services/update-feed'

function fetchJson(url: string, body: unknown) {
  void url
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  ) as unknown as typeof fetch
}
const failFetch = (async () => {
  throw new Error('unreachable')
}) as unknown as typeof fetch

describe('cnbFeedUrlFromTag', () => {
  it('tag 保留 v 前缀构造下载目录', () => {
    expect(cnbFeedUrlFromTag('v1.0.9')).toBe(
      'https://cnb.cool/nghqqa/tizhou/-/releases/download/v1.0.9'
    )
  })
})

describe('versionGte', () => {
  it('标准 semver 比较', () => {
    expect(versionGte('v1.0.9', 'v1.0.9')).toBe(true)
    expect(versionGte('v1.0.10', 'v1.0.9')).toBe(true)
    expect(versionGte('v1.0.9', 'v1.0.10')).toBe(false)
    expect(versionGte('v1.1.0', 'v1.0.99')).toBe(true)
  })
  it('异常格式保守返回 false（回退 GitHub）', () => {
    expect(versionGte('not-a-version', 'v1.0.9')).toBe(false)
  })
})

describe('resolveUpdateFeed', () => {
  it('cnb 可达 → 使用国内镜像目录', async () => {
    const calls: string[] = []
    const fetchImpl = ((url: string | URL) => {
      calls.push(String(url))
      return fetchJson(url, { tag_name: 'v1.0.9' })
    }) as unknown as typeof fetch
    const feed = await resolveUpdateFeed(fetchImpl)
    expect(feed.source).toBe('cnb')
    expect(feed.provider).toBe('generic')
    expect(feed.url).toContain('/download/v1.0.9')
    expect(calls.some((c) => c.includes('api.cnb.cool'))).toBe(true)
  })

  it('cnb 不可达但 GitHub 可达 → 回退 GitHub', async () => {
    const fetchImpl = ((url: string | URL) => {
      if (String(url).includes('cnb')) throw new Error('blocked')
      return fetchJson(url, { tag_name: 'v1.0.9' })
    }) as unknown as typeof fetch
    const feed = await resolveUpdateFeed(fetchImpl)
    expect(feed.source).toBe('github')
    expect(feed.provider).toBe('github')
  })

  it('cnb 版本落后于 GitHub → 回退 GitHub（避免陈旧镜像）', async () => {
    const fetchImpl = ((url: string | URL) =>
      fetchJson(url, {
        tag_name: String(url).includes('cnb') ? 'v1.0.8' : 'v1.0.9'
      })) as unknown as typeof fetch
    const feed = await resolveUpdateFeed(fetchImpl)
    expect(feed.source).toBe('github')
  })

  it('两边都不可达 → 保持默认 GitHub 行为', async () => {
    const feed = await resolveUpdateFeed(failFetch)
    expect(feed.source).toBe('github')
    expect(feed.url).toBeUndefined()
  })
})
