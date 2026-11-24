import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHANGELOG_TOPICS,
  matchesChangelogFilter,
  parseChangelog
} from '../website/src/changelog-parser'

const ROOT = resolve(__dirname, '..')
const rawChangelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8')
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  version: string
}

describe('website changelog-parser', () => {
  it('完整解析仓库 CHANGELOG.md 并对齐最新版本', () => {
    const releases = parseChangelog(rawChangelog)
    expect(releases.length).toBeGreaterThanOrEqual(45)
    expect(releases[0]?.version).toBe(rootPkg.version)
    expect(releases[0]?.anchorId).toBe(`changelog-${rootPkg.version}`)

    for (const rel of releases) {
      expect(rel.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(rel.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(rel.headline.length).toBeGreaterThan(0)
      expect(rel.itemCount).toBeGreaterThan(0)
    }
  })

  it('正确解析版本尾注、多小节版本及无三级标题版本', () => {
    const releases = parseChangelog(rawChangelog)

    const v040 = releases.find((item) => item.version === '0.4.0')
    expect(v040?.badgeNote).toBe('二创维护版首个发布')
    expect(v040?.sections.some((sec) => sec.heading === null && sec.paragraphs.length > 0)).toBe(
      true
    )
    expect(v040?.sections.filter((sec) => Boolean(sec.heading)).length).toBeGreaterThanOrEqual(5)

    const v101 = releases.find((item) => item.version === '1.0.1')
    expect(v101?.sections).toHaveLength(1)
    expect(v101?.sections[0]?.heading).toBeNull()
    expect(v101?.headline.length).toBeGreaterThan(0)
  })

  it('支持版本号、多词空格/全角空格 AND 检索与主题过滤', () => {
    const releases = parseChangelog(rawChangelog)

    const byVerPrefix = releases.filter((item) => matchesChangelogFilter(item, 'v1.0.47', 'all'))
    expect(byVerPrefix.map((item) => item.version)).toEqual(['1.0.47'])

    const multiTerm = releases.filter((item) =>
      matchesChangelogFilter(item, '资料分析\u3000流式', 'all')
    )
    expect(multiTerm.some((item) => item.version === '1.0.46')).toBe(true)

    const shenlunTopic = CHANGELOG_TOPICS.find((t) => t.id === 'shenlun')
    expect(shenlunTopic).toBeDefined()
    const shenlunMatches = releases.filter((item) => matchesChangelogFilter(item, '', 'shenlun'))
    expect(shenlunMatches.some((item) => item.version === '1.0.45')).toBe(true)
    expect(
      shenlunMatches.every((item) => !matchesChangelogFilter(item, '不存在关键词xyz', 'shenlun'))
    ).toBe(true)
  })
})
