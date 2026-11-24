import { Fragment, useEffect, useMemo, useState } from 'react'
import changelogMarkdown from '../../CHANGELOG.md?raw'
import { release } from './release'
import {
  CHANGELOG_TOPICS,
  matchesChangelogFilter,
  parseChangelog,
  type ChangelogRelease,
  type ChangelogTopicId
} from './changelog-parser'
import { renderInline } from './markdown-inline'

const GITHUB_CHANGELOG_URL = 'https://github.com/nghqqa/tizhou/blob/master/CHANGELOG.md'
const GITHUB_RELEASES_BASE = 'https://github.com/nghqqa/tizhou/releases/tag/v'
const RECENT_VISIBLE_COUNT = 5

function renderReleaseBody(entry: ChangelogRelease): React.JSX.Element {
  return (
    <div className="cl-body">
      {entry.sections.map((section, secIndex) => (
        <div key={secIndex} className="cl-subsection">
          {section.heading && <h3>{section.heading}</h3>}
          {section.paragraphs.map((para, pIndex) => (
            <p key={pIndex} className="cl-para">
              {renderInline(para)}
            </p>
          ))}
          {section.items.length > 0 && (
            <ul className="cl-list">
              {section.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  {item.split('\n').map((line, lineIndex) => (
                    <Fragment key={lineIndex}>
                      {lineIndex > 0 && <br />}
                      {renderInline(line)}
                    </Fragment>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function ReleaseCard({
  entry,
  isLatest
}: {
  entry: ChangelogRelease
  isLatest: boolean
}): React.JSX.Element {
  return (
    <article
      className={isLatest ? 'cl-card cl-card-latest' : 'cl-card'}
      id={entry.anchorId}
      aria-labelledby={`${entry.anchorId}-title`}
    >
      <header className="cl-card-header">
        <div className="cl-card-title-row">
          <h2 id={`${entry.anchorId}-title`}>
            <span className="cl-ver-pill">v{entry.version}</span>
          </h2>
          {isLatest && <span className="cl-badge cl-badge-accent">最新版</span>}
          {entry.badgeNote && <span className="cl-badge">{entry.badgeNote}</span>}
          <time className="cl-date" dateTime={entry.date}>
            {entry.date}
          </time>
        </div>
        {isLatest && (
          <div className="cl-latest-actions">
            <a className="btn btn-primary btn-small" href={release.directDownload.url}>
              下载 v{release.version} 安装包
            </a>
            <a
              className="btn btn-secondary btn-small"
              href={`${GITHUB_RELEASES_BASE}${entry.version}`}
              target="_blank"
              rel="noreferrer"
            >
              查看 Release 说明
            </a>
          </div>
        )}
      </header>
      {renderReleaseBody(entry)}
    </article>
  )
}

export function ChangelogPage({
  onBack,
  onOpenGuide,
  targetVersion
}: {
  onBack: () => void
  onOpenGuide: () => void
  targetVersion?: string | null
}): React.JSX.Element {
  const releases = useMemo(() => parseChangelog(changelogMarkdown), [])
  const latest = releases[0]

  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState<ChangelogTopicId>('all')
  const [openVersions, setOpenVersions] = useState<Set<string>>(() => new Set())
  const [activeVersion, setActiveVersion] = useState<string>(
    () => targetVersion ?? latest?.version ?? ''
  )

  const isFiltering = query.trim().length > 0 || topic !== 'all'

  const filteredReleases = useMemo(
    () => releases.filter((entry) => matchesChangelogFilter(entry, query, topic)),
    [releases, query, topic]
  )

  const recentReleases = useMemo(
    () => (isFiltering ? filteredReleases : filteredReleases.slice(0, RECENT_VISIBLE_COUNT)),
    [filteredReleases, isFiltering]
  )

  const historyReleases = useMemo(
    () => (isFiltering ? [] : filteredReleases.slice(RECENT_VISIBLE_COUNT)),
    [filteredReleases, isFiltering]
  )

  const allHistoryOpen =
    historyReleases.length > 0 && historyReleases.every((entry) => openVersions.has(entry.version))

  useEffect(() => {
    if (!targetVersion) return
    const target = releases.find((entry) => entry.version === targetVersion)
    if (!target) return
    setActiveVersion(target.version)
    if (releases.indexOf(target) >= RECENT_VISIBLE_COUNT) {
      setOpenVersions((prev) => {
        if (prev.has(target.version)) return prev
        const next = new Set(prev)
        next.add(target.version)
        return next
      })
    }
    const raf = window.requestAnimationFrame(() => {
      document.getElementById(target.anchorId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      })
    })
    return () => window.cancelAnimationFrame(raf)
  }, [targetVersion, releases])

  function handleToggleHistoryVersion(version: string, isOpen: boolean): void {
    setOpenVersions((prev) => {
      const has = prev.has(version)
      if (isOpen === has) return prev
      const next = new Set(prev)
      if (isOpen) next.add(version)
      else next.delete(version)
      return next
    })
  }

  function handleToggleAllHistory(): void {
    if (allHistoryOpen) {
      setOpenVersions(new Set())
    } else {
      setOpenVersions(new Set(historyReleases.map((entry) => entry.version)))
    }
  }

  function jumpToVersion(version: string): void {
    const target = releases.find((entry) => entry.version === version)
    if (!target) return
    setActiveVersion(version)
    if (!isFiltering && releases.indexOf(target) >= RECENT_VISIBLE_COUNT) {
      setOpenVersions((prev) => {
        if (prev.has(version)) return prev
        const next = new Set(prev)
        next.add(version)
        return next
      })
    }
    window.history.replaceState(null, '', `#${target.anchorId}`)
    window.requestAnimationFrame(() => {
      document.getElementById(target.anchorId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      })
    })
  }

  function resetFilters(): void {
    setQuery('')
    setTopic('all')
  }

  return (
    <section className="changelog-section" aria-labelledby="changelog-page-title">
      <div className="container guide-topbar">
        <button type="button" className="btn btn-secondary btn-small" onClick={onBack}>
          ← 返回官网首页
        </button>
        <div className="guide-topbar-links">
          <a
            href="#guide"
            className="header-link"
            onClick={(e) => {
              e.preventDefault()
              onOpenGuide()
            }}
          >
            用户手册
          </a>
          <a
            href={release.releasePages.github}
            target="_blank"
            rel="noreferrer"
            className="header-link"
          >
            GitHub Releases
          </a>
          <a
            href={release.releasePages.cnb}
            target="_blank"
            rel="noreferrer"
            className="header-link"
          >
            CNB Releases
          </a>
        </div>
      </div>

      <div className="container">
        <div className="cl-hero">
          <div className="cl-hero-copy">
            <p className="eyebrow">版本演进记录</p>
            <h1 id="changelog-page-title">更新日志</h1>
            <p className="cl-hero-desc">
              同步自项目 <code>CHANGELOG.md</code>，记录题舟每个版本的特性升级、体验打磨与问题修复。
            </p>
            {latest && (
              <div className="cl-hero-stats">
                <span className="cl-stat-chip">当前最新 v{latest.version}</span>
                <span className="cl-stat-chip">发布于 {latest.date}</span>
                <span className="cl-stat-chip">共 {releases.length} 个版本</span>
              </div>
            )}
          </div>
          <div className="cl-hero-cta">
            <a className="btn btn-primary" href={release.directDownload.url}>
              下载最新版 v{release.version}
              <span className="btn-sub">
                {release.asset.name} · {release.asset.sizeHint}
              </span>
            </a>
          </div>
        </div>

        <div className="cl-toolbar" role="search" aria-label="筛选更新日志">
          <div className="cl-search-row">
            <div className="cl-search-field">
              <label className="sr-only" htmlFor="cl-search">
                搜索更新日志
              </label>
              <input
                id="cl-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.nativeEvent.isComposing) return
                  if (e.key === 'Escape' && query) {
                    setQuery('')
                  }
                }}
                placeholder="搜索版本号或关键词，例如：资料分析、申论、OCR、1.0.46"
              />
              {query && (
                <button
                  type="button"
                  className="cl-clear-btn"
                  onClick={() => setQuery('')}
                  aria-label="清空搜索词"
                >
                  清空
                </button>
              )}
            </div>

            {filteredReleases.length > 0 && (
              <div className="cl-mobile-jump">
                <label className="sr-only" htmlFor="cl-mobile-select">
                  快速跳转版本
                </label>
                <select
                  id="cl-mobile-select"
                  aria-label="快速跳转版本"
                  value={
                    filteredReleases.some((item) => item.version === activeVersion)
                      ? activeVersion
                      : filteredReleases[0]!.version
                  }
                  onChange={(e) => jumpToVersion(e.target.value)}
                >
                  {filteredReleases.map((entry) => (
                    <option key={entry.version} value={entry.version}>
                      v{entry.version}（{entry.date}）
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="cl-topics" role="group" aria-label="按功能主题筛选">
            {CHANGELOG_TOPICS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={topic === item.id ? 'cl-topic-btn active' : 'cl-topic-btn'}
                aria-pressed={topic === item.id}
                onClick={() => setTopic(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="cl-status-row">
            <p className="cl-status" aria-live="polite">
              {isFiltering
                ? `匹配到 ${filteredReleases.length} 个版本（共 ${releases.length} 个版本）`
                : `共收录 ${releases.length} 个版本，默认展开最近 ${Math.min(RECENT_VISIBLE_COUNT, releases.length)} 个版本`}
            </p>
            {!isFiltering && historyReleases.length > 0 && (
              <button
                type="button"
                className="cl-toggle-all-btn"
                aria-expanded={allHistoryOpen}
                onClick={handleToggleAllHistory}
              >
                {allHistoryOpen ? '收起历史版本' : '展开全部历史版本'}
              </button>
            )}
            {isFiltering && (
              <button type="button" className="cl-toggle-all-btn" onClick={resetFilters}>
                重置筛选
              </button>
            )}
          </div>
        </div>

        <div className="changelog-layout">
          <aside className="cl-toc" aria-label="版本目录">
            <p className="guide-toc-title">版本索引（{filteredReleases.length}）</p>
            <nav>
              {filteredReleases.map((entry) => {
                const isLatestEntry = entry.version === latest?.version
                const isCurrent = entry.version === activeVersion
                return (
                  <a
                    key={entry.version}
                    href={`#${entry.anchorId}`}
                    className={isCurrent ? 'cl-toc-link current' : 'cl-toc-link'}
                    onClick={(e) => {
                      e.preventDefault()
                      jumpToVersion(entry.version)
                    }}
                  >
                    <span className="cl-toc-ver">
                      {isLatestEntry && <span className="cl-toc-dot" aria-hidden="true" />}v
                      {entry.version}
                    </span>
                    <span className="cl-toc-date">{entry.date.slice(5)}</span>
                  </a>
                )
              })}
            </nav>
          </aside>

          <div className="cl-timeline">
            {filteredReleases.length === 0 ? (
              <div className="cl-empty">
                <p>没有找到匹配的更新记录，可以尝试缩短关键词或切换主题标签。</p>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={resetFilters}
                >
                  重置筛选
                </button>
              </div>
            ) : (
              <>
                <div className="cl-cards">
                  {recentReleases.map((entry) => (
                    <ReleaseCard
                      key={entry.version}
                      entry={entry}
                      isLatest={entry.version === latest?.version}
                    />
                  ))}
                </div>

                {historyReleases.length > 0 && (
                  <section className="cl-history" aria-labelledby="cl-history-heading">
                    <h2 id="cl-history-heading" className="cl-history-heading">
                      历史版本（共 {historyReleases.length} 个）
                    </h2>
                    <div className="cl-history-list">
                      {historyReleases.map((entry) => (
                        <details
                          key={entry.version}
                          id={entry.anchorId}
                          className="cl-history-item"
                          open={openVersions.has(entry.version)}
                          onToggle={(e) =>
                            handleToggleHistoryVersion(entry.version, e.currentTarget.open)
                          }
                        >
                          <summary>
                            <span className="cl-ver-pill">v{entry.version}</span>
                            <span className="cl-date">{entry.date}</span>
                            <span className="cl-summary-title">{entry.headline}</span>
                            <span className="cl-summary-count">{entry.itemCount} 项</span>
                          </summary>
                          <div className="cl-history-body">{renderReleaseBody(entry)}</div>
                        </details>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}

            <div className="cl-bottom-bar">
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              >
                ↑ 回到顶部
              </button>
              <a
                href={GITHUB_CHANGELOG_URL}
                target="_blank"
                rel="noreferrer"
                className="header-link"
              >
                在 GitHub 查看完整 CHANGELOG.md
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
