import { useEffect, useMemo, useState } from 'react'
import { Button, Field, Input, Select, Textarea } from '@fluentui/react-components'
import {
  BookBookmarkIcon,
  CopyIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  QuotesIcon,
  TrashIcon,
  XIcon
} from '@phosphor-icons/react'
import type { StudySnippet } from '@shared/contracts'
import { invoke } from '../../api'
import { useAppStore } from '../../store'

interface BuiltinNormPair {
  id: string
  oral: string
  formal: string
  scene: string
}

const BUILTIN_NORMS: readonly BuiltinNormPair[] = [
  {
    id: 'bn-1',
    oral: '老百姓没钱看病/看病贵',
    formal: '医疗保障供给不足，群众就医负担较重，基本公共服务可及性有待提升',
    scene: '民生/医疗'
  },
  {
    id: 'bn-2',
    oral: '网上乱说话/造谣传谣',
    formal: '网络空间治理失范，虚假信息传播扰乱舆论生态，平台主体责任落实不到位',
    scene: '社会治理'
  },
  {
    id: 'bn-3',
    oral: '办事跑很多趟/流程太烦',
    formal: '政务服务流程繁琐、部门数据壁垒尚未打通，群众办事便捷度不高',
    scene: '政务服务'
  },
  {
    id: 'bn-4',
    oral: '人才留不住/不愿来基层',
    formal: '基层引才留才机制不健全，薪酬待遇与职业发展空间受限，人才虹吸效应凸显',
    scene: '人才振兴'
  },
  {
    id: 'bn-5',
    oral: '企业融资难、缺钱发展',
    formal: '民营中小微企业信贷融资渠道偏窄、综合融资成本偏高，金融精准滴灌不足',
    scene: '产业发展'
  },
  {
    id: 'bn-6',
    oral: '只顾挣钱不顾污染',
    formal: '粗放式发展模式尚未根本扭转，生态环境保护与经济增速协同统筹不足',
    scene: '生态文明'
  },
  {
    id: 'bn-7',
    oral: '管不住、出了事推责任',
    formal: '监管执法存在盲区与“九龙治水”现象，权责边界不清，协同联动机制缺位',
    scene: '法治/监管'
  },
  {
    id: 'bn-8',
    oral: '政策发下去没人听、落不了地',
    formal: '政策宣传解读“最后一公里”存在梗阻，基层执行“上热下冷”，缺乏有效督查闭环',
    scene: '执行落地'
  },
  {
    id: 'bn-9',
    oral: '村里东西卖不出去/价格低',
    formal: '农产品产销衔接不畅，品牌化与冷链物流体系建设滞后，产业附加值偏低',
    scene: '乡村振兴'
  },
  {
    id: 'bn-10',
    oral: '老旧小区脏乱差、没人管',
    formal: '城市更新与精细化治理滞后，基础设施老化，多元主体共治共享格局尚未形成',
    scene: '基层治理'
  },
  {
    id: 'bn-11',
    oral: '传统文化年轻人不爱看',
    formal: '中华优秀传统文化创造性转化和创新性发展不足，现代表达与年轻化传播力有待增强',
    scene: '文化建设'
  },
  {
    id: 'bn-12',
    oral: '建好设施之后闲置浪费',
    formal: '重建设、轻运营管护倾向突出，长效运维机制缺失，公共资源使用效能偏低',
    scene: '长效机制'
  },
  {
    id: 'bn-13',
    oral: '一刀切、搞形式主义',
    formal: '政绩观存在偏差，考核激励机制不科学，政策执行机械僵化、脱离群众实际需求',
    scene: '作风建设'
  },
  {
    id: 'bn-14',
    oral: '大家不配合、积极性不高',
    formal: '群众参与意识薄弱，内生动力尚未充分激发，利益联结与正向激励机制有待完善',
    scene: '多元共治'
  },
  {
    id: 'bn-15',
    oral: '加强惩罚、严格把关',
    formal: '健全全链条监管体系，强化事中事后常态化执法，提高违法失信成本，形成有力震慑',
    scene: '高频对策'
  },
  {
    id: 'bn-16',
    oral: '多宣传让大家都知道',
    formal: '拓宽线上线下融合宣传矩阵，创新群众喜闻乐见的科普宣教形式，营造共建共治良好氛围',
    scene: '高频对策'
  }
]

interface ShenlunSnippetDrawerProps {
  open: boolean
  onClose: () => void
  onInsert?: (text: string) => void
}

/** 申论规范词 & 个人金句随身抽屉（非模态侧滑，支持搜、增、删与一键插入作答框） */
export function ShenlunSnippetDrawer({
  open,
  onClose,
  onInsert
}: ShenlunSnippetDrawerProps): React.JSX.Element | null {
  const showToast = useAppStore((state) => state.showToast)
  const [tab, setTab] = useState<'norms' | 'custom'>('norms')
  const [query, setQuery] = useState('')
  const [snippets, setSnippets] = useState<StudySnippet[]>([])
  const [adding, setAdding] = useState(false)
  const [newKind, setNewKind] = useState<'norm' | 'quote'>('quote')
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newTags, setNewTags] = useState('')

  useEffect(() => {
    if (!open) return
    void invoke<StudySnippet[]>({ method: 'snippets.list', params: {} })
      .then(setSnippets)
      .catch(() => setSnippets([]))
  }, [open])

  const filteredBuiltins = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return BUILTIN_NORMS
    return BUILTIN_NORMS.filter(
      (item) =>
        item.oral.toLowerCase().includes(q) ||
        item.formal.toLowerCase().includes(q) ||
        item.scene.toLowerCase().includes(q)
    )
  }, [query])

  const filteredCustom = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return snippets
    return snippets.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [snippets, query])

  if (!open) return null

  async function handleCopy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      showToast('已复制到剪贴板')
    } catch {
      showToast('复制失败，请手动选中复制')
    }
  }

  async function handleSaveNew(): Promise<void> {
    if (!newTitle.trim() || !newContent.trim()) {
      showToast('请填写标题/原词与规范表达/金句内容')
      return
    }
    try {
      const saved = await invoke<StudySnippet>({
        method: 'snippets.save',
        params: {
          kind: newKind,
          title: newTitle.trim(),
          content: newContent.trim(),
          tags: newTags
            .split(/[,，\s]+/)
            .map((t) => t.trim())
            .filter(Boolean)
        }
      })
      setSnippets((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)])
      setNewTitle('')
      setNewContent('')
      setNewTags('')
      setAdding(false)
      setTab('custom')
      showToast('已收录到个人素材抽屉')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '保存失败')
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await invoke({ method: 'snippets.delete', params: { id } })
      setSnippets((prev) => prev.filter((item) => item.id !== id))
      showToast('已删除该条素材')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '删除失败')
    }
  }

  return (
    <aside className="snippet-drawer" aria-label="申论规范词与金句抽屉">
      <div className="snippet-drawer-head">
        <div>
          <strong>规范词 & 金句随身抽屉</strong>
          <small className="muted">口语→政务书面语速查 · 个人收藏金句一键写入</small>
        </div>
        <button
          type="button"
          className="snippet-close-btn"
          aria-label="关闭素材抽屉"
          onClick={onClose}
        >
          <XIcon size={15} />
        </button>
      </div>
      <div className="snippet-drawer-tools">
        <Input
          size="small"
          value={query}
          contentBefore={<MagnifyingGlassIcon size={13} />}
          placeholder="搜索口语表达、政务场景或金句关键词"
          onChange={(_, data) => setQuery(data.value)}
        />
        <div className="snippet-tab-row">
          <button
            type="button"
            className={`doc-filter-chip${tab === 'norms' ? ' is-active' : ''}`}
            onClick={() => setTab('norms')}
          >
            <BookBookmarkIcon size={12} /> 常用规范词 ({filteredBuiltins.length})
          </button>
          <button
            type="button"
            className={`doc-filter-chip${tab === 'custom' ? ' is-active' : ''}`}
            onClick={() => setTab('custom')}
          >
            <QuotesIcon size={12} /> 我的金句库 ({filteredCustom.length})
          </button>
          <Button
            size="small"
            appearance={adding ? 'secondary' : 'subtle'}
            icon={<PlusIcon size={12} />}
            onClick={() => setAdding((v) => !v)}
          >
            新增
          </Button>
        </div>
      </div>

      {adding && (
        <div className="snippet-add-box">
          <div className="snippet-add-row">
            <Field label="类型">
              <Select
                size="small"
                value={newKind}
                onChange={(_, data) => setNewKind(data.value as 'norm' | 'quote')}
              >
                <option value="quote">金句 / 范文句</option>
                <option value="norm">规范词转换</option>
              </Select>
            </Field>
            <Field label={newKind === 'norm' ? '口语原词' : '主题标题'} className="grow">
              <Input
                size="small"
                value={newTitle}
                onChange={(_, d) => setNewTitle(d.value)}
                placeholder={newKind === 'norm' ? '如：没人监管' : '如：青年担当金句'}
              />
            </Field>
          </div>
          <Field label={newKind === 'norm' ? '规范政务表达' : '正文内容'}>
            <Textarea
              rows={3}
              value={newContent}
              onChange={(_, d) => setNewContent(d.value)}
              placeholder="填入规范用语或名言金句正文"
            />
          </Field>
          <Field label="标签（可选，空格分隔）">
            <Input
              size="small"
              value={newTags}
              onChange={(_, d) => setNewTags(d.value)}
              placeholder="如：基层治理 对策"
            />
          </Field>
          <div className="button-row" style={{ marginTop: 8 }}>
            <Button size="small" appearance="primary" onClick={() => void handleSaveNew()}>
              保存收藏
            </Button>
            <Button size="small" appearance="subtle" onClick={() => setAdding(false)}>
              取消
            </Button>
          </div>
        </div>
      )}

      <div className="snippet-drawer-list">
        {tab === 'norms' ? (
          filteredBuiltins.map((pair) => (
            <div className="snippet-card" key={pair.id}>
              <div className="snippet-card-top">
                <span className="pill">{pair.scene}</span>
                <span className="snippet-oral">口语：{pair.oral}</span>
              </div>
              <p className="snippet-formal">{pair.formal}</p>
              <div className="button-row">
                {onInsert && (
                  <Button
                    size="small"
                    appearance="primary"
                    onClick={() => {
                      onInsert(pair.formal)
                      showToast('已插入当前作答区')
                    }}
                  >
                    插入作答
                  </Button>
                )}
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<CopyIcon />}
                  onClick={() => void handleCopy(pair.formal)}
                >
                  复制
                </Button>
              </div>
            </div>
          ))
        ) : filteredCustom.length === 0 ? (
          <p className="muted" style={{ padding: '12px 4px' }}>
            暂无自定义规范词或金句。点击上方「新增」，或在「知识中心」划词文本一键收藏。
          </p>
        ) : (
          filteredCustom.map((item) => (
            <div className="snippet-card" key={item.id}>
              <div className="snippet-card-top">
                <span className="pill">{item.kind === 'norm' ? '规范词' : '金句素材'}</span>
                <strong>{item.title}</strong>
              </div>
              <p className="snippet-formal">{item.content}</p>
              <div className="button-row">
                {onInsert && (
                  <Button
                    size="small"
                    appearance="primary"
                    onClick={() => {
                      onInsert(item.content)
                      showToast('已插入当前作答区')
                    }}
                  >
                    插入作答
                  </Button>
                )}
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<CopyIcon />}
                  onClick={() => void handleCopy(item.content)}
                >
                  复制
                </Button>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<TrashIcon />}
                  onClick={() => void handleDelete(item.id)}
                >
                  删除
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
