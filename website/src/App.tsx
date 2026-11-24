import { useEffect, useState } from 'react'
import { release } from './release'
import { UserGuide } from './UserGuide'
import { ChangelogPage } from './ChangelogPage'

type PageView = 'home' | 'guide' | 'changelog'

function resolveRouteFromHash(hash: string): { view: PageView; targetVersion: string | null } {
  if (hash === '#guide') {
    return { view: 'guide', targetVersion: null }
  }
  if (hash === '#changelog') {
    return { view: 'changelog', targetVersion: null }
  }
  const versionMatch = hash.match(/^#changelog-([\d.]+)$/)
  if (versionMatch?.[1]) {
    return { view: 'changelog', targetVersion: versionMatch[1] }
  }
  return { view: 'home', targetVersion: null }
}

const shot = (name: string): string => `./screenshots/${name}.webp`

interface FlowTab {
  id: string
  tab: string
  img: string
  caption: string
  title: string
  desc: string
  points: string[]
}

// 展示顺序把最直观的图形推理与模考复盘放前两位
const FLOWS: FlowTab[] = [
  {
    id: 'practice',
    tab: '行测与图形推理直显',
    img: shot('02-practice-graphic'),
    caption: '题舟 · 专项练习（内置示例库数据）',
    title: '多维筛选组卷，图形推理图片选项直显',
    desc: '科目、模块、年份、地区、试卷、难度、关键词多维组合筛选，支持只练错题、只练收藏，断点续练。',
    points: [
      '顺序 / 随机 / 自适应三种模式，即时或汇总解析',
      '混合卷图推小题按版面坐标自动绑定选项图，作答与复盘直接显示图片选项',
      '键盘作答：数字选选项、回车提交、N 切下一题'
    ]
  },
  {
    id: 'exam',
    tab: '真题模考与逐题复盘',
    img: shot('03-exam-review'),
    caption: '题舟 · 真题模考成绩单与逐题复盘',
    title: '按原题号整卷组卷，交卷即出成绩单',
    desc: '导入你的真题卷后限时模考，交卷自动评分：得分、正确率、用时一目了然。',
    points: [
      '逐题复盘：你的作答 vs 参考答案、选项对照、模块正确率分布',
      '可筛「仅看错题与未答」，历史模考随时回看',
      '主观题自动保存，保存失败会阻止交卷并提供重试'
    ]
  },
  {
    id: 'import',
    tab: 'PDF 题本建库与来源页对照',
    img: shot('04-knowledge-builder'),
    caption: '题舟 · 知识库工坊（来源页对照）',
    title: 'PDF 题本一键建库，来源页逐页对照',
    desc: '题本、解析、答案册同批导入：逐页检测文字层、自动切题、按题号配答案、去重、抽查入库。',
    points: [
      '点击「来源页预览」调出原始 PDF 页对照，切分结果与原卷逐页核对',
      '图形推理等高风险产物必须人工确认后才能入库，配对存疑会明确标注',
      '文字为主模块导入效果最佳；资料分析等表格材料务必逐项核对数字'
    ]
  },
  {
    id: 'essay',
    tab: '申论给定材料与规则评分',
    img: shot('05-shenlun'),
    caption: '题舟 · 申论作答与本地规则评分',
    title: '给定材料 + 草稿自动保存，评分即时可见',
    desc: '左看材料、右写作答，草稿自动保存不丢失；提交评估立刻得到维度化的分数与建议。',
    points: [
      'AI 评估按需自备模型 Key，配置后自动启用',
      '不配置 AI 也有本地规则评分兜底，全功能刷题零依赖',
      '学习报告、能力诊断、学习计划持续跟踪备考状态'
    ]
  }
]

const HERO_CHIPS = ['本地 SQLite + Markdown 双存储', 'PDF OCR 一键建库', '日常刷题完全离线']

const WHY: Array<{ icon: string; title: string; lead: string; text: string }> = [
  {
    icon: 'storage',
    title: '双存储形态',
    lead: '本机 SQLite',
    text: '学习记录存在本机 SQLite，不上传、无遥测；题库与知识文档是纯 Markdown，备份、迁移、自己动手写都自由。'
  },
  {
    icon: 'ocr',
    title: 'PDF OCR 建库',
    lead: '一键导入',
    text: '题本与解析同批直导，扫描件走本地 OCR，来源页逐页留证，人工审核通过才入库。'
  },
  {
    icon: 'offline',
    title: '完全离线',
    lead: '零依赖刷题',
    text: '训练、模考、错题复习全程离线可用，无广告无推送；仅扫描版 PDF 导入需要 Python，未安装时应用会自动下载独立运行时。'
  },
  {
    icon: 'backup',
    title: '每日自动备份',
    lead: '数据可回滚',
    text: '按保留数量滚动备份，跨机迁移一键打包；数据就是本机文件，手动复制同样有效。'
  },
  {
    icon: 'box',
    title: '示例库开箱即试',
    lead: '装好就能刷',
    text: '安装包内置体验示例库，训练、模考、申论、报告立即上手；正式备考导入你自己的资料。'
  },
  {
    icon: 'ai',
    title: 'AI 可选接入',
    lead: '自备 Key',
    text: 'AI 助教、错题深讲、变式训练按需启用，Key 加密存储；不配置也全功能可用。'
  }
]

const COMPARE = [
  { dim: '题目数据', app: '存在云端服务器', tizhou: '存在本机 SQLite，随时备份迁移' },
  { dim: '题库来源', app: '平台统一分发', tizhou: '你自己的 PDF / Markdown 资料' },
  { dim: '广告与会员', app: '广告、会员解锁常见', tizhou: '无广告无会员，MIT 开源免费' },
  { dim: '离线使用', app: '多数场景需要联网', tizhou: '日常刷题完全离线' },
  { dim: 'AI 能力', app: '平台内置，按量收费', tizhou: '自备 Key 可选接入，明文不落盘' }
]

const FAQ = [
  {
    q: 'SmartScreen 提示「未知发布者」，能安装吗？',
    a: '可以。点击「更多信息 → 仍要运行」即可。题舟是个人维护的开源项目，暂未购买商业代码签名证书；安装包在发布页附带 SHA256SUMS.txt，可自行校验哈希。'
  },
  {
    q: '题库从哪里来？软件自带题目吗？',
    a: '题舟因版权原因不分发任何题目内容，安装包内置的示例库仅用于体验功能。正式备考有三种导入渠道：自己的题本 PDF 直导（扫描件走本地 OCR）、Markdown 题库目录直连、社区公开题库的格式转换（权利状态需自行评估）。'
  },
  {
    q: '必须配置 AI 模型吗？',
    a: '不必须。不填 API Key 也能使用训练、模考、错题复习、申论本地规则评分等全部功能。需要 AI 助教、AI 深度讲解、变式训练时，在模型设置中选择服务商并填入自备的 Key；Key 经 Windows 加密存储，明文不落盘。'
  },
  {
    q: '数据会丢吗？怎么备份和换电脑？',
    a: '应用默认每日自动备份并按保留数量滚动清理；设置页可一键导出跨机迁移包。你的全部数据就是本机的 SQLite 数据库与 Markdown 文件，手动复制同样有效。'
  },
  {
    q: '对电脑配置有什么要求？',
    a: 'Windows 10 1809+ 或 Windows 11（64 位）；内存 4 GB 起步、推荐 8 GB；磁盘空间为应用约 500 MB 加 OCR 引擎约 200 MB，另加题库空间。Python 仅在导入扫描版 PDF 时需要，未安装时应用会自动下载独立运行时。'
  },
  {
    q: '题舟收费吗？',
    a: '免费。MIT 开源协议，代码公开可审查，无广告、无会员、无使用统计与遥测。'
  }
]

function WhyIcon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, React.JSX.Element> = {
    storage: (
      <>
        <ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
        <path d="M5 5.5v6c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-6" />
        <path d="M5 11.5v6c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-6" />
      </>
    ),
    ocr: (
      <>
        <path d="M6 3h8.5L19 7.5V21H6z" />
        <path d="M14 3v5h5" />
        <path d="M9 13h6M9 16.5h4" />
      </>
    ),
    offline: (
      <>
        <path d="M2.5 9.5c5.3-5.2 13.7-5.2 19 0" />
        <path d="M6 13c3.5-3.4 8.5-3.4 12 0" />
        <path d="M9.3 16.3c1.6-1.5 3.8-1.5 5.4 0" />
        <circle cx="12" cy="19.3" r="1.1" fill="currentColor" stroke="none" />
        <path d="M3.5 3.5l17 17" />
      </>
    ),
    backup: (
      <>
        <path d="M12 3l7 2.8v5.4c0 4.8-3.4 8.2-7 9.8-3.6-1.6-7-5-7-9.8V5.8z" />
        <path d="M9 11.8l2.1 2.2 4-4.2" />
      </>
    ),
    box: (
      <>
        <path d="M21 8.2L12 3.5 3 8.2v7.6l9 4.7 9-4.7z" />
        <path d="M3 8.2l9 4.6 9-4.6" />
        <path d="M12 12.8v7.7" />
      </>
    ),
    ai: (
      <>
        <path d="M11 4l1.6 4.6 4.6 1.6-4.6 1.7L11 16.5 9.4 11.9 4.8 10.2 9.4 8.6z" />
        <path d="M18.2 14.6l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z" />
      </>
    )
  }
  return (
    <span className="why-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths[name]}
      </svg>
    </span>
  )
}

interface ZoomState {
  src: string
  alt: string
}

function Lightbox({ zoom, onClose }: { zoom: ZoomState; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="截图放大查看"
      onClick={onClose}
    >
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭大图">
        ×
      </button>
      <img src={zoom.src} alt={zoom.alt} onClick={(event) => event.stopPropagation()} />
    </div>
  )
}

function ShotFrame({
  src,
  alt,
  caption,
  onZoom,
  eager
}: {
  src: string
  alt: string
  caption: string
  onZoom: () => void
  eager?: boolean
}): React.JSX.Element {
  return (
    <figure className="shot-frame">
      <div className="shot-bar" aria-hidden="true">
        <span className="shot-dot" />
        <span className="shot-dot" />
        <span className="shot-dot" />
        <span className="shot-caption">{caption}</span>
        <span className="shot-zoom-hint">点击放大</span>
      </div>
      <button type="button" className="shot-body" onClick={onZoom} aria-label={`放大查看：${alt}`}>
        <img src={src} alt={alt} loading={eager ? undefined : 'lazy'} />
      </button>
    </figure>
  )
}

function FlowTabs({ onZoom }: { onZoom: (zoom: ZoomState) => void }): React.JSX.Element {
  const [active, setActive] = useState(FLOWS[0]!.id)
  const flow = FLOWS.find((item) => item.id === active) ?? FLOWS[0]!
  return (
    <div className="flow">
      <div className="flow-tabs" role="tablist" aria-label="核心流程">
        {FLOWS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === active}
            className={`flow-tab ${item.id === active ? 'active' : ''}`}
            onClick={() => setActive(item.id)}
          >
            <span className="flow-tab-no">{index + 1}</span>
            {item.tab}
          </button>
        ))}
      </div>
      <div className="flow-body">
        <ShotFrame
          src={flow.img}
          alt={flow.title}
          caption={flow.caption}
          onZoom={() => onZoom({ src: flow.img, alt: flow.title })}
        />
        <div className="flow-info">
          <h3>{flow.title}</h3>
          <p>{flow.desc}</p>
          <ul>
            {flow.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

export function App(): React.JSX.Element {
  const [zoom, setZoom] = useState<ZoomState | null>(null)
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [route, setRoute] = useState(() => resolveRouteFromHash(window.location.hash))
  const view = route.view

  useEffect(() => {
    const syncHash = (): void => {
      const next = resolveRouteFromHash(window.location.hash)
      setRoute(next)
      if (next.view === 'guide' || (next.view === 'changelog' && !next.targetVersion)) {
        window.scrollTo({ top: 0, behavior: 'auto' })
      }
    }
    window.addEventListener('hashchange', syncHash)
    return () => window.removeEventListener('hashchange', syncHash)
  }, [])

  useEffect(() => {
    if (view === 'guide') {
      document.title = '用户手册 · 题舟 Tizhou'
    } else if (view === 'changelog') {
      document.title = '更新日志 · 题舟 Tizhou'
    } else {
      document.title = '题舟 Tizhou · 本地优先的开源考公学习工作台'
    }
  }, [view])

  function openGuide(): void {
    if (window.location.hash !== '#guide') {
      window.location.hash = '#guide'
    }
    setRoute({ view: 'guide', targetVersion: null })
    window.scrollTo({ top: 0, behavior: 'auto' })
  }

  function openChangelog(version?: string): void {
    const targetHash = version ? `#changelog-${version}` : '#changelog'
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash
    }
    setRoute({ view: 'changelog', targetVersion: version ?? null })
    if (!version) {
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
  }

  function backToHome(anchor?: string): void {
    setRoute({ view: 'home', targetVersion: null })
    if (anchor) {
      window.location.hash = anchor
      window.requestAnimationFrame(() => {
        document.getElementById(anchor.replace(/^#/, ''))?.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        })
      })
    } else {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
  }

  function copyChecksumCommand(): void {
    void navigator.clipboard
      ?.writeText(release.asset.checksumCommand)
      .then(() => {
        setCopiedCmd(true)
        window.setTimeout(() => setCopiedCmd(false), 2000)
      })
      .catch(() => {
        /* 忽略受限环境剪贴板写入失败 */
      })
  }

  return (
    <div className="site">
      <header className="site-header">
        <div className="container header-inner">
          <a
            className="brand"
            href="#top"
            onClick={(e) => {
              if (view !== 'home') {
                e.preventDefault()
                backToHome()
              }
            }}
          >
            <img className="brand-logo" src="./favicon-64.png" alt="" />
            <span className="brand-name">题舟 Tizhou</span>
          </a>
          <nav className="site-nav" aria-label="页面导航">
            <a href="#flow" onClick={() => view !== 'home' && backToHome('#flow')}>
              核心流程
            </a>
            <a href="#why" onClick={() => view !== 'home' && backToHome('#why')}>
              为什么用题舟
            </a>
            <a href="#start" onClick={() => view !== 'home' && backToHome('#start')}>
              快速上手
            </a>
            <a href="#faq" onClick={() => view !== 'home' && backToHome('#faq')}>
              常见问题
            </a>
            <a
              href="#guide"
              aria-current={view === 'guide' ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault()
                openGuide()
              }}
            >
              用户手册
            </a>
            <a
              href="#changelog"
              aria-current={view === 'changelog' ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault()
                openChangelog()
              }}
            >
              更新日志
            </a>
          </nav>
          <div className="header-links">
            <a href="https://github.com/nghqqa/tizhou" className="header-link">
              GitHub
            </a>
            <a href="https://cnb.cool/nghqqa/tizhou" className="header-link">
              CNB
            </a>
            <a
              href="#download"
              className="btn btn-primary btn-small"
              onClick={(e) => {
                if (view !== 'home') {
                  e.preventDefault()
                  backToHome('#download')
                }
              }}
            >
              下载 v{release.version}
            </a>
          </div>
        </div>
      </header>

      <main id="top">
        {view === 'guide' ? (
          <UserGuide onBack={() => backToHome()} onOpenChangelog={() => openChangelog()} />
        ) : view === 'changelog' ? (
          <ChangelogPage
            onBack={() => backToHome()}
            onOpenGuide={() => openGuide()}
            targetVersion={route.targetVersion}
          />
        ) : (
          <>
            {/* Hero 首屏 */}
            <section className="hero" id="download">
              <div className="container hero-inner">
                <div className="hero-copy">
                  <p className="eyebrow">本地优先 · 开源 · MIT 协议</p>
                  <h1>
                    题舟 <span className="latin">Tizhou</span>
                  </h1>
                  <p className="hero-tag">数据存你自己的电脑，题库由你自己导入。</p>
                  <p className="hero-desc">
                    本地优先的开源考公学习工作台：PDF
                    题本一键建库，训练、模考、错题复习、学习报告完整闭环。
                    无广告、无会员、无遥测，日常刷题完全离线。
                  </p>
                  <ul className="hero-chips" aria-label="关键能力">
                    {HERO_CHIPS.map((chip) => (
                      <li key={chip}>{chip}</li>
                    ))}
                  </ul>
                  <div className="dl-buttons">
                    <a className="btn btn-primary" href={release.directDownload.url}>
                      国内高速下载 v{release.version}
                      <span className="btn-sub">
                        直接下载 {release.asset.name} · {release.asset.sizeHint}
                      </span>
                    </a>
                    <a className="btn btn-ghost" href={release.releasePages.github}>
                      GitHub Releases
                      <span className="btn-sub">国际网络适用</span>
                    </a>
                  </div>
                  <p className="hero-meta">
                    全量文件与{' '}
                    <a href={release.checksumUrls.cnb}>{release.asset.checksumFile}（国内源）</a> /{' '}
                    <a href={release.checksumUrls.github}>GitHub 源</a> 同步公开，v{release.version}{' '}
                    · {release.platform} · {release.license} ·{' '}
                    <a
                      href="#changelog"
                      onClick={(e) => {
                        e.preventDefault()
                        openChangelog()
                      }}
                    >
                      查看更新日志
                    </a>
                  </p>
                  <details className="hero-trust">
                    <summary>
                      首次安装遇 Windows 蓝色安全提示？查看放行步骤与 SHA-256 核验方法
                    </summary>
                    <div className="hero-trust-body">
                      <p>
                        题舟是个人维护的 MIT
                        开源软件，暂未购置商业代码签名证书。下载后首次运行若出现 Windows SmartScreen
                        提示「未知发布者」，点击「<strong>更多信息</strong>」再选 「
                        <strong>仍要运行</strong>」即可，仅需放行一次。
                      </p>
                      <p>
                        如需核验安装包完整性，在安装包所在目录打开终端执行下方命令，并与官方{' '}
                        <a href={release.checksumUrls.cnb}>{release.asset.checksumFile}</a>{' '}
                        中的哈希逐字比对：
                      </p>
                      <div className="checksum-row">
                        <code>{release.asset.checksumCommand}</code>
                        <button
                          type="button"
                          className="copy-cmd-btn"
                          onClick={copyChecksumCommand}
                        >
                          {copiedCmd ? '已复制' : '复制命令'}
                        </button>
                      </div>
                    </div>
                  </details>
                </div>
                <ShotFrame
                  src={shot('01-dashboard')}
                  alt="题舟今日工作台：学习日历热力图与待复习概览"
                  caption="题舟 · 今日工作台（内置示例库数据）"
                  eager
                  onZoom={() => setZoom({ src: shot('01-dashboard'), alt: '今日工作台大图' })}
                />
              </div>
            </section>

            {/* 核心流程 */}
            <section className="section" id="flow">
              <div className="container">
                <h2>从题本 PDF 到上岸，一条完整闭环</h2>
                <p className="section-desc">
                  四个阶段覆盖备考全程：训练、模考、建库、复盘。以下截图均来自真实应用界面，点击可放大查看。
                </p>
                <FlowTabs onZoom={setZoom} />
              </div>
            </section>

            {/* 为什么用题舟 */}
            <section className="section section-alt" id="why">
              <div className="container">
                <h2>为什么用题舟，而不是又一个刷题 App</h2>
                <p className="section-desc">题舟把数据主权还给你：本地存储、开放格式、离线可用。</p>
                <div className="why-grid">
                  {WHY.map((item) => (
                    <div className="why-card" key={item.title}>
                      <WhyIcon name={item.icon} />
                      <h3>
                        {item.title}
                        <span className="kw">{item.lead}</span>
                      </h3>
                      <p>{item.text}</p>
                    </div>
                  ))}
                </div>
                <div className="table-wrap">
                  <table className="compare">
                    <thead>
                      <tr>
                        <th>对比维度</th>
                        <th>商业刷题 App</th>
                        <th>题舟</th>
                      </tr>
                    </thead>
                    <tbody>
                      {COMPARE.map((row) => (
                        <tr key={row.dim}>
                          <td>{row.dim}</td>
                          <td>{row.app}</td>
                          <td className="highlight">{row.tizhou}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {/* 快速上手 */}
            <section className="section" id="start">
              <div className="container">
                <h2>3 分钟上手</h2>
                <p className="section-desc">
                  装好即用：内置示例库无需任何配置。正式备考约 10 分钟完成题本导入。
                </p>
                <div className="steps">
                  <div className="step">
                    <span className="step-no">1</span>
                    <h3>下载安装包</h3>
                    <p>
                      约 130 MB，点击「国内高速下载」直接开始；GitHub Releases
                      内容一致。下载后可用发布页 SHA256SUMS.txt 校验完整性。
                    </p>
                  </div>
                  <div className="step">
                    <span className="step-no">2</span>
                    <h3>双击安装</h3>
                    <p>
                      首次运行如遇 SmartScreen
                      提示，按下方指引放行即可。题舟暂未购买商业代码签名证书。
                    </p>
                  </div>
                  <div className="step">
                    <span className="step-no">3</span>
                    <h3>开始学习</h3>
                    <p>
                      安装完成即启动，内置示例题库可直接体验全部功能；正式备考时在知识库工坊导入自己的题本
                      PDF 或 Markdown。
                    </p>
                  </div>
                </div>
                <div className="smartbox">
                  <span className="smartbox-badge">Windows SmartScreen</span>
                  <div className="smartbox-flow">
                    <span>提示「未知发布者」</span>
                    <span className="smartbox-arrow">→</span>
                    <span className="smartbox-chip">点击「更多信息」</span>
                    <span className="smartbox-arrow">→</span>
                    <span className="smartbox-chip accent">选择「仍要运行」</span>
                  </div>
                  <p className="smartbox-note">
                    只需放行一次。下载后可对照官方{' '}
                    <a href={release.checksumUrls.cnb}>{release.asset.checksumFile}（CNB）</a> 或{' '}
                    <a href={release.checksumUrls.github}>GitHub 校验文件</a> 核验哈希：
                  </p>
                  <div className="checksum-row">
                    <code>{release.asset.checksumCommand}</code>
                    <button type="button" className="copy-cmd-btn" onClick={copyChecksumCommand}>
                      {copiedCmd ? '已复制' : '复制命令'}
                    </button>
                  </div>
                </div>
                <p className="start-note">
                  完整配置（可选）：知识库工坊安装转换引擎（约 200 MB，含 OCR 模型）→
                  选择题本目录导入 → 抽查发布；如需 AI 能力，再到模型设置填入自备 Key 并测试连接。
                </p>
              </div>
            </section>

            {/* FAQ */}
            <section className="section section-alt" id="faq">
              <div className="container faq-container">
                <h2>常见问题</h2>
                <div className="faq">
                  {FAQ.map((item) => (
                    <details key={item.q}>
                      <summary>{item.q}</summary>
                      <p>{item.a}</p>
                    </details>
                  ))}
                </div>
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="site-footer">
        <div className="container footer-inner">
          <div className="footer-brand">
            <img className="brand-logo" src="./favicon-64.png" alt="" />
            <div>
              <strong>题舟 Tizhou</strong>
              <p>题海行舟，终将上岸。</p>
            </div>
          </div>
          <nav className="footer-links" aria-label="项目链接">
            <a href="https://github.com/nghqqa/tizhou">GitHub 仓库</a>
            <a href="https://cnb.cool/nghqqa/tizhou">CNB 镜像</a>
            <a href={release.releasePages.cnb}>Releases（含校验文件）</a>
            <a href="https://github.com/nghqqa/tizhou/issues">问题反馈</a>
            <a
              href="#guide"
              onClick={(e) => {
                e.preventDefault()
                openGuide()
              }}
            >
              用户手册
            </a>
            <a
              href="#changelog"
              onClick={(e) => {
                e.preventDefault()
                openChangelog()
              }}
            >
              更新日志
            </a>
          </nav>
          <div className="footer-meta">
            <p>
              MIT License · v{release.version} · {release.platform}
            </p>
            {release.icp && <p>{release.icp}</p>}
          </div>
        </div>
      </footer>

      {zoom && <Lightbox zoom={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}
