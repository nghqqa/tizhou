// 转换组件的 pip 安装源管理。
// 默认行为：安装时对官方 PyPI 与国内镜像做快速探活，选第一个可达的国内源；
// 用户也可在工坊里手动钉死。只影响应用内 spawn 的 pip 命令（--index-url），
// 不写系统级 pip.ini / 环境变量——不污染用户的 Python 环境。
// 源清单在 src/shared/pip-mirrors.ts（渲染进程选择器共用）。
import { PIP_MIRRORS, type PipMirror } from '../../shared/pip-mirrors'

export type PipMirrorPreference = 'auto' | string

export const DEFAULT_MIRROR_PREFERENCE: PipMirrorPreference = 'auto'

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

// 探活：对源的简单页面发 HEAD，短超时内 any 2xx/3xx 视为可达。
// 源的 /simple/<包>/ 页面才是 pip 实际拉取路径，HEAD 根路径对大站都通，
// 因此探测路径用 /pypi/（各镜像均支持）以贴近真实可用性。
export async function probeMirror(indexUrl: string, timeoutMs = 2500): Promise<boolean> {
  const target = `${indexUrl.replace(/\/+$/, '')}/pypi/`
  try {
    const response = await fetch(target, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    })
    return response.status < 500
  } catch {
    return false
  }
}

export interface MirrorProbeResult extends PipMirror {
  reachable: boolean
  elapsedMs: number
}

// 自动优选：可达的国内源优先（按响应耗时），全都不可达时退回官方 PyPI（哪怕它也不通——
// pip 自身还有重试与系统代理兜底，选它至少与历史行为一致）。
export function pickMirrorByProbes(probes: MirrorProbeResult[]): PipMirror {
  const reachable = probes.filter((probe) => probe.reachable)
  const domestic = reachable.filter((probe) => probe.id !== 'pypi')
  const pool = domestic.length ? domestic : reachable
  if (!pool.length) return mirrorById('pypi')!
  return pool.reduce((best, current) => (current.elapsedMs < best.elapsedMs ? current : best))
}
