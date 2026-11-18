import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installWithMirrorQueue,
  mirrorQueueFromProbes,
  normalizeMirrorPreference,
  pipMirrorFailureHint,
  probeMirror,
  PINNED_MIRROR_HINT,
  PipSourceFailure,
  type MirrorProbeResult,
  type PipSource
} from '../src/main/services/pip-mirror'
import { PIP_MIRROR_OPTIONS, PIP_MIRRORS, pipMirrorLabel } from '../src/shared/pip-mirrors'

afterEach(() => {
  vi.unstubAllGlobals()
})

function probe(id: string, reachable: boolean, elapsedMs = 100): MirrorProbeResult {
  const mirror = PIP_MIRRORS.find((item) => item.id === id)!
  return { ...mirror, reachable, elapsedMs }
}

describe('pip mirror basics', () => {
  it('keeps shared mirror list sane (unique ids, https endpoints)', () => {
    const ids = PIP_MIRRORS.map((mirror) => mirror.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const mirror of PIP_MIRRORS) expect(mirror.indexUrl.startsWith('https://')).toBe(true)
    expect(PIP_MIRROR_OPTIONS[0]?.id).toBe('auto')
  })

  it('normalizes unknown or empty preferences back to auto', () => {
    expect(normalizeMirrorPreference(undefined)).toBe('auto')
    expect(normalizeMirrorPreference('nope')).toBe('auto')
    expect(normalizeMirrorPreference('tuna')).toBe('tuna')
    expect(normalizeMirrorPreference('auto')).toBe('auto')
  })

  it('labels mirror ids for display', () => {
    expect(pipMirrorLabel('tuna')).toBe('清华 TUNA')
    expect(pipMirrorLabel('auto')).toContain('自动')
    expect(pipMirrorLabel('unknown')).toContain('自动')
  })
})

describe('probeMirror liveness verdicts', () => {
  it('treats 2xx as reachable and probes the real package index page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeMirror('https://pypi.org/simple')).resolves.toBe(true)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://pypi.org/simple/rapidocr/')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('HEAD')
  })

  it.each([403, 404, 429, 500])('treats HTTP %i as unreachable', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })))
    await expect(probeMirror('https://pypi.tuna.tsinghua.edu.cn/simple')).resolves.toBe(false)
  })

  it('treats network errors and timeouts as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    await expect(probeMirror('https://pypi.org/simple')).resolves.toBe(false)
  })
})

describe('mirrorQueueFromProbes ordering', () => {
  it('orders reachable domestic by latency, then official, then unreachable fallback order', () => {
    const queue = mirrorQueueFromProbes([
      probe('tuna', true, 500),
      probe('aliyun', true, 120),
      probe('pypi', true, 60),
      probe('tencent', false, 2500)
    ])
    expect(queue.map((mirror) => mirror.id)).toEqual(['aliyun', 'tuna', 'pypi', 'tencent'])
  })

  it('keeps every unreachable source as tail fallback in fixed order', () => {
    const queue = mirrorQueueFromProbes(
      ['pypi', 'tuna', 'aliyun', 'tencent'].map((id) => probe(id, false))
    )
    expect(queue.map((mirror) => mirror.id)).toEqual(['tencent', 'aliyun', 'tuna', 'pypi'])
  })

  it('never duplicates a source across queue segments', () => {
    const queue = mirrorQueueFromProbes([probe('pypi', true, 10), probe('tencent', false, 0)])
    const ids = queue.map((mirror) => mirror.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('installWithMirrorQueue', () => {
  const sources: PipSource[] = [
    { url: 'https://a.example/simple', label: '源A' },
    { url: 'https://b.example/simple', label: '源B' }
  ]

  it('uses the first source without retries when it succeeds', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const onSourceSuccess = vi.fn()
    await installWithMirrorQueue({ queue: sources, run, onSourceSuccess })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toEqual(sources[0])
    expect(onSourceSuccess).toHaveBeenCalledWith(sources[0])
  })

  it('switches to the next source after a failure and promotes the winner', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new PipSourceFailure('403 Forbidden from tuna', '安装失败'))
      .mockResolvedValueOnce(undefined)
    const onSourceFailure = vi.fn()
    const onSourceSuccess = vi.fn()
    await installWithMirrorQueue({ queue: sources, run, onSourceFailure, onSourceSuccess })
    expect(run).toHaveBeenCalledTimes(2)
    expect(onSourceFailure).toHaveBeenCalledWith(sources[0], sources[1])
    expect(onSourceSuccess).toHaveBeenCalledWith(sources[1])
  })

  it('aggregates per-source reasons when every candidate fails', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new PipSourceFailure('… 403 Forbidden'))
      .mockRejectedValueOnce(new PipSourceFailure('connection reset by peer'))
    const failure = await installWithMirrorQueue({ queue: sources, run }).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('源A')
    expect(failure.message).toContain('源B')
    expect(failure.message).toContain('connection reset')
    expect(failure.message).not.toContain(PINNED_MIRROR_HINT)
  })

  it('appends an actionable hint when a pinned mirror returns 403', async () => {
    const run = vi.fn().mockRejectedValue(new PipSourceFailure('ERROR: 403 Forbidden'))
    const failure = await installWithMirrorQueue({
      queue: [sources[0]!],
      run,
      buildHint: (output) => pipMirrorFailureHint(output, 'tuna')
    }).catch((error: unknown) => error)
    expect(failure.message).toContain('建议将组件安装源改为「自动」或「腾讯云镜像」后重试')
  })

  it('only hints on genuine markers, not version-number coincidences', () => {
    expect(pipMirrorFailureHint('403 Forbidden', 'auto')).toBeUndefined()
    expect(pipMirrorFailureHint('plain failure', 'tuna')).toBeUndefined()
    expect(pipMirrorFailureHint('from versions: none', 'aliyun')).toBe(PINNED_MIRROR_HINT)
    expect(pipMirrorFailureHint('Downloading numpy-2.403.1', 'tuna')).toBeUndefined()
  })

  it('rejects an empty queue outright', async () => {
    await expect(installWithMirrorQueue({ queue: [], run: vi.fn() })).rejects.toThrow(
      '没有可用的 pip 安装源'
    )
  })
})
