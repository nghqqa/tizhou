import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import { invoke } from '../api'

// 插件与组件映射必须是稳定引用：内联字面量会让 react-markdown 在每次父组件
// 重渲染时整树重建，图片随之重新走 IPC 加载，表现为点击后闪“正在读取图片”。
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeKatex]

// 资源 data URL 缓存：题目重渲染或重访时不再重复请求主进程
const assetUrlCache = new Map<string, string>()
const ASSET_CACHE_LIMIT = 240

function rememberAsset(key: string, value: string): void {
  if (assetUrlCache.size >= ASSET_CACHE_LIMIT) {
    const oldest = assetUrlCache.keys().next().value
    if (oldest !== undefined) assetUrlCache.delete(oldest)
  }
  assetUrlCache.set(key, value)
}

function VaultImage(props: {
  src?: string
  alt?: string
  sourceFilePath?: string
}): React.JSX.Element {
  const cacheKey = `${props.sourceFilePath ?? ''}\n${props.src ?? ''}`
  const [resolved, setResolved] = useState(() =>
    props.src?.startsWith('data:image/') ? props.src : (assetUrlCache.get(cacheKey) ?? '')
  )
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!props.src || props.src.startsWith('data:image/')) return
    if (!props.sourceFilePath || /^[a-z][a-z0-9+.-]*:/i.test(props.src)) {
      setFailed(true)
      return
    }
    const cached = assetUrlCache.get(cacheKey)
    if (cached) {
      setFailed(false)
      setResolved(cached)
      return
    }
    let cancelled = false
    setFailed(false)
    setResolved('')
    void invoke<string>({
      method: 'vault.asset',
      params: { sourceFilePath: props.sourceFilePath, assetPath: props.src }
    })
      .then((value) => {
        if (cancelled) return
        rememberAsset(cacheKey, value)
        setResolved(value)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [props.src, props.sourceFilePath, cacheKey])
  if (failed) return <span className="muted">图片不可用：{props.alt || props.src}</span>
  if (!resolved) return <span className="muted">正在读取图片：{props.alt || '未命名图片'}</span>
  return <img src={resolved} alt={props.alt ?? ''} loading="lazy" />
}

export function MarkdownContent(props: {
  content: string
  sourceFilePath?: string
  className?: string
}): React.JSX.Element {
  const components = useMemo(
    () => ({
      img: ({ src, alt }: { src?: string; alt?: string }) => (
        <VaultImage src={src} alt={alt} sourceFilePath={props.sourceFilePath} />
      )
    }),
    [props.sourceFilePath]
  )
  return (
    <div className={`markdown ${props.className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {props.content}
      </ReactMarkdown>
    </div>
  )
}
