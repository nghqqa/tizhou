// 转换组件的 pip 安装源管理。
// 默认行为：安装时对官方 PyPI 与国内镜像并发探活，得到一条有序候选源队列——
// 可达国内源按耗时升序排最前，可达官方源次之，探活未过的源按固定兜底顺序排末尾；
// pip 安装按队列依次尝试，某个源失败自动切换下一个，首个成功的源会被提升为
// 本次安装任务后续包的首选源。
// 关键背景：Node fetch 不读 Windows 注册表里的系统代理，而 python -m pip 会走系统
// 代理，两者看到的网络视图可能不一致——所以探活未过的源也要留在队尾兜底，
// 且探活判活必须收紧（403 = 开启系统代理时绕行海外节点访问清华源的典型返回）。
// 用户也可在工坊里手动钉死源。只影响应用内 spawn 的 pip 命令（--index-url），
// 不写系统级 pip.ini / 环境变量——不污染用户的 Python 环境。
// 源清单在 src/shared/pip-mirrors.ts（渲染进程选择器共用）。
import { PIP_MIRRORS, type PipMirror } from '../../shared/pip-mirrors'

export type PipMirrorPreference = 'auto' | string

export const DEFAULT_MIRROR_PREFERENCE: PipMirrorPreference = 'auto'

// 手动钉死的源返回 403 / 空 versions 时追加的排障指引（可直接操作的结论）
export const PINNED_MIRROR_HINT =
  '当前指定的镜像源拒绝访问或不可用（常见于开启系统代理时访问清华源），' +
  '建议将组件安装源改为「自动」或「腾讯云镜像」后重试'

// 探活未过源的兜底顺序：优先国内源（官方 PyPI 排最后，与历史行为一致）
const FALLBACK_ORDER = ['tencent', 'aliyun', 'tuna', 'pypi']

// 环境变量已显式指定源时优先尊重（用户自己配置的环境不该被应用覆盖）
export function envPipIndexUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.PIP_INDEX_URL?.trim()
  return value || undefined
}

export function normalizeMirrorPreference(id: string | undefined): PipMirrorPreference {
  if (!id) return DEFAULT_MIRROR_PREFERENCE
  if (id === 'auto') return 'auto'
  return PIP_MIRRORS.some((mirror) => mirror.id === id) ? id : DEFAULT_MIRROR_PREFERENCE
}

export function mirrorById(id: string): PipMirror | undefined {
  return PIP_MIRRORS.find((mirror) => mirror.id === id)
}

// 探活：HEAD 真实包索引页（/simple/rapidocr/ 才是 pip 实际拉取的路径）。
// 判活只认 2xx/3xx——403（系统代理绕行海外访问清华源）、404、429 都说明该源
// 当前不可用，绝不能像旧版 `status < 500` 那样把拒绝访问当成可达。
export async function probeMirror(indexUrl: string, timeoutMs = 2500): Promise<boolean> {
  const target = `${indexUrl.replace(/\/+$/, '')}/rapidocr/`
  try {
    const response = await fetch(target, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    })
    return response.status >= 200 && response.status < 400
  } catch {
    return false
  }
}

export interface MirrorProbeResult extends PipMirror {
  reachable: boolean
  elapsedMs: number
}

// 探活结果 → 有序候选源队列：可达国内源按耗时升序排最前，可达官方源次之，
// 探活未过的其余源按 tencent → aliyun → tuna → pypi 的兜底顺序排末尾备用
//（pip 走系统代理时的网络视图可能与 Node fetch 直连探活不同，未过源也要留着兜底）。
export function mirrorQueueFromProbes(probes: MirrorProbeResult[]): PipMirror[] {
  const queue: PipMirror[] = []
  const push = (probe: MirrorProbeResult | undefined): void => {
    if (!probe) return
    if (queue.some((mirror) => mirror.id === probe.id)) return
    queue.push({ id: probe.id, label: probe.label, indexUrl: probe.indexUrl })
  }
  const domestic = probes
    .filter((probe) => probe.reachable && probe.id !== 'pypi')
    .sort((a, b) => a.elapsedMs - b.elapsedMs)
  const official = probes.find((probe) => probe.reachable && probe.id === 'pypi')
  const unreachable = probes
    .filter((probe) => !probe.reachable)
    .sort((a, b) => fallbackRank(a.id) - fallbackRank(b.id))
  for (const probe of domestic) push(probe)
  push(official)
  for (const probe of unreachable) push(probe)
  return queue
}

function fallbackRank(id: string): number {
  const index = FALLBACK_ORDER.indexOf(id)
  return index === -1 ? FALLBACK_ORDER.length : index
}

export interface PipSource {
  url: string
  label: string
}

// 单源 pip 安装失败：output 保留该源的 stdout + stderr 尾部
//（部分 pip 错误如 from versions: none 输出在 stdout），供换源提示与失败汇总诊断
export class PipSourceFailure extends Error {
  constructor(
    readonly output: string,
    message?: string
  ) {
    super(message ?? (summarizePipOutput(output) || 'pip 安装失败'))
    this.name = 'PipSourceFailure'
  }
}

// 压成单行并只保留尾部（pip 报错的关键行几乎都在末尾）
export function summarizePipOutput(output: string): string {
  const text = output.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > 400 ? `…${text.slice(-400)}` : text
}

// 按有序候选源队列安装一个包：当前源失败自动切换下一源；全部失败时汇总各源
// 简明原因抛出，并可经 buildHint 追加可操作的排障指引。
export async function installWithMirrorQueue(options: {
  queue: PipSource[]
  run: (source: PipSource) => Promise<void>
  onSourceFailure?: (failed: PipSource, next: PipSource) => void
  onSourceSuccess?: (source: PipSource) => void
  buildHint?: (combinedOutput: string) => string | undefined
}): Promise<void> {
  const failures: Array<{ source: PipSource; reason: string; output: string }> = []
  for (let index = 0; index < options.queue.length; index += 1) {
    const source = options.queue[index]!
    try {
      await options.run(source)
      options.onSourceSuccess?.(source)
      return
    } catch (error) {
      const output = error instanceof PipSourceFailure ? error.output : ''
      const reason = error instanceof Error ? error.message : String(error)
      failures.push({ source, reason, output })
      const next = options.queue[index + 1]
      if (!next) break
      options.onSourceFailure?.(source, next)
    }
  }
  if (!failures.length) throw new Error('没有可用的 pip 安装源')
  const summary = failures
    .map(
      (failure) => `${failure.source.label}（${summarizePipOutput(failure.reason) || '未知原因'}）`
    )
    .join('；')
  let message = `全部候选安装源均失败：${summary}`
  const hint = options.buildHint?.(failures.map((failure) => failure.output).join('\n'))
  if (hint) message += `\n${hint}`
  throw new Error(message)
}

// 手动钉死源的失败兜底指引：403 或「from versions: none」是开启系统代理时
// 访问清华源的典型症状，直接给可操作结论而不是让用户面对 pip 原始报错。
// 版本号里恰好含 403（如 2.403.1）不算命中。
export function pipMirrorFailureHint(
  output: string,
  preference: PipMirrorPreference
): string | undefined {
  if (preference === 'auto') return undefined
  if (!(/(?<![\d.])403(?![\d.])/.test(output) || /from versions: none/i.test(output)))
    return undefined
  return PINNED_MIRROR_HINT
}
