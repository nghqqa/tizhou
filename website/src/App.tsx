import { useState } from 'react'
import { release } from './release'

const shot = (name: string): string => `./screenshots/${name}.webp`

interface FlowTab {
  id: string
  tab: string
  img: string
  title: string
  desc: string
  points: string[]
}

const FLOWS: FlowTab[] = [
  {
    id: 'import',
    tab: '题库直导与人工门禁',
    img: shot('04-knowledge-builder'),
    title: 'PDF 题本一键建库，扫描件本地 OCR',
    desc: '题本、解析、答案册同批导入：逐页检测文字层、自动切题、按题号配答案、去重、抽查入库。切题结果先审核再发布。',
    points: [
      '配对一致性自动校验，疑似套号错位整书拦截，支持按任务撤销',
      '图形推理等高风险产物必须勾选「我已查看原始页面并确认内容正确」才能入库，可回跳来源 PDF 页对照核对',
      '文字为主模块导入效果最佳；资料分析等图表密集材料务必逐项核对数字'
    ]
  },
  {
    id: 'practice',
    tab: '行测训练与图推直显',
    img: shot('02-practice-graphic'),
    title: '多维筛选组卷，图形推理图片选项直显',
    desc: '科目、模块、年份、地区、试卷、难度、关键词多维组合筛选，支持只练错题、只练收藏，断点续练。',
    points: [
      '顺序 / 随机 / 自适应三种模式，即时或汇总解析',
      '混合卷图推小题按版面坐标自动绑定选项图，作答区与复盘区直接显示图片选项',
      '键盘作答：数字选选项、回车提交、N 切下一题'
    ]
  },
  {
    id: 'exam',
    tab: '真题模考与逐题复盘',
    img: shot('03-exam-review'),
    title: '按原题号整卷组卷，交卷即出成绩单',
    desc: '导入你的真题卷后限时模考，交卷自动评分：得分、正确率、用时一目了然。',
    points: [
      '逐题复盘：你的作答 vs 参考答案、选项对照、模块正确率分布',
      '可筛「仅看错题与未答」，历史模考随时回看',
      '主观题自动保存，保存失败会阻止交卷并提供重试'
    ]
  },
  {
    id: 'review',
    tab: '错题复习与申论辅助',
    img: shot('05-shenlun'),
    title: '错因记录、间隔复习，申论自动保存与评分',
    desc: '错题自动归类：错因记录 + 分级间隔复习；申论给定材料 + 题干 + 草稿自动保存。',
    points: [
      'AI 深讲错题易错点、申论 AI 评估，均按需自备模型 Key',
      '不配置 AI 也有本地规则评分兜底，全功能刷题零依赖',
      '学习报告、能力诊断、学习计划持续跟踪备考状态'
    ]
  }
]

const WHY = [
  {
    title: '数据存本机',
    desc: '学习记录、错题、模考全部保存在本机 SQLite，不上传、无遥测，随时可以自己备份。'
  },
  {
    title: 'Markdown 双形态',
    desc: '题库与知识文档都是纯 Markdown：想备份、迁移、版本管理或者自己动手写题库，都可以。'
  },
  {
    title: '每日自动备份',
    desc: '按保留数量滚动备份，出问题可回滚；换电脑时一键导出迁移包，整套数据随身走。'
  },
  {
    title: '离线零依赖',
    desc: '装好就能刷题，日常训练、模考、复习完全离线；仅扫描版 PDF 导入需要 Python 3.10+。'
  },
  {
    title: '示例库开箱即试',
    desc: '安装包内置体验示例库，训练、模考、申论、报告立即上手；正式备考导入你自己的资料。'
  },
  {
    title: 'AI 可选接入',
    desc: '自备模型 Key 即可启用 AI 助教与变式训练，Key 用系统加密存储；不配置也全功能可用。'
  }
]

const COMPARE = [
  { dim: '题目数据', app: '存在云端服务器', tizhou: '存在本机 SQLite，随时备份迁移' },
  { dim: '题库来源', app: '平台统一分发', tizhou: '你自己的 PDF / Markdown 资料' },
  { dim: '广告与会员', app: '广告、会员解锁常见', tizhou: '无广告无会员，MIT 开源免费' },
  { dim: '离线使用', app: '多数场景需要联网', tizhou: '日常刷题完全离线' },
  { dim: 'AI 能力', app: '平台内置，按量收费', tizhou: '自备 Key 可选接入，明文不落盘' }
]

const STEPS = [
  {
    no: '1',
    title: '下载安装包',
    desc: '约 130 MB，国内推荐 CNB Releases 通道，GitHub Releases 内容一致；下载后可用同页 SHA256SUMS.txt 校验完整性。'
  },
  {
    no: '2',
    title: '双击安装',
    desc: 'Windows SmartScreen 提示「未知发布者」时，点击「更多信息 → 仍要运行」。题舟暂未购买商业代码签名证书。'
  },
  {
    no: '3',
    title: '开始学习',
    desc: '安装完成即启动，内置示例题库可直接体验全部功能；正式备考时在知识库工坊导入自己的题本 PDF 或 Markdown。'
  }
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
    a: 'Windows 10 1809+ 或 Windows 11（64 位）；内存 4 GB 起步、推荐 8 GB；磁盘空间为应用约 500 MB 加 OCR 引擎约 200 MB，另加题库空间。Python 3.10+ 仅在导入扫描版 PDF 时需要。'
  },
  {
    q: '题舟收费吗？',
    a: '免费。MIT 开源协议，代码公开可审查，无广告、无会员、无使用统计与遥测。'
  }
]

function DownloadButtons(): React.JSX.Element {
  return (
    <div className="dl-buttons">
      {release.channels
        .filter((channel) => channel.primary)
        .map((channel) => (
          <a key={channel.id} className="btn btn-primary" href={channel.url}>
            {channel.label}
            <span className="btn-sub">{channel.provider}</span>
          </a>
        ))}
      {release.channels
        .filter((channel) => !channel.primary)
        .map((channel) => (
          <a key={channel.id} className="btn btn-ghost" href={channel.url}>
            {channel.label}
            <span className="btn-sub">{channel.provider}</span>
          </a>
        ))}
      {release.selfHosted.enabled && (
        <a className="btn btn-ghost" href={release.selfHosted.url}>
          本站直链下载
          <span className="btn-sub">{release.selfHosted.note}</span>
        </a>
      )}
    </div>
  )
}

function FlowTabs(): React.JSX.Element {
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
        <figure className="flow-shot">
          <img src={flow.img} alt={flow.title} loading="lazy" />
          <figcaption>{flow.title}</figcaption>
        </figure>
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
  return (
    <div className="site">
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href="#top">
            <span className="brand-mark">题</span>
            <span className="brand-name">题舟 Tizhou</span>
          </a>
          <nav className="site-nav" aria-label="页面导航">
            <a href="#flow">核心流程</a>
            <a href="#why">为什么用题舟</a>
            <a href="#start">快速上手</a>
            <a href="#faq">常见问题</a>
          </nav>
          <div className="header-links">
            <a href="https://github.com/nghqqa/tizhou" className="header-link">
              GitHub
            </a>
            <a href="https://cnb.cool/nghqqa/tizhou" className="header-link">
              CNB
            </a>
            <a href="#download" className="btn btn-primary btn-small">
              下载 v{release.version}
            </a>
          </div>
        </div>
      </header>

      <main id="top">
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
              <DownloadButtons />
              <p className="hero-meta">
                v{release.version} · {release.platform} · 安装包{release.asset.sizeHint}
              </p>
              <p className="hero-meta muted">{release.asset.checksumHint}</p>
            </div>
            <figure className="hero-shot">
              <img src={shot('01-dashboard')} alt="题舟今日工作台：学习日历热力图与待复习概览" />
            </figure>
          </div>
        </section>

        {/* 核心流程 */}
        <section className="section" id="flow">
          <div className="container">
            <h2>从题本 PDF 到上岸，一条完整闭环</h2>
            <p className="section-desc">
              四个阶段覆盖备考全程：建库、训练、模考、复习。以下截图均来自真实应用界面。
            </p>
            <FlowTabs />
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
                  <h3>{item.title}</h3>
                  <p>{item.desc}</p>
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
              {STEPS.map((step) => (
                <div className="step" key={step.no}>
                  <span className="step-no">{step.no}</span>
                  <h3>{step.title}</h3>
                  <p>{step.desc}</p>
                </div>
              ))}
            </div>
            <p className="start-note">
              完整配置（可选）：知识库工坊安装转换引擎（约 200 MB，含 OCR 模型）→ 选择题本目录导入 →
              抽查发布；如需 AI 能力，再到模型设置填入自备 Key 并测试连接。
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
      </main>

      <footer className="site-footer">
        <div className="container footer-inner">
          <div className="footer-brand">
            <span className="brand-mark">题</span>
            <div>
              <strong>题舟 Tizhou</strong>
              <p>题海行舟，终将上岸。</p>
            </div>
          </div>
          <nav className="footer-links" aria-label="项目链接">
            <a href="https://github.com/nghqqa/tizhou">GitHub 仓库</a>
            <a href="https://cnb.cool/nghqqa/tizhou">CNB 镜像</a>
            <a href="https://github.com/nghqqa/tizhou/releases/latest">Releases</a>
            <a href="https://github.com/nghqqa/tizhou/issues">问题反馈</a>
            <a href="https://github.com/nghqqa/tizhou/blob/master/docs/user-guide.md">用户手册</a>
          </nav>
          <div className="footer-meta">
            <p>
              MIT License · v{release.version} · {release.platform}
            </p>
            {release.icp && <p>{release.icp}</p>}
          </div>
        </div>
      </footer>
    </div>
  )
}
